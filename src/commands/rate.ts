import { EXIT } from '../exit';
import { ApiError } from '../http';
import { LockError, readLock } from '../install/lock';
import { redact } from '../mcp/redact';
import { messages } from '../messages';
import { detectProfile, ProfileInputError } from '../profile';
import type { Ctx } from '../types';
import { RatingResponseSchema, SettingsResponseSchema } from '../wire';

/**
 * `arnesa rate pass|fail [<harness>]`: records a self-rating for a harness installed in this project.
 *
 * The rating is sent ONLY for a signed-in device token (not an `ak_` key, not anonymous).
 * When there is no device token, it prints a one-line notice and exits 0 with zero HTTP requests.
 */
export async function runRate(_args: readonly string[], ctx: Ctx): Promise<number> {
  const { io } = ctx;

  const outcome = ctx.args[0];
  if (outcome !== 'pass' && outcome !== 'fail') {
    io.err(messages.rateUsage);
    return EXIT.usage;
  }

  // The rating is sent ONLY for a signed-in device token (not an `ak_` key, not anonymous).
  const envKey = io.env.ARNESA_API_KEY?.trim();
  const stored = (await ctx.keychain()).get();
  const isDevice = !envKey && Boolean(stored && stored.startsWith('ad_'));
  if (!isDevice) {
    ctx.emit({ sent: false, reason: 'unauthenticated' }, [messages.rateNeedsDevice]);
    return EXIT.ok;
  }
  const token = stored as string;

  if (ctx.args.length > 2) {
    io.err(messages.rateUsage);
    return EXIT.usage;
  }

  let lock;
  try {
    lock = readLock(io.cwd);
  } catch (error) {
    if (error instanceof LockError) {
      throw new ApiError(error.message, EXIT.failure, 'LOCK_INVALID');
    }
    throw error;
  }

  const harnessArg = ctx.args[1];
  let harness: string;
  let version: string | undefined;
  let recordRuntime: string | undefined;

  if (harnessArg) {
    const [slug = '', ver] = harnessArg.split('@');
    harness = slug;
    version = ver;
    const record = lock?.installs[harness];
    if (record) {
      version ??= record.harness.version;
      recordRuntime = record.runtime;
    }
  } else {
    const installs = lock ? Object.values(lock.installs) : [];
    const defaultInstall = installs[installs.length - 1];
    if (!defaultInstall) {
      io.err(messages.rateNoHarness);
      return EXIT.usage;
    }
    harness = defaultInstall.harness.slug;
    version = defaultInstall.harness.version;
    recordRuntime = defaultInstall.runtime;
  }

  if (!version) {
    io.err(messages.rateHarnessNotInstalled(harness));
    return EXIT.usage;
  }

  const model = ctx.options.model ?? io.env.ARNESA_MODEL ?? null;
  if (!model) {
    io.err(messages.rateModelNeeded);
    return EXIT.usage;
  }

  const runtime = ctx.options.runtime ?? recordRuntime ?? detectProfile(io.cwd, {}).runtime;
  if (!runtime || runtime === 'unknown') {
    io.err(messages.runtimeNeeded);
    return EXIT.usage;
  }

  try {
    detectProfile(io.cwd, { runtime, model });
  } catch (error) {
    if (error instanceof ProfileInputError) {
      io.err(error.message);
      return EXIT.usage;
    }
    throw error;
  }

  const http = ctx.client();
  let settings;
  try {
    settings = await http.request('GET', '/api/v1/local/settings', {
      token,
      schema: SettingsResponseSchema,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const redacted = redact(message);
    io.err(`Rating was not sent: could not read account settings (${redacted})`);
    return EXIT.failure;
  }

  if (!settings.metadataSharing) {
    ctx.emit({ sent: false, reason: 'sharing_off' }, [
      'Rating was not sent because metadata sharing is off.',
    ]);
    return EXIT.ok;
  }

  const payload = {
    harness,
    version,
    model,
    runtime,
    outcome,
  };

  try {
    const data = await ctx.client().request('POST', '/api/v1/local/ratings', {
      token,
      body: payload,
      schema: RatingResponseSchema,
    });
    ctx.emit({ recorded: true, outcome: data.outcome }, [
      messages.rateRecorded(data.outcome, harness),
    ]);
    return EXIT.ok;
  } catch (error) {
    if (error instanceof ApiError) {
      throw new ApiError(redact(error.message), error.exitCode, error.code, redact(error.details));
    }
    throw error;
  }
}
