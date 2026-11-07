const MAX_CELLS = 4_000_000;

/**
 * A line diff in unified style with two lines of context. For very large inputs it falls back to a
 * one-line summary, because the diff is for a person to read, not for patching.
 */
export function unifiedDiff(before: string, after: string, label: string): string[] {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length * b.length > MAX_CELLS) {
    return [
      `--- ${label}`,
      `+++ ${label}`,
      `(changed: ${a.length} lines became ${b.length} lines)`,
    ];
  }

  // Longest common subsequence table.
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * cols + j] =
        a[i] === b[j]
          ? (table[(i + 1) * cols + j + 1] as number) + 1
          : Math.max(table[(i + 1) * cols + j] as number, table[i * cols + j + 1] as number);
    }
  }

  const ops: Array<{ tag: ' ' | '-' | '+'; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ tag: ' ', text: a[i] as string });
      i++;
      j++;
    } else if ((table[(i + 1) * cols + j] as number) >= (table[i * cols + j + 1] as number)) {
      ops.push({ tag: '-', text: a[i++] as string });
    } else {
      ops.push({ tag: '+', text: b[j++] as string });
    }
  }
  while (i < a.length) ops.push({ tag: '-', text: a[i++] as string });
  while (j < b.length) ops.push({ tag: '+', text: b[j++] as string });

  const CONTEXT = 2;
  const keep = ops.map((op, index) =>
    ops.some(
      (other, k) => other.tag !== ' ' && Math.abs(k - index) <= (op.tag === ' ' ? CONTEXT : 0),
    ),
  );
  const out = [`--- ${label}`, `+++ ${label}`];
  let skipped = false;
  ops.forEach((op, index) => {
    if (keep[index]) {
      out.push(`${op.tag}${op.text}`);
      skipped = false;
    } else if (!skipped) {
      out.push('...');
      skipped = true;
    }
  });
  return out;
}
