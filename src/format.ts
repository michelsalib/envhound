import type { BlameReport, EnvRow, PathEntry, PathStep } from "./analyze.ts";
import { origin } from "./analyze.ts";
import type { DotenvKey, DotenvProblem } from "./dotenv.ts";
import type { Assignment, Location } from "./model.ts";

export interface RenderOptions {
  home: string;
  color: boolean;
  /** Terminal width; undefined means never truncate (output is piped). */
  width?: number;
  showSecrets: boolean;
}

const SECRET = /TOKEN|SECRET|PASSW(OR)?D|API_?KEY|PRIVATE_?KEY|CREDENTIAL|_KEY$|^KEY$/i;
export const isSecret = (name: string) => SECRET.test(name);

export function shown(name: string, value: string | undefined, o: RenderOptions): string | undefined {
  return value === undefined || o.showSecrets || !isSecret(name) ? value : "********";
}

export function paint(o: RenderOptions) {
  const wrap = (code: string) => (s: string) => (o.color && s ? `\x1b[${code}m${s}\x1b[0m` : s);
  return { bold: wrap("1"), dim: wrap("2"), red: wrap("31"), green: wrap("32"), yellow: wrap("33"), cyan: wrap("36") };
}

export function tilde(s: string, home: string): string {
  if (!home || home === "/") return s;
  const esc = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return s.replace(new RegExp(`(^|[:=\\s])${esc}(?=/|:|$|\\s)`, "g"), "$1~");
}

