// Lossless .env parser: every physical line is kept verbatim in `raw`, so a
// document can be edited entry by entry and written back without touching
// comments, order or quoting. Syntax is the common subset of dotenv, Node's
// --env-file, Bun and docker compose.

export type Quote = "'" | '"' | "`" | "";

export interface DotenvLine {
  /** 1-based line where this entry starts; multi-line values span to endLine. */
  line: number;
  endLine: number;
  /** Original text, including any continuation lines. */
  raw: string;
  kind: "blank" | "comment" | "entry" | "invalid";
  key?: string;
  value?: string;
  exported?: boolean;
  quote?: Quote;
  /** Value contains $VAR or ${VAR}: loaders disagree on whether it expands. */
  expands?: boolean;
  problem?: string;
}

export interface DotenvDoc {
  lines: DotenvLine[];
  eol: "\n" | "\r\n";
  trailingNewline: boolean;
}

const ENTRY = /^(\s*)(export\s+)?([^=\s#]+)(\s*)=(.*)$/;
const KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const EXPANSION = /\$\{?[A-Za-z_]/;

/** Index just past the closing quote `q` in `s` from `start`, or -1. Only double quotes have escapes. */
function closing(s: string, start: number, q: string): number {
  for (let i = start; i < s.length; i++) {
    if (q === '"' && s[i] === "\\") i++;
    else if (s[i] === q) return i;
  }
  return -1;
}

const unescapeDouble = (s: string) =>
  s.replace(/\\([nrt"\\$])/g, (_, c: string) => ({ n: "\n", r: "\r", t: "\t" })[c] ?? c);

export function parseDotenv(text: string): DotenvDoc {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = text.endsWith("\n");
  const physical = text.split(/\r?\n/);
  if (trailingNewline) physical.pop();

  const lines: DotenvLine[] = [];
  for (let i = 0; i < physical.length; i++) {
    const raw = physical[i]!;
    const base = { line: i + 1, endLine: i + 1, raw };
    const trimmed = raw.trim();
    if (!trimmed) {
      lines.push({ ...base, kind: "blank" });
      continue;
    }
    if (trimmed.startsWith("#")) {
      lines.push({ ...base, kind: "comment" });
      continue;
    }
    const m = ENTRY.exec(raw);
    if (!m) {
      lines.push({ ...base, kind: "invalid", problem: "not a KEY=value line" });
      continue;
    }
    const [, , exportWord, key, , rest] = m as unknown as [string, string, string | undefined, string, string, string];
    if (!KEY.test(key)) {
      lines.push({ ...base, kind: "invalid", key, problem: `invalid key '${key}'` });
      continue;
    }
    const body = rest.trimStart();
    const q = (["'", '"', "`"] as const).find((c) => body.startsWith(c));
    let value: string;
    let quote: Quote = "";
    let problem: string | undefined;
    let endLine = i + 1;
    let fullRaw = raw;

    if (q) {
      // a quoted value may continue on the following lines
      let text = body.slice(1);
      let end = closing(text, 0, q);
      let j = i;
      while (end < 0 && j + 1 < physical.length) {
        j++;
        text += "\n" + physical[j]!;
        end = closing(text, 0, q);
      }
      if (end < 0) {
        lines.push({ ...base, kind: "invalid", key, problem: `unterminated ${q} quote` });
        continue;
      }
      const after = text.slice(end + 1).trim();
      if (after && !after.startsWith("#")) problem = "text after the closing quote is ignored";
      value = q === '"' ? unescapeDouble(text.slice(0, end)) : text.slice(0, end);
      quote = q;
      fullRaw = physical.slice(i, j + 1).join("\n");
      endLine = j + 1;
      i = j;
    } else {
      value = body.replace(/(^|\s+)#.*$/, "").trim();
    }

    lines.push({
      line: base.line,
      endLine,
      raw: fullRaw,
      kind: "entry",
      key,
      value,
      exported: !!exportWord,
      quote,
      expands: quote !== "'" && EXPANSION.test(value),
      problem,
    });
  }
  return { lines, eol, trailingNewline };
}

/** Text of the document; parse → serialize gives back the original bytes. */
export function serializeDotenv(doc: DotenvDoc): string {
  const body = doc.lines.map((l) => l.raw.replace(/\n/g, doc.eol)).join(doc.eol);
  return body + (doc.trailingNewline ? doc.eol : "");
}

export interface DotenvProblem {
  line: number;
  key?: string;
  message: string;
}

/** Syntax problems, duplicates and portability warnings, in line order. */
export function dotenvProblems(doc: DotenvDoc): DotenvProblem[] {
  const out: DotenvProblem[] = [];
  const seen = new Map<string, number>();
  for (const l of doc.lines) {
    if (l.problem) out.push({ line: l.line, key: l.key, message: l.problem });
    if (l.kind !== "entry") continue;
    const first = seen.get(l.key!);
    if (first !== undefined)
      out.push({ line: l.line, key: l.key, message: `duplicate of line ${first}; most loaders keep the last one` });
    else seen.set(l.key!, l.line);
    if (l.expands)
      out.push({ line: l.line, key: l.key, message: "uses $VAR expansion, which not every loader supports" });
  }
  return out.sort((a, b) => a.line - b.line);
}

export type KeyStatus = "new" | "same" | "conflict";

export interface DotenvKey {
  key: string;
  line: number;
  value: string;
  status: KeyStatus;
  /** Value the current environment already has, for same/conflict. */
  current?: string;
}

/**
 * How each key relates to the current environment. Effective values only:
 * for duplicates the last line is used, as dotenv does.
 */
export function compareDotenv(doc: DotenvDoc, env: Record<string, string | undefined>): DotenvKey[] {
  const last = new Map<string, DotenvLine>();
  for (const l of doc.lines) if (l.kind === "entry") last.set(l.key!, l);
  return [...last.values()]
    .sort((a, b) => a.line - b.line)
    .map((l) => {
      const current = env[l.key!];
      const status: KeyStatus = current === undefined ? "new" : current === l.value ? "same" : "conflict";
      return { key: l.key!, line: l.line, value: l.value!, status, current };
    });
}
