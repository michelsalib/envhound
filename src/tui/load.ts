// What `envhound edit` shows: the current environment and PATH, annotated from a trace.
import { chain, dirKey, envRows, isPath, lookup, origin, pathEntries, splitPath } from "../analyze.ts";
import { compareDotenv, dotenvProblems, errorCount, parseDotenv } from "../dotenv.ts";
import { readIfExists } from "../edit.ts";
import { where } from "../format.ts";
import { parseManaged, type Locations } from "../managed.ts";
import type { Assignment, Trace } from "../model.ts";
import { USER } from "../trace/windows.ts";
import type { Data, DotenvData, PathRow, VarRow } from "./state.ts";

/** A .env file's keys compared with the shell; a missing file loads empty (it is created on write). */
export function loadDotenv(file: string, env: Record<string, string | undefined>): DotenvData {
  const text = readIfExists(file);
  const doc = parseDotenv(text ?? "");
  const problems = dotenvProblems(doc, env);
  const counts = new Map<string, number>();
  for (const l of doc.lines) if (l.kind === "entry") counts.set(l.key!, (counts.get(l.key!) ?? 0) + 1);
  const rows = compareDotenv(doc, env).map((k) => {
    // errors first: they matter more than a warning on the same key
    const problem = problems.find((p) => p.key === k.key && p.severity === "error") ?? problems.find((p) => p.key === k.key);
    return {
      key: k.key,
      value: k.value,
      expanded: k.expanded,
      template: k.template,
    line: k.line,
    status: k.status,
    current: k.current,
      count: counts.get(k.key) ?? 1,
      problem: problem?.message,
      warning: problem?.severity === "warning",
    };
  });
  const errors = errorCount(problems);
  return { file, exists: text !== undefined, rows, problems: errors, warnings: problems.length - errors };
}

/** What envhound can change: the variables and PATH directories in its own file, or on Windows the user's. */
function changeable(trace: Trace, loc: Locations): { vars: string[]; dirs: string[] } {
  if (trace.shell === "windows") {
    const ours = trace.assignments.filter((a) => a.at.file === USER);
    const userPath = ours.filter((a) => isPath(trace, a.name)).at(-1);
    // the user's part of PATH: what comes after the machine's
    const own = userPath?.op === "+=" ? userPath.result!.slice(userPath.previous!.length + 1) : userPath?.result;
    return { vars: ours.map((a) => a.name), dirs: splitPath(trace, own).filter(Boolean) };
  }
  const lines = parseManaged(readIfExists(loc.managed) ?? "", loc.home);
  return {
    vars: lines.flatMap((l) => (l.kind === "var" ? [l.name!] : [])),
    dirs: lines.flatMap((l) => (l.kind === "path" ? [l.dir!] : [])),
  };
}

export function loadData(trace: Trace, env: Record<string, string | undefined>, loc: Locations, dotenvFiles: string[] = []): Data {
  const windows = trace.shell === "windows";
  const name = (n: string) => (windows ? n.toUpperCase() : n);
  const ours = changeable(trace, loc);
  const managedVars = new Set(ours.vars.map(name));
  const key = dirKey(trace);
  const managedDirs = new Set(ours.dirs.map(key));
  const by = (a: Assignment) => (a.at.file === loc.managed ? "envhound" : where(a, loc.home));
  // a registry key has no line to open
  const source = (a?: Assignment) => (a && a.at.line ? origin(a) : undefined);
  const added = windows ? `${USER} (new terminals)` : "envhound (new shells)";

  const vars: VarRow[] = envRows(trace, env)
    .filter((r) => !isPath(trace, r.name))
    .map((r) => ({
      name: r.name,
      value: r.value,
      by: r.last ? by(r.last) : r.kind === "shell" ? (windows ? "(windows)" : "(login/shell)") : "(inherited)",
      source: source(r.last),
      managed: managedVars.has(name(r.name)),
    }));
  // set by envhound but not in this shell yet (it started before)
  for (const n of new Set(ours.vars))
    if (!vars.some((v) => name(v.name) === name(n)) && !isPath(trace, n) && chain(trace, n).length)
      vars.push({ name: n, value: lookup(trace, trace.final, n), by: added, managed: true });

  const path: PathRow[] = pathEntries(trace, lookup(trace, env, "PATH") ?? "").map((e) => ({
    dir: e.dir,
    by: e.addedBy ? by(e.addedBy) : `(${e.source})`,
    source: source(e.addedBy),
    managed: managedDirs.has(key(e.dir)),
    exists: e.exists,
    duplicateOf: e.duplicateOf,
  }));
  for (const dir of ours.dirs)
    if (!path.some((p) => key(p.dir) === key(dir))) path.push({ dir, by: added, managed: true, exists: true });

  return { home: loc.home, vars, path, dotenv: dotenvFiles.map((f) => loadDotenv(f, env)), windows };
}
