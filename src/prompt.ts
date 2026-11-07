import { createInterface } from 'node:readline/promises';
import { stdin, stderr } from 'node:process';

/**
 * Asks a yes/no question on the terminal. Without a terminal it never prompts and answers `null`,
 * so the caller exits with "confirmation required" instead of hanging or assuming yes. An empty
 * answer takes `defaultValue`, shown as `[Y/n]` or `[y/N]`: the consent question defaults to yes
 * (D20, D44), every other confirmation keeps the default of no.
 */
export async function confirm(
  question: string,
  isTty: boolean,
  defaultValue = false,
  input: NodeJS.ReadableStream = stdin,
  output: NodeJS.WritableStream = stderr,
): Promise<boolean | null> {
  if (!isTty) return null;
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(`${question} [${defaultValue ? 'Y/n' : 'y/N'}] `))
      .trim()
      .toLowerCase();
    if (answer === '') return defaultValue;
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

/**
 * Reads one line from standard input with no prompt and nothing written anywhere; used by
 * `arnesa login --key`, because the key is a secret and must not be echoed by this process.
 */
export async function readSecretLine(input: NodeJS.ReadableStream = stdin): Promise<string> {
  const rl = createInterface({ input });
  try {
    return (await rl.question('')).trim();
  } finally {
    rl.close();
  }
}
