import type { FetchLike, HttpClient } from './http';
import type { Keychain } from './keychain';

/** The terminal the CLI runs against (review R1-14: moved here, detect imports it from this file). */
export interface CommandIo {
  cwd: string;
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  /** The CLI version, sent with the profile so links carry it. */
  version?: string;
}

export interface CliIo extends CommandIo {
  /** True when standard input and error are a terminal: the only case where a prompt may appear. */
  isTty: boolean;
  fetch?: FetchLike;
  version: string;
  /** Opens the credential store for one API origin (the OS keychain in production). */
  openKeychain: (origin: string) => Promise<Keychain>;
  /** The installed version of a runtime, or null; replaced in tests. */
  runtimeVersion?: (runtime: string) => Promise<string | null>;
  /** Waits between device-login polls; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface Ctx {
  io: CliIo;
  json: boolean;
  yes: boolean;
  /** Values of the options shared by profile commands. */
  options: { runtime?: string; model?: string; markdown?: boolean };
  /** Command ids the user named with `--allow`. */
  allow: readonly string[];
  /** Positional arguments after the command name. */
  args: readonly string[];
  client(): HttpClient;
  keychain(): Promise<Keychain>;
  /** Standard output: one JSON document in `--json` mode, the given lines otherwise. */
  emit(data: unknown, lines: readonly string[]): void;
}
