// Minimal line diff for previews. Files envhound edits are small, so plain LCS is fine.

export interface DiffLine {
  op: " " | "-" | "+";
  text: string;
}

export function lineDiff(a: string[], b: string[]): DiffLine[] {
  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ op: " ", text: a[i]! });
      i++;
      j++;
    } else if (i < a.length && (j === b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      out.push({ op: "-", text: a[i++]! }); // removals before additions, as in unified diffs
    } else {
      out.push({ op: "+", text: b[j++]! });
    }
  }
  return out;
}

/** Changed lines with `context` unchanged lines around them; skipped runs become null. */
export function hunks(diff: DiffLine[], context = 2): (DiffLine | null)[] {
  const keep = diff.map((_, i) =>
    diff.slice(Math.max(0, i - context), i + context + 1).some((d) => d.op !== " "),
  );
  const out: (DiffLine | null)[] = [];
  diff.forEach((d, i) => {
    if (keep[i]) out.push(d);
    else if (out.at(-1) !== null) out.push(null);
  });
  if (out[0] === null) out.shift();
  if (out.at(-1) === null) out.pop();
  return out;
}
