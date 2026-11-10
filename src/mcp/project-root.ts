import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, parse, resolve } from 'node:path';

/** Recognised project markers from the detect code and standard project manifests. */
export const PROJECT_MARKERS = [
  '.git',
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'setup.py',
  'uv.lock',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Gemfile',
  'composer.json',
  'deno.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
] as const;

/** Checks whether the directory is the user's home directory. */
export function isHomeDir(
  dir: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const candidates: string[] = [];
  if (env.HOME) candidates.push(env.HOME);
  if (env.USERPROFILE) candidates.push(env.USERPROFILE);
  try {
    const home = homedir();
    if (home) candidates.push(home);
  } catch {
    // homedir might throw in restricted environments
  }
  const resolved = resolve(dir);
  return candidates.some((c) => {
    const rc = resolve(c);
    return process.platform === 'win32'
      ? resolved.toLowerCase() === rc.toLowerCase()
      : resolved === rc;
  });
}

/** Checks whether the directory is a filesystem or drive root. */
export function isDriveOrFsRoot(
  dir: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.ARNESA_MOCK_DRIVE_ROOT === '1' || env.ARNESA_MOCK_DRIVE_ROOT === 'true') {
    return true;
  }
  const resolved = resolve(dir);
  const parsed = parse(resolved);
  return (
    parsed.root.toLowerCase() === resolved.toLowerCase() ||
    resolved === '/' ||
    /^[a-zA-Z]:[\\/]?$/.test(resolved)
  );
}

/** Checks whether the directory contains a .git entry or a recognised project manifest. */
export function hasProjectMarker(root: string): boolean {
  for (const marker of PROJECT_MARKERS) {
    try {
      if (existsSync(join(root, marker))) {
        return true;
      }
    } catch {
      // Ignore file system errors
    }
  }
  return false;
}

export type RootRefusalReason = 'home' | 'root' | 'no-marker';

export interface ProjectRootResult {
  valid: boolean;
  root: string;
  reason?: RootRefusalReason;
  message?: string;
}

/** Validates the project root at start according to AC-39.1. */
export function validateProjectRoot(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): ProjectRootResult {
  const resolved = resolve(cwd);

  if (isHomeDir(resolved, env)) {
    return {
      valid: false,
      root: resolved,
      reason: 'home',
      message:
        'Refusing to start MCP server in home directory. Start the server inside the project.',
    };
  }

  if (isDriveOrFsRoot(resolved, env)) {
    return {
      valid: false,
      root: resolved,
      reason: 'root',
      message:
        'Refusing to start MCP server in filesystem root. Start the server inside the project.',
    };
  }

  if (!hasProjectMarker(resolved)) {
    return {
      valid: false,
      root: resolved,
      reason: 'no-marker',
      message:
        'Refusing to start MCP server: no .git or recognised manifest found. Start the server inside the project.',
    };
  }

  return {
    valid: true,
    root: resolved,
  };
}
