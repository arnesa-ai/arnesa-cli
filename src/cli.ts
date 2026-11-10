import { parseArgs } from 'node:util';
import type { CliIo, Ctx } from './types';
import { runDetect } from './commands/detect';
import { runDoctor } from './commands/doctor';
import { runInstall } from './commands/install';
import { runRecommend } from './commands/recommend';
import { runRemove } from './commands/remove';
import { EXIT } from './exit';
import { ApiError, createHttpClient, type HttpClient } from './http';
import { runConfig, runLogin, runLogout } from './commands/auth';
import { runRate } from './commands/rate';
import { runMcp } from './mcp/stdio';
import type { Keychain } from './keychain';
import { commandHelp, messages } from './messages';

/** The default API origin, injected at build time from `ARNESA_PUBLIC_API_URL` (D55: no domain in source). */
declare const __ARNESA_API_URL__: string | undefined;

/** Build-time default; empty when the bundle was made without `ARNESA_PUBLIC_API_URL`. Override with `--api` or `ARNESA_API_URL`. */
export const DEFAULT_API_URL = typeof __ARNESA_API_URL__ === 'string' ? __ARNESA_API_URL__ : '';

type Command = (args: readonly string[], ctx: Ctx) => Promise<number> | number;

const COMMANDS: Record<string, Command> = {
  detect: (_args, ctx) => runDetect(_args, ctx),
  recommend: runRecommend,
  install: runInstall,
  doctor: runDoctor,
  remove: runRemove,
  login: runLogin,
  logout: runLogout,
  config: runConfig,
  mcp: runMcp,
  rate: runRate,
};

/** The command names, exported for the tests that pin the coverage of the per-command help. */
export const COMMAND_NAMES = Object.keys(COMMANDS);

const OPTIONS = {
  json: { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  api: { type: 'string' },
  runtime: { type: 'string' },
  model: { type: 'string' },
  allow: { type: 'string', multiple: true },
  // `arnesa doctor --markdown` prints the "Copy for your agent" handoff.
  markdown: { type: 'boolean' },
  // R1-17 option A: `arnesa login --key` reads the key from standard input.
  key: { type: 'boolean' },
} as const;

/** Escape sequences and other control characters, except newline and tab: text from a server must not rewrite the screen. */
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL = new RegExp('[\u0000-\u0008\u000b-\u001f\u007f-\u009f]', 'g');

/** Runs one invocation; returns the exit code and never throws. */
export async function main(argv: readonly string[], terminal: CliIo): Promise<number> {
  const io: CliIo = {
    ...terminal,
    out: (line) => terminal.out(line.replace(CONTROL, '')),
    err: (line) => terminal.err(line.replace(CONTROL, '')),
  };
  // `--json` must shape errors too, so it is found before the full parse can fail.
  const json = argv.includes('--json');
  const fail = (message: string, code: number, errorCode: string, details?: unknown): number => {
    io.err(message);
    if (json) {
      const error = { code: errorCode, message, ...(details ? { details } : {}) };
      io.out(JSON.stringify({ error }));
    }
    return code;
  };

  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    const detail = error instanceof Error ? (error.message.split('\n')[0] ?? '') : '';
    return fail(messages.unknownOption(detail), EXIT.usage, 'USAGE');
  }

  const { values, positionals } = parsed;
  if (values.version) {
    io.out(io.version);
    return EXIT.ok;
  }
  const name = positionals[0];
  if (values.help) {
    // An unknown command with --help stays a usage error; a known one gets its own help
    // and never runs (so `arnesa logout --help` cannot touch the keychain).
    if (name && !COMMANDS[name]) return fail(messages.unknownCommand(name), EXIT.usage, 'USAGE');
    for (const line of (name ? commandHelp[name] : undefined) ?? messages.usage) io.out(line);
    return EXIT.ok;
  }
  if (!name) {
    for (const line of messages.usage) io.err(line);
    return fail(messages.noCommand, EXIT.usage, 'USAGE');
  }
  const command = COMMANDS[name];
  if (!command) return fail(messages.unknownCommand(name), EXIT.usage, 'USAGE');

  let client: HttpClient | null = null;
  let keychainPromise: Promise<Keychain> | null = null;
  const ctx: Ctx = {
    io,
    json,
    yes: values.yes === true,
    options: { runtime: values.runtime, model: values.model, markdown: values.markdown === true },
    allow: values.allow ?? [],
    args: positionals.slice(1),
    keychain: () => (keychainPromise ??= io.openKeychain(ctx.client().origin)),
    client() {
      const baseUrl = values.api ?? io.env.ARNESA_API_URL ?? DEFAULT_API_URL;
      if (baseUrl === '') throw new ApiError(messages.apiMissing, EXIT.usage, 'USAGE');
      client ??= createHttpClient({ baseUrl, fetch: io.fetch });
      return client;
    },
    emit(data, lines) {
      if (json) io.out(JSON.stringify(data));
      else for (const line of lines) io.out(line);
    },
  };

  // The command sees its own arguments only; the global flags were parsed above.
  const own = argv.filter((a) => a !== '--json' && a !== name);
  try {
    return await command(own, ctx);
  } catch (error) {
    if (error instanceof ApiError)
      return fail(error.message, error.exitCode, error.code, error.details);
    return fail('Unexpected error.', EXIT.failure, 'INTERNAL');
  }
}

export type { CliIo, Ctx };
