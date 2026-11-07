import { EXIT } from '../exit';
import { ApiError } from '../http';
import { diskProblem, commitWrites, newInstallId, responseProblems } from '../install/safe-write';
import {
  LockError,
  newLock,
  readLock,
  writeLock,
  type FileRecord,
  type InstallRecord,
} from '../install/lock';
import { buildPlan, manifestHashOf, type Plan } from '../install/plan';
import { isNewer } from '../install/runtime';
import { messages } from '../messages';
import { detectProfile } from '../profile';
import { confirm } from '../prompt';
import type { Ctx } from '../types';
import { withClientGates } from '../install/launch';
import { CompileRequestSchema, CompileResponseSchema, type CompileResponse } from '../wire';
import { credential } from './auth';
import { reportSetup } from './events';

const COMPILE_TIMEOUT_MS = 60_000;

/** A link to Studio is printed only when it points at the server the CLI is talking to. */
function studioLink(details: unknown, origin: string): string | null {
  const url = (details as { studioUrl?: unknown } | null)?.studioUrl;
  if (typeof url !== 'string') return null;
  try {
    return new URL(url).origin === origin ? url : null;
  } catch {
    return null;
  }
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

function planLines(plan: Plan, response: CompileResponse): string[] {
  const lines = [
    messages.installHeader(response.harness.name, response.harness.version, response.runtime),
  ];
  for (const p of plan.items) {
    const where = p.item.path + (p.item.mode === 'create' ? '' : ` (${p.item.mode})`);
    lines.push(`  ${p.action.padEnd(9)} ${where}${p.note ? `  - ${p.note}` : ''}`);
  }
  for (const file of plan.files) {
    if (file.diff.length > 0) lines.push('', ...file.diff);
  }
  const gates = gatesOf(response);
  if (gates.size > 0) {
    lines.push('', messages.gatesIntro);
    for (const [id, gate] of gates) {
      lines.push(`  ${id}  (${gate.path})`, ...gate.commands.map((c) => `      ${c}`));
    }
  }
  for (const n of response.notices) {
    lines.push(`  not installed: ${n.kind}${n.component ? ` ${n.component}` : ''}: ${n.message}`);
  }
  return lines;
}

/**
 * `arnesa install <harness>[@version] --runtime <id>`: asks the server for the files, checks every
 * part of the answer, shows the plan, and writes only what the user confirmed, all or nothing.
 */
export async function runInstall(_args: readonly string[], ctx: Ctx): Promise<number> {
  const { io } = ctx;
  const spec = ctx.args[0];
  if (!spec || ctx.args.length > 1) throw new ApiError(messages.installUsage, EXIT.usage, 'USAGE');
  const [slug = '', wanted] = spec.split('@');
  const request = CompileRequestSchema.safeParse({ slug, runtime: 'x' });
  if (!request.success) throw new ApiError(messages.installUsage, EXIT.usage, 'USAGE');

  const runtime = ctx.options.runtime ?? detectProfile(io.cwd, {}).runtime;
  if (runtime === 'unknown') throw new ApiError(messages.runtimeNeeded, EXIT.usage, 'USAGE');

  let lock;
  try {
    lock = readLock(io.cwd);
  } catch (error) {
    if (error instanceof LockError) throw new ApiError(error.message, EXIT.failure, 'LOCK_INVALID');
    throw error;
  }
  const already = lock?.installs[slug];
  if (already)
    throw new ApiError(
      messages.alreadyInstalled(slug, already.harness.version),
      EXIT.failure,
      'ALREADY_INSTALLED',
    );

  const http = ctx.client();
  let response: CompileResponse;
  try {
    response = await http.request('POST', '/api/v1/local/compile', {
      token: await credential(ctx),
      body: { slug, runtime, cliVersion: io.version },
      schema: CompileResponseSchema,
      timeoutMs: COMPILE_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof ApiError && error.code === 'PAID_HARNESS') {
      const link = studioLink(error.details, http.origin);
      throw new ApiError(
        link ? `${error.message} ${link}` : error.message,
        EXIT.refused,
        error.code,
        error.details,
      );
    }
    throw error;
  }

  // The answer is untrusted: it must be the harness asked for, scanned for the hash it names, and
  // every file must pass the path, size and digest checks before anything is shown or written.
  const refuse = (message: string, code: string, details?: unknown) => {
    throw new ApiError(message, EXIT.refused, code, details);
  };
  if (response.harness.slug !== slug) refuse(messages.wrongHarness, 'UNSAFE_RESPONSE');
  if (wanted && wanted !== response.harness.version) {
    refuse(messages.versionUnavailable(wanted, response.harness.version), 'VERSION_UNAVAILABLE');
  }
  if (response.scan.contentHash.toLowerCase() !== response.harness.contentHash.toLowerCase()) {
    refuse(messages.scanMismatch, 'HASH_MISMATCH');
  }
  if (manifestHashOf(response) !== response.manifestHash)
    refuse(messages.manifestMismatch, 'HASH_MISMATCH');
  const problems = [
    ...responseProblems(response.files),
    ...response.files.flatMap((f) => {
      const reason = diskProblem(io.cwd, f.path);
      return reason ? [{ path: f.path, reason }] : [];
    }),
  ];
  if (problems.length > 0) {
    for (const p of problems) io.err(`  refused ${p.path}: ${p.reason}`);
    refuse(messages.unsafeResponse, 'UNSAFE_RESPONSE', { problems });
  }

  if (response.verifiedVersion && io.runtimeVersion) {
    const have = await io.runtimeVersion(response.runtime);
    if (have && isNewer(have, response.verifiedVersion)) {
      io.err(messages.newerRuntime(response.runtime, have, response.verifiedVersion));
    }
  }

  // The server's gate labels are not trusted to be complete: the client gates what launches a process.
  response = { ...response, files: withClientGates(response.files) };
  const gates = gatesOf(response);
  const preview = buildPlan(
    io.cwd,
    response.harness,
    response.files,
    'preview',
    new Set(gates.keys()),
  );
  for (const line of planLines(preview, response)) io.err(line);

  if (preview.files.length === 0) {
    ctx.emit({ installed: false, reason: 'nothing to change' }, [messages.nothingToChange]);
    return EXIT.ok;
  }

  // Level 1: the files. Level 2: each command that starts a process, by name.
  if (!ctx.yes) {
    const answer = await confirm(messages.installQuestion, io.isTty);
    if (answer === null)
      throw new ApiError(messages.confirmationRequired, EXIT.confirmation, 'CONFIRMATION_REQUIRED');
    if (!answer) throw new ApiError(messages.notConfirmed, EXIT.confirmation, 'NOT_CONFIRMED');
  }
  const allowed = new Set<string>();
  for (const id of gates.keys()) {
    if (ctx.allow.includes(id)) allowed.add(id);
    else if (io.isTty && (await confirm(messages.allowCommand(id), true))) allowed.add(id);
    else io.err(messages.commandSkipped(id));
  }

  const installId = newInstallId();
  const plan = buildPlan(io.cwd, response.harness, response.files, installId, allowed);
  const writes = plan.files.flatMap((f) => [
    { path: f.path, bytes: f.final, executable: f.executable },
    // The installed bytes, so `remove` can show what changed since.
    { path: `.arnesa/backups/${installId}/installed/${f.path}`, bytes: f.final },
  ]);

  const tx = commitWrites(io.cwd, installId, writes);
  let projectId = '';
  try {
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
    projectId = next.projectId;
    next.installs[slug] = record;
    writeLock(io.cwd, next);
  } catch (error) {
    tx.rollback();
    throw error;
  }

  await reportSetup(ctx, {
    kind: 'install',
    projectId,
    harnessSlug: slug,
    versionLabel: response.harness.version,
    runtime: response.runtime,
  });
  const written = plan.files.map((f) => f.path);
  const skipped = plan.items
    .filter((p) => p.action === 'skipped' || p.action === 'conflict')
    .map((p) => ({ path: p.item.path, reason: p.note }));
  ctx.emit(
    {
      installed: true,
      slug,
      version: response.harness.version,
      runtime: response.runtime,
      written,
      skipped,
      notices: response.notices,
    },
    [
      messages.installed(response.harness.name, written.length),
      ...(skipped.length ? [messages.someSkipped(skipped.length)] : []),
    ],
  );
  return EXIT.ok;
}
