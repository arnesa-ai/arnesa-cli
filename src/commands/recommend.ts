import { EXIT } from '../exit';
import { ApiError } from '../http';
import { messages } from '../messages';
import { detectProfile, profileRequest, ProfileInputError } from '../profile';
import { confirm } from '../prompt';
import type { Ctx } from '../types';
import { RecommendResponseSchema } from '../wire';
import { credential } from './auth';

/**
 * `arnesa recommend`: shows the exact request body, sends it only after a yes (terminal prompt or
 * `--yes`), and lists at most five harnesses. Without a terminal and without `--yes` it exits 3
 * having made no network request.
 */
export async function runRecommend(_args: readonly string[], ctx: Ctx): Promise<number> {
  const { io } = ctx;
  const model = ctx.options.model ?? io.env.ARNESA_MODEL ?? null;

  let body: string;
  try {
    body = profileRequest(
      detectProfile(io.cwd, { runtime: ctx.options.runtime, model }),
      io.version,
    );
  } catch (error) {
    if (error instanceof ProfileInputError) throw new ApiError(error.message, EXIT.usage, 'USAGE');
    throw error;
  }

  io.err(messages.previewIntro);
  io.err(body);
  if (!ctx.yes) {
    const answer = await confirm(messages.recommendQuestion, io.isTty);
    if (answer === null) {
      throw new ApiError(
        messages.confirmationRequired,
        EXIT.confirmation,
        'CONFIRMATION_REQUIRED',
        {
          request: JSON.parse(body),
        },
      );
    }
    if (!answer) throw new ApiError(messages.notConfirmed, EXIT.confirmation, 'NOT_CONFIRMED');
  }

  const data = await ctx.client().request('POST', '/api/v1/local/recommend', {
    token: await credential(ctx),
    body: JSON.parse(body),
    schema: RecommendResponseSchema,
  });

  const lines: string[] = data.results.length === 0 ? [messages.noResults] : [];
  for (const r of data.results) {
    lines.push('', `${r.name} (${r.slug})`);
    if (r.summary) lines.push(`  ${r.summary}`);
    lines.push(
      `  scan: ${r.scanLevel}  licence: ${r.license ?? 'none declared'}`,
      r.bench
        ? `  ${messages.benchmarked(r.bench.model, r.bench.passRate, r.bench.wilsonLow, r.bench.wilsonHigh, r.bench.n, r.bench.epoch)}`
        : `  ${messages.notBenchmarked}`,
      `  ${r.links.harness}`,
    );
    if (r.links.replay) lines.push(`  replay:  ${r.links.replay}`);
    if (r.links.compare) lines.push(`  compare: ${r.links.compare}`);
    lines.push(`  install: arnesa install ${r.slug}`);
  }
  ctx.emit(data, lines);
  return EXIT.ok;
}
