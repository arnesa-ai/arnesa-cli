import { main } from './cli';
import { installedVersion } from './install/runtime';
import { systemKeychain } from './keychain';

declare const __ARNESA_VERSION__: string;

const code = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  isTty: Boolean(process.stdin.isTTY && process.stderr.isTTY),
  openKeychain: systemKeychain,
  runtimeVersion: installedVersion,
  version: typeof __ARNESA_VERSION__ === 'string' ? __ARNESA_VERSION__ : '0.0.0-dev',
});
process.exitCode = code;
