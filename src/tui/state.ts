// State and key handling for `envhound edit`. Pure: no terminal access, so it is
// tested directly. Changes are only staged here; writing reuses `envhound set`.
import { isAbsolute, resolve } from "node:path";
import { isSecret, tilde } from "../format.ts";
import type { Location } from "../model.ts";
import type { EditOp } from "../set.ts";

export interface VarRow {
  name: string;
  value: string | undefined;
  /** "~/.profile:3", "(inherited)", ... */
  by: string;
  source?: Location;
  /** set by envhound's own file, so envhound can change or remove it */
  managed: boolean;
}

export interface PathRow {
  dir: string;
  by: string;
  source?: Location;
  managed: boolean;
  exists: boolean;
  duplicateOf?: number;
}

export interface DotenvRow {
  key: string;
  /** effective value as written: the last line for this key */
  value: string;
  /** value after $VAR expansion, for lines that expand */
  expanded?: string;
  /** the expanding text as written, e.g. `${HOST}/api` */
  template?: string;
  line: number;
  /** compared with the current shell */
  status: "new" | "same" | "conflict";
  current?: string;
  /** lines defining this key; more than one is a duplicate */
  count: number;
  problem?: string;
  /** the problem is a warning: the line loads fine */
  warning?: boolean;
}

export interface DotenvData {
  file: string;
  exists: boolean;
  rows: DotenvRow[];
  /** errors */
  problems: number;
  warnings?: number;
}

export interface Data {
  home: string;
  vars: VarRow[];
  path: PathRow[];
  dotenv: DotenvData[];
}

export type TabDef = { kind: "vars" } | { kind: "path" } | { kind: "dotenv"; file: string };

export type PromptKind =
  | { kind: "filter" }
  | { kind: "edit"; name: string; file?: string }
  | { kind: "new-name"; file?: string }
  | { kind: "new-value"; name: string; file?: string }
  | { kind: "path-add"; position: "front" | "back" };

export interface State {
  data: Data;
  /** index into tabs(state) */
  tab: number;
  ops: EditOp[];
  /** cursor per tab, by tabId */
  cursor: Record<string, number>;
  filter: string;
  /** reveal: the last character was just typed and shows unmasked; the terminal driver clears it after a moment */
  prompt?: { for: PromptKind; label: string; value: string; secret?: boolean; reveal?: boolean };
  message?: { text: string; error?: boolean };
  /** q was pressed once with pending changes */
  confirmQuit: boolean;
  help: boolean;
  showSecrets: boolean;
  /** rows that fit on screen, for page up/down; set by the terminal driver */
  pageSize: number;
}

export interface Key {
  /** readline key name: up, down, return, escape, tab, backspace, ... */
  name?: string;
  /** printable character typed, if any */
  ch?: string;
  ctrl?: boolean;
}

export type Effect = { kind: "quit" } | { kind: "write" } | { kind: "open"; at: Location };

export function tabs(s: State): TabDef[] {
  return [{ kind: "vars" }, { kind: "path" }, ...s.data.dotenv.map((d): TabDef => ({ kind: "dotenv", file: d.file }))];
}

export const tabId = (t: TabDef) => (t.kind === "dotenv" ? `dotenv:${t.file}` : t.kind);
export const currentTab = (s: State): TabDef => tabs(s)[s.tab] ?? { kind: "vars" };
export const cursorOf = (s: State) => s.cursor[tabId(currentTab(s))] ?? 0;

export function initialState(data: Data, opts: { showSecrets?: boolean; tab?: number } = {}): State {
  return {
    data,
    tab: opts.tab ?? 0,
    ops: [],
    cursor: {},
    filter: "",
    confirmQuit: false,
    help: false,
    showSecrets: opts.showSecrets ?? false,
    pageSize: 10,
  };
}

// ---- rows as displayed: data plus staged changes ----

export interface VarView extends VarRow {
  pending?: "set" | "unset" | "new";
  newValue?: string;
}

export interface PathView extends PathRow {
  pending?: "add" | "remove";
}

export interface DotenvView extends DotenvRow {
  pending?: "set" | "unset" | "new";
  newValue?: string;
}

