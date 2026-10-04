// State and key handling for `rcenv edit`. Pure: no terminal access, so it is
// tested directly. Changes are only staged here; writing reuses `rcenv set`.
import { isAbsolute, resolve } from "node:path";
import { isSecret, tilde } from "../format.ts";
import type { Location } from "../model.ts";
import type { EditOp } from "../set.ts";

export type Tab = "vars" | "path";

export interface VarRow {
  name: string;
  value: string | undefined;
  /** "~/.profile:3", "(inherited)", ... */
  by: string;
  source?: Location;
  /** set by rcenv's own file, so rcenv can change or remove it */
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

export interface Data {
  home: string;
  vars: VarRow[];
  path: PathRow[];
}

export type PromptKind =
  | { kind: "filter" }
  | { kind: "edit"; name: string }
  | { kind: "new-name" }
  | { kind: "new-value"; name: string }
  | { kind: "path-add"; position: "front" | "back" };

export interface State {
  data: Data;
  tab: Tab;
  ops: EditOp[];
  cursor: Record<Tab, number>;
  filter: string;
  prompt?: { for: PromptKind; label: string; value: string; secret?: boolean };
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

export function initialState(data: Data, showSecrets = false): State {
  return { data, tab: "vars", ops: [], cursor: { vars: 0, path: 0 }, filter: "", confirmQuit: false, help: false, showSecrets, pageSize: 10 };
}

// ---- rows as displayed: data plus staged changes ----

export interface VarView extends VarRow {
  pending?: "set" | "unset" | "new";
  newValue?: string;
}

export interface PathView extends PathRow {
  pending?: "add" | "remove";
}

export function varViews(s: State): VarView[] {
  const rows: VarView[] = s.data.vars.map((r) => ({ ...r }));
  for (const op of s.ops) {
    if (op.kind !== "set" && op.kind !== "unset") continue;
    const row = rows.find((r) => r.name === op.name);
    if (op.kind === "unset") {
      if (row) row.pending = "unset";
    } else if (row) {
      row.pending = "set";
      row.newValue = op.value;
    } else {
      rows.push({ name: op.name, value: undefined, by: "rcenv", managed: true, pending: "new", newValue: op.value });
    }
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  const f = s.filter.toLowerCase();
  return f ? rows.filter((r) => r.name.toLowerCase().includes(f) || (r.newValue ?? r.value ?? "").toLowerCase().includes(f)) : rows;
}

export function pathViews(s: State): PathView[] {
  const rows: PathView[] = s.data.path.map((r) => ({ ...r }));
  for (const op of s.ops) {
    if (op.kind === "path-remove") {
      for (const r of rows) if (r.dir === op.dir) r.pending = "remove";
    } else if (op.kind === "path-add") {
      const row: PathView = { dir: op.dir, by: "rcenv", managed: true, exists: true, pending: "add" };
      if (op.position === "front") rows.unshift(row);
      else rows.push(row);
    }
  }
  return rows;
}

const rowCount = (s: State) => (s.tab === "vars" ? varViews(s).length : pathViews(s).length);

// ---- staging ----

const target = (op: EditOp) => (op.kind === "set" || op.kind === "unset" ? `var:${op.name}` : `path:${op.dir}`);

/** Stage an op, replacing earlier ops on the same variable or directory. */
function stage(s: State, op: EditOp, text: string): State {
  const ops = s.ops.filter((o) => target(o) !== target(op));
  return { ...s, ops: [...ops, op], message: { text } };
}

/** Drop staged ops on a target, e.g. unsetting a variable that was only staged. */
function unstage(s: State, t: string, text: string): State {
  return { ...s, ops: s.ops.filter((o) => target(o) !== t), message: { text } };
}

const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function expandDir(input: string, home: string): string {
  const d = input.trim().replace(/^~(?=\/|$)/, home);
  return isAbsolute(d) ? resolve(d) : resolve(process.cwd(), d);
}

function submitPrompt(s: State): State {
  const p = s.prompt!;
  const closed: State = { ...s, prompt: undefined };
  switch (p.for.kind) {
    case "filter":
      return { ...closed, filter: p.value };
    case "edit":
      return stage(closed, { kind: "set", name: p.for.name, value: p.value }, `${p.for.name} will be set`);
    case "new-name": {
      const name = p.value.trim();
      if (!SHELL_NAME.test(name)) return { ...s, message: { text: `'${name}' is not a valid variable name`, error: true } };
      if (name === "PATH") return { ...closed, message: { text: "use the PATH tab to change PATH", error: true } };
      const existing = s.data.vars.find((r) => r.name === name);
      return { ...closed, prompt: { for: { kind: "new-value", name }, label: `${name}=`, value: existing?.value ?? "", secret: isSecret(name) } };
    }
    case "new-value":
      return stage(closed, { kind: "set", name: p.for.name, value: p.value }, `${p.for.name} will be set`);
    case "path-add": {
      if (!p.value.trim()) return closed;
      const dir = expandDir(p.value, s.data.home);
      const shown = tilde(dir, s.data.home);
      if (s.data.path.some((r) => r.dir === dir)) return { ...closed, message: { text: `${shown} is already in PATH`, error: true } };
      return stage(closed, { kind: "path-add", dir, position: p.for.position }, `${shown} will be added`);
    }
  }
}

function promptKey(s: State, key: Key): State {
  const p = s.prompt!;
  const set = (value: string): State => {
    const next = { ...s, prompt: { ...p, value } };
    // the filter applies as you type
    return p.for.kind === "filter" ? { ...next, filter: value, cursor: { ...s.cursor, vars: 0 } } : next;
  };
  if (key.name === "escape") return { ...s, prompt: undefined, filter: p.for.kind === "filter" ? "" : s.filter };
  if (key.name === "return" || key.name === "enter") return submitPrompt(s);
  if (key.name === "backspace") return set([...p.value].slice(0, -1).join(""));
  if (key.ctrl && key.name === "u") return set("");
  if (key.ch && !key.ctrl) return set(p.value + key.ch);
  return s;
}

function move(s: State, to: number): State {
  const max = Math.max(0, rowCount(s) - 1);
  return { ...s, cursor: { ...s.cursor, [s.tab]: Math.min(max, Math.max(0, to)) } };
}

function varKey(s: State, key: Key): [State, Effect?] {
  const row = varViews(s)[s.cursor.vars];
  switch (key.ch) {
    case "/":
      return [{ ...s, prompt: { for: { kind: "filter" }, label: "filter: ", value: s.filter } }];
    case "n":
      return [{ ...s, prompt: { for: { kind: "new-name" }, label: "new variable name: ", value: "" } }];
    case "s":
      return [{ ...s, showSecrets: !s.showSecrets }];
  }
  if (!row) return [s];
  if (key.ch === "e" || key.name === "return" || key.name === "enter") {
    const value = row.newValue ?? row.value ?? "";
    return [{ ...s, prompt: { for: { kind: "edit", name: row.name }, label: `${row.name}=`, value, secret: isSecret(row.name) } }];
  }
  if (key.ch === "d") {
    if (row.pending === "new") return [unstage(s, `var:${row.name}`, `${row.name} will not be added`)];
    if (row.managed) return [stage(s, { kind: "unset", name: row.name }, `${row.name} will be removed from rcenv's file`)];
    if (row.pending === "set") return [unstage(s, `var:${row.name}`, `change to ${row.name} dropped`)];
    return [{ ...s, message: { text: notOurs(row.name, row), error: true } }];
  }
  if (key.ch === "o") return open(s, row);
  return [s];
}

function pathKey(s: State, key: Key): [State, Effect?] {
  if (key.ch === "a" || key.ch === "A") {
    const position = key.ch === "a" ? "front" : "back";
    return [{ ...s, prompt: { for: { kind: "path-add", position }, label: `add to the ${position} of PATH: `, value: "" } }];
  }
  const row = pathViews(s)[s.cursor.path];
  if (!row) return [s];
  if (key.ch === "d") {
    if (row.pending) return [unstage(s, `path:${row.dir}`, `change to ${row.dir} dropped`)];
    if (row.managed) return [stage(s, { kind: "path-remove", dir: row.dir }, `${row.dir} will be removed`)];
    return [{ ...s, message: { text: notOurs(tilde(row.dir, s.data.home), row), error: true } }];
  }
  if (key.ch === "o") return open(s, row);
  return [s];
}

function notOurs(what: string, row: { by: string; source?: Location }): string {
  if (row.source) return `${what} comes from ${row.by}, not rcenv: press o to open that line`;
  return `${what} ${row.by === "(inherited)" ? "comes from the program that started this shell" : "is set by login or bash itself"}`;
}

function open(s: State, row: { source?: Location }): [State, Effect?] {
  if (!row.source) return [{ ...s, message: { text: "not set by a startup file, nothing to open", error: true } }];
  return [s, { kind: "open", at: row.source }];
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
  if (key.name === "tab" || key.ch === "1" || key.ch === "2") {
    const tab: Tab = key.ch === "1" ? "vars" : key.ch === "2" ? "path" : s.tab === "vars" ? "path" : "vars";
    return [{ ...s, tab }];
  }
  if (key.ch === "?") return [{ ...s, help: true }];
  if (key.ch === "w") return s.ops.length ? [s, { kind: "write" }] : [{ ...s, message: { text: "nothing staged yet" } }];
  if (key.ch === "u") {
    const last = s.ops.at(-1);
    if (!last) return [{ ...s, message: { text: "nothing to undo" } }];
    return [{ ...s, ops: s.ops.slice(0, -1), message: { text: "undone" } }];
  }

  const at = s.cursor[s.tab];
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

  const [next, effect] = s.tab === "vars" ? varKey(s, key) : pathKey(s, key);
  // staging can add or remove rows: keep the cursor in range
  return [move(next, next.cursor[next.tab]), effect];
}
