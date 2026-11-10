import { ApiError } from '../http';
import { manifestHashOf } from '../install/plan';
import { diskProblem, responseProblems } from '../install/safe-write';
import { messages } from '../messages';
import type { Ctx } from '../types';
import { CompileRequestSchema, CompileResponseSchema, type CompileResponse } from '../wire';
import { redact, sanitizeForDisplay } from './redact';
import { validateProjectRoot } from './project-root';
import { buildWebUrl, type InstallHarnessInput, type ToolHandlerExtra } from './tools';

const COMPILE_TIMEOUT_MS = 60_000;

interface PinnedHarness {
  slug: string;
  items: Map<string, string>; // path -> sha256
}

/** In-memory pin keyed by harness slug, persistent for the process lifetime (SD 24.2). */
const tryPins = new Map<string, PinnedHarness>();

/** For test teardown only */
export function clearTryPinsForTesting(): void {
  tryPins.clear();
}

function parseSkillMeta(content: string, path: string): { name: string; description: string } {
  const parts = path.split('/');
  const skillIdx = parts.indexOf('skills');
  const defaultName = skillIdx >= 0 && parts[skillIdx + 1] ? parts[skillIdx + 1]! : 'skill';

  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') {
    return { name: defaultName, description: 'No description' };
  }
  const endIdx = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (endIdx < 0) {
    return { name: defaultName, description: 'No description' };
  }
  const fmLines = lines.slice(1, endIdx);
  let name = defaultName;
  let description = 'No description';
  for (const line of fmLines) {
    const nameMatch = line.match(/^name\s*:\s*(.+)$/i);
    if (nameMatch) name = nameMatch[1]!.trim().replace(/^["']|["']$/g, '');
    const descMatch = line.match(/^description\s*:\s*(.+)$/i);
    if (descMatch) description = descMatch[1]!.trim().replace(/^["']|["']$/g, '');
  }
  return { name, description };
}

export async function handleTryMode(
  args: InstallHarnessInput,
  ctx: Ctx,
  extra: ToolHandlerExtra,
  projectRoot: string,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const rootCheck = validateProjectRoot(projectRoot, ctx.io.env);
  if (!rootCheck.valid) {
    return {
      content: [
        {
          type: 'text',
          text: redact(rootCheck.message ?? 'Refused: not inside a project.'),
        },
      ],
      isError: true,
    };
  }

  const [slug = '', wanted] = args.harness.split('@');
  const request = CompileRequestSchema.safeParse({ slug, runtime: 'baseline' });
  if (!request.success) {
    return {
      content: [{ type: 'text', text: redact(messages.installUsage) }],
      isError: true,
    };
  }
  const client = ctx.client();
  const targetOrigin = extra?.appOrigin ?? client.origin;

  // Compile with baseline layout
  let response: CompileResponse;
  try {
    response = await client.request('POST', '/api/v1/local/compile', {
      body: { slug, runtime: 'baseline', cliVersion: ctx.io.version },
      schema: CompileResponseSchema,
      timeoutMs: COMPILE_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof ApiError && error.code === 'PAID_HARNESS') {
      const studioUrl = buildWebUrl(targetOrigin, { kind: 'harness', id: slug });
      return {
        content: [
          {
            type: 'text',
            text: redact(`PAID_HARNESS: This harness is not free. Run it on Studio: ${studioUrl}`),
          },
        ],
        isError: true,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: redact(message) }],
      isError: true,
    };
  }

  // Response verification
  if (response.harness.slug !== slug) {
    return { content: [{ type: 'text', text: redact(messages.wrongHarness) }], isError: true };
  }
  if (wanted && wanted !== response.harness.version) {
    return {
      content: [
        {
          type: 'text',
          text: redact(messages.versionUnavailable(wanted, response.harness.version)),
        },
      ],
      isError: true,
    };
  }
  if (response.scan.contentHash.toLowerCase() !== response.harness.contentHash.toLowerCase()) {
    return { content: [{ type: 'text', text: redact(messages.scanMismatch) }], isError: true };
  }
  if (manifestHashOf(response) !== response.manifestHash) {
    return { content: [{ type: 'text', text: redact(messages.manifestMismatch) }], isError: true };
  }
  const problems = [
    ...responseProblems(response.files),
    ...response.files.flatMap((f) => {
      const reason = diskProblem(projectRoot, f.path);
      return reason ? [{ path: f.path, reason }] : [];
    }),
  ];
  if (problems.length > 0) {
    return {
      content: [{ type: 'text', text: redact(messages.unsafeResponse) }],
      isError: true,
    };
  }

  // Scan status check: passed only! Warned harnesses are NOT_TRYABLE.
  if (response.scan.status !== 'passed') {
    return {
      content: [
        {
          type: 'text',
          text: redact(
            `NOT_TRYABLE: Harness ${slug} has scan status "${response.scan.status}" and cannot be tried in this session. It can be installed with:\n\narnesa install ${slug}`,
          ),
        },
      ],
      isError: true,
    };
  }

  // Elicitation & Pin check
  const pinned = tryPins.get(slug);

  if (!pinned) {
    // First try in this session
    if (!extra.canElicit?.() || !extra.elicit) {
      // Elicitation unavailable: serves nothing, returns install command
      return {
        content: [
          {
            type: 'text',
            text: redact(
              `Elicitation is unavailable. To install this harness in your terminal:\n\narnesa install ${slug}`,
            ),
          },
        ],
      };
    }

    const firstTryMsg = [
      `Project root: ${projectRoot}`,
      `Try harness ${response.harness.name} (${slug}@${response.harness.version})?`,
      `This will show you this harness's rules and skill instructions in this session; nothing is written.`,
      `Scan status: ${response.scan.status}.`,
    ].join('\n');

    const accepted = await extra.elicit(sanitizeForDisplay(firstTryMsg, 4000));
    if (!accepted) {
      return {
        content: [
          {
            type: 'text',
            text: redact(
              `Try mode declined. To install this harness in your terminal:\n\narnesa install ${slug}`,
            ),
          },
        ],
      };
    }

    // Pin items in process memory
    const itemsMap = new Map<string, string>();
    for (const f of response.files) {
      itemsMap.set(f.path, f.sha256);
    }
    tryPins.set(slug, { slug, items: itemsMap });
  } else {
    // Subsequent try: check for any difference against pinned item set and hashes
    let hasDiff = false;
    if (pinned.items.size !== response.files.length) {
      hasDiff = true;
    } else {
      for (const f of response.files) {
        if (pinned.items.get(f.path) !== f.sha256) {
          hasDiff = true;
          break;
        }
      }
    }

    if (hasDiff) {
      if (!extra.canElicit?.() || !extra.elicit) {
        return {
          content: [
            {
              type: 'text',
              text: redact(
                `Harness content changed and elicitation is unavailable. Try stopped. To install:\n\narnesa install ${slug}`,
              ),
            },
          ],
          isError: true,
        };
      }

      const changeMsg = [
        `Project root: ${projectRoot}`,
        `Content for harness ${response.harness.name} (${slug}) changed.`,
        `Accept the updated rules and skills for this session?`,
      ].join('\n');

      const accepted = await extra.elicit(sanitizeForDisplay(changeMsg, 4000));
      if (!accepted) {
        // Decline ends the try of that harness; old pin kept, no new content returned
        return {
          content: [
            {
              type: 'text',
              text: redact(
                `Content update declined. Try of ${slug} ended. To install:\n\narnesa install ${slug}`,
              ),
            },
          ],
        };
      }

      // Re-pin after acceptance
      const updatedMap = new Map<string, string>();
      for (const f of response.files) {
        updatedMap.set(f.path, f.sha256);
      }
      tryPins.set(slug, { slug, items: updatedMap });
    }
  }

  // Serve content (labelled as preview, ends with install command)
  const header = 'Preview, not the benchmarked form\n\n';
  const footer = `\n\nTo install this harness permanently, run:\narnesa install ${slug}`;

  // If specific item requested
  if (args.item) {
    const requested = args.item.trim();

    // Check if it's an install-only component
    const installOnlyMatch = response.files.find((f) => {
      if (f.kind === 'rule' || f.path === 'AGENTS.md') return false;
      if (f.kind === 'skill' && f.path.endsWith('SKILL.md')) return false;
      return (
        f.path === requested ||
        f.path.endsWith(`/${requested}`) ||
        (f.component && f.component === requested)
      );
    });

    if (installOnlyMatch) {
      return {
        content: [
          {
            type: 'text',
            text: redact(
              `${header}Item "${requested}" is an install-only component (${installOnlyMatch.kind}) and is never served in try mode.${footer}`,
            ),
          },
        ],
      };
    }

    // Check if it's a skill SKILL.md
    const skillMatch = response.files.find((f) => {
      if (f.kind !== 'skill' || !f.path.endsWith('SKILL.md')) return false;
      if (f.path === requested || f.path.endsWith(`/${requested}`)) return true;
      const text = f.mode === 'create' ? f.content : f.mode === 'block' ? f.text : '';
      const meta = parseSkillMeta(text, f.path);
      return meta.name === requested || f.path.includes(`/${requested}/`);
    });

    if (skillMatch) {
      const content =
        skillMatch.mode === 'create'
          ? skillMatch.content
          : skillMatch.mode === 'block'
            ? skillMatch.text
            : '';
      return {
        content: [
          {
            type: 'text',
            text: redact(
              sanitizeForDisplay(`${header}--- ${skillMatch.path} ---\n${content}${footer}`),
            ),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: redact(`${header}Item "${requested}" not found in harness ${slug}.${footer}`),
        },
      ],
      isError: true,
    };
  }

  // No specific item requested: return rules text and skill names & descriptions, list install-only
  const lines: string[] = [header.trim(), ''];

  // Rules text
  const ruleItems = response.files.filter((f) => f.kind === 'rule' || f.path === 'AGENTS.md');
  if (ruleItems.length > 0) {
    lines.push('Rules:');
    for (const r of ruleItems) {
      const text = r.mode === 'create' ? r.content : r.mode === 'block' ? r.text : '';
      lines.push(`--- ${r.path} ---`);
      lines.push(text.trim());
      lines.push('');
    }
  }

  // Skills: names and descriptions only
  const skillFiles = response.files.filter(
    (f) => f.kind === 'skill' && f.path.endsWith('SKILL.md'),
  );
  if (skillFiles.length > 0) {
    lines.push('Skills:');
    for (const s of skillFiles) {
      const text = s.mode === 'create' ? s.content : s.mode === 'block' ? s.text : '';
      const meta = parseSkillMeta(text, s.path);
      lines.push(`  - ${meta.name}: ${meta.description}`);
    }
    lines.push('');
  }

  // Install-only components
  const installOnlyItems = response.files.filter((f) => {
    if (f.kind === 'rule' || f.path === 'AGENTS.md') return false;
    if (f.kind === 'skill' && f.path.endsWith('SKILL.md')) return false;
    return true;
  });
  if (installOnlyItems.length > 0) {
    lines.push('Install-only items (not served in try mode):');
    for (const io of installOnlyItems) {
      lines.push(`  - [install only] ${io.path} (${io.kind})`);
    }
    lines.push('');
  }

  lines.push(`To install this harness permanently, run:\narnesa install ${slug}`);

  return {
    content: [{ type: 'text', text: redact(sanitizeForDisplay(lines.join('\n'))) }],
  };
}
