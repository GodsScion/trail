/**
 * After an action, return a diff of what changed rather than a fresh snapshot.
 * On multi-step forms most steps change one field's worth of DOM.
 */
export const DIFF_MAX_LINES = 40;

/** Above this line count the LCS table gets expensive; fall back to a set difference. */
const LCS_MAX_LINES = 1500;

type DiffOp = { op: '=' | '+' | '-'; line: string };

function coarseDiff(a: string[], b: string[]): DiffOp[] {
  const counts = new Map<string, number>();
  for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
  const ops: DiffOp[] = [];
  for (const line of b) {
    const n = counts.get(line) ?? 0;
    if (n > 0) counts.set(line, n - 1);
    else ops.push({ op: '+', line });
  }
  for (const [line, n] of counts) for (let i = 0; i < n; i += 1) ops.push({ op: '-', line });
  return ops;
}

function lcsDiff(a: string[], b: string[]): DiffOp[] {
  if (a.length > LCS_MAX_LINES || b.length > LCS_MAX_LINES) return coarseDiff(a, b);
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i]![j] = a[i] === b[j]
        ? table[i + 1]![j + 1]! + 1
        : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ op: '=', line: a[i]! }); i += 1; j += 1; }
    else if (table[i + 1]![j]! >= table[i]![j + 1]!) { ops.push({ op: '-', line: a[i]! }); i += 1; }
    else { ops.push({ op: '+', line: b[j]! }); j += 1; }
  }
  while (i < n) { ops.push({ op: '-', line: a[i]! }); i += 1; }
  while (j < m) { ops.push({ op: '+', line: b[j]! }); j += 1; }
  return ops;
}

function split(s: string): string[] {
  return s.length === 0 ? [] : s.split('\n');
}

export function diffSnapshots(before: string, after: string, maxLines = DIFF_MAX_LINES): string {
  const changed = lcsDiff(split(before), split(after)).filter((o) => o.op !== '=');
  if (changed.length === 0) return '';
  const shown = changed.slice(0, maxLines).map((o) => `${o.op} ${o.line}`);
  if (changed.length > maxLines) {
    shown.push(`… ${changed.length - maxLines} more changes (call snapshot for detail)`);
  }
  return shown.join('\n');
}
