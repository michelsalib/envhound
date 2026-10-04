// Draws a State as exactly `height` lines of at most `width` columns.
import { isSecret, tilde } from "../format.ts";
import { pathViews, varViews, type PathView, type State, type VarView } from "./state.ts";

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

/** Cut or pad plain text to exactly `w` columns. */
function cell(s: string, w: number): string {
  if (w <= 0) return "";
  const clean = s.replace(/[\x00-\x1f\x7f]/g, " ");
  const chars = [...clean];
  return chars.length > w ? chars.slice(0, w - 1).join("") + "…" : clean.padEnd(w + (clean.length - chars.length));
}

/** Like cell, but keeps the end: the line number of a location, the tail of a directory. */
function cellEnd(s: string, w: number): string {
  const chars = [...s];
  return chars.length > w ? "…" + chars.slice(chars.length - w + 1).join("") : cell(s, w);
}

const KEYS: Record<State["tab"], string> = {
  vars: "↑↓ move  / filter  enter edit  n new  d unset  o open  u undo  w write  tab PATH  ? help  q quit",
  path: "↑↓ move  a add front  A add end  d remove  o open  u undo  w write  tab variables  ? help  q quit",
};

const HELP = [
  "rcenv edit: stage changes, then w to review them as a diff and write.",
  "",
  "Variables tab",
  "  enter / e   edit the value (rcenv's line comes last, so it wins in login shells)",
  "  n           new variable",
  "  d           unset a variable rcenv set, or drop a staged change",
  "  o           open your editor at the line that sets it, then reload",
  "  /           filter by name or value; esc clears",
  "  s           show or hide secret values",
  "",
  "PATH tab",
  "  a / A       add a directory at the front / end of PATH",
  "  d           remove a directory rcenv added, or drop a staged change",
  "  o           open the line that adds it",
  "",
  "Anywhere",
  "  u undo  ·  w write  ·  tab / 1 / 2 switch tabs  ·  q or esc quit  ·  ctrl-c quit now",
  "",
  "rcenv never rewrites your startup files: for their lines, o opens them in $EDITOR.",
  "",
  "Press any key to go back.",
];

/** First row to show so that `cursor` stays visible, roughly centred. */
function windowStart(cursor: number, total: number, size: number): number {
  return Math.max(0, Math.min(cursor - Math.floor(size / 2), total - size));
}

export function render(s: State, width: number, height: number, style: Style): string[] {
  const c = styles(style.color);
  const out: string[] = [];

  // header: tabs and staged count, dropping parts that don't fit
  const tab = (label: string, active: boolean) => (active ? c.inverse(` ${label} `) : c.dim(` ${label} `));
  const stagedText = s.ops.length ? `${s.ops.length} staged · w to write` : "nothing staged";
  const staged = s.ops.length ? c.yellow(stagedText) : c.dim(stagedText);
  const tabs = `${tab("1 Variables", s.tab === "vars")} ${tab("2 PATH", s.tab === "path")}`;
  const tabsWidth = " 1 Variables   2 PATH ".length;
  if (12 + tabsWidth + 3 + stagedText.length <= width) out.push(`${c.bold("rcenv edit")}  ${tabs}   ${staged}`);
  else if (tabsWidth + 1 + stagedText.length <= width) out.push(`${tabs} ${staged}`);
  else if (tabsWidth <= width) out.push(tabs);
  else out.push(cell(s.tab === "vars" ? "Variables" : "PATH", width));
  out.push(c.dim("─".repeat(Math.max(0, width))));

  const footer: string[] = [];
  if (s.prompt) {
    const shown = s.prompt.secret && !s.showSecrets ? "•".repeat([...s.prompt.value].length) : s.prompt.value;
    const room = Math.max(1, width - s.prompt.label.length - 1);
    const chars = [...shown];
    footer.push(c.bold(s.prompt.label) + (chars.length > room ? "…" + chars.slice(chars.length - room + 1).join("") : shown) + (style.color ? "\x1b[7m \x1b[0m" : "_"));
  } else if (s.message) {
    footer.push(s.message.error ? c.red(cell(s.message.text, width)) : c.green(cell(s.message.text, width)));
  } else {
    footer.push(c.dim(cell(s.filter ? `filter: ${s.filter}  (esc clears)` : "", width)));
  }
  footer.unshift(c.dim(cell(KEYS[s.tab], width)));

  const bodyHeight = Math.max(0, height - out.length - footer.length - 2);
  const body = s.help
    ? HELP.map((l) => cell(l, width))
    : s.tab === "vars"
      ? varLines(s, width, bodyHeight, c)
      : pathLines(s, width, bodyHeight, c);
  const detail = s.help ? "" : s.tab === "vars" ? varDetail(s) : pathDetail(s);

  for (let i = 0; i < bodyHeight; i++) out.push(body[i] ?? "");
  out.push(c.dim("─".repeat(Math.max(0, width))));
  out.push(cell(detail, width));
  out.push(...footer);
  return out.slice(0, height);
}

