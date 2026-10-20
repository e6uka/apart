const REF_PATTERN = / \[ref=[^\]]+\]/g;
const MAX_DP_CELLS = 4_000_000;

function stripRefs(tree: string): string[] {
  return tree.split("\n").map((line) => line.replace(REF_PATTERN, ""));
}

function lcsDiff(a: string[], b: string[]): string[] {
  const table: Uint32Array[] = [];
  for (let i = 0; i <= a.length; i++) table.push(new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push(`- ${a[i++]}`);
    } else {
      out.push(`+ ${b[j++]}`);
    }
  }
  while (i < a.length) out.push(`- ${a[i++]}`);
  while (j < b.length) out.push(`+ ${b[j++]}`);
  return out;
}

function multisetDiff(a: string[], b: string[]): string[] {
  const counts = new Map<string, number>();
  for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
  const added: string[] = [];
  for (const line of b) {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else added.push(`+ ${line}`);
  }
  const removed: string[] = [];
  for (const [line, left] of counts) for (let k = 0; k < left; k++) removed.push(`- ${line}`);
  return [...removed, ...added];
}

export function diffTrees(before: string | null, after: string): string {
  if (before === null) return "(first snapshot, nothing to diff against)";
  const a = stripRefs(before);
  const b = stripRefs(after);
  const lines = a.length * b.length > MAX_DP_CELLS ? multisetDiff(a, b) : lcsDiff(a, b);
  return lines.length ? lines.join("\n") : "(no changes)";
}
