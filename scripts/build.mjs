// Bundles the CLI into dist/arnesa.mjs (one file, Node 22, dependencies bundled except native ones).
//
// The default API origin is injected at build time from ARNESA_PUBLIC_API_URL (D55: the interim
// production domain lives only in the environment, never in source). `--release` is what
// `prepublishOnly` runs: it refuses to build a release without an https value.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const pkg = JSON.parse(readFileSync(here('../package.json'), 'utf8'));

const apiUrl = process.env.ARNESA_PUBLIC_API_URL ?? '';
const release = process.argv.includes('--release');
if (apiUrl === '' && !release) {
  console.warn(
    'warning: ARNESA_PUBLIC_API_URL is not set; the CLI is built with no default API URL (users must pass --api or ARNESA_API_URL)',
  );
}
if (release) {
  if (apiUrl === '') {
    console.error('ARNESA_PUBLIC_API_URL is not set; a release build needs an https API origin.');
    process.exit(1);
  }
  if (!apiUrl.startsWith('https://')) {
    console.error('ARNESA_PUBLIC_API_URL must be an https URL; refusing the release build.');
    process.exit(1);
  }
}

await build({
  entryPoints: [here('../src/bin.ts')],
  outfile: here('../dist/arnesa.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  banner: { js: '#!/usr/bin/env node' },
  define: {
    __ARNESA_VERSION__: JSON.stringify(pkg.version),
    __ARNESA_API_URL__: JSON.stringify(apiUrl),
  },
  external: ['@napi-rs/keyring'],
  legalComments: 'none',
});
