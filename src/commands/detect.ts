import { EXIT } from '../exit';
import { detectProfile, profileRequest, ProfileInputError } from '../profile';
import type { Ctx } from '../types';

// The io shape lives in types.ts (review R1-14: importing it from here made a cycle).
export type { CommandIo } from '../types';

/**
 * `arnesa detect`: prints the exact body `recommend` would send, and sends nothing.
 * Only file names and manifest files are read; no network is used. Options come from
 * the shared parse (`ctx.options`), so `--runtime=codex` and `--runtime codex` are the
 * same (review R1-14): the spec says `detect` prints exactly what `recommend` sends.
 */
export function runDetect(_args: readonly string[], ctx: Ctx): number {
  const { io } = ctx;
  const model = ctx.options.model ?? io.env.ARNESA_MODEL ?? null;
  try {
    io.out(
      profileRequest(detectProfile(io.cwd, { runtime: ctx.options.runtime, model }), io.version),
    );
    return EXIT.ok;
  } catch (error) {
    if (error instanceof ProfileInputError) {
      io.err(error.message);
      return EXIT.usage;
    }
    throw error;
  }
}
