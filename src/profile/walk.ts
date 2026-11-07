import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveOnPath } from '../install/which';

/** Bounds of the file walk (design decision 3). */
export const WALK_LIMITS = { maxEntries: 50_000, maxDepth: 12, maxManifestBytes: 1024 * 1024 };

const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'target',
  '.venv',
  'vendor',
]);

function skipped(path: string): boolean {
  return path.split('/').some((segment) => SKIPPED_DIRECTORIES.has(segment));
}

function fromGit(root: string): string[] | null {
  const git = resolveOnPath('git', process.env, root);
  if (!git) return null;
  try {
    const out = execFileSync(
      git,
      ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    ).toString('utf8');
    return out.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

function boundedWalk(root: string): string[] {
  const found: string[] = [];
  const visit = (relative: string, depth: number) => {
    if (depth > WALK_LIMITS.maxDepth || found.length >= WALK_LIMITS.maxEntries) return;
    const names = readdirSync(join(root, relative)).sort();
    for (const name of names) {
      if (found.length >= WALK_LIMITS.maxEntries) return;
      const path = relative ? `${relative}/${name}` : name;
      const info = lstatSync(join(root, path));
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(name)) visit(path, depth + 1);
      } else if (info.isFile()) {
        found.push(path);
      }
    }
  };
  visit('', 0);
  return found;
}

/**
 * Project files as sorted, unique, slash-separated relative paths. `git ls-files` when it works,
 * otherwise a bounded walk that follows no symlink. Sorting makes the result independent of the
 * order the file system or git listed them in.
 */
export function listProjectFiles(root: string): string[] {
  const listed = fromGit(root) ?? boundedWalk(root);
  const clean = [...new Set(listed.map((p) => p.replaceAll('\\', '/')))]
    .filter((p) => !skipped(p) && p.split('/').length <= WALK_LIMITS.maxDepth + 1)
    .sort();
  return clean.slice(0, WALK_LIMITS.maxEntries);
}

/** Reads a manifest-sized regular file; a symlink, a directory or a large file gives null. */
export function readSmallFile(root: string, relative: string): string | null {
  try {
    const full = join(root, relative);
    const info = lstatSync(full);
    if (!info.isFile() || info.size > WALK_LIMITS.maxManifestBytes) return null;
    return readFileSync(full, 'utf8');
  } catch {
    return null;
  }
}
