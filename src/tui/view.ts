// Draws a State as exactly `height` lines of at most `width` columns.
import { basename, relative } from "node:path";
import { isSecret, tilde } from "../format.ts";
import {
  currentTab,
  cursorOf,
  dotenvViews,
  pathViews,
  tabs,
  varViews,
  type DotenvView,
  type PathView,
  type State,
  type TabDef,
  type VarView,
} from "./state.ts";

export interface Style {
  color: boolean;
}

const code = (c: string, on: boolean) => (s: string) => (on && s ? `\x1b[${c}m${s}\x1b[0m` : s);

function styles(on: boolean) {
  return {
    bold: code("1", on),
    dim: code("2", on),
    inverse: code("7", on),
    red: code("31", on),
    green: code("32", on),
    yellow: code("33", on),
    cyan: code("36", on),
  };
}

type Styles = ReturnType<typeof styles>;

/** Cut or pad plain text to exactly `w` columns. */
function cell(s: string, w: number): string {
  if (w <= 0) return "";
  const clean = s.replace(/[\x00-\x1f\x7f]/g, " ");
  const chars = [...clean];
  return chars.length > w ? chars.slice(0, w - 1).join("") + "…" : clean.padEnd(w + (clean.length - chars.length));
}

/** Cut a table row that is wider than the screen; shorter rows are left as they are. */
function clip(s: string, w: number): string {
  return [...s].length > w ? cell(s, w) : s;
}

/** Like cell, but keeps the end: the line number of a location, the tail of a directory. */
function cellEnd(s: string, w: number): string {
  const chars = [...s];
  return chars.length > w ? "…" + chars.slice(chars.length - w + 1).join("") : cell(s, w);
}

const KEYS: Record<TabDef["kind"], string> = {
  vars: "↑↓ move  / filter  enter edit  n new  d unset  o open  u undo  w write  tab next  ? help  q quit",
  path: "↑↓ move  a add front  A add end  d remove  o open  u undo  w write  tab next  ? help  q quit",
  dotenv: "↑↓ move  / filter  enter edit  n new  d delete  o open  u undo  w write  tab next  ? help  q quit",
};

const HELP = [
  "envhound edit: stage changes, then w to review them as a diff and write.",
  "",
  "Variables tab",
  "  enter / e   edit the value (envhound's line comes last, so it wins in login shells)",
  "  n           new variable",
  "  d           unset a variable envhound set, or drop a staged change",
  "  o           open your editor at the line that sets it, then reload",
  "  /           filter by name or value; esc clears",
  "  s           show or hide secret values",
  "",
  "PATH tab",
  "  a / A       add a directory at the front / end of PATH",
  "  d           remove a directory envhound added, or drop a staged change",
  "  o           open the line that adds it",
  "",
  ".env tabs (envhound edit FILE...; ./.env is opened when it exists)",
  "  enter / e   edit a value: only that line changes, comments and quoting are kept",
  "  n / d       add a key / delete every line for a key",
  "  o           open the file at the key's line",
  "",
  "Anywhere",
  "  u undo  ·  w write  ·  tab or 1-9 switch tabs  ·  q or esc quit  ·  ctrl-c quit now",
  "",
  "Press any key to go back.",
];

/** First row to show so that `cursor` stays visible, roughly centred. */
function windowStart(cursor: number, total: number, size: number): number {
  return Math.max(0, Math.min(cursor - Math.floor(size / 2), total - size));
}

function tabLabel(t: TabDef, home: string): string {
  if (t.kind === "vars") return "Variables";
  if (t.kind === "path") return "PATH";
  const rel = relative(process.cwd(), t.file);
  const name = rel && !rel.startsWith("..") ? rel : tilde(t.file, home);
  return name.length > 24 ? basename(t.file) : name;
}

function header(s: State, width: number, c: Styles): string {
  const all = tabs(s);
  const labels = all.map((t, i) => ` ${i + 1} ${tabLabel(t, s.data.home)} `);
  const styled = labels.map((l, i) => (i === s.tab ? c.inverse(l) : c.dim(l))).join(" ");
  const tabsWidth = labels.join(" ").length;
  const stagedText = s.ops.length ? `${s.ops.length} staged · w to write` : "nothing staged";
  const staged = s.ops.length ? c.yellow(stagedText) : c.dim(stagedText);
  // drop parts that don't fit: title, then staged count, then the other tabs
  if (15 + tabsWidth + 3 + stagedText.length <= width) return `${c.bold("envhound edit")}  ${styled}   ${staged}`;
  if (tabsWidth + 1 + stagedText.length <= width) return `${styled} ${staged}`;
  if (tabsWidth <= width) return styled;
  return c.inverse(cell(labels[s.tab]!.trim(), width));
}

