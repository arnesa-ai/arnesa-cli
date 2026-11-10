import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { credential } from '../commands/auth';
import { reportSetup } from '../commands/events';
import { ApiError } from '../http';
import { withClientGates } from '../install/launch';
import {
  LockError,
  newLock,
  readLock,
  writeLock,
  type FileRecord,
  type InstallRecord,
} from '../install/lock';
import { buildPlan, manifestHashOf } from '../install/plan';
import {
  diskProblem,
  newInstallId,
  responseProblems,
  WriteTransaction,
} from '../install/safe-write';
import { messages } from '../messages';
import { detectProfile } from '../profile';
import type { Ctx } from '../types';
import { CompileRequestSchema, CompileResponseSchema, type CompileResponse } from '../wire';
import { redact, sanitizeForDisplay } from './redact';
import { validateProjectRoot } from './project-root';
import { buildWebUrl, type InstallHarnessInput, type ToolHandlerExtra } from './tools';

const COMPILE_TIMEOUT_MS = 60_000;

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');

function collapseWhitespace(text: string): string {
  return sanitizeForDisplay(text).replace(/\s+/g, ' ').trim();
}

function gatesOf(response: CompileResponse) {
  const gates = new Map<string, { path: string; commands: string[] }>();
  for (const item of response.files) {
    if (!item.gate) continue;
    const known = gates.get(item.gate.id);
    gates.set(item.gate.id, {
      path: item.path,
      commands: [...(known?.commands ?? []), ...item.gate.commands],
    });
  }
  return gates;
}

interface DestCheck {
  exists: boolean;
  sha256: string | null;
}