function matches(s: State, ...texts: (string | undefined)[]): boolean {
  const f = s.filter.toLowerCase();
  return !f || texts.some((t) => t?.toLowerCase().includes(f));
}

export function varViews(s: State): VarView[] {
  const rows: VarView[] = s.data.vars.map((r) => ({ ...r }));
  for (const op of s.ops) {
    if ((op.kind !== "set" && op.kind !== "unset") || op.file) continue;
    const row = rows.find((r) => r.name === op.name);
    if (op.kind === "unset") {
      if (row) row.pending = "unset";
    } else if (row) {
      row.pending = "set";
      row.newValue = op.value;
    } else {
      rows.push({ name: op.name, value: undefined, by: "envhound", managed: true, pending: "new", newValue: op.value });
    }
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows.filter((r) => matches(s, r.name, r.newValue ?? r.value));
}

export function pathViews(s: State): PathView[] {
  const rows: PathView[] = s.data.path.map((r) => ({ ...r }));
  for (const op of s.ops) {
    if (op.kind === "path-remove") {
      for (const r of rows) if (r.dir === op.dir) r.pending = "remove";
    } else if (op.kind === "path-add") {
      const row: PathView = { dir: op.dir, by: "envhound", managed: true, exists: true, pending: "add" };
      if (op.position === "front") rows.unshift(row);
      else rows.push(row);
    }
  }
  return rows;
}

export function dotenvViews(s: State, file: string): DotenvView[] {
  const data = s.data.dotenv.find((d) => d.file === file);
  const rows: DotenvView[] = (data?.rows ?? []).map((r) => ({ ...r }));
  for (const op of s.ops) {
    if ((op.kind !== "set" && op.kind !== "unset") || op.file !== file) continue;
    const row = rows.find((r) => r.key === op.name);
    if (op.kind === "unset") {
      if (row) row.pending = "unset";
    } else if (row) {
      row.pending = "set";
      row.newValue = op.value;
    } else {
      rows.push({ key: op.name, value: "", line: 0, status: "new", count: 0, pending: "new", newValue: op.value });
    }
  }
  return rows.filter((r) => matches(s, r.key, r.newValue ?? r.value));
}

function rowCount(s: State): number {
  const t = currentTab(s);
  return t.kind === "vars" ? varViews(s).length : t.kind === "path" ? pathViews(s).length : dotenvViews(s, t.file).length;
}

// ---- staging ----

function target(op: EditOp): string {
  if (op.kind === "set" || op.kind === "unset") return `${op.file ?? "shell"}:${op.name}`;
  return `path:${op.dir}`;
}

/** Stage an op, replacing earlier ops on the same variable, key or directory. */
function stage(s: State, op: EditOp, text: string): State {
  const ops = s.ops.filter((o) => target(o) !== target(op));
  return { ...s, ops: [...ops, op], message: { text } };
}

/** Drop staged ops on the same target as `op`. */
function unstage(s: State, op: EditOp, text: string): State {
  return { ...s, ops: s.ops.filter((o) => target(o) !== target(op)), message: { text } };
}

const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DOTENV_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function expandDir(input: string, home: string): string {
  const d = input.trim().replace(/^~(?=\/|$)/, home);
  return isAbsolute(d) ? resolve(d) : resolve(process.cwd(), d);
}

const short = (s: State, path: string) => tilde(path, s.data.home);

function submitPrompt(s: State): State {
  const p = s.prompt!;
  const closed: State = { ...s, prompt: undefined };
  switch (p.for.kind) {
    case "filter":
      return { ...closed, filter: p.value };
    case "edit":
    case "new-value": {
      const { name, file } = p.for;
      return stage(closed, { kind: "set", name, value: p.value, file }, `${name} will be set${file ? ` in ${short(s, file)}` : ""}`);
    }
    case "new-name": {
      const name = p.value.trim();
      const file = p.for.file;
      if (!(file ? DOTENV_NAME : SHELL_NAME).test(name))
        return { ...s, message: { text: `'${name}' is not a valid ${file ? "key" : "variable name"}`, error: true } };
      if (name === "PATH" && !file) return { ...closed, message: { text: "use the PATH tab to change PATH", error: true } };
      const existing = file
        ? s.data.dotenv.find((d) => d.file === file)?.rows.find((r) => r.key === name)?.value
        : s.data.vars.find((r) => r.name === name)?.value;
      return { ...closed, prompt: { for: { kind: "new-value", name, file }, label: `${name}=`, value: existing ?? "", secret: isSecret(name) } };
    }
    case "path-add": {
      if (!p.value.trim()) return closed;
      const dir = expandDir(p.value, s.data.home);
      if (s.data.path.some((r) => r.dir === dir)) return { ...closed, message: { text: `${short(s, dir)} is already in PATH`, error: true } };
      return stage(closed, { kind: "path-add", dir, position: p.for.position }, `${short(s, dir)} will be added`);
    }
  }
}

function promptKey(s: State, key: Key): State {
  const p = s.prompt!;
  const set = (value: string, reveal = false): State => {
    const next = { ...s, prompt: { ...p, value, reveal } };
    // the filter applies as you type
    return p.for.kind === "filter" ? { ...next, filter: value, cursor: { ...s.cursor, [tabId(currentTab(s))]: 0 } } : next;
  };
  if (key.name === "escape") return { ...s, prompt: undefined, filter: p.for.kind === "filter" ? "" : s.filter };
  if (key.name === "return" || key.name === "enter") return submitPrompt(s);
  if (key.name === "backspace") return set([...p.value].slice(0, -1).join(""));
  if (key.ctrl && key.name === "u") return set("");
  if (key.ch && !key.ctrl) return set(p.value + key.ch, true);
  return s;
}

function move(s: State, to: number): State {
  const max = Math.max(0, rowCount(s) - 1);
  return { ...s, cursor: { ...s.cursor, [tabId(currentTab(s))]: Math.min(max, Math.max(0, to)) } };
}

interface Pair {
  name: string;
  /** current value, staged one included */
  value: string;
  source?: Location;
}

/** Keys shared by the Variables and .env tabs, which both list NAME=value pairs. */
function pairKey(s: State, key: Key, row: Pair | undefined, file: string | undefined, remove: () => State): [State, Effect?] {
  switch (key.ch) {
    case "/":
      return [{ ...s, prompt: { for: { kind: "filter" }, label: "filter: ", value: s.filter } }];
    case "n":
      return [{ ...s, prompt: { for: { kind: "new-name", file }, label: file ? "new key: " : "new variable name: ", value: "" } }];
    case "s":
      return [{ ...s, showSecrets: !s.showSecrets }];
  }
  if (!row) return [s];
  if (key.ch === "e" || key.name === "return" || key.name === "enter")
    return [{ ...s, prompt: { for: { kind: "edit", name: row.name, file }, label: `${row.name}=`, value: row.value, secret: isSecret(row.name) } }];
  if (key.ch === "d") return [remove()];
  if (key.ch === "o") {
    if (!row.source)
      return [{ ...s, message: { text: file ? "not in the file yet: write first" : "not set by a startup file, nothing to open", error: true } }];
    return [s, { kind: "open", at: row.source }];
  }
  return [s];
}

function varKey(s: State, key: Key): [State, Effect?] {
  const row = varViews(s)[cursorOf(s)];
  const pair = row && { name: row.name, value: row.newValue ?? row.value ?? "", source: row.source };
  return pairKey(s, key, pair, undefined, () => {
    const r = row!;
    const op: EditOp = { kind: "unset", name: r.name };
    // d on a staged change drops it, except on envhound's own variables where it stages the removal
    if (r.pending === "new" || r.pending === "unset" || (r.pending === "set" && !r.managed))
      return unstage(s, op, `change to ${r.name} dropped`);
    if (r.managed) return stage(s, op, `${r.name} will be removed from envhound's file`);
    return { ...s, message: { text: notOurs(r.name, r), error: true } };
  });
}

function dotenvKey(s: State, key: Key, file: string): [State, Effect?] {
  const row = dotenvViews(s, file)[cursorOf(s)];
  const pair = row && { name: row.key, value: row.newValue ?? row.value, source: row.line ? { file, line: row.line } : undefined };
  return pairKey(s, key, pair, file, () => {
    const r = row!;
    const op: EditOp = { kind: "unset", name: r.key, file };
    if (r.pending) return unstage(s, op, `change to ${r.key} dropped`);
    return stage(s, op, `${r.key} will be deleted from ${short(s, file)}`);
  });
}

function pathKey(s: State, key: Key): [State, Effect?] {
  if (key.ch === "a" || key.ch === "A") {
    const position = key.ch === "a" ? "front" : "back";
    return [{ ...s, prompt: { for: { kind: "path-add", position }, label: `add to the ${position} of PATH: `, value: "" } }];
  }
  const row = pathViews(s)[cursorOf(s)];
  if (!row) return [s];
  if (key.ch === "d") {
    const op: EditOp = { kind: "path-remove", dir: row.dir };
    if (row.pending) return [unstage(s, op, `change to ${short(s, row.dir)} dropped`)];
    if (row.managed) return [stage(s, op, `${short(s, row.dir)} will be removed`)];
    return [{ ...s, message: { text: notOurs(short(s, row.dir), row), error: true } }];
  }
  if (key.ch === "o") {
    if (!row.source) return [{ ...s, message: { text: "not added by a startup file, nothing to open", error: true } }];
    return [s, { kind: "open", at: row.source }];
  }
  return [s];
}

function notOurs(what: string, row: { by: string; source?: Location }): string {
  if (row.source) return `${what} comes from ${row.by}, not envhound: press o to open that line`;
  return `${what} ${row.by === "(inherited)" ? "comes from the program that started this shell" : "is set by login or bash itself"}`;
}

export function handleKey(state: State, key: Key): [State, Effect?] {
  if (key.ctrl && key.name === "c") return [state, { kind: "quit" }];
  if (state.prompt) return [promptKey(state, key)];

  // any key but a second q cancels a pending quit
  const s: State = { ...state, message: undefined, confirmQuit: false };
  if (state.help) return [{ ...s, help: false }];

  if (key.ch === "q" || (key.name === "escape" && !state.filter)) {
    if (state.ops.length && !state.confirmQuit)
      return [{ ...s, confirmQuit: true, message: { text: `${state.ops.length} staged change(s) will be lost: q again to quit, w to write`, error: true } }];
    return [s, { kind: "quit" }];
  }
  if (key.name === "escape") return [{ ...s, filter: "" }];
  const count = tabs(s).length;
  if (key.name === "tab") return [{ ...s, tab: (s.tab + 1) % count }];
  if (key.ch && /^[1-9]$/.test(key.ch) && Number(key.ch) <= count) return [{ ...s, tab: Number(key.ch) - 1 }];
  if (key.ch === "?") return [{ ...s, help: true }];
  if (key.ch === "w") return s.ops.length ? [s, { kind: "write" }] : [{ ...s, message: { text: "nothing staged yet" } }];
  if (key.ch === "u") {
    if (!s.ops.length) return [{ ...s, message: { text: "nothing to undo" } }];
    return [move({ ...s, ops: s.ops.slice(0, -1), message: { text: "undone" } }, cursorOf(s))];
  }

  const at = cursorOf(s);
  switch (key.name) {
    case "up":
      return [move(s, at - 1)];
    case "down":
      return [move(s, at + 1)];
    case "pageup":
      return [move(s, at - s.pageSize)];
    case "pagedown":
      return [move(s, at + s.pageSize)];
    case "home":
      return [move(s, 0)];
    case "end":
      return [move(s, Infinity)];
  }
  if (key.ch === "k") return [move(s, at - 1)];
  if (key.ch === "j") return [move(s, at + 1)];
  if (key.ch === "g") return [move(s, 0)];
  if (key.ch === "G") return [move(s, Infinity)];

  const t = currentTab(s);
  const [next, effect] = t.kind === "vars" ? varKey(s, key) : t.kind === "path" ? pathKey(s, key) : dotenvKey(s, key, t.file);
  // staging can add or remove rows: keep the cursor in range
  return [move(next, cursorOf(next)), effect];
}