export function render(s: State, width: number, height: number, style: Style): string[] {
  const c = styles(style.color);
  const out = [header(s, width, c), c.dim("─".repeat(Math.max(0, width)))];
  const tab = currentTab(s);

  const footer = [c.dim(cell(KEYS[tab.kind], width))];
  if (s.prompt) {
    const shown = s.prompt.secret && !s.showSecrets ? "•".repeat([...s.prompt.value].length) : s.prompt.value;
    const room = Math.max(1, width - s.prompt.label.length - 1);
    const chars = [...shown];
    const visible = chars.length > room ? "…" + chars.slice(chars.length - room + 1).join("") : shown;
    footer.push(c.bold(s.prompt.label) + visible + (style.color ? "\x1b[7m \x1b[0m" : "_"));
  } else if (s.message) {
    footer.push(s.message.error ? c.red(cell(s.message.text, width)) : c.green(cell(s.message.text, width)));
  } else {
    footer.push(c.dim(cell(s.filter ? `filter: ${s.filter}  (esc clears)` : "", width)));
  }

  const bodyHeight = Math.max(0, height - out.length - footer.length - 2);
  let body: string[];
  let detail: string;
  if (s.help) {
    body = HELP.map((l) => cell(l, width));
    detail = "";
  } else if (tab.kind === "vars") {
    body = varLines(s, width, bodyHeight, c);
    detail = varDetail(s);
  } else if (tab.kind === "path") {
    body = pathLines(s, width, bodyHeight, c);
    detail = pathDetail(s);
  } else {
    body = dotenvLines(s, tab.file, width, bodyHeight, c);
    detail = dotenvDetail(s, tab.file);
  }

  for (let i = 0; i < bodyHeight; i++) out.push(body[i] ?? "");
  out.push(c.dim("─".repeat(Math.max(0, width))));
  out.push(cell(detail, width));
  out.push(...footer);
  return out.slice(0, height);
}

function mask(name: string, value: string | undefined, s: State): string {
  if (value === undefined) return "";
  const v = value.replace(/\n/g, "\\n");
  return isSecret(name) && !s.showSecrets ? "********" : tilde(v, s.data.home);
}

/** "value", "old → new", "value  (unset)" */
function pairValue(name: string, r: { value?: string; newValue?: string; pending?: string }, s: State, unsetWord: string): string {
  if (r.pending === "unset") return `${mask(name, r.value, s)}  (${unsetWord})`;
  if (r.pending === "new") return mask(name, r.newValue, s);
  if (r.pending === "set") return `${mask(name, r.value, s)} → ${mask(name, r.newValue, s)}`;
  return mask(name, r.value, s);
}

const markOf = (pending: string | undefined) =>
  pending === "new" || pending === "add" ? "+" : pending === "unset" || pending === "remove" ? "-" : pending ? "*" : " ";

function varLines(s: State, width: number, height: number, c: Styles): string[] {
  const rows = varViews(s);
  if (!rows.length) return [c.dim(s.filter ? "no variable matches the filter" : "no variables")];
  const nameW = Math.min(28, Math.max(8, ...rows.map((r) => r.name.length)));
  const byW = Math.min(32, Math.max(6, ...rows.map((r) => r.by.length)));
  const valueW = Math.max(10, width - nameW - byW - 6);
  const list = height - 1;
  const cursor = cursorOf(s);
  const start = windowStart(cursor, rows.length, list);
  const lines = [c.bold(clip(`  ${cell("NAME", nameW)}  ${cell("SET BY", byW)}  VALUE`, width))];
  rows.slice(start, start + list).forEach((r: VarView, i) => {
    const plain = clip(`${markOf(r.pending)} ${cell(r.name, nameW)}  ${cellEnd(r.by, byW)}  ${cell(pairValue(r.name, r, s, "unset"), valueW)}`, width);
    const color = r.pending === "unset" ? c.red : r.pending ? c.yellow : r.managed ? c.cyan : r.by.startsWith("(") ? c.dim : (x: string) => x;
    lines.push(start + i === cursor ? c.inverse(plain) : color(plain));
  });
  return lines;
}

function varDetail(s: State): string {
  const r = varViews(s)[cursorOf(s)];
  if (!r) return "";
  const from = r.managed
    ? "set by envhound"
    : r.source
      ? `set at ${r.by}`
      : r.by === "(inherited)"
        ? "inherited from the program that started this shell"
        : "set by login or bash";
  return `${r.name}: ${from}${r.pending ? `, staged: ${r.pending}` : ""}`;
}

