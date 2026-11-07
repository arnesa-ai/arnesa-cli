import { createHash } from 'node:crypto';
import { allowedStrings, MODEL_PATTERN, VOCABULARY } from './vocabulary';

export interface ProjectProfile {
  version: 1;
  languages: string[];
  frameworks: string[];
  packageManagers: string[];
  testCommand: string;
  agentConfig: Record<string, number>;
  runtime: string;
  model: string | null;
}

export interface ProfileInput {
  /** Relative, slash-separated paths of the project files, in any order. */
  files: readonly string[];
  /** Reads a small manifest; null when the file cannot be read. */
  read: (relativePath: string) => string | null;
  runtime?: string | null;
  model?: string | null;
}

export class ProfileInputError extends Error {}

const MANIFEST_NAMES = [
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
];
const MAX_MANIFEST_DEPTH = 3;
const MAX_MANIFESTS_PER_KIND = 25;
const MAX_LANGUAGES = 5;
const NODE_LOCKS: [string, string][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
];
const RUNTIME_MARKERS: [string, string][] = [
  ['.claude', 'claude-code'],
  ['CLAUDE.md', 'claude-code'],
  ['.codex', 'codex'],
  ['.opencode', 'opencode'],
  ['.gemini', 'gemini'],
  ['GEMINI.md', 'gemini'],
  ['.cursor', 'cursor'],
  ['.cursorrules', 'cursor'],
  ['.github/copilot-instructions.md', 'copilot'],
];

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const depthOf = (path: string) => path.split('/').length - 1;
const extensionOf = (path: string) => {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

function languagesOf(files: readonly string[]): string[] {
  const counts = new Map<string, number>();
  const table: Record<string, string> = VOCABULARY.languages;
  for (const file of files) {
    const id = table[extensionOf(file)];
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || compareCodeUnit(a[0], b[0]))
    .slice(0, MAX_LANGUAGES)
    .map(([id]) => id);
}

function nodeDependencies(text: string): { names: string[]; hasTestScript: boolean } {
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    const names = ['dependencies', 'devDependencies', 'peerDependencies'].flatMap((key) => {
      const block = json[key];
      return block && typeof block === 'object' ? Object.keys(block) : [];
    });
    const scripts = json.scripts as Record<string, unknown> | undefined;
    const test = scripts?.test;
    const placeholder = typeof test === 'string' && /no test specified/.test(test);
    return { names, hasTestScript: typeof test === 'string' && test.trim() !== '' && !placeholder };
  } catch {
    return { names: [], hasTestScript: false };
  }
}

function pythonDependencies(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*["']?([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:[[<>=!~;"',]|$)/.exec(line);
    if (match?.[1]) names.push(match[1].toLowerCase().replaceAll('_', '-'));
  }
  return names;
}

function goDependencies(text: string): string[] {
  return [...text.matchAll(/^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]{2,}\/[^\s]+)\s+v\d/gim)].map(
    (m) => m[1] as string,
  );
}

function rustDependencies(text: string): string[] {
  const names: string[] = [];
  let inDeps = false;
  for (const line of text.split('\n')) {
    const header = /^\s*\[([^\]]+)\]/.exec(line);
    if (header) {
      inDeps = /(^|\.)(dev-|build-)?dependencies$/.test(header[1] as string);
      continue;
    }
    const key = inDeps ? /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line) : null;
    if (key?.[1]) names.push(key[1]);
  }
  return names;
}

/** Dependency names found in the manifests, never returned: they only select framework ids. */
function frameworksOf(files: readonly string[], read: ProfileInput['read']): string[] {
  const ids = new Set<string>();
  const fw = VOCABULARY.frameworks;
  const pick = (table: Record<string, string>, names: string[], prefix = false) => {
    for (const name of names) {
      const hit = table[name];
      if (hit) ids.add(hit);
      else if (prefix) {
        for (const [key, id] of Object.entries(table)) {
          if (name === key || name.startsWith(`${key}/`)) ids.add(id);
        }
      }
    }
  };
  for (const name of MANIFEST_NAMES) {
    const paths = files
      .filter((f) => baseName(f) === name && depthOf(f) <= MAX_MANIFEST_DEPTH)
      .slice(0, MAX_MANIFESTS_PER_KIND);
    for (const path of paths) {
      const text = read(path);
      if (text === null) continue;
      if (name === 'package.json') pick(fw.node, nodeDependencies(text).names);
      else if (name === 'go.mod') pick(fw.go, goDependencies(text), true);
      else if (name === 'Cargo.toml') pick(fw.rust, rustDependencies(text));
      else if (name === 'pyproject.toml' || name === 'requirements.txt') {
        pick(fw.python, pythonDependencies(text));
      } else if (name === 'pom.xml' || name.startsWith('build.gradle')) {
        for (const [key, id] of Object.entries(fw.java)) if (text.includes(key)) ids.add(id);
      }
    }
  }
  return [...ids].sort();
}

