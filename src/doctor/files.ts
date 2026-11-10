import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listProjectFiles } from '../profile/walk';

/** The limits the server enforces again: 200 files, 256 KiB each, 1 MiB in all. */
export const DOCTOR_CAPS = { maxFiles: 200, maxFileBytes: 256 * 1024, maxTotalBytes: 1024 * 1024 };

const BINARY_EXTENSIONS = new Set(
  (
    '.zip .tar .gz .tgz .bz2 .tbz2 .xz .txz .7z .rar .zst .exe .bin .dll .so .dylib .wasm .png ' +
    '.jpg .jpeg .gif .webp .ico .bmp .tiff .tif .svgz .pdf .pyc .pyo .pyd .class .jar .war .o ' +
    '.obj .node .iso .dmg .mp3 .mp4 .wav .ogg .mov .avi .mkv .flac .aac .doc .docx .xls .xlsx ' +
    '.ppt .pptx .ttf .otf .woff .woff2 .eot .db .sqlite .sqlite3 .parquet .arrow'
  ).split(' '),
);

/** Names that hold credentials: never uploaded, even inside an allowed directory. */
const DENIED_NAME =
  /^(\.env(\..*)?|\.netrc|\.npmrc|auth\.json|settings\.local\.json|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx)|.*credentials.*|.*secret.*)$/i;

/**
 * The Doctor allow-list, equal to the spec's (R0-19 review R1-16). These two constants are
 * the test-checked copy of `DOCTOR_DIRECTORIES` and `DOCTOR_FILES` in
 * `packages/scanner/src/predicates.ts`: the contract tests on both sides assert the copies
 * are equal, so a one-sided change fails.
 */
export const DOCTOR_DIRECTORIES = [
  '.claude/',
  '.codex/',
  '.opencode/',
  '.agents/',
  '.cursor/',
  '.gemini/',
  '.github/instructions/',
  '.github/prompts/',
  '.github/agents/',
  '.github/skills/',
  '.github/hooks/',
] as const;

export const DOCTOR_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  '.mcp.json',
  'opencode.json',
  'opencode.jsonc',
  '.github/copilot-instructions.md',
  '.github/mcp.json',
  '.github/lsp.json',
] as const;

function isBinary(path: string): boolean {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf('.');
  return (
    (dot !== -1 && BINARY_EXTENSIONS.has(lower.slice(dot))) ||
    lower.endsWith('.tar.gz') ||
    lower.endsWith('.tar.bz2') ||
    lower.endsWith('.tar.xz')
  );
}

/**
 * The agent configuration files Doctor reads: exactly the spec's Doctor allow-list, minus
 * credential files (the DENIED_NAME filter). `test/contract.test.ts` keeps these constants
 * equal to the server's copy in `packages/scanner/src/predicates.ts`.
 */
export function isDoctorFile(path: string): boolean {
  if (path.length === 0 || path.length > 240) return false;
  if (
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    /^[A-Za-z]:/.test(path)
  ) {
    return false;
  }
  const segments = path.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..' || s.toLowerCase() === '.git')) {
    return false;
  }
  const name = path.split('/').at(-1) ?? '';
  if (DENIED_NAME.test(name) || isBinary(path)) return false;
  if ((DOCTOR_FILES as readonly string[]).includes(path)) return true;
  return DOCTOR_DIRECTORIES.some((d) => path.startsWith(d));
}

export interface DoctorSelection {
  files: Array<{ path: string; content: string }>;
  bytes: number;
  /** Files that matched but were left out, with the reason. */
  skipped: Array<{ path: string; reason: string }>;
}

/**
 * Normalises the optional path argument of `arnesa doctor <directory>` with the
 * same segment rules `isDoctorFile` enforces (no absolute path, no backslash, no
 * NUL, no drive letter, no `.`/`..`/`.git` segment). Null when unusable.
 */
export function normalizeDoctorSubPath(raw: string): string | null {
  const p = raw.replace(/\\/g, '/');
  if (p.length === 0 || p.length > 240) return null;
  if (p.startsWith('/') || p.includes('\0') || /^[A-Za-z]:/.test(p)) return null;
  const segments = p.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..' || s.toLowerCase() === '.git')) {
    return null;
  }
  return p;
}

/** Matching files per first-level directory, largest first: the over-cap refusal names them. */
export function countsByFirstDirectory(
  paths: readonly string[],
): Array<{ dir: string; count: number }> {
  const counts = new Map<string, number>();
  for (const p of paths) {
    const dir = p.includes('/') ? p.split('/')[0]! : '(project root)';
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([dir, count]) => ({ dir, count }))
    .sort((a, b) => b.count - a.count || a.dir.localeCompare(b.dir));
}

/** Reads the matching files as text. A symlink, a large file or non-text content is skipped and said so. */
export function selectDoctorFiles(root: string, subPath?: string): DoctorSelection {
  const prefix = subPath === undefined ? null : `${subPath}/`;
  const files: DoctorSelection['files'] = [];
  const skipped: DoctorSelection['skipped'] = [];
  let bytes = 0;
  for (const path of listProjectFiles(root)) {
    if (!isDoctorFile(path)) continue;
    // The optional path argument narrows the selection; the allow-list still applies first.
    if (prefix !== null && !path.startsWith(prefix)) continue;
    const full = join(root, path);
    const info = lstatSync(full);
    if (!info.isFile()) {
      skipped.push({ path, reason: 'not a regular file' });
      continue;
    }
    const buffer = readFileSync(full);
    if (buffer.includes(0)) {
      skipped.push({ path, reason: 'not text' });
      continue;
    }
    // Review R1-16: measure the bytes exactly as the server does — Buffer.byteLength of
    // the decoded string — so both sides refuse the same file for the same size.
    const content = buffer.toString('utf8');
    const size = Buffer.byteLength(content);
    if (size > DOCTOR_CAPS.maxFileBytes) {
      skipped.push({ path, reason: 'larger than 256 KiB' });
      continue;
    }
    files.push({ path, content });
    bytes += size;
  }
  return { files, bytes, skipped };
}
