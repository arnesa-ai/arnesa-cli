import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../profile';

const sha256 = (data: string) => createHash('sha256').update(data).digest('hex');

// ── blocks: a marked region appended to a text file ────────────────────────────────────────────
const markers = (comment: 'html' | 'hash', blockId: string, installId: string) =>
  comment === 'html'
    ? {
        begin: `<!-- arnesa:begin ${blockId} install=${installId} -->`,
        end: `<!-- arnesa:end ${blockId} -->`,
      }
    : {
        begin: `# arnesa:begin ${blockId} install=${installId}`,
        end: `# arnesa:end ${blockId}`,
      };

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Where the block of `blockId` sits in `text`: from its begin line to just after its end line. */
function findBlock(text: string, blockId: string) {
  const begin = new RegExp(
    `^(?:<!-- |# )arnesa:begin ${escapeRegExp(blockId)}(?: install=\\w+)?(?: -->)?$`,
    'm',
  ).exec(text);
  if (!begin) return null;
  const end = new RegExp(`^(?:<!-- |# )arnesa:end ${escapeRegExp(blockId)}(?: -->)?$`, 'm');
  const rest = text.slice(begin.index);
  const endMatch = end.exec(rest);
  if (!endMatch) return null;
  const afterEnd = begin.index + endMatch.index + endMatch[0].length;
  const stop = text[afterEnd] === '\n' ? afterEnd + 1 : afterEnd;
  const innerStart = begin.index + begin[0].length + 1;
  const inner = text.slice(innerStart, begin.index + endMatch.index - 1);
  return { start: begin.index, stop, inner };
}

export interface BlockApplied {
  text: string;
  /** What was put before the block to separate it from the user's text; removal takes it back. */
  prefix: string;
}

/** Appends the block; every byte already in the file stays. Null when a block with this id exists. */
export function applyBlock(
  existing: string | null,
  item: { blockId: string; comment: 'html' | 'hash'; text: string },
  installId: string,
): BlockApplied | null {
  if (existing !== null && findBlock(existing, item.blockId)) return null;
  const { begin, end } = markers(item.comment, item.blockId, installId);
  const block = `${begin}\n${item.text}\n${end}\n`;
  if (existing === null || existing === '') return { text: block, prefix: '' };
  const prefix = existing.endsWith('\n') ? '\n' : '\n\n';
  return { text: existing + prefix + block, prefix };
}

export interface BlockRemoved {
  text: string;
  /** The block still reads exactly as installed. */
  intact: boolean;
}

export function removeBlock(
  text: string,
  blockId: string,
  prefix: string,
  installedSha: string,
): BlockRemoved | null {
  const found = findBlock(text, blockId);
  if (!found) return null;
  const from =
    prefix && text.slice(found.start - prefix.length, found.start) === prefix
      ? found.start - prefix.length
      : found.start;
  return {
    text: text.slice(0, from) + text.slice(found.stop),
    intact: sha256(found.inner) === installedSha,
  };
}

export const blockText = (text: string, blockId: string): string | null =>
  findBlock(text, blockId)?.inner ?? null;

// ── merge-json: objects merged by key, arrays unioned ──────────────────────────────────────────
export const AddedSchema = z.discriminatedUnion('kind', [
  /** A key that was absent: removal deletes it when its value is still the installed one. */
  z.strictObject({ kind: z.literal('key'), path: z.array(z.string()), sha256: z.string() }),
  /** An array element that was absent: removal deletes the first equal element. */
  z.strictObject({ kind: z.literal('item'), path: z.array(z.string()), value: z.unknown() }),
]);
export type Added = z.infer<typeof AddedSchema>;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

export interface JsonMerged {
  text: string;
  added: Added[];
  /** Containers this merge created (the top-level key); removal deletes them once empty. */
  createdContainers: string[][];
}