function packageManagersOf(files: readonly string[], read: ProfileInput['read']): string[] {
  const root = new Set(files.filter((f) => !f.includes('/')));
  const any = (name: string) => files.some((f) => baseName(f) === name);
  const out = new Set<string>();
  if (any('package.json')) {
    out.add(NODE_LOCKS.find(([lock]) => root.has(lock))?.[1] ?? 'npm');
  }
  const pyproject = root.has('pyproject.toml') ? read('pyproject.toml') : null;
  if (pyproject?.includes('[tool.poetry]')) out.add('poetry');
  else if (root.has('uv.lock')) out.add('uv');
  else if (root.has('requirements.txt') || root.has('setup.py') || pyproject !== null)
    out.add('pip');
  if (root.has('go.mod')) out.add('go');
  if (root.has('Cargo.toml')) out.add('cargo');
  if (root.has('pom.xml')) out.add('maven');
  if (root.has('build.gradle') || root.has('build.gradle.kts')) out.add('gradle');
  if (files.some((f) => /\.(csproj|fsproj|sln)$/.test(f))) out.add('dotnet');
  if (root.has('Gemfile')) out.add('bundler');
  if (root.has('composer.json')) out.add('composer');
  return [...out].sort();
}

/** A command *name* from the closed list, never the script text. */
function testCommandOf(
  files: readonly string[],
  read: ProfileInput['read'],
  frameworks: string[],
  managers: string[],
): string {
  const root = new Set(files.filter((f) => !f.includes('/')));
  if (root.has('package.json')) {
    const text = read('package.json');
    if (text && nodeDependencies(text).hasTestScript) {
      const pm = NODE_LOCKS.find(([lock]) => root.has(lock))?.[1] ?? 'npm';
      return `${pm} test`;
    }
  }
  const pythonTests = files.some((f) => /(^|\/)(test_[^/]*\.py|conftest\.py)$/.test(f));
  if (frameworks.includes('pytest') || pythonTests) return 'pytest';
  if (managers.includes('go')) return 'go test';
  if (managers.includes('cargo')) return 'cargo test';
  if (managers.includes('maven')) return 'mvn test';
  if (managers.includes('gradle')) return 'gradle test';
  if (managers.includes('dotnet')) return 'dotnet test';
  if (root.has('Makefile') && /^test\s*:/m.test(read('Makefile') ?? '')) return 'make test';
  return 'unknown';
}

function agentConfigOf(files: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of VOCABULARY.agentConfig) {
    const count = files.filter((f) => f === entry || f.startsWith(`${entry}/`)).length;
    if (count > 0) out[entry] = count;
  }
  return out;
}

function runtimeOf(config: Record<string, number>, requested?: string | null): string {
  if (requested) {
    if (!(VOCABULARY.runtimes as readonly string[]).includes(requested)) {
      throw new ProfileInputError(`Unknown runtime: ${requested}`);
    }
    return requested;
  }
  return RUNTIME_MARKERS.find(([marker]) => marker in config)?.[1] ?? 'unknown';
}

export function buildProfile(input: ProfileInput): ProjectProfile {
  const files = [...new Set(input.files)].sort();
  const model = input.model?.trim() || null;
  if (model !== null && !MODEL_PATTERN.test(model)) {
    throw new ProfileInputError('Model must match ^[A-Za-z0-9._:/-]{1,64}$');
  }
  const frameworks = frameworksOf(files, input.read);
  const packageManagers = packageManagersOf(files, input.read);
  const agentConfig = agentConfigOf(files);
  return {
    version: 1,
    languages: languagesOf(files),
    frameworks,
    packageManagers,
    testCommand: testCommandOf(files, input.read, frameworks, packageManagers),
    agentConfig,
    runtime: runtimeOf(agentConfig, input.runtime),
    model,
  };
}

/** JSON with sorted keys and no whitespace: the same value always gives the same bytes. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * String order by UTF-16 code unit, never by locale (review R1-08): two machines must
 * compute the same manifest hash for the same items, and `localeCompare` differs between
 * locales. The same helper exists in `packages/core/local/domain/compile/safe.ts`; the
 * contract tests pin one literal hash on both sides.
 */
export function compareCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function profileHash(profile: ProjectProfile): string {
  return createHash('sha256').update(canonicalJson(profile)).digest('hex');
}

/** The request body of `recommend`; `detect` prints exactly this. */
export function profileRequest(profile: ProjectProfile, cliVersion?: string): string {
  return canonicalJson({ cliVersion, profile, profileHash: profileHash(profile) });
}

/** Every string of a profile other than `model` that is not in the vocabulary (empty when closed). */
export function stringsOutsideVocabulary(profile: ProjectProfile): string[] {
  const allowed = allowedStrings();
  const { model: _model, version: _version, ...rest } = profile;
  const strings: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === 'string') strings.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        strings.push(k);
        visit(v);
      }
    }
  };
  visit(rest);
  // Keys of the profile itself are part of its fixed shape, not data.
  const shape = new Set([
    'languages',
    'frameworks',
    'packageManagers',
    'testCommand',
    'agentConfig',
    'runtime',
  ]);
  return strings.filter((s) => !allowed.has(s) && !shape.has(s));
}
