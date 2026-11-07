/** Every user-facing string of the CLI. The CLI speaks English; a locale can replace this table later. */
export const messages = {
  usage: [
    'Usage: arnesa <command> [options]',
    '',
    'Commands:',
    '  detect      Print the project profile that recommend would send (sends nothing)',
    '  recommend   Suggest installable harnesses for this project (asks before sending)',
    '  install <harness>[@version] --runtime <id>   Install a harness into this project',
    '  remove <harness>   Undo one install exactly, using arnesa.lock',
    '  doctor      Scan the agent configuration files of this project (asks before uploading)',
    '  login       Sign in with your browser (stores a token in the OS keychain)',
    '  logout      Remove the stored token from the OS keychain',
    '  config telemetry [on|off]   Show or change metadata sharing for your account',
    '',
    'Options:',
    '  --json      Print one JSON document on standard output and nothing else there',
    '  --api <url> API base URL (env override: $ARNESA_API_URL)',
    '  --yes       Confirm the files of an install without asking',
    '  --allow <id>   Also confirm one command that starts a process (repeatable)',
    '  --help      Show this help',
    '  --version   Show the version',
  ],
  unknownCommand: (name: string) => `Unknown command: ${name}. Run "arnesa --help".`,
  unknownOption: (detail: string) => `${detail} Run "arnesa --help".`,
  noCommand: 'No command given. Run "arnesa --help".',
  badApiUrl: 'The API URL must be an http(s) URL.',
  apiMissing:
    'No API URL is set. Say it with --api <url> or the environment variable ARNESA_API_URL.',
  confirmationRequired: 'Confirmation is required and there is no terminal. Re-run with --yes.',
  network: (reason: string) => `Could not reach Arnesa: ${reason}`,
  timeout: 'The request to Arnesa timed out.',
  tooLarge: 'The response from Arnesa is larger than this client accepts.',
  badResponse: 'The response from Arnesa is not in the expected shape.',
  httpFailure: (status: number) => `Arnesa answered with status ${status}.`,
  rateLimited: (seconds: number | null) =>
    seconds === null
      ? 'Too many requests. Try again later.'
      : `Too many requests. Try again in ${seconds} seconds.`,
  noKeychain: (origin: string) =>
    `No OS keychain is available, so nothing was stored. Create a key at ${origin}/me and set ARNESA_API_KEY in your shell.`,
  loginPrompt: (uri: string, code: string) => `Open ${uri} and enter the code ${code}`,
  loginLink: (uri: string) => `Or open this link: ${uri}`,
  loggedIn: 'Signed in. The token is stored in your OS keychain.',
  loggedOut: 'Signed out on this machine. Revoke the device at /me to invalidate the token.',
  loginDenied: 'The sign-in was denied.',
  loginExpired: 'The sign-in code expired. Run "arnesa login" again.',
  notLoggedIn: 'Not signed in. Run "arnesa login" or set ARNESA_API_KEY.',
  configUsage: 'Usage: arnesa config telemetry [on|off]',
  telemetryState: (on: boolean) => `Metadata sharing is ${on ? 'on' : 'off'}.`,
  consent: [
    '',
    'Share anonymous install metadata?',
    'When you install a harness while signed in, Arnesa counts it. These fields are sent:',
    '  - the harness',
    '  - the model',
    '  - the runtime',
    '  - the result you give it yourself',
    '  - an error code, if the install fails',
    'Your source code, prompts and file paths are never sent. The count carries no user id.',
    'Change it any time: arnesa config telemetry off',
  ],
  consentQuestion: 'Share it?',
  previewIntro: 'This profile is what will be sent. Nothing else leaves this machine:',
  recommendQuestion: 'Send this profile to Arnesa?',
  notConfirmed: 'Not sent.',
  noResults: 'No installable harness matches this project yet.',
  notBenchmarked: 'not benchmarked',
  benchmarked: (model: string, rate: number, low: number, high: number, n: number, epoch: number) =>
    `Verified on ${model}: pass rate ${pct(rate)} (interval ${pct(low)} to ${pct(high)}, n=${n}, epoch ${epoch})`,
  installUsage: 'Usage: arnesa install <harness>[@version] [--runtime <id>] [--yes] [--allow <id>]',
  runtimeNeeded: 'Could not tell which runtime this project uses. Say it with --runtime <id>.',
  alreadyInstalled: (slug: string, version: string) =>
    `${slug} ${version} is already installed here. Run "arnesa remove ${slug}" first.`,
  wrongHarness:
    'The answer is for a different harness than the one asked for. Nothing was written.',
  versionUnavailable: (wanted: string, have: string) =>
    `Only the current version (${have}) can be installed, not ${wanted}.`,
  scanMismatch: 'The scan result is for different content than the files. Nothing was written.',
  manifestMismatch: 'The file list does not match its checksum. Nothing was written.',
  unsafeResponse: 'The files from the server failed the safety checks. Nothing was written.',
  newerRuntime: (runtime: string, have: string, verified: string) =>
    `Your ${runtime} (${have}) is newer than the version this layout was checked against (${verified}). The files may need adjusting.`,
  installHeader: (name: string, version: string, runtime: string) =>
    `Install ${name} ${version} for ${runtime}:`,
  gatesIntro: 'These commands start a process. They are written only if you confirm each one:',
  nothingToChange: 'Nothing to change: every file is already in place.',
  installQuestion: 'Write these files?',
  allowCommand: (id: string) => `Allow the command ${id} to be installed?`,
  commandSkipped: (id: string) => `Skipped ${id}. Re-run with --allow ${id} to install it.`,
  installed: (name: string, count: number) => `Installed ${name}: ${count} file(s) written.`,
  someSkipped: (count: number) => `${count} item(s) were skipped; see the plan above.`,
  removeUsage: 'Usage: arnesa remove <harness> [--yes]',
  notInstalled: (slug: string) => `${slug} is not installed in this project.`,
  editedIntro: 'These files changed since the install:',
  removeEditedQuestion: 'Remove them anyway?',
  removed: (slug: string) => `Removed ${slug}.`,
  eventFailed: 'Could not update your Arnesa account list. The install itself is complete.',
  doctorNoFiles: 'No agent configuration files were found in this project.',
  doctorTooBig: (count: number, bytes: number) =>
    `Found ${count} files (${bytes} bytes). Doctor takes at most 200 files and 1 MiB.`,
  doctorIntro: (count: number, bytes: number) =>
    `These ${count} files (${bytes} bytes) would be uploaded. They are kept for at most one hour and the report is private:`,
  doctorQuestion: 'Upload these files?',
  doctorLogin: 'Doctor needs a signed-in device. Run "arnesa login" first.',
  doctorQueued: (url: string) => `Scan started. Report: ${url}`,
  doctorDone: (status: string, critical: number, warning: number, info: number) =>
    `Scan ${status}: ${critical} critical, ${warning} warning, ${info} info.`,
  doctorStillRunning: (url: string) => `The scan is still running. Check the report later: ${url}`,
} as const;

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}
