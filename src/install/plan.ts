import { createHash } from 'node:crypto';
import { canonicalJson, compareCodeUnit } from '../profile';
import type { CompileResponse, WireItem } from '../wire';
import { unifiedDiff } from './diff';
import type { FileRecord } from './lock';
import { applyBlock, mergeJson } from './merge';
import { mayBeExecutable } from './paths';
import { createBytes, readIfExists } from './safe-write';

export type Action = 'create' | 'modify' | 'identical' | 'conflict' | 'skipped';

export interface PlannedItem {
  item: WireItem;
  action: Action;
  /** Why an item is a conflict or was skipped. */
  note: string | null;
}

/** A record before the write: the backup path is filled in once the original has been copied. */
export type DraftRecord = FileRecord extends infer R
  ? R extends { backup: unknown }
    ? Omit<R, 'backup'>
    : never
  : never;

export interface PlannedFile {
  path: string;
  original: Buffer | null;
  final: Buffer;
  executable: boolean;
  records: DraftRecord[];
  /** Unified diff for a modified text file; empty for a new file. */
  diff: string[];
}

export interface Plan {
  items: PlannedItem[];
  files: PlannedFile[];
}

interface State {
  original: Buffer | null;
  current: Buffer | null;
  records: DraftRecord[];
  executable: boolean;
  createdBy: boolean;
  /** False when the original bytes are not valid UTF-8, so editing them through text would corrupt them. */
  utf8: boolean;
}

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const looksBinary = (b: Buffer) => b.includes(0);
/** True when decoding to text and re-encoding gives back the same bytes, i.e. the file is UTF-8. */
const isUtf8 = (b: Buffer) => Buffer.from(b.toString('utf8')).equals(b);

/**
 * What an install would do to the project, computed without writing. Items whose command gate is
 * not in `allowed` are skipped. Several items for one path are applied in order to one in-memory
 * copy, so the file is written once.
 */
export function buildPlan(
  root: string,
  harness: CompileResponse['harness'],
  files: readonly WireItem[],
  installId: string,
  allowed: ReadonlySet<string>,
): Plan {
  void harness;
  const states = new Map<string, State>();
  const stateOf = (path: string): State => {
    let state = states.get(path);
    if (!state) {
      const original = readIfExists(root, path);
      state = {
        original,
        current: original,
        records: [],
        executable: false,
        createdBy: false,
        utf8: original === null || isUtf8(original),
      };
      states.set(path, state);
    }
    return state;
  };

  const items: PlannedItem[] = files.map((item) => {
    if (item.gate && !allowed.has(item.gate.id)) {
      return { item, action: 'skipped', note: `needs your confirmation of ${item.gate.id}` };
    }
    const state = stateOf(item.path);
    // An existing file that is not UTF-8 (a UTF-16LE AGENTS.md, a Latin-1 CLAUDE.md) cannot be
    // edited through text: decoding would turn its bytes into U+FFFD. Leave it byte for byte.
    if (state.original !== null && !state.utf8)
      return {
        item,
        action: 'conflict',
        note: 'the file is not UTF-8; writing would corrupt it. Convert it to UTF-8 first.',
      };
    const wasCreated = state.original === null;

    if (item.mode === 'create') {
      const bytes = createBytes(item);
      if (state.createdBy) return { item, action: 'conflict', note: 'two items name this file' };
      state.createdBy = true;
      if (state.current && state.current.equals(bytes))
        return { item, action: 'identical', note: null };
      const action: Action = state.current ? 'modify' : 'create';
      state.current = bytes;
      const executable = item.executable && mayBeExecutable(item.path);
      state.executable ||= executable;
      state.records.push({
        mode: 'create',
        path: item.path,
        sha256: sha256(bytes),
        executable,
        createdFile: wasCreated,
      });
      return { item, action, note: null };
    }

    const existing = state.current ? state.current.toString('utf8') : null;
    if (item.mode === 'block') {
      const applied = applyBlock(existing, item, installId);
      if (!applied)
        return { item, action: 'conflict', note: 'a block with this id is already in the file' };
      state.current = Buffer.from(applied.text);
      state.records.push({
        mode: 'block',
        path: item.path,
        blockId: item.blockId,
        sha256: sha256(item.text),
        prefix: applied.prefix,
        createdFile: wasCreated,
      });
      return { item, action: state.original ? 'modify' : 'create', note: null };
    }

    const result = mergeJson(existing, item.key, item.value);
    if ('unreadable' in result) return { item, action: 'conflict', note: result.unreadable };
    if (result.conflicts.length > 0) {
      return {
        item,
        action: 'conflict',
        note: `already set differently: ${result.conflicts.join(', ')}`,
      };
    }
    if (result.merged.added.length === 0) return { item, action: 'identical', note: null };
    state.current = Buffer.from(result.merged.text);
    state.records.push({
      mode: 'merge-json',
      path: item.path,
      key: item.key,
      added: result.merged.added,
      createdContainers: result.merged.createdContainers,
      createdFile: wasCreated,
    });
    return { item, action: state.original ? 'modify' : 'create', note: null };
  });

  const planned: PlannedFile[] = [];
  for (const [path, state] of states) {
    if (state.records.length === 0 || !state.current) continue;
    const diff =
      state.original && !looksBinary(state.original) && !looksBinary(state.current)
        ? unifiedDiff(state.original.toString('utf8'), state.current.toString('utf8'), path)
        : [];
    planned.push({
      path,
      original: state.original,
      final: state.current,
      executable: state.executable,
      records: state.records,
      diff,
    });
  }
  return { items, files: planned };
}

/** Recomputes the server's `manifestHash` from the items received; a mismatch means the answer was altered. */
export function manifestHashOf(response: CompileResponse): string {
  const identity = (i: WireItem) =>
    i.mode === 'merge-json'
      ? { path: i.path, mode: i.mode, key: i.key, sha256: i.sha256 }
      : i.mode === 'block'
        ? { path: i.path, mode: i.mode, blockId: i.blockId, sha256: i.sha256 }
        : { path: i.path, mode: i.mode, sha256: i.sha256 };
  return sha256(
    canonicalJson({
      runtime: response.runtime,
      adapterVersion: response.adapterVersion,
      commit: response.harness.commit,
      contentHash: response.harness.contentHash,
      items: response.files
        .map(identity)
        .sort((a, b) => compareCodeUnit(canonicalJson(a), canonicalJson(b))),
    }),
  );
}
