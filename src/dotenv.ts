// Lossless .env parser: every physical line is kept verbatim in `raw`, so a
// document can be edited entry by entry and written back without touching
// comments, order or quoting. Syntax is the common subset of dotenv, Node's
// --env-file, Bun and docker compose.

import { dotenvQuote } from "./quote.ts";

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
  /** Inline comment after the value, with its leading whitespace, kept when the value is rewritten. */
  trailing?: string;
  /** Leading whitespace of the line. */
  indent?: string;
  /** Value text as written (inside the quotes, before unescaping); expansion works on it. */
  source?: string;
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

/** Index of the `}` closing the `{` at `open`, or -1. */
function matchingBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

export interface Expansion {
  value: string;
  /** Variables referenced. */
  refs: string[];
  /** Referenced without a default and not set: they expand to empty. */
  missing: string[];
}

/**
 * Expand $NAME, ${NAME}, ${NAME:-default} and ${NAME-default} in a value as
 * written, the way dotenv-expand, Bun and docker compose do; `\$` is a literal
 * dollar. Double-quoted text is unescaped in the same pass.
 */
export function expandValue(source: string, quote: Quote, lookup: (name: string) => string | undefined): Expansion {
  const refs: string[] = [];
  const missing: string[] = [];
  const walk = (s: string): string => {
    let out = "";
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]!;
      const next = s[i + 1];
      if (ch === "\\" && next !== undefined && (next === "$" || (quote === '"' && /[nrt"\\]/.test(next)))) {
        out += ({ n: "\n", r: "\r", t: "\t" } as Record<string, string>)[next] ?? next;
        i++;
        continue;
      }
      if (ch !== "$") {
        out += ch;
        continue;
      }
      const bare = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i + 1))?.[0];
      if (bare) {
        refs.push(bare);
        const v = lookup(bare);
        if (v === undefined) missing.push(bare);
        out += v ?? "";
        i += bare.length;
        continue;
      }
      const close = next === "{" ? matchingBrace(s, i + 1) : -1;
      const m = close > 0 ? /^([A-Za-z_][A-Za-z0-9_]*)(?:(:?-)([\s\S]*))?$/.exec(s.slice(i + 2, close)) : null;
      if (!m) {
        out += ch;
        continue;
      }
      const [, name, op, fallback] = m as unknown as [string, string, string | undefined, string | undefined];
      refs.push(name);
      const v = lookup(name);
      if (op && (v === undefined || (op === ":-" && v === ""))) out += walk(fallback ?? "");
      else {
        if (v === undefined) missing.push(name);
        out += v ?? "";
      }
      i = close;
    }
    return out;
  };
  return { value: walk(source), refs, missing };
}