function mergeInto(
  parent: Json,
  path: string[],
  key: string,
  value: unknown,
  out: JsonMerged,
  conflicts: string[],
) {
  const here = [...path, key];
  if (!(key in parent)) {
    parent[key] = structuredClone(value);
    out.added.push({ kind: 'key', path: here, sha256: sha256(canonicalJson(value)) });
    return;
  }
  const current = parent[key];
  if (same(current, value)) return;
  if (isObject(current) && isObject(value)) {
    for (const [k, v] of Object.entries(value)) mergeInto(current, here, k, v, out, conflicts);
  } else if (Array.isArray(current) && Array.isArray(value)) {
    for (const element of value) {
      if (current.some((c) => same(c, element))) continue;
      current.push(structuredClone(element));
      out.added.push({ kind: 'item', path: here, value: element });
    }
  } else {
    conflicts.push(here.join('.'));
  }
}

/**
 * Merges `value` into `doc[key]`. A scalar that differs is a conflict and the whole item is
 * skipped (`conflicts` non-empty); nothing the user wrote is overwritten.
 */
export function mergeJson(
  existing: string | null,
  key: string,
  value: Json,
): { merged: JsonMerged; conflicts: string[] } | { unreadable: string } {
  let doc: Json = {};
  if (existing !== null && existing.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (!isObject(parsed)) return { unreadable: 'the file is not a JSON object' };
      doc = parsed;
    } catch {
      return { unreadable: 'the file is not plain JSON (comments or a syntax error)' };
    }
  }
  const out: JsonMerged = { text: '', added: [], createdContainers: [] };
  const conflicts: string[] = [];
  if (!(key in doc)) {
    doc[key] = {};
    out.createdContainers.push([key]);
  } else if (!isObject(doc[key])) {
    return { merged: out, conflicts: [key] };
  }
  const container = doc[key] as Json;
  for (const [k, v] of Object.entries(value)) mergeInto(container, [key], k, v, out, conflicts);
  if (out.added.length === 0 && out.createdContainers.length > 0) out.createdContainers.length = 0;
  out.text =
    out.added.length === 0 && existing !== null ? existing : `${JSON.stringify(doc, null, 2)}\n`;
  return { merged: out, conflicts };
}

const walk = (doc: Json, path: string[]): { parent: Json | unknown[]; key: string } | null => {
  let node: unknown = doc;
  for (const step of path.slice(0, -1)) {
    if (!isObject(node) || !(step in node)) return null;
    node = node[step];
  }
  const key = path.at(-1);
  return key !== undefined && node && typeof node === 'object'
    ? { parent: node as Json, key }
    : null;
};

export interface JsonRemoved {
  text: string;
  /** Added keys whose value was changed after the install; left in place. */
  modified: string[];
  empty: boolean;
}

/** Takes back what a merge added and nothing else. */
export function unmergeJson(
  existing: string,
  added: readonly Added[],
  createdContainers: readonly string[][],
): JsonRemoved | null {
  let doc: Json;
  try {
    const parsed: unknown = JSON.parse(existing);
    if (!isObject(parsed)) return null;
    doc = parsed;
  } catch {
    return null;
  }
  const modified: string[] = [];
  for (const entry of added) {
    if (entry.kind === 'key') {
      const spot = walk(doc, entry.path);
      const key = entry.path.at(-1) as string;
      if (!spot || !(key in spot.parent)) continue;
      const value = (spot.parent as Json)[key];
      if (sha256(canonicalJson(value)) === entry.sha256) delete (spot.parent as Json)[key];
      else modified.push(entry.path.join('.'));
    } else {
      let node: unknown = doc;
      for (const step of entry.path) node = isObject(node) ? node[step] : undefined;
      if (!Array.isArray(node)) continue;
      const at = node.findIndex((v) => same(v, entry.value));
      if (at >= 0) node.splice(at, 1);
    }
  }
  for (const path of createdContainers) {
    const spot = walk(doc, path);
    const key = path.at(-1) as string;
    if (!spot) continue;
    const value = (spot.parent as Json)[key];
    if (isObject(value) && Object.keys(value).length === 0) delete (spot.parent as Json)[key];
  }
  return {
    text: `${JSON.stringify(doc, null, 2)}\n`,
    modified,
    empty: Object.keys(doc).length === 0,
  };
}
