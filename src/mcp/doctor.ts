import { createHash } from 'node:crypto';
import { DOCTOR_CAPS, selectDoctorFiles } from '../doctor/files';
import { messages } from '../messages';
import type { Ctx } from '../types';
import {
  DoctorStartResponseSchema,
  DoctorStatusResponseSchema,
  type DoctorStatusResponse,
} from '../wire';
import { redact, sanitizeForDisplay } from './redact';
import { validateProjectRoot } from './project-root';
import type { ToolHandlerExtra } from './tools';

const POLL_MS = 3000;
const MAX_POLLS = 100;
const RUNNING = new Set(['queued', 'fetching', 'scanning']);

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');

export async function handleDoctorScan(
  ctx: Ctx,
  extra: ToolHandlerExtra,
  projectRoot: string,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  // Validate project root
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

  // Device token check: Doctor needs a signed-in device
  const token = (await ctx.keychain()).get();
  if (!token) {
    return {
      content: [
        {
          type: 'text',
          text: redact(`Nothing uploaded. ${messages.doctorLogin}`),
        },
      ],
      isError: true,
    };
  }

  // Check if client can elicit
  if (!extra.canElicit?.() || !extra.elicit) {
    return {
      content: [
        {
          type: 'text',
          text: redact(
            `Elicitation is unavailable. Nothing was uploaded. To run Doctor, run this command in your terminal:\n\narnesa doctor`,
          ),
        },
      ],
    };
  }

  // Select doctor files from project root
  const selection = selectDoctorFiles(projectRoot);
  const { files, bytes, skipped } = selection;

  if (files.length === 0) {
    return {
      content: [{ type: 'text', text: redact(messages.doctorNoFiles) }],
    };
  }

  if (files.length > DOCTOR_CAPS.maxFiles || bytes > DOCTOR_CAPS.maxTotalBytes) {
    return {
      content: [{ type: 'text', text: redact(messages.doctorTooBig(files.length, bytes)) }],
      isError: true,
    };
  }

  // Elicitation: must name project root and every file with sha256
  const msgLines: string[] = [
    `Project root: ${projectRoot}`,
    `Doctor scan will upload ${files.length} agent configuration file(s) (${bytes} bytes):`,
    'Files to upload:',
  ];
  for (const f of files) {
    const hash = sha256(Buffer.from(f.content, 'utf8'));
    msgLines.push(`  ${f.path} (sha256: ${hash})`);
  }
  if (skipped.length > 0) {
    msgLines.push('Skipped files:');
    for (const s of skipped) {
      msgLines.push(`  ${s.path} (${s.reason})`);
    }
  }
  msgLines.push('', 'Upload these files to scan for issues?');

  let uploadPrompt: string;
  try {
    uploadPrompt = sanitizeForDisplay(msgLines.join('\n'), 4000);
  } catch {
    return {
      content: [
        {
          type: 'text',
          text: redact('too many files to list in full; run `arnesa doctor` in a terminal'),
        },
      ],
      isError: true,
    };
  }
  const accepted = await extra.elicit(uploadPrompt);
  if (!accepted) {
    return {
      content: [
        {
          type: 'text',
          text: redact(
            `Doctor upload declined. Nothing was uploaded. To run Doctor in your terminal:\n\narnesa doctor`,
          ),
        },
      ],
    };
  }

  const client = ctx.client();
  const targetOrigin = extra?.appOrigin ?? client.origin;

  let started;
  try {
    started = await client.request('POST', '/api/v1/local/doctor', {
      token,
      body: { files },
      schema: DoctorStartResponseSchema,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: redact(message) }],
      isError: true,
    };
  }

  const sleep = ctx.io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let detail: DoctorStatusResponse | null = null;

  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_MS);
    try {
      detail = await client.request(
        'GET',
        `/api/v1/local/doctor/${encodeURIComponent(started.id)}`,
        {
          token,
          schema: DoctorStatusResponseSchema,
        },
      );
      if (!RUNNING.has(detail.status)) {
        break;
      }
    } catch (pollError) {
      const message = pollError instanceof Error ? pollError.message : String(pollError);
      return {
        content: [{ type: 'text', text: redact(message) }],
        isError: true,
      };
    }
  }

  if (!detail || RUNNING.has(detail.status)) {
    return {
      content: [{ type: 'text', text: redact(messages.doctorStillRunning(started.reportUrl)) }],
      isError: true,
    };
  }

  // Compact report: counts, levels, web link, completeness, no excerpts, within 4,000 characters
  const webLink = `${targetOrigin.replace(/\/+$/, '')}/doctor/${encodeURIComponent(started.id)}`;
  const reportLines: string[] = [
    messages.doctorDone(
      detail.status,
      detail.counts.critical,
      detail.counts.warning,
      detail.counts.info,
    ),
  ];

  if (detail.findings && detail.findings.length > 0) {
    reportLines.push(messages.doctorGroups);
    for (const g of detail.findings) {
      const first = g.files[0];
      reportLines.push(
        messages.doctorGroupLine(
          g.severity,
          g.ruleId,
          g.count,
          g.files.length + (g.moreFiles ?? 0),
          first ?? '(no file)',
        ),
      );
    }
  }

  const c = detail.completeness;
  if (c && !c.isComplete) {
    const total = (c.fullyInspected ?? 0) + (c.partiallyInspected ?? 0) + (c.uninspected ?? 0);
    reportLines.push(
      messages.doctorScanPartial(
        c.fullyInspected ?? 0,
        c.partiallyInspected ?? 0,
        c.uninspected ?? 0,
        total,
      ),
    );
    if (c.coveragePercent !== null) {
      reportLines.push(messages.doctorCoverage(c.coveragePercent));
    }
  }

  reportLines.push('', `Report link: ${webLink}`);

  const reportText = reportLines.join('\n');
  return {
    content: [{ type: 'text', text: redact(sanitizeForDisplay(reportText, 4000)) }],
  };
}
