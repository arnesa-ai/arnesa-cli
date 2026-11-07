import { hostname } from 'node:os';
import { z } from 'zod';
import type { Ctx } from '../types';
import { EXIT } from '../exit';
import { ApiError } from '../http';
import { messages } from '../messages';
import { confirm, readSecretLine } from '../prompt';
import {
  DeviceCodeResponseSchema,
  DeviceTokenResponseSchema,
  SettingsResponseSchema,
  type DeviceTokenResponse,
} from '../wire';
import type { Keychain } from '../keychain';

/** Bumped when the list of fields on the consent screen changes. */
export const CONSENT_VERSION = 1;

/**
 * Strings of this command that `messages.ts` does not carry yet (that file belongs to another
 * change in this round); they move there when the two files can be touched together.
 */
const keychainWriteFailed = (reason: string) =>
  `The sign-in succeeded, but the credential could not be stored in the OS keychain: ${reason}. Run "arnesa login" again.`;
const keyStored =
  'The Arnesa key is stored in your OS keychain. It opens recommend, compile and install; sign in with "arnesa login" for Doctor and settings.';
const keyUsage =
  'The key must be "ak_" followed by 43 letters, digits, "-" or "_". Nothing was stored. Paste a key from your Arnesa /me page and run "arnesa login --key" again.';

/** The credential in use: an environment key wins over the keychain; never printed. */
export async function credential(ctx: Ctx): Promise<string | null> {
  return ctx.io.env.ARNESA_API_KEY?.trim() || (await ctx.keychain()).get();
}

async function saveSharing(ctx: Ctx, token: string, metadataSharing: boolean) {
  return ctx.client().request('PUT', '/api/v1/local/settings', {
    token,
    body: { metadataSharing, consentVersion: CONSENT_VERSION },
    schema: SettingsResponseSchema,
  });
}

/** Shown once per account: the fields that leave this machine, and the way to turn them off. */
async function consentScreen(ctx: Ctx, token: string): Promise<boolean> {
  const settings = await ctx.client().request('GET', '/api/v1/local/settings', {
    token,
    schema: SettingsResponseSchema,
  });
  if (settings.decided) return false;
  for (const line of messages.consent) ctx.io.err(line);
  // Sharing is on by default (D20, D44): Enter alone keeps it on, shown as [Y/n]. Without a
  // terminal the answer is `null`: nothing is recorded and the screen is shown again at the next
  // login that can answer, so a missing answer is never saved as consent.
  const answer = await confirm(messages.consentQuestion, ctx.io.isTty, true);
  if (answer === null) return true;
  await saveSharing(ctx, token, answer);
  return true;
}

const sleepOf = (ctx: Ctx) =>
  ctx.io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

/** Stores the credential, or reports the failure of the store by name; the value is never printed. */
function storeOrFail(keychain: Keychain, value: string): void {
  try {
    keychain.set(value);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    throw new ApiError(keychainWriteFailed(reason), EXIT.failure, 'KEYCHAIN_WRITE_FAILED');
  }
}

/** The three-digit status an `HTTP_ERROR` names in its message, when it carries one. */
const statusOf = (error: ApiError): number | null => {
  const match = /status (\d{3})/.exec(error.message);
  return match ? Number(match[1]) : null;
};

/** A failure a later poll may still survive: a network error, a timeout, a 5xx or `server_error`. */
function isTransient(error: ApiError): boolean {
  if (error.code === 'NETWORK' || error.code === 'TIMEOUT' || error.code === 'server_error') {
    return true;
  }
  const status = statusOf(error);
  return error.code === 'HTTP_ERROR' && status !== null && status >= 500;
}

/** A 429, whatever shape the raw RFC 8628 endpoint answered in. */
function isRateLimited(error: ApiError): boolean {
  if (error.code === 'RATE_LIMITED') return true;
  return error.code === 'HTTP_ERROR' && statusOf(error) === 429;
}

