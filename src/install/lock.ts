import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { AddedSchema } from './merge';

export const LOCK_FILE = 'arnesa.lock';

const Common = {
  path: z.string(),
  /** The saved original under `.arnesa/backups/<installId>/`, or null when the file did not exist. */
  backup: z.string().nullable(),
  /** The file did not exist before the install, so removing the install may delete it. */
  createdFile: z.boolean(),
};

export const FileRecordSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    ...Common,
    mode: z.literal('create'),
    sha256: z.string(),
    executable: z.boolean(),
  }),
  z.strictObject({
    ...Common,
    mode: z.literal('block'),
    blockId: z.string(),
    /** sha256 of the block text as installed. */
    sha256: z.string(),
    prefix: z.string(),
  }),
  z.strictObject({
    ...Common,
    mode: z.literal('merge-json'),
    key: z.string(),
    added: z.array(AddedSchema),
    createdContainers: z.array(z.array(z.string())),
  }),
]);
export type FileRecord = z.infer<typeof FileRecordSchema>;

export const InstallRecordSchema = z.strictObject({
  installId: z.string(),
  harness: z.strictObject({
    slug: z.string(),
    name: z.string(),
    version: z.string(),
    commit: z.string(),
    contentHash: z.string(),
    license: z.string().nullable(),
    sourceUrl: z.string(),
    author: z.string(),
  }),
  runtime: z.string(),
  adapterVersion: z.number(),
  manifestHash: z.string(),
  files: z.array(FileRecordSchema),
  /** Directories the install created, in creation order; removal deletes them when empty. */
  createdDirs: z.array(z.string()),
  /** Ids of the commands the user confirmed. */
  commands: z.array(z.string()),
});
export type InstallRecord = z.infer<typeof InstallRecordSchema>;

export const LockSchema = z.strictObject({
  version: z.literal(1),
  /** Random, not derived from a path; names this project in a setup event. */
  projectId: z.string().regex(/^[0-9a-f]{32}$/),
  installs: z.record(z.string(), InstallRecordSchema),
});
export type Lock = z.infer<typeof LockSchema>;

export class LockError extends Error {}

/** A path that stays inside the project: relative, no dot segments, no backslash, no NUL, no .git. */
function insideProject(path: string): boolean {
  if (path.length === 0 || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false;
  if (path.includes('\\') || path.includes('\0')) return false;
  return path
    .split('/')
    .every((s) => s !== '' && s !== '.' && s !== '..' && s.toLowerCase() !== '.git');
}

/** The lock is a file in the project, so a cloned repository can ship a crafted one: trust no path in it. */
export function lockProblem(lock: Lock): string | null {
  for (const [name, install] of Object.entries(lock.installs)) {
    if (!/^[0-9a-f]{12}$/.test(install.installId)) return `${name}: bad install id`;
    const backups = `.arnesa/backups/${install.installId}/`;
    for (const file of install.files) {
      if (!insideProject(file.path)) return `${name}: unsafe path ${file.path}`;
      if (
        file.backup !== null &&
        !(file.backup.startsWith(backups) && insideProject(file.backup))
      ) {
        return `${name}: unsafe backup path for ${file.path}`;
      }
    }
    for (const dir of install.createdDirs) {
      if (!insideProject(dir)) return `${name}: unsafe directory ${dir}`;
    }
  }
  return null;
}

export function readLock(root: string): Lock | null {
  const path = join(root, LOCK_FILE);
  if (!existsSync(path)) return null;
  try {
    const lock = LockSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    const problem = lockProblem(lock);
    if (problem) throw new LockError(problem);
    return lock;
  } catch (error) {
    if (error instanceof LockError) {
      throw new LockError(
        `${LOCK_FILE} refused: ${error.message}. Fix or delete it, then try again.`,
      );
    }
    throw new LockError(`${LOCK_FILE} is not a valid lock file. Fix or delete it, then try again.`);
  }
}

export const newLock = (): Lock => ({
  version: 1,
  projectId: randomBytes(16).toString('hex'),
  installs: {},
});

/** Keys sorted, no timestamps: the same installs always give the same bytes. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, stable(v)]),
    );
  }
  return value;
}

export function writeLock(root: string, lock: Lock): void {
  const path = join(root, LOCK_FILE);
  const temp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(stable(LockSchema.parse(lock)), null, 2)}\n`);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
