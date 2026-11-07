import { existsSync, readdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT } from '../exit';
import { ApiError } from '../http';
import { unifiedDiff } from '../install/diff';
import { LockError, readLock, writeLock, type FileRecord } from '../install/lock';
import { removeBlock, unmergeJson } from '../install/merge';
import { newInstallId, readIfExists, WriteTransaction } from '../install/safe-write';
import { messages } from '../messages';
import { reportSetup } from './events';
import { confirm } from '../prompt';
import type { Ctx } from '../types';
import { createHash } from 'node:crypto';

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');

/**
 * `arnesa remove <harness>`: undoes exactly one install from `arnesa.lock`. A file that no longer
 * matches what the install wrote is shown as a diff and touched only after a yes. A JSON file that
 * is no longer plain JSON (a comment was added, say) cannot be undone at all: it is shown in the
 * preview, and after a yes it is left untouched and its lock entry is kept for a later remove.
 */
export async function runRemove(_args: readonly string[], ctx: Ctx): Promise<number> {
  const { io } = ctx;
  const slug = ctx.args[0];
  if (!slug || ctx.args.length > 1) throw new ApiError(messages.removeUsage, EXIT.usage, 'USAGE');

  let lock;
  try {
    lock = readLock(io.cwd);
  } catch (error) {
    if (error instanceof LockError) throw new ApiError(error.message, EXIT.failure, 'LOCK_INVALID');
    throw error;
  }
  const record = lock?.installs[slug];
  if (!lock || !record)
    throw new ApiError(messages.notInstalled(slug), EXIT.failure, 'NOT_INSTALLED');

  const installedCopy = (path: string) =>
    readIfExists(io.cwd, `.arnesa/backups/${record.installId}/installed/${path}`)?.toString(
      'utf8',
    ) ?? '';
  const textOf = (path: string) => readIfExists(io.cwd, path);

  // Pass 1: find what was edited since the install, without touching anything.
  const edited: { path: string; diff: string[] }[] = [];
  /** Files that are no longer plain JSON: nothing of them can be undone; keys the install added. */
  const stuck = new Map<string, string[]>();
  for (const f of record.files) {
    const now = textOf(f.path);
    if (!now) continue;
    const text = now.toString('utf8');
    let changed = false;
    if (f.mode === 'create') changed = sha256(now) !== f.sha256;
    else if (f.mode === 'block') {
      const probe = removeBlock(text, f.blockId, f.prefix, f.sha256);
      changed = !!probe && !probe.intact;
    } else {
      const probe = unmergeJson(text, f.added, f.createdContainers);
      if (!probe) {
        // The file no longer parses as plain JSON, so the merge cannot be taken back. Treat it
        // like an edited file: show it, and on a yes keep the file and its lock entry.
        stuck.set(
          f.path,
          f.added.map((a) => a.path.join('.')),
        );
        changed = true;
      } else changed = probe.modified.length > 0;
    }
    if (changed && !edited.some((e) => e.path === f.path)) {
      edited.push({ path: f.path, diff: unifiedDiff(installedCopy(f.path), text, f.path) });
    }
  }
  if (edited.length > 0) {
    io.err(messages.editedIntro);
    for (const e of edited) for (const line of e.diff) io.err(line);
    if (!ctx.yes) {
      const answer = await confirm(messages.removeEditedQuestion, io.isTty);
      if (answer === null)
        throw new ApiError(
          messages.confirmationRequired,
          EXIT.confirmation,
          'CONFIRMATION_REQUIRED',
        );
      if (!answer) throw new ApiError(messages.notConfirmed, EXIT.confirmation, 'NOT_CONFIRMED');
    }
  }

  // Pass 2: undo, all or nothing.
  const tx = new WriteTransaction(io.cwd, newInstallId());
  const removed: string[] = [];
  try {
    const restored = new Set<string>();
    for (const f of [...record.files].reverse()) {
      if (stuck.has(f.path)) continue; // no longer plain JSON: nothing to undo there
      undo(f, io.cwd, tx, restored);
      removed.push(f.path);
    }
    for (const dir of [...record.createdDirs].reverse()) {
      const full = join(io.cwd, dir);
      if (existsSync(full) && readdirSync(full).length === 0) rmdirSync(full);
    }
    if (stuck.size > 0) {
      // The install is not fully undone, so the lock keeps the entries of the files that can no
      // longer be undone; a later remove can finish the job once the file is plain JSON again.
      record.files = record.files.filter((f) => stuck.has(f.path));
    } else {
      delete lock.installs[slug];
    }
    writeLock(io.cwd, lock);
  } catch (error) {
    tx.rollback();
    throw error;
  }

  await reportSetup(ctx, { kind: 'remove', projectId: lock.projectId, harnessSlug: slug });
  const lines = [messages.removed(slug)];
  for (const [path, keys] of stuck) {
    lines.push(
      `${path} was not changed: it is no longer plain JSON, so what the install added could not be ` +
        `taken back. These keys remain in it: ${keys.join(', ')}. Its lock entry is kept.`,
    );
  }
  ctx.emit(
    {
      removed: stuck.size === 0,
      slug,
      files: [...new Set(removed)],
      ...(stuck.size > 0 ? { kept: [...stuck.keys()] } : {}),
    },
    lines,
  );
  return EXIT.ok;
}

function undo(f: FileRecord, root: string, tx: WriteTransaction, restored: Set<string>): void {
  const current = readIfExists(root, f.path);
  if (!current) return;
  const text = current.toString('utf8');

  if (f.mode === 'create') {
    if (f.backup) {
      if (restored.has(f.path)) return;
      restored.add(f.path);
      const original = readIfExists(root, f.backup);
      if (original) tx.write(f.path, original);
    } else {
      tx.remove(f.path);
    }
    return;
  }

  const next =
    f.mode === 'block'
      ? removeBlock(text, f.blockId, f.prefix, f.sha256)?.text
      : unmergeJson(text, f.added, f.createdContainers)?.text;
  if (next === undefined) return;
  const empty =
    f.mode === 'block'
      ? next === ''
      : (JSON.parse(next) as object) && Object.keys(JSON.parse(next)).length === 0;
  if (f.createdFile && empty) tx.remove(f.path);
  else tx.write(f.path, Buffer.from(next));
}