function pathLines(s: State, width: number, height: number, c: Styles): string[] {
  const rows = pathViews(s);
  if (!rows.length) return [c.dim("PATH is empty")];
  const dirW = Math.min(60, Math.max(9, ...rows.map((r) => tilde(r.dir, s.data.home).length)));
  const byW = Math.min(32, Math.max(8, ...rows.map((r) => r.by.length)));
  const list = height - 1;
  const cursor = cursorOf(s);
  const start = windowStart(cursor, rows.length, list);
  const lines = [c.bold(clip(`   #  ${cell("DIRECTORY", dirW)}  ${cell("ADDED BY", byW)}`, width))];
  rows.slice(start, start + list).forEach((r: PathView, i) => {
    const index = start + i;
    const flag = r.pending ? `staged: ${r.pending}` : r.duplicateOf ? `duplicate of #${r.duplicateOf}` : !r.exists ? "missing" : "";
    const plain = clip(`${markOf(r.pending)} ${String(index + 1).padStart(2)}  ${cellEnd(tilde(r.dir, s.data.home), dirW)}  ${cellEnd(r.by, byW)}  ${cell(flag, Math.max(0, width - dirW - byW - 10))}`, width);
    const color = r.pending === "remove" ? c.red : r.pending ? c.yellow : flag ? c.red : r.managed ? c.cyan : r.by.startsWith("(") ? c.dim : (x: string) => x;
    lines.push(index === cursor ? c.inverse(plain) : color(plain));
  });
  return lines;
}

function pathDetail(s: State): string {
  const r = pathViews(s)[cursorOf(s)];
  if (!r) return "";
  const from = r.managed
    ? "added by envhound"
    : r.source
      ? `added at ${r.by}`
      : r.by === "(initial)"
        ? "in the initial PATH bash starts with"
        : "inherited from the program that started this shell";
  return `${tilde(r.dir, s.data.home)}: ${from}`;
}

/** What a .env row means next to the shell, duplicates and problems first. */
function dotenvStatus(r: DotenvView, s: State): string {
  if (r.pending) return `staged: ${r.pending === "unset" ? "delete" : r.pending}`;
  if (r.problem) return r.problem;
  if (r.count > 1) return `defined ${r.count} times`;
  if (r.status === "conflict") return `shell has ${mask(r.key, r.current, s)}`;
  return r.status === "same" ? "same as shell" : "";
}

function dotenvLines(s: State, file: string, width: number, height: number, c: Styles): string[] {
  const rows = dotenvViews(s, file);
  const data = s.data.dotenv.find((d) => d.file === file);
  if (!rows.length) {
    if (s.filter) return [c.dim("no key matches the filter")];
    return [c.dim(data?.exists ? "no keys in this file: n adds one" : "this file does not exist yet: n adds a key, w creates it")];
  }
  const keyW = Math.min(28, Math.max(3, ...rows.map((r) => r.key.length)));
  const valueW = Math.max(10, Math.min(48, width - keyW - 32));
  const statusW = Math.max(0, width - keyW - valueW - 12);
  const list = height - 1;
  const cursor = cursorOf(s);
  const start = windowStart(cursor, rows.length, list);
  const lines = [c.bold(clip(`  ${cell("KEY", keyW)}  LINE  ${cell("VALUE", valueW)}  `, width))];
  rows.slice(start, start + list).forEach((r, i) => {
    const status = dotenvStatus(r, s);
    const line = r.line ? String(r.line).padStart(4) : "    ";
    const plain = clip(`${markOf(r.pending)} ${cell(r.key, keyW)}  ${line}  ${cell(pairValue(r.key, r, s, "delete"), valueW)}  ${cell(status, statusW)}`, width);
    const color =
      r.pending === "unset"
        ? c.red
        : r.pending
          ? c.yellow
          : r.problem || r.count > 1
            ? c.red
            : r.status === "conflict"
              ? c.yellow
              : r.status === "same"
                ? c.dim
                : (x: string) => x;
    lines.push(start + i === cursor ? c.inverse(plain) : color(plain));
  });
  return lines;
}

function dotenvDetail(s: State, file: string): string {
  const data = s.data.dotenv.find((d) => d.file === file);
  const where = tilde(file, s.data.home);
  const problems = data?.problems ? ` · ${data.problems} problem(s), see envhound dotenv` : "";
  const r = dotenvViews(s, file)[cursorOf(s)];
  if (!r) return `${where}${data?.exists ? "" : " (new file)"}${problems}`;
  const at = r.line ? `line ${r.line} of ${where}` : `new in ${where}`;
  const conflict = r.status === "conflict" ? ": loaders such as dotenv keep the shell's value" : "";
  return `${r.key}: ${at}${conflict}${problems}`;
}