/** One-line form of a value: control characters made visible. */
const oneLine = (s: string) => s.replace(/\n/g, "\\n").replace(/[\x00-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);

function fit(s: string, width: number | undefined): string {
  return width !== undefined && width > 0 && s.length > width ? s.slice(0, Math.max(0, width - 1)) + "…" : s;
}

/** Like fit, but keeps the end: the line number of a location, the last parts of a directory. */
function fitStart(s: string, width: number): string {
  return s.length > width ? "…" + s.slice(s.length - width + 1) : s;
}

export const loc = (l: Location, home: string) => `${tilde(l.file, home)}:${l.line}`;

/** Where to look for an assignment, e.g. `~/.bashrc:12` or `~/.bashrc:12 add_path()`. */
export function where(a: Assignment, home: string): string {
  return loc(origin(a), home) + (a.via?.kind === "function" ? ` ${a.via.name}()` : "");
}

function table(rows: string[][], widths: number[], styles: ((s: string) => string)[]): string {
  return rows
    .map((cells) =>
      cells
        .map((cell, i) => {
          const last = i === cells.length - 1;
          const text = fit(cell, widths[i]);
          return (styles[i] ?? ((s: string) => s))(last ? text : text.padEnd(widths[i] ?? 0));
        })
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

export function renderList(rows: EnvRow[], o: RenderOptions): string {
  const c = paint(o);
  const setBy = (r: EnvRow) => {
    if (r.kind === "shell") return "(login/shell)";
    if (r.kind === "inherited") return "(inherited)";
    const notes = [r.count > 1 ? `×${r.count}` : "", r.status === "not-effective" ? "not effective" : ""].filter(Boolean);
    return where(r.last!, o.home) + (notes.length ? ` (${notes.join(", ")})` : "");
  };
  const cells = rows.map((r) => [r.name, setBy(r), tilde(oneLine(shown(r.name, r.value, o)!), o.home)]);
  const nameW = Math.min(28, Math.max(8, ...cells.map((x) => x[0]!.length)));
  const setW = Math.min(44, Math.max(6, ...cells.map((x) => x[1]!.length)));
  for (const x of cells) x[1] = fitStart(x[1]!, setW);
  const valueW = o.width === undefined ? undefined : Math.max(10, o.width - nameW - setW - 4);
  const header = table([["VARIABLE", "SET BY", "VALUE"]], [nameW, setW, 0], [c.bold, c.bold, c.bold]);
  const body = rows.map((r, i) => {
    const color = r.kind !== "startup" ? c.dim : r.status === "not-effective" ? c.yellow : (s: string) => s;
    const value = r.differsFromFresh ? c.cyan : (s: string) => s;
    return table([cells[i]!], [nameW, setW, valueW ?? 0], [(s) => s, color, value]);
  });
  // without color the cyan marking is invisible, so only explain it when it shows
  if (o.color && rows.some((r) => r.differsFromFresh))
    body.push("", c.dim("values in ") + c.cyan("cyan") + c.dim(" differ from what a fresh login shell gets"));
  return [header, ...body].join("\n");
}

function pathStepText(s: PathStep, home: string): string {
  const parts = [...s.added.map((d) => `+${tilde(d, home) || "(empty)"}`), ...s.removed.map((d) => `-${tilde(d, home) || "(empty)"}`)];
  if (parts.length) return parts.join("  ");
  return s.reordered ? "(reordered)" : "(reassigned, nothing new)";
}

export function renderBlame(r: BlameReport, o: RenderOptions): string {
  const c = paint(o);
  const v = (s: string | undefined) => tilde(oneLine(shown(r.name, s, o) ?? "<unset>"), o.home);
  if (!r.assignments.length) {
    if (r.current === undefined) return `${r.name} is not set anywhere.`;
    const by = r.fresh !== undefined ? "set by login or bash itself" : "inherited from whatever launched this shell";
    return `${r.name} is not set by any startup file (${by}).\nCurrent value: ${v(r.current)}`;
  }

  let rows: string[][];
  if (r.pathSteps) {
    rows = r.pathSteps.map((s) => [s.assignment ? where(s.assignment, o.home) : "(initial)", pathStepText(s, o.home)]);
  } else {
    // quote values whose edges would otherwise be invisible
    const q = (s: string) => (s === "" || /^\s|\s$/.test(s) ? JSON.stringify(s) : s);
    rows = r.assignments.map((a) => [where(a, o.home), a.op === "unset" ? "unset" : `${a.op} ${q(v(a.value))}`]);
  }
  const w = Math.min(48, Math.max(...rows.map((x) => x[0]!.length)));
  const lines = [table(rows, [w, o.width === undefined ? 0 : Math.max(10, o.width - w - 2)], [c.dim, (s) => s])];

  // where the assignments themselves live, when that differs from the line shown
  const details = r.assignments.flatMap((a) =>
    a.via?.kind === "function"
      ? [`${a.via.name}() is defined in ${tilde(a.at.file, o.home)}`]
      : a.via?.kind === "source"
        ? [`${tilde(a.at.file, o.home)} is sourced from ${loc(a.via.at, o.home)}`]
        : [],
  );
  if (details.length) lines.push("", ...unique(details).map((d) => c.dim(d)));

  lines.push("");
  switch (r.status) {
    case "effective":
      lines.push(c.green("✓ a fresh login shell ends with this value"));
      break;
    case "unset":
      lines.push(c.green("✓ a fresh login shell ends with this variable unset"));
      break;
    case "not-exported":
      lines.push(c.yellow(`! set as a shell variable but never exported: programs started from the shell don't see it`));
      break;
    case "not-effective":
      lines.push(
        c.yellow(
          `! not effective: a fresh shell ends with ${r.name}=${v(r.fresh)}\n` +
            `  so the last line above is a one-command prefix (${r.name}=x cmd), or something envhound can't trace undid it`,
        ),
      );
      break;
  }
  if (r.current === undefined && r.fresh !== undefined)
    lines.push(c.cyan("~ not set in this shell: it started before this was added, or something unset it"));
  else if (r.current !== r.fresh && r.current !== undefined)
    lines.push(c.cyan(`~ this shell has a different value: ${r.pathSteps ? pathDiff(r.fresh, r.current, o.home) : v(r.current)}`));
  return lines.join("\n");
}

const unique = (xs: string[]) => [...new Set(xs)];

/** Summary of how this shell's PATH differs from a fresh one; the full value is usually too long to read. */
function pathDiff(fresh: string | undefined, current: string | undefined, home: string): string {
  const f = new Set((fresh ?? "").split(":"));
  const cur = new Set((current ?? "").split(":"));
  const extra = [...cur].filter((d) => !f.has(d));
  const lost = [...f].filter((d) => !cur.has(d));
  const list = (ds: string[]) => (ds.length > 3 ? `${ds.slice(0, 3).map((d) => tilde(d, home)).join(", ")}, …` : ds.map((d) => tilde(d, home)).join(", "));
  const parts = [
    extra.length ? `${extra.length} extra (${list(extra)})` : "",
    lost.length ? `${lost.length} missing (${list(lost)})` : "",
  ].filter(Boolean);
  return (parts.join("; ") || "same entries, different order") + "\n  run 'envhound path' to see each entry";
}

export function renderPath(entries: PathEntry[], o: RenderOptions): string {
  const c = paint(o);
  const by = (e: PathEntry) =>
    e.source === "startup" ? where(e.addedBy!, o.home) : e.source === "initial" ? "(initial)" : "(inherited)";
  const flag = (e: PathEntry) =>
    e.dir === "" ? "empty entry: searches the current directory" : e.duplicateOf ? `duplicate of #${e.duplicateOf}` : !e.exists ? "missing" : "";
  const rows = entries.map((e) => [String(e.index).padStart(2), tilde(e.dir, o.home) || "(empty)", by(e), flag(e)]);
  const dirW = Math.min(50, Math.max(9, ...rows.map((x) => x[1]!.length)));
  const byW = Math.min(40, Math.max(8, ...rows.map((x) => x[2]!.length)));
  for (const x of rows) {
    x[1] = fitStart(x[1]!, dirW);
    x[2] = fitStart(x[2]!, byW);
  }
  const header = table([[" #", "DIRECTORY", "ADDED BY", ""]], [2, dirW, byW, 0], [c.bold, c.bold, c.bold]);
  const body = rows.map((row, i) =>
    table([row], [2, dirW, byW, 0], [c.dim, (s) => s, entries[i]!.source === "startup" ? (s) => s : c.dim, c.red]),
  );
  return [header, ...body].join("\n");
}

// JSON forms: same data, secrets masked unless asked otherwise.

const assignmentJson = (a: Assignment, o: RenderOptions) => ({
  ...a,
  value: shown(a.name, a.value, o),
  previous: shown(a.name, a.previous, o),
  result: shown(a.name, a.result, o),
});

export const listJson = (rows: EnvRow[], o: RenderOptions) =>
  rows.map((r) => ({ ...r, value: shown(r.name, r.value, o), last: r.last && assignmentJson(r.last, o) }));

export const blameJson = (r: BlameReport, o: RenderOptions) => ({
  ...r,
  fresh: shown(r.name, r.fresh, o),
  current: shown(r.name, r.current, o),
  assignments: r.assignments.map((a) => assignmentJson(a, o)),
  pathSteps: r.pathSteps?.map((s) => ({ ...s, assignment: s.assignment && assignmentJson(s.assignment, o) })),
});

export interface DotenvReport {
  file: string;
  keys: DotenvKey[];
  problems: DotenvProblem[];
  /** For conflicting keys: the startup assignment behind the shell's value, if any. */
  shellOrigin: Record<string, Assignment | undefined>;
}

export function renderDotenv(r: DotenvReport, o: RenderOptions): string {
  const c = paint(o);
  const v = (name: string, s: string | undefined) => tilde(oneLine(shown(name, s, o) ?? ""), o.home);
  const out = [c.bold(`${tilde(r.file, o.home)}: ${r.keys.length} key${r.keys.length === 1 ? "" : "s"}`)];
  if (r.keys.length) {
    const rows = r.keys.map((k) => {
      const value = v(k.key, k.value);
      if (k.status === "new") return [k.key, String(k.line), "new", value];
      if (k.status === "same") return [k.key, String(k.line), "same as shell", value];
      const from = r.shellOrigin[k.key];
      return [k.key, String(k.line), "conflict", `${value}  (shell has ${v(k.key, k.current)}${from ? `, set at ${where(from, o.home)}` : ""})`];
    });
    const keyW = Math.min(32, Math.max(3, ...rows.map((x) => x[0]!.length)));
    const lineW = Math.max(4, ...rows.map((x) => x[1]!.length));
    const statusW = Math.max(6, ...rows.map((x) => x[2]!.length));
    const valueW = o.width === undefined ? 0 : Math.max(10, o.width - keyW - lineW - statusW - 6);
    for (const x of rows) x[3] = fit(x[3]!, valueW);
    const color = (s: string) => (s.startsWith("conflict") ? c.yellow(s) : s.startsWith("same") ? c.dim(s) : c.green(s));
    out.push(table([["KEY", "LINE", "STATUS", "VALUE"]], [keyW, lineW, statusW, 0], [c.bold, c.bold, c.bold, c.bold]));
    for (const row of rows) out.push(table([row], [keyW, lineW, statusW, 0], [(s) => s, c.dim, color, (s) => s]));
    if (rows.some((x) => x[2] === "conflict"))
      out.push("", c.dim("conflict: loaders such as dotenv keep the shell's value unless told to override; check yours"));
  }
  if (r.problems.length) {
    out.push("", c.bold("Problems"));
    for (const p of r.problems) out.push(`${c.red(`line ${p.line}`)}${p.key ? ` ${p.key}` : ""}: ${p.message}`);
  }
  return out.join("\n");
}
