import { EXIT } from '../exit';
import { ApiError } from '../http';
import { INSTALL_CAPS } from './paths';
import type { WireItem } from '../wire';

/**
 * Files and keys that make an agent start a process or a connection on its own. The server labels
 * such items with a gate, but a lying server can leave the label off, so the client decides too:
 * whatever matches here is gated and shown in full, whatever the response says.
 */
const LAUNCH_DIR = /(^|\/)(hooks|plugins?)\//;
const LAUNCH_FILE = new Set([
  '.mcp.json',
  'mcp.json',
  'hooks.json',
  'lsp.json',
  '.lsp.json',
  'opencode.json',
  'opencode.jsonc',
  'settings.json',
  'config.toml',
]);
const LAUNCH_KEY = new Set([
  'hooks',
  'mcpServers',
  'mcp',
  'mcp_servers',
  'lsp',
  'plugin',
  'plugins',
]);
/**
 * Claude Code runs a command from many `settings.json` keys beyond `hooks` (`statusLine`,
 * `apiKeyHelper`, ...), so every merge into that file is gated, whatever key it touches.
 */
const LAUNCH_MERGE_FILE = new Set(['settings.json']);
/**
 * Frontmatter keys of an agent or skill file that make the agent run a command or connect. Matched
 * on the whole frontmatter block and erring toward a gate: YAML spells a key many ways
 * (`"hooks":`, `'mcpServers':`, `hooks :`, inside a flow mapping), and a lying server (design
 * decision 11) counts on the client missing one.
 */
const COMMAND_FRONTMATTER = /(^|[\s{,])["']?(hooks|mcpServers|mcp_servers)["']?\s*:/;

function basename(path: string): string {
  return path.split('/').at(-1) ?? path;
}

/** The full text the item installs, decoded; a gate shows it verbatim. */
function textOf(item: WireItem): string {
  if (item.mode === 'create') {
    return item.encoding === 'utf8'
      ? item.content
      : Buffer.from(item.content, 'base64').toString('utf8');
  }
  if (item.mode === 'block') return item.text;
  return JSON.stringify({ [item.key]: item.value }, null, 2);
}

/** True when the file starts with YAML frontmatter carrying a key that runs a command. */
function hasCommandFrontmatter(item: WireItem): boolean {
  if (item.mode !== 'create') return false;
  const lines = textOf(item).split('\n');
  if (lines[0]?.trim() !== '---') return false;
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (end < 0) return false;
  return COMMAND_FRONTMATTER.test(lines.slice(1, end).join('\n'));
}

/** True when installing this item can start a process, a connection or a plugin without a further step by the user. */
export function launchesProcess(item: WireItem): boolean {
  if (LAUNCH_DIR.test(item.path)) return true;
  if (item.mode === 'merge-json') {
    return LAUNCH_KEY.has(item.key) || LAUNCH_MERGE_FILE.has(basename(item.path));
  }
  if (item.mode === 'block') return basename(item.path) === 'config.toml';
  return LAUNCH_FILE.has(basename(item.path)) || hasCommandFrontmatter(item);
}

function describe(item: WireItem): string[] {
  // Verbatim: the spec wants the full text of every hook, local MCP command and LSP command, so
  // nothing is cut and nothing is replaced by a placeholder. An item too large for that is refused
  // in `withClientGates` before it reaches here.
  return textOf(item).split('\n');
}

/** Adds a gate the client derives to every launching item the server did not gate. The id is `launch:<path>`. */
export function withClientGates(files: readonly WireItem[]): WireItem[] {
  return files.map((item) => {
    if (item.gate || !launchesProcess(item)) return item;
    const bytes = Buffer.byteLength(textOf(item), 'utf8');
    if (bytes > INSTALL_CAPS.maxFileBytes) {
      throw new ApiError(
        `refused ${item.path}: its command gate must show all ${bytes} bytes, ` +
          `which is over the ${INSTALL_CAPS.maxFileBytes}-byte install cap`,
        EXIT.refused,
        'UNSAFE_RESPONSE',
        { path: item.path },
      );
    }
    return { ...item, gate: { id: `launch:${item.path}`, commands: describe(item) } } as WireItem;
  });
}
