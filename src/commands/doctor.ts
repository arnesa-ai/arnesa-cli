import { statSync } from 'node:fs';
import { join } from 'node:path';
import {
  countsByFirstDirectory,
  DOCTOR_CAPS,
  normalizeDoctorSubPath,
  selectDoctorFiles,
} from '../doctor/files';
import { EXIT } from '../exit';
import { ApiError } from '../http';
import { messages } from '../messages';
import { confirm } from '../prompt';
import type { Ctx } from '../types';
import {
  DoctorStartResponseSchema,
  DoctorStatusResponseSchema,
  type DoctorStatusResponse,
} from '../wire';
import { z } from 'zod';

const POLL_MS = 3000;
const MAX_POLLS = 100;
const RUNNING = new Set(['queued', 'fetching', 'scanning']);
const MARKDOWN_TEXT = z.string();

/**
 * `arnesa doctor [directory]`: lists the agent configuration files it would send (optionally
 * only those under a directory), uploads them only after a yes, then waits for the scan and
 * prints the counts, the findings grouped by rule and the completeness detail. `--json` adds
 * the grouped findings and completeness to the one document (never excerpts); `--markdown`
 * prints the "Copy for your agent" handoff instead. It needs a signed-in device (`arnesa
 * login`); an API key does not open Doctor.
 */
export async function runDoctor(_args: readonly string[], ctx: Ctx): Promise<number> {
  const { io } = ctx;

  // The optional path argument narrows the selection to one directory of the project.
  // Positionals only (`ctx.args`): a value of `--api` or another flag is never a path.
  const rawPath = ctx.args[0];
  let subPath: string | undefined;
  if (rawPath !== undefined) {
    const normalized = normalizeDoctorSubPath(rawPath);
    let isDirectory = false;
    if (normalized !== null) {
      try {
        isDirectory = statSync(join(io.cwd, normalized)).isDirectory();
      } catch {
        isDirectory = false;
      }
    }
    if (normalized === null || !isDirectory) {
      throw new ApiError(messages.doctorBadPath(rawPath), EXIT.usage, 'USAGE');
    }
    subPath = normalized;
  }

  const selection = selectDoctorFiles(io.cwd, subPath);
  const { files, bytes, skipped } = selection;

  if (files.length === 0) {
    ctx.emit({ uploaded: false, reason: 'no files' }, [messages.doctorNoFiles]);
    return EXIT.ok;
  }
  if (files.length > DOCTOR_CAPS.maxFiles || bytes > DOCTOR_CAPS.maxTotalBytes) {
    // A dead end is not a refusal: name where the matching files live and how to narrow.
    for (const line of [
      messages.doctorTooBig(files.length, bytes),
      messages.doctorTooBigIntro,
      ...countsByFirstDirectory(files.map((f) => f.path))
        .slice(0, 20)
        .map((c) => messages.doctorTooBigDirLine(c.dir, c.count)),
      messages.doctorTooBigHint,
    ]) {
      io.err(line);
    }
    throw new ApiError(messages.doctorTooBig(files.length, bytes), EXIT.failure, 'TOO_LARGE');
  }

  io.err(messages.doctorIntro(files.length, bytes));
  for (const f of files) io.err(`  ${f.path}`);
  for (const s of skipped) io.err(`  skipped ${s.path}: ${s.reason}`);

  if (!ctx.yes) {
    const answer = await confirm(messages.doctorQuestion, io.isTty);
    if (answer === null) {
      throw new ApiError(messages.confirmationRequired, EXIT.confirmation, 'CONFIRMATION_REQUIRED');
    }
    if (!answer) throw new ApiError(messages.notConfirmed, EXIT.confirmation, 'NOT_CONFIRMED');
  }

  // Only a device token opens Doctor; the environment key is deliberately not used here.
  const token = (await ctx.keychain()).get();
  if (!token) throw new ApiError(messages.doctorLogin, EXIT.failure, 'UNAUTHENTICATED');

  const http = ctx.client();
  const started = await http.request('POST', '/api/v1/local/doctor', {
    token,
    body: { files },
    schema: DoctorStartResponseSchema,
  });
  io.err(messages.doctorQueued(started.reportUrl));

  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_MS);
    // The status answer carries the grouped findings and completeness once the scan
    // ends; an older server answers without them and the command prints what it has.
    const detail = await pollStatus(http, token, started.id);
    if (RUNNING.has(detail.status)) continue;

    if (ctx.options.markdown && !ctx.json) {
      const markdown = await http.request(
        'GET',
        `/api/v1/local/doctor/${encodeURIComponent(started.id)}?format=markdown`,
        { token, schema: MARKDOWN_TEXT, text: true },
      );
      for (const line of markdown.split('\n')) io.out(line);
      return EXIT.ok;
    }

    ctx.emit({ uploaded: true, ...detail }, [
      messages.doctorDone(
        detail.status,
        detail.counts.critical,
        detail.counts.warning,
        detail.counts.info,
      ),
      ...plainDetailLines(detail),
      detail.reportUrl,
    ]);
    return EXIT.ok;
  }
  throw new ApiError(messages.doctorStillRunning(started.reportUrl), EXIT.failure, 'TIMEOUT');
}

function pollStatus(
  http: ReturnType<Ctx['client']>,
  token: string,
  id: string,
): Promise<DoctorStatusResponse> {
  return http.request('GET', `/api/v1/local/doctor/${encodeURIComponent(id)}`, {
    token,
    schema: DoctorStatusResponseSchema,
  });
}

/** The grouped findings and the completeness detail as plain lines (English; the CLI's only language). */
function plainDetailLines(detail: DoctorStatusResponse): string[] {
  const lines: string[] = [];
  const groups = detail.findings ?? [];
  if (groups.length > 0) {
    lines.push(messages.doctorGroups);
    for (const g of groups) {
      const first = g.files[0];
      lines.push(
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
    lines.push(
      messages.doctorScanPartial(
        c.fullyInspected ?? 0,
        c.partiallyInspected ?? 0,
        c.uninspected ?? 0,
        total,
      ),
    );
    if (c.coveragePercent !== null) lines.push(messages.doctorCoverage(c.coveragePercent));
    if (c.exceptions.length > 0) {
      lines.push(messages.doctorPartiallyRead);
      for (const e of c.exceptions)
        lines.push(messages.doctorPartiallyReadLine(e.path, e.reasonCode));
    }
  }
  return lines;
}