export function parseDotenv(text: string): DotenvDoc {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = text.endsWith("\n");
  const physical = text === "" ? [] : text.split(/\r?\n/);
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
    const [, indent, exportWord, key, , rest] = m as unknown as [string, string, string | undefined, string, string, string];
    if (!KEY.test(key)) {
      lines.push({ ...base, kind: "invalid", key, problem: `invalid key '${key}'` });
      continue;
    }
    const body = rest.trimStart();
    const q = (["'", '"', "`"] as const).find((c) => body.startsWith(c));
    let value: string;
    let quote: Quote = "";
    let problem: string | undefined;
    let trailing: string | undefined;
    let endLine = i + 1;
    let fullRaw = raw;
    let source: string;

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
      const after = text.slice(end + 1);
      if (after.trim().startsWith("#")) trailing = after;
      else if (after.trim()) problem = "text after the closing quote is ignored";
      source = text.slice(0, end);
      value = q === '"' ? unescapeDouble(source) : source;
      quote = q;
      fullRaw = physical.slice(i, j + 1).join("\n");
      endLine = j + 1;
      i = j;
    } else {
      const comment = /(^|\s+)#.*$/.exec(body);
      if (comment) trailing = comment[0];
      value = body.slice(0, comment?.index ?? body.length).trim();
      source = value;
    }
    const expands = quote !== "'" && expandValue(source, quote, () => "").refs.length > 0;

    lines.push({
      line: base.line,
      endLine,
      raw: fullRaw,
      kind: "entry",
      key,
      value,
      exported: !!exportWord,
      quote,
      trailing,
      indent,
      source,
      expands,
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
  /** Errors are lines loaders reject or misread; warnings are worth a look but load fine. */
  severity: "error" | "warning";
}

type Env = Record<string, string | undefined>;

/**
 * Expanded values of the lines that expand, top to bottom: a reference is
 * looked up in the environment first (loaders keep the shell's value), then in
 * the lines above.
 */
export function expandDotenv(doc: DotenvDoc, env: Env): Map<DotenvLine, Expansion> {
  const out = new Map<DotenvLine, Expansion>();
  const defined = new Map<string, string>();
  for (const l of doc.lines) {
    if (l.kind !== "entry") continue;
    if (l.expands) {
      const x = expandValue(l.source!, l.quote!, (name) => env[name] ?? defined.get(name));
      out.set(l, x);
      defined.set(l.key!, x.value);
    } else defined.set(l.key!, l.value!);
  }
  return out;
}

const list = (names: string[]) => [...new Set(names)].join(", ");

/** Syntax problems, duplicates and expansion warnings, in line order. */
export function dotenvProblems(doc: DotenvDoc, env: Env = {}): DotenvProblem[] {
  const out: DotenvProblem[] = [];
  const seen = new Map<string, number>();
  const expanded = expandDotenv(doc, env);
  for (const l of doc.lines) {
    if (l.problem) out.push({ line: l.line, key: l.key, message: l.problem, severity: "error" });
    if (l.kind !== "entry") continue;
    const first = seen.get(l.key!);
    if (first !== undefined)
      out.push({ line: l.line, key: l.key, message: `duplicate of line ${first}; most loaders keep the last one`, severity: "error" });
    else seen.set(l.key!, l.line);
    const x = expanded.get(l);
    if (!x) continue;
    const unset = x.missing.length ? `; ${list(x.missing)} ${x.missing.length > 1 ? "are" : "is"} not set and expands to empty` : "";
    out.push({ line: l.line, key: l.key, message: `expands ${list(x.refs)}, which not every loader does${unset}`, severity: "warning" });
  }
  return out.sort((a, b) => a.line - b.line);
}

export const errorCount = (problems: DotenvProblem[]) => problems.filter((p) => p.severity === "error").length;

export type KeyStatus = "new" | "same" | "conflict";

export interface DotenvKey {
  key: string;
  line: number;
  /** Value as the file has it, unexpanded. */
  value: string;
  /** Value after $VAR expansion, for lines that expand. */
  expanded?: string;
  /** The expanding text as written, e.g. `${HOST}/api`. */
  template?: string;
  status: KeyStatus;
  /** Value the current environment already has, for same/conflict. */
  current?: string;
}

/**
 * How each key relates to the current environment. Effective values only:
 * for duplicates the last line is used, as dotenv does, after expansion.
 */
export function compareDotenv(doc: DotenvDoc, env: Env): DotenvKey[] {
  const last = new Map<string, DotenvLine>();
  for (const l of doc.lines) if (l.kind === "entry") last.set(l.key!, l);
  const expanded = expandDotenv(doc, env);
  return [...last.values()]
    .sort((a, b) => a.line - b.line)
    .map((l) => {
      const current = env[l.key!];
      const x = expanded.get(l)?.value;
      const value = x ?? l.value!;
      const status: KeyStatus = current === undefined ? "new" : current === value ? "same" : "conflict";
      return { key: l.key!, line: l.line, value: l.value!, ...(x !== undefined && { expanded: x, template: l.source }), status, current };
    });
}

/** Set `key`, rewriting its last line in place (keeping export, quote style, inline comment) or appending it. */
export function setKey(doc: DotenvDoc, key: string, value: string): DotenvDoc {
  const i = doc.lines.findLastIndex((l) => l.kind === "entry" && l.key === key);
  const old = doc.lines[i];
  const quote = old?.quote ?? "";
  const raw = `${old?.indent ?? ""}${old?.exported ? "export " : ""}${key}=${dotenvQuote(value, quote)}${old?.trailing ?? ""}`;
  const parsed = parseDotenv(raw).lines[0]!;
  const line: DotenvLine = { ...parsed, line: old?.line ?? 0, endLine: old?.endLine ?? 0 };
  if (old) return { ...doc, lines: doc.lines.map((l, j) => (j === i ? line : l)) };
  // appending: the file now needs a newline between its old last line and the new one
  return { ...doc, lines: [...doc.lines, line], trailingNewline: true };
}

/** Remove every line for `key`. */
export function unsetKey(doc: DotenvDoc, key: string): DotenvDoc {
  return { ...doc, lines: doc.lines.filter((l) => !(l.kind === "entry" && l.key === key)) };
}
