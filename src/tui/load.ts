// What `envhound edit` shows: the current environment and PATH, annotated from a trace.
import { envRows, origin, pathEntries } from "../analyze.ts";
import { compareDotenv, dotenvProblems, parseDotenv } from "../dotenv.ts";
import { readIfExists } from "../edit.ts";
import { where } from "../format.ts";
import { parseManaged, type Locations } from "../managed.ts";
import type { Assignment, Trace } from "../model.ts";
import type { Data, DotenvData, PathRow, VarRow } from "./state.ts";

/** A .env file's keys compared with the shell; a missing file loads empty (it is created on write). */
export function loadDotenv(file: string, env: Record<string, string | undefined>): DotenvData {
  const text = readIfExists(file);
  const doc = parseDotenv(text ?? "");
  const problems = dotenvProblems(doc);
  const counts = new Map<string, number>();
  for (const l of doc.lines) if (l.kind === "entry") counts.set(l.key!, (counts.get(l.key!) ?? 0) + 1);
  const rows = compareDotenv(doc, env).map((k) => ({
    key: k.key,
    value: k.value,
    line: k.line,
    status: k.status,
    current: k.current,
    count: counts.get(k.key) ?? 1,
    problem: problems.find((p) => p.key === k.key)?.message,
  }));
  return { file, exists: text !== undefined, rows, problems: problems.length };
}

export function loadData(trace: Trace, env: Record<string, string | undefined>, loc: Locations, dotenvFiles: string[] = []): Data {
  const lines = parseManaged(readIfExists(loc.managed) ?? "", loc.home);
  const managedVars = new Set(lines.flatMap((l) => (l.kind === "var" ? [l.name!] : [])));
  const managedDirs = new Set(lines.flatMap((l) => (l.kind === "path" ? [l.dir!] : [])));
  const by = (a: Assignment) => (a.at.file === loc.managed ? "envhound" : where(a, loc.home));

  const vars: VarRow[] = envRows(trace, env)
    .filter((r) => r.name !== "PATH")
    .map((r) => ({
      name: r.name,
      value: r.value,
      by: r.last ? by(r.last) : r.kind === "shell" ? "(login/shell)" : "(inherited)",
      source: r.last && origin(r.last),
      managed: managedVars.has(r.name),
    }));
  // set by envhound but not in this shell yet (it started before)
  for (const name of managedVars)
    if (!vars.some((v) => v.name === name) && name !== "PATH")
      vars.push({ name, value: trace.final[name], by: "envhound (new shells)", managed: true });

  const path: PathRow[] = pathEntries(trace, env.PATH ?? "").map((e) => ({
    dir: e.dir,
    by: e.addedBy ? by(e.addedBy) : `(${e.source})`,
    source: e.addedBy && origin(e.addedBy),
    managed: managedDirs.has(e.dir),
    exists: e.exists,
    duplicateOf: e.duplicateOf,
  }));
  for (const dir of managedDirs)
    if (!path.some((p) => p.dir === dir)) path.push({ dir, by: "envhound (new shells)", managed: true, exists: true });

  return { home: loc.home, vars, path, dotenv: dotenvFiles.map((f) => loadDotenv(f, env)) };
}
