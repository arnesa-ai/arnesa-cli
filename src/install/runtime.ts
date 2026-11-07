import { execFile } from 'node:child_process';
import { needsShell, resolveOnPath } from './which';

/** The command that prints each runtime's version; only runtimes with a known binary are checked. */
const BINARIES: Record<string, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  opencode: 'opencode',
  gemini: 'gemini',
};

/** The installed version of a runtime, or null when it is not installed or cannot be read. */
export function installedVersion(runtime: string): Promise<string | null> {
  const bin = BINARIES[runtime];
  if (!bin) return Promise.resolve(null);
  // PATH only, never the project directory: a planted binary in a cloned repository must not run.
  const path = resolveOnPath(bin);
  if (!path) return Promise.resolve(null);
  const shell = needsShell(path);
  return new Promise((resolve) => {
    execFile(
      shell ? `"${path}"` : path,
      ['--version'],
      { timeout: 3000, windowsHide: true, shell },
      (error, stdout) =>
        resolve(error ? null : (/\d+\.\d+\.\d+/.exec(String(stdout))?.[0] ?? null)),
    );
  });
}

const parts = (v: string) => v.split('.').map((n) => Number.parseInt(n, 10));

/** True when `installed` is a later version than `verified` (both `x.y.z`). */
export function isNewer(installed: string, verified: string): boolean {
  const a = parts(installed);
  const b = parts(verified);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}