type Styles = ReturnType<typeof styles>;

function varLines(s: State, width: number, height: number, c: Styles): string[] {
  const rows = varViews(s);
  if (!rows.length) return [c.dim(s.filter ? "no variable matches the filter" : "no variables")];
  const nameW = Math.min(28, Math.max(8, ...rows.map((r) => r.name.length)));
  const byW = Math.min(32, Math.max(6, ...rows.map((r) => r.by.length)));
  const valueW = Math.max(10, width - nameW - byW - 6);
  const list = height - 1;
  const start = windowStart(s.cursor.vars, rows.length, list);
  const lines = [c.bold(`  ${cell("NAME", nameW)}  ${cell("SET BY", byW)}  VALUE`)];
  rows.slice(start, start + list).forEach((r, i) => {
    const selected = start + i === s.cursor.vars;
    const mark = r.pending === "new" ? "+" : r.pending === "unset" ? "-" : r.pending ? "*" : " ";
    const plain = `${mark} ${cell(r.name, nameW)}  ${cellEnd(r.by, byW)}  ${cell(varValue(r, s), valueW)}`;
    const color = r.pending === "unset" ? c.red : r.pending ? c.yellow : r.managed ? c.cyan : r.by.startsWith("(") ? c.dim : (x: string) => x;
    lines.push(selected ? c.inverse(plain) : color(plain));
  });
  return lines;
}

function mask(name: string, value: string | undefined, s: State): string {
  if (value === undefined) return "";
  const v = value.replace(/\n/g, "\\n");
  return isSecret(name) && !s.showSecrets ? "********" : tilde(v, s.data.home);
}

function varValue(r: VarView, s: State): string {
  if (r.pending === "unset") return `${mask(r.name, r.value, s)}  (unset)`;
  if (r.pending === "new") return mask(r.name, r.newValue, s);
  if (r.pending === "set") return `${mask(r.name, r.value, s)} → ${mask(r.name, r.newValue, s)}`;
  return mask(r.name, r.value, s);
}

function varDetail(s: State): string {
  const r = varViews(s)[s.cursor.vars];
  if (!r) return "";
  const from = r.managed ? "set by rcenv" : r.source ? `set at ${r.by}` : r.by === "(inherited)" ? "inherited from the program that started this shell" : "set by login or bash";
  return `${r.name}: ${from}${r.pending ? `, staged: ${r.pending}` : ""}`;
}

function pathLines(s: State, width: number, height: number, c: Styles): string[] {
  const rows = pathViews(s);
  if (!rows.length) return [c.dim("PATH is empty")];
  const dirW = Math.min(60, Math.max(9, ...rows.map((r) => tilde(r.dir, s.data.home).length)));
  const byW = Math.min(32, Math.max(8, ...rows.map((r) => r.by.length)));
  const list = height - 1;
  const start = windowStart(s.cursor.path, rows.length, list);
  const lines = [c.bold(`  ${" #"}  ${cell("DIRECTORY", dirW)}  ${cell("ADDED BY", byW)}`)];
  rows.slice(start, start + list).forEach((r, i) => {
    const index = start + i;
    const mark = r.pending === "add" ? "+" : r.pending === "remove" ? "-" : " ";
    const flag = r.pending ? `staged: ${r.pending}` : r.duplicateOf ? `duplicate of #${r.duplicateOf}` : !r.exists ? "missing" : "";
    const plain = `${mark} ${String(index + 1).padStart(2)}  ${cellEnd(tilde(r.dir, s.data.home), dirW)}  ${cellEnd(r.by, byW)}  ${cell(flag, Math.max(0, width - dirW - byW - 10))}`;
    const color = r.pending === "remove" ? c.red : r.pending ? c.yellow : flag ? c.red : r.managed ? c.cyan : r.by.startsWith("(") ? c.dim : (x: string) => x;
    lines.push(index === s.cursor.path ? c.inverse(plain) : color(plain));
  });
  return lines;
}

function pathDetail(s: State): string {
  const r: PathView | undefined = pathViews(s)[s.cursor.path];
  if (!r) return "";
  const from = r.managed ? "added by rcenv" : r.source ? `added at ${r.by}` : r.by === "(initial)" ? "in the initial PATH bash starts with" : "inherited from the program that started this shell";
  return `${tilde(r.dir, s.data.home)}: ${from}`;
}
