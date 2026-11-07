/**
 * Where an install may write. The server's compile engine carries the same list; a parity test
 * (`test/contract.test.ts`) keeps them equal. A trailing `/` is a directory prefix, anything else
 * is one file. `.github/workflows` and `package.json` are not on it, so they can never be written.
 */
export const ALLOWED_DESTINATIONS = [
  '.claude/',
  '.codex/',
  '.opencode/',
  '.agents/',
  '.cursor/',
  '.gemini/',
  '.arnesa/',
  '.github/skills/',
  '.github/instructions/',
  '.github/prompts/',
  '.github/agents/',
  '.github/hooks/',
  '.github/copilot-instructions.md',
  '.github/mcp.json',
  '.github/lsp.json',
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  '.mcp.json',
  'opencode.json',
  'opencode.jsonc',
] as const;

export const INSTALL_CAPS = {
  maxFiles: 200,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 2 * 1024 * 1024,
} as const;

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

const hasControlChar = (s: string): boolean => [...s].some((ch) => ch.charCodeAt(0) < 32);

/** Why a destination path is refused, or null when it may be written. */
export function destinationProblem(path: string): string | null {
  if (path.length === 0 || path.length > 240) return 'length';
  if (
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes('\0') ||
    /^[A-Za-z]:/.test(path)
  ) {
    return 'not relative';
  }
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') return 'dot or empty segment';
    if (segment.toLowerCase() === '.git') return '.git segment';
    if (WINDOWS_RESERVED.test(segment)) return 'reserved name';
    if (/[. ]$/.test(segment)) return 'trailing dot or space';
    if (/[<>:"|?*]/.test(segment) || hasControlChar(segment)) return 'forbidden character';
  }
  const allowed = ALLOWED_DESTINATIONS.some((entry) =>
    entry.endsWith('/') ? path.startsWith(entry) : path === entry,
  );
  return allowed ? null : 'outside the allow-list';
}

/** Two spellings that differ only by case name one file on a case-insensitive disk. */
export function caseDuplicates(paths: readonly string[]): string[] {
  const byLower = new Map<string, Set<string>>();
  for (const p of paths) {
    const key = p.toLowerCase();
    byLower.set(key, (byLower.get(key) ?? new Set()).add(p));
  }
  return [...byLower.values()].filter((set) => set.size > 1).flatMap((set) => [...set]);
}

/** The executable bit is honoured only for files under a `hooks/` or `scripts/` directory. */
export const mayBeExecutable = (path: string): boolean => /(^|\/)(hooks|scripts)\//.test(path);