/** `arnesa login --key`: reads an API key from standard input and stores it, for scripting use. */
async function storeApiKey(ctx: Ctx): Promise<number> {
  const keychain = await ctx.keychain();
  if (!keychain.available) {
    throw new ApiError(messages.noKeychain(ctx.client().origin), EXIT.failure, 'NO_KEYCHAIN');
  }
  const key = await readSecretLine();
  if (!/^ak_[A-Za-z0-9_-]{43}$/.test(key)) {
    ctx.io.err(keyUsage);
    return EXIT.usage;
  }
  storeOrFail(keychain, key);
  ctx.emit({ keyStored: true }, [keyStored]);
  return EXIT.ok;
}

export async function runLogin(args: readonly string[], ctx: Ctx): Promise<number> {
  // `--key` stores an API key instead of signing a person in with a device token (R1-17, option A).
  if (args.includes('--key')) return storeApiKey(ctx);
  const { io } = ctx;
  const http = ctx.client();
  const keychain = await ctx.keychain();
  // Checked first so a code is not spent on a login that could not be saved.
  if (!keychain.available) {
    throw new ApiError(messages.noKeychain(http.origin), EXIT.failure, 'NO_KEYCHAIN');
  }

  const start = await http.request('POST', '/api/v1/device/code', {
    body: { deviceLabel: hostname().slice(0, 80), cliVersion: io.version },
    schema: DeviceCodeResponseSchema,
  });
  io.err(messages.loginPrompt(start.verificationUri, start.userCode));
  io.err(messages.loginLink(start.verificationUriComplete));

  let interval = start.interval;
  let waited = 0;
  const sleep = sleepOf(ctx);
  for (;;) {
    await sleep(interval * 1000);
    waited += interval;
    let token: DeviceTokenResponse;
    try {
      token = await http.request('POST', '/api/v1/device/token', {
        raw: true,
        body: { deviceCode: start.deviceCode },
        schema: DeviceTokenResponseSchema,
      });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.code === 'authorization_pending') {
        // keep waiting
      } else if (error.code === 'slow_down') {
        const next = z.object({ interval: z.number().nullable() }).safeParse(error.details);
        interval = next.success && next.data.interval ? next.data.interval : interval + 5;
      } else if (error.code === 'access_denied') {
        throw new ApiError(messages.loginDenied, EXIT.refused, 'access_denied');
      } else if (isRateLimited(error)) {
        throw new ApiError(error.message, EXIT.rateLimited, 'RATE_LIMITED', error.details);
      } else if (isTransient(error)) {
        // A network error, a timeout or a 5xx: the next poll may still succeed before expiry.
      } else {
        throw new ApiError(messages.loginExpired, EXIT.failure, error.code);
      }
      if (waited >= start.expiresIn)
        throw new ApiError(messages.loginExpired, EXIT.failure, 'expired_token');
      continue;
    }
    // Storage and consent sit outside the poll `try`: a failure here is not "the login expired".
    storeOrFail(keychain, token.accessToken);
    const shown = await consentScreen(ctx, token.accessToken);
    ctx.emit({ loggedIn: true, consentShown: shown }, [messages.loggedIn]);
    return EXIT.ok;
  }
}

export async function runLogout(_args: readonly string[], ctx: Ctx): Promise<number> {
  (await ctx.keychain()).delete();
  ctx.emit({ loggedOut: true }, [messages.loggedOut]);
  return EXIT.ok;
}

/** `arnesa config telemetry [on|off]`: shows or changes metadata sharing on the account. */
export async function runConfig(_args: readonly string[], ctx: Ctx): Promise<number> {
  const [topic, value, ...extra] = ctx.args;
  if (
    topic !== 'telemetry' ||
    extra.length > 0 ||
    (value !== undefined && value !== 'on' && value !== 'off')
  ) {
    ctx.io.err(messages.configUsage);
    return EXIT.usage;
  }
  // Settings take a device token only (AC-46.3); the environment key is deliberately not used here.
  const token = (await ctx.keychain()).get();
  if (!token) {
    throw new ApiError(messages.notLoggedIn, EXIT.failure, 'UNAUTHENTICATED');
  }
  const settings =
    value === undefined
      ? await ctx
          .client()
          .request('GET', '/api/v1/local/settings', { token, schema: SettingsResponseSchema })
      : await saveSharing(ctx, token, value === 'on');
  ctx.emit({ metadataSharing: settings.metadataSharing }, [
    messages.telemetryState(settings.metadataSharing),
  ]);
  return EXIT.ok;
}
