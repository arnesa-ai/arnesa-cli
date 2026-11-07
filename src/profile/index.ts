import { buildProfile, type ProjectProfile } from './profile';
import { listProjectFiles, readSmallFile } from './walk';

export * from './profile';
export * from './vocabulary';
export { WALK_LIMITS } from './walk';

/** Profiles the project at `root` from file names and manifest files only. */
export function detectProfile(
  root: string,
  options: { runtime?: string | null; model?: string | null } = {},
): ProjectProfile {
  return buildProfile({
    files: listProjectFiles(root),
    read: (path) => readSmallFile(root, path),
    runtime: options.runtime,
    model: options.model,
  });
}
