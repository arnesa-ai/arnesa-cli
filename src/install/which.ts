import { statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

/**
 * The absolute path of a binary found on PATH only. On Windows a bare name is also searched in the
 * current directory first, and the current directory is the project, which may be hostile (a
 * `git.exe` or `claude.cmd` planted in a cloned repository). Relative PATH entries, an empty entry
 * and the project directory itself are skipped, so only the user's own installation can run.
 */
export function resolveOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  platform: NodeJS.Platform = process.platform,
): string | null {
  const windows = platform === 'win32';
  const entries = (env.PATH ?? env.Path ?? '').split(delimiter);
  const extensions = windows
    ? ['.exe', '.cmd', '.bat'].filter((e) =>
        (env.PATHEXT ?? '.EXE;.CMD;.BAT').toLowerCase().includes(e),
      )
    : [''];
  const here = resolve(cwd).toLowerCase();
  for (const entry of entries) {
    if (!entry || !isAbsolute(entry)) continue;
    if (resolve(entry).toLowerCase() === here) continue;
    for (const extension of extensions) {
      const candidate = join(entry, name + extension);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

/** True for a Windows shim that only a command shell can start. */
export function needsShell(path: string): boolean {
  return /\.(cmd|bat)$/i.test(path);
}
