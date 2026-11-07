import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalJson } from '../profile';
import type { WireItem } from '../wire';
import { INSTALL_CAPS, caseDuplicates, destinationProblem, mayBeExecutable } from './paths';

export class UnsafeWriteError extends Error {
  constructor(
    message: string,
    readonly problems: readonly { path: string; reason: string }[] = [],
  ) {
    super(message);
    this.name = 'UnsafeWriteError';
  }
}

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');

/** The bytes a `create` item writes. */
export const createBytes = (item: Extract<WireItem, { mode: 'create' }>): Buffer =>
  Buffer.from(item.content, item.encoding === 'base64' ? 'base64' : 'utf8');

/** The size an item counts for against the caps, and the digest its `sha256` must equal. */
function measure(item: WireItem): { bytes: number; digest: string } {
  if (item.mode === 'create') {
    const data = createBytes(item);
    return { bytes: data.byteLength, digest: sha256(data) };
  }
  if (item.mode === 'block') {
    return { bytes: Buffer.byteLength(item.text), digest: sha256(item.text) };
  }
  const json = canonicalJson({ key: item.key, value: item.value });
  return { bytes: Buffer.byteLength(json), digest: sha256(json) };
}

/**
 * Checks a server response without touching the disk: allow-list and path rules, case duplicates,
 * the caps and every `sha256`. Returns every problem found; an install writes nothing unless the
 * list is empty.
 */
export function responseProblems(items: readonly WireItem[]): { path: string; reason: string }[] {
  const problems: { path: string; reason: string }[] = [];
  if (items.length > INSTALL_CAPS.maxFiles) {
    problems.push({ path: '(response)', reason: `more than ${INSTALL_CAPS.maxFiles} files` });
  }
  let total = 0;
  for (const item of items) {
    const reason = destinationProblem(item.path);
    if (reason) problems.push({ path: item.path, reason });
    const { bytes, digest } = measure(item);
    total += bytes;
    if (bytes > INSTALL_CAPS.maxFileBytes)
      problems.push({ path: item.path, reason: 'file too large' });
    if (digest !== item.sha256) problems.push({ path: item.path, reason: 'sha256 mismatch' });
    if (item.mode === 'create' && item.executable && !mayBeExecutable(item.path)) {
      problems.push({ path: item.path, reason: 'executable outside hooks/ and scripts/' });
    }
  }
  if (total > INSTALL_CAPS.maxTotalBytes) {
    problems.push({ path: '(response)', reason: 'total size too large' });
  }
  for (const path of caseDuplicates(items.map((i) => i.path))) {
    problems.push({ path, reason: 'case-insensitive duplicate' });
  }
  return problems;
}

/**
 * The first symlink among a path's existing ancestors and the target itself, or a file standing
 * where a directory is needed. Run again right before each write, not only when planning.
 */
export function diskProblem(root: string, relPath: string): string | null {
  const parts = relPath.split('/');
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i] as string);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      return null; // nothing exists from here on, so nothing can be a link
    }
    if (stat.isSymbolicLink()) return 'symlink';
    if (i < parts.length - 1 && !stat.isDirectory()) return 'a file where a directory is needed';
    if (i === parts.length - 1 && stat.isDirectory()) return 'a directory where a file is needed';
  }
  return null;
}

export function newInstallId(): string {
  return randomBytes(6).toString('hex');
}

/** Writes one file atomically: a temporary file in the same directory, then a rename. */
function atomicWrite(path: string, bytes: Uint8Array, mode: number): void {
  const temp = join(dirname(path), `.${randomBytes(4).toString('hex')}.arnesa-tmp`);
  const fd = openSync(temp, 'wx', mode);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temp, { force: true });
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(temp, path);
    chmodSync(path, mode);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

interface Journal {
  path: string;
  /** Path of the saved original under `.arnesa/backups`, or null when the file did not exist. */
  backup: string | null;
}

/**
 * One install's writes. Every file is checked for links, its original is copied to
 * `.arnesa/backups/<installId>/` before it is replaced, and `rollback` puts the project back as it
 * was: restores the originals, deletes what was created and the directories created for it.
 */
export class WriteTransaction {
  private readonly journal: Journal[] = [];
  private readonly createdDirs: string[] = [];

