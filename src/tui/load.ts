// What `rcenv edit` shows: the current environment and PATH, annotated from a trace.
import { envRows, origin, pathEntries } from "../analyze.ts";
import { readIfExists } from "../edit.ts";
import { where } from "../format.ts";
import { parseManaged, type Locations } from "../managed.ts";
import type { Assignment, Trace } from "../model.ts";
import type { Data, PathRow, VarRow } from "./state.ts";

export function loadData(trace: Trace, env: Record<string, string | undefined>, loc: Locations): Data {
  const lines = parseManaged(readIfExists(loc.managed) ?? "", loc.home);
  const managedVars = new Set(lines.flatMap((l) => (l.kind === "var" ? [l.name!] : [])));
  const managedDirs = new Set(lines.flatMap((l) => (l.kind === "path" ? [l.dir!] : [])));
  const by = (a: Assignment) => (a.at.file === loc.managed ? "rcenv" : where(a, loc.home));

  const vars: VarRow[] = envRows(trace, env)
    .filter((r) => r.name !== "PATH")
    .map((r) => ({
      name: r.name,
      value: r.value,
      by: r.last ? by(r.last) : r.kind === "shell" ? "(login/shell)" : "(inherited)",
      source: r.last && origin(r.last),
      managed: managedVars.has(r.name),
    }));
  // set by rcenv but not in this shell yet (it started before)
  for (const name of managedVars)
    if (!vars.some((v) => v.name === name) && name !== "PATH")
      vars.push({ name, value: trace.final[name], by: "rcenv (new shells)", managed: true });

  const path: PathRow[] = pathEntries(trace, env.PATH ?? "").map((e) => ({
    dir: e.dir,
    by: e.addedBy ? by(e.addedBy) : `(${e.source})`,
    source: e.addedBy && origin(e.addedBy),
    managed: managedDirs.has(e.dir),
    exists: e.exists,
    duplicateOf: e.duplicateOf,
  }));
  for (const dir of managedDirs)
    if (!path.some((p) => p.dir === dir)) path.push({ dir, by: "rcenv (new shells)", managed: true, exists: true });

  return { home: loc.home, vars, path };
}