export async function handleInstallMode(
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
  const request = CompileRequestSchema.safeParse({ slug, runtime: 'x' });
  if (!request.success) {
    return {
      content: [{ type: 'text', text: redact(messages.installUsage) }],
      isError: true,
    };
  }

  // If the client cannot elicit or elicitation is missing: write nothing, send nothing, return terminal command
  if (!extra.canElicit?.() || !extra.elicit) {
    return {
      content: [
        {
          type: 'text',
          text: redact(
            `Run this command in your terminal to install the harness:\n\narnesa install ${slug}`,
          ),
        },
      ],
    };
  }

  const runtime = ctx.options.runtime ?? detectProfile(projectRoot, {}).runtime;
  if (runtime === 'unknown') {
    return {
      content: [{ type: 'text', text: redact(messages.runtimeNeeded) }],
      isError: true,
    };
  }

  let lock;
  try {
    lock = readLock(projectRoot);
  } catch (error) {
    if (error instanceof LockError) {
      return {
        content: [{ type: 'text', text: redact(error.message) }],
        isError: true,
      };
    }
    throw error;
  }

  const already = lock?.installs[slug];
  if (already) {
    return {
      content: [
        {
          type: 'text',
          text: redact(messages.alreadyInstalled(slug, already.harness.version)),
        },
      ],
      isError: true,
    };
  }

  const client = ctx.client();
  const targetOrigin = extra?.appOrigin ?? client.origin;

  let token: string | null = null;
  try {
    token = await credential(ctx);
  } catch {
    // Continue without token
  }

  let response: CompileResponse;
  try {
    response = await client.request('POST', '/api/v1/local/compile', {
      token: token ?? undefined,
      body: { slug, runtime, cliVersion: ctx.io.version },
      schema: CompileResponseSchema,
      timeoutMs: COMPILE_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof ApiError && error.code === 'PAID_HARNESS') {
      const studioUrl = buildWebUrl(targetOrigin, { kind: 'harness', id: slug });
      return {
        content: [{ type: 'text', text: redact(`PAID_HARNESS: ${error.message} ${studioUrl}`) }],
        isError: true,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: redact(message) }],
      isError: true,
    };
  }

  // Response integrity checks
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

  // Detect process-launching items & gates
  response = { ...response, files: withClientGates(response.files) };
  const gates = gatesOf(response);

  // Check commands against sanitizeForDisplay limit (4000 chars)
  const eligibleGates = new Map<string, { path: string; commands: string[] }>();
  const tooLongSkipped: Array<{ path: string; reason: string }> = [];

  for (const [id, gate] of gates) {
    let tooLong = false;
    for (const cmd of gate.commands) {
      try {
        sanitizeForDisplay(cmd, 4000);
      } catch {
        tooLong = true;
        break;
      }
    }
    if (tooLong) {
      tooLongSkipped.push({
        path: gate.path,
        reason: `command too long to display in full (exceeds 4000 characters): ${id}`,
      });
    } else {
      eligibleGates.set(id, gate);
    }
  }

  // Final installId generated once so plan preview matches actual written bytes
  const installId = newInstallId();

  // Build plans for both scenarios: all gates allowed and no gates allowed
  const planAll = buildPlan(
    projectRoot,
    response.harness,
    response.files,
    installId,
    new Set(eligibleGates.keys()),
  );
  const planNone = buildPlan(projectRoot, response.harness, response.files, installId, new Set());

  const allFilesMap = new Map<string, (typeof planAll.files)[0]>();
  for (const f of planAll.files) {
    allFilesMap.set(f.path, f);
  }
  const noneFilesMap = new Map<string, (typeof planNone.files)[0]>();
  for (const f of planNone.files) {
    noneFilesMap.set(f.path, f);
  }

  const allPaths: string[] = [];
  for (const f of planAll.files) {
    if (!allPaths.includes(f.path)) allPaths.push(f.path);
  }
  for (const f of planNone.files) {
    if (!allPaths.includes(f.path)) allPaths.push(f.path);
  }

  if (allPaths.length === 0) {
    return {
      content: [{ type: 'text', text: redact(messages.nothingToChange) }],
    };
  }

  const shownDestinations = new Map<string, DestCheck>();
  for (const path of allPaths) {
    const full = join(projectRoot, path);
    if (existsSync(full)) {
      try {
        const bytes = readFileSync(full);
        shownDestinations.set(path, { exists: true, sha256: sha256(bytes) });
      } catch {
        shownDestinations.set(path, { exists: true, sha256: null });
      }
    } else {
      shownDestinations.set(path, { exists: false, sha256: null });
    }
  }

  // Stage 1 Elicitation: Summary of files
  const safeName = collapseWhitespace(response.harness.name);
  const safeSlug = collapseWhitespace(response.harness.slug);
  const safeVersion = collapseWhitespace(response.harness.version);
  const safeRuntime = collapseWhitespace(response.runtime);

  const summaryLines: string[] = [
    `Project root: ${projectRoot}`,
    `Install harness ${safeName} (${safeSlug}@${safeVersion}) for runtime ${safeRuntime}:`,
    'Files to be written:',
  ];
  for (const path of allPaths) {
    const fAll = allFilesMap.get(path);
    const fNone = noneFilesMap.get(path);
    if (fAll && fNone && !fAll.final.equals(fNone.final)) {
      const hashAll = sha256(fAll.final);
      const hashNone = sha256(fNone.final);
      summaryLines.push(`  ${path} (with commands: ${hashAll}; without: ${hashNone})`);
    } else {
      const f = fNone ?? fAll!;
      const size = f.final.byteLength;
      const hash = sha256(f.final);
      summaryLines.push(`  ${path} (${size} bytes, sha256: ${hash})`);
    }
  }
  summaryLines.push('', 'Install these files?');
  let stage1Prompt: string;
  try {
    stage1Prompt = sanitizeForDisplay(summaryLines.join('\n'), 4000);
  } catch {
    // Too much to show in full: the user cannot confirm what they cannot read, so nothing is written.
    return {
      content: [
        {
          type: 'text',
          text: redact(
            `This harness changes too many files to show in full here. Nothing was written. Run in your terminal:\n\narnesa install ${slug}`,
          ),
        },
      ],
      isError: true,
    };
  }

  const acceptedFiles = await extra.elicit(stage1Prompt);
  if (!acceptedFiles) {
    return {
      content: [{ type: 'text', text: redact('Install declined. Nothing was installed.') }],
    };
  }

  // Stage 2 Elicitation: Process-starting items/commands (if any)
  const allowed = new Set<string>();
  if (eligibleGates.size > 0) {
    const cmdLines: string[] = [
      `Project root: ${projectRoot}`,
      `The harness ${collapseWhitespace(response.harness.name)} requests permission to configure commands/processes:`,
    ];
    for (const [id, gate] of eligibleGates) {
      cmdLines.push(`  Gate ${collapseWhitespace(id)} (${collapseWhitespace(gate.path)}):`);
      for (const cmd of gate.commands) {
        const sanitized = sanitizeForDisplay(cmd);
        const lines = sanitized.split(/\r?\n/);
        for (const line of lines) {
          cmdLines.push(`    | ${line}`);
        }
      }
    }
    cmdLines.push('', 'Allow these commands to be configured? (Default: no)');
    const stage2Prompt = sanitizeForDisplay(cmdLines.join('\n'), 4000);

    const acceptedCommands = await extra.elicit(stage2Prompt);
    if (acceptedCommands) {
      for (const id of eligibleGates.keys()) {
        allowed.add(id);
      }
    }
  }

  // Final plan with allowed gates
  const plan = buildPlan(projectRoot, response.harness, response.files, installId, allowed);

  // Pre-check destination states: verify no file changed after acceptance
  for (const f of plan.files) {
    const full = join(projectRoot, f.path);
    const currentExists = existsSync(full);
    const recorded = shownDestinations.get(f.path);
    if (recorded) {
      if (!recorded.exists && currentExists) {
        return {
          content: [
            {
              type: 'text',
              text: redact(`a file changed after you accepted; nothing was written (${f.path})`),
            },
          ],
          isError: true,
        };
      }
      if (recorded.exists) {
        if (!currentExists) {
          return {
            content: [
              {
                type: 'text',
                text: redact(`a file changed after you accepted; nothing was written (${f.path})`),
              },
            ],
            isError: true,
          };
        }
        const currentBytes = readFileSync(full);
        const currentHash = sha256(currentBytes);
        if (currentHash !== recorded.sha256) {
          return {
            content: [
              {
                type: 'text',
                text: redact(`a file changed after you accepted; nothing was written (${f.path})`),
              },
            ],
            isError: true,
          };
        }
      }
    }
  }

  // Execute writes atomically with rollback on any failure
  const tx = new WriteTransaction(projectRoot, installId);
  try {
    for (const f of plan.files) {
      // Re-check destination state right before writing
      const full = join(projectRoot, f.path);
      const currentExists = existsSync(full);
      const recorded = shownDestinations.get(f.path);
      if (recorded) {
        if (!recorded.exists && currentExists) {
          throw new Error(`a file changed after you accepted; nothing was written (${f.path})`);
        }
        if (recorded.exists) {
          if (!currentExists) {
            throw new Error(`a file changed after you accepted; nothing was written (${f.path})`);
          }
          const currentBytes = readFileSync(full);
          const currentHash = sha256(currentBytes);
          if (currentHash !== recorded.sha256) {
            throw new Error(`a file changed after you accepted; nothing was written (${f.path})`);
          }
        }
      }

      tx.write(f.path, f.final, f.executable);
      // Backup of installed bytes for remove command
      tx.write(`.arnesa/backups/${installId}/installed/${f.path}`, f.final);
    }

    const records: FileRecord[] = plan.files.flatMap((f) =>
      f.records.map(
        (r) =>
          ({
            ...r,
            backup: tx.written().find((w) => w.path === f.path)?.backup ?? null,
          }) as FileRecord,
      ),
    );
    const record: InstallRecord = {
      installId,
      harness: {
        slug,
        name: response.harness.name,
        version: response.harness.version,
        commit: response.harness.commit,
        contentHash: response.harness.contentHash,
        license: response.harness.license,
        sourceUrl: response.harness.sourceUrl,
        author: response.harness.author,
      },
      runtime: response.runtime,
      adapterVersion: response.adapterVersion,
      manifestHash: response.manifestHash,
      files: records,
      createdDirs: tx.createdDirectories(),
      commands: [...allowed].sort(),
    };
    const next = lock ?? newLock();
    next.installs[slug] = record;
    writeLock(projectRoot, next);

    await reportSetup(ctx, {
      kind: 'install',
      projectId: next.projectId,
      harnessSlug: slug,
      versionLabel: response.harness.version,
      runtime: response.runtime,
    });
  } catch (error) {
    tx.rollback();
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: redact(message) }],
      isError: true,
    };
  }

  const written = plan.files.map((f) => f.path);
  const skipped = [
    ...plan.items
      .filter((p) => p.action === 'skipped' || p.action === 'conflict')
      .map((p) => ({ path: p.item.path, reason: p.note })),
    ...tooLongSkipped,
  ];

  const resultLines: string[] = [messages.installed(response.harness.name, written.length)];
  for (const w of written) {
    resultLines.push(`  installed: ${w}`);
  }
  if (skipped.length > 0) {
    resultLines.push(messages.someSkipped(skipped.length));
    for (const s of skipped) {
      resultLines.push(`  skipped: ${s.path}${s.reason ? ` (${s.reason})` : ''}`);
    }
  }

  return {
    content: [{ type: 'text', text: redact(resultLines.join('\n')) }],
  };
}