  constructor(
    readonly root: string,
    readonly installId: string,
  ) {}

  /** Writes `bytes` to `relPath` (already validated); returns the backup path when an original existed. */
  write(relPath: string, bytes: Uint8Array, executable = false): string | null {
    const reason = destinationProblem(relPath) ?? diskProblem(this.root, relPath);
    if (reason)
      throw new UnsafeWriteError(`Refused ${relPath}: ${reason}`, [{ path: relPath, reason }]);

    const full = join(this.root, relPath);
    this.makeDirs(dirname(full));

    let backup: string | null = null;
    if (existsSync(full)) {
      backup = `.arnesa/backups/${this.installId}/${relPath}`;
      const backupFull = join(this.root, backup);
      this.makeDirs(dirname(backupFull));
      copyFileSync(full, backupFull);
    }
    this.journal.push({ path: relPath, backup });
    atomicWrite(full, bytes, executable && mayBeExecutable(relPath) ? 0o755 : 0o644);
    return backup;
  }

  /** Undoes every write, newest first. Never throws: it reports what it could not restore. */
  rollback(): string[] {
    const failed: string[] = [];
    for (const entry of this.journal.reverse()) {
      try {
        const full = join(this.root, entry.path);
        if (entry.backup) {
          copyFileSync(join(this.root, entry.backup), full);
          rmSync(join(this.root, entry.backup), { force: true });
        } else rmSync(full, { force: true });
      } catch {
        failed.push(entry.path);
      }
    }
    for (const dir of this.createdDirs.reverse()) {
      try {
        rmdirSync(dir); // fails when not empty, which is the point
      } catch {
        // keep a directory that holds something
      }
    }
    this.journal.length = 0;
    this.createdDirs.length = 0;
    return failed;
  }

  /** Deletes a file after saving it, so `rollback` can bring it back. */
  remove(relPath: string): void {
    const reason = destinationProblem(relPath) ?? diskProblem(this.root, relPath);
    if (reason)
      throw new UnsafeWriteError(`Refused ${relPath}: ${reason}`, [{ path: relPath, reason }]);
    const full = join(this.root, relPath);
    if (!existsSync(full)) return;
    const backup = `.arnesa/backups/${this.installId}/${relPath}`;
    this.makeDirs(dirname(join(this.root, backup)));
    copyFileSync(full, join(this.root, backup));
    this.journal.push({ path: relPath, backup });
    rmSync(full);
  }

  /** Files this transaction wrote, with the backup made for each. */
  written(): readonly Journal[] {
    return this.journal;
  }

  /** Directories this transaction created, in creation order. */
  createdDirectories(): string[] {
    return this.createdDirs.map((d) => d.slice(this.root.length + 1).replaceAll('\\', '/'));
  }

  private makeDirs(dir: string): void {
    const missing: string[] = [];
    for (let d = dir; d.length > this.root.length && !existsSync(d); d = dirname(d))
      missing.push(d);
    for (const d of missing.reverse()) {
      mkdirSync(d);
      this.createdDirs.push(d);
    }
  }
}

export const readIfExists = (root: string, relPath: string): Buffer | null => {
  try {
    return readFileSync(join(root, relPath));
  } catch {
    return null;
  }
};

export interface PendingWrite {
  path: string;
  bytes: Uint8Array;
  executable?: boolean;
}

/**
 * Writes all or nothing: every path is checked first (allow-list, links, case duplicates), then the
 * files are written in order, and a failure part-way restores the project and rethrows.
 */
export function commitWrites(
  root: string,
  installId: string,
  writes: readonly PendingWrite[],
): WriteTransaction {
  const problems: { path: string; reason: string }[] = [];
  for (const w of writes) {
    const reason = destinationProblem(w.path) ?? diskProblem(root, w.path);
    if (reason) problems.push({ path: w.path, reason });
  }
  for (const path of caseDuplicates(writes.map((w) => w.path))) {
    problems.push({ path, reason: 'case-insensitive duplicate' });
  }
  if (problems.length > 0) throw new UnsafeWriteError('Refused unsafe destinations.', problems);

  const tx = new WriteTransaction(root, installId);
  try {
    for (const w of writes) tx.write(w.path, w.bytes, w.executable);
  } catch (error) {
    tx.rollback();
    throw error;
  }
  return tx;
}
