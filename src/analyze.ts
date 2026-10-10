import { statSync } from "node:fs";
import type { Assignment, Location, Trace } from "./model.ts";

export type Status = "effective" | "not-effective" | "not-exported" | "unset";

/** Windows ignores case in variable names, and in directories. */
const fold = (t: Trace) => (s: string) => (t.shell === "windows" ? s.toUpperCase() : s);

/** `rec[name]`, ignoring case on Windows. */
export function lookup(t: Trace, rec: Record<string, string | undefined>, name: string): string | undefined {
  if (t.shell !== "windows" || name in rec) return rec[name];
  const key = fold(t)(name);
  const found = Object.keys(rec).find((k) => fold(t)(k) === key);
  return found === undefined ? undefined : rec[found];
}

export const has = (t: Trace, rec: Record<string, string>, name: string) => lookup(t, rec, name) !== undefined;

export const isPath = (t: Trace, name: string) => fold(t)(name) === "PATH";

/** PATH entries; a trailing separator is the same directory on Windows. */
export function splitPath(t: Trace, path: string | undefined): string[] {
  return path === undefined ? [] : path.split(t.shell === "windows" ? ";" : ":");
}

/** What makes two PATH entries the same directory. */
export const dirKey = (t: Trace) => (d: string) => (t.shell === "windows" ? d.replace(/[\\/]+$/, "").toUpperCase() : d);

/** Assignments to `name` that can outlive the startup files (function locals excluded). */
export function chain(t: Trace, name: string): Assignment[] {
  const key = fold(t)(name);
  return t.assignments.filter((a) => fold(t)(a.name) === key && !a.local);
}

/** Whether the last assignment is what a fresh shell actually ends up with. */
export function status(t: Trace, name: string): Status | undefined {
  const last = chain(t, name).at(-1);
  if (!last) return undefined;
  const fresh = lookup(t, t.final, name);
  if (last.result === undefined) return fresh === undefined ? "unset" : "not-effective";
  if (fresh === undefined) return "not-exported";
  return last.result === fresh ? "effective" : "not-effective";
}

/** The line to point a user at: the call site when a helper function made the assignment. */
export function origin(a: Assignment): Location {
  return a.via?.kind === "function" ? a.via.at : a.at;
}

// Variables the shell changes on its own after startup; a difference there means nothing.
// PowerShell adds its own modules' directories to PSModulePath in every session.
const VOLATILE = new Set(["PWD", "OLDPWD", "SHLVL", "_", "PSMODULEPATH"]);

export interface EnvRow {
  name: string;
  value: string;
  /** startup: set by a startup file; shell: set by login or bash itself; inherited: from whatever launched this shell. */
  kind: "startup" | "shell" | "inherited";
  last?: Assignment;
  count: number;
  status?: Status;
  /** The current value is not what a fresh login shell ends up with. */
  differsFromFresh: boolean;
}

export function envRows(t: Trace, env: Record<string, string | undefined>): EnvRow[] {
  return Object.keys(env)
    .filter((name) => name !== "_" && env[name] !== undefined)
    .sort()
    .map((name) => {
      const c = chain(t, name);
      const value = env[name]!;
      return {
        name,
        value,
        kind: c.length ? "startup" : has(t, t.final, name) ? "shell" : "inherited",
        last: c.at(-1),
        count: c.length,
        status: status(t, name),
        differsFromFresh: !VOLATILE.has(fold(t)(name)) && has(t, t.final, name) && lookup(t, t.final, name) !== value,
      };
    });
}

export interface BlameReport {
  name: string;
  assignments: Assignment[];
  status?: Status;
  fresh?: string;
  current?: string;
  /** Only for PATH: what each assignment added or removed. */
  pathSteps?: PathStep[];
  pathSeparator?: string;
}

export function blame(t: Trace, name: string, env: Record<string, string | undefined>): BlameReport {
  return {
    name,
    assignments: chain(t, name),
    status: status(t, name),
    fresh: lookup(t, t.final, name),
    current: lookup(t, env, name),
    pathSteps: isPath(t, name) ? pathSteps(t) : undefined,
    pathSeparator: isPath(t, name) ? (t.shell === "windows" ? ";" : ":") : undefined,
  };
}

export interface PathStep {
  /** Undefined for the initial PATH the shell started with. */
  assignment?: Assignment;
  value: string;
  added: string[];
  removed: string[];
  reordered: boolean;
}

export function pathSteps(t: Trace): PathStep[] {
  const dirs = (path: string | undefined) => splitPath(t, path);
  const key = dirKey(t);
  const unique = (xs: string[]) => [...new Map(xs.map((d) => [key(d), d])).values()];
  // Windows starts with no PATH: the machine's comes from the registry
  let prev = lookup(t, t.initial, "PATH");
  const steps: PathStep[] = prev === undefined ? [] : [{ value: prev, added: unique(dirs(prev)), removed: [], reordered: false }];
  for (const a of chain(t, "PATH")) {
    const cur = a.result ?? "";
    const before = new Set(dirs(prev).map(key));
    const after = new Set(dirs(cur).map(key));
    const added = unique(dirs(cur).filter((d) => !before.has(key(d))));
    const removed = unique(dirs(prev).filter((d) => !after.has(key(d))));
    const reordered = !added.length && !removed.length && [...before].join("\0") !== [...after].join("\0");
    steps.push({ assignment: a, value: cur, added, removed, reordered });
    prev = cur;
  }
  return steps;
}

export interface PathEntry {
  index: number;
  dir: string;
  exists: boolean;
  /** Index of the earlier entry this one repeats. */
  duplicateOf?: number;
  source: "startup" | "initial" | "inherited";
  addedBy?: Assignment;
}

function isDir(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** The given PATH entry by entry, with the startup line that added each one. */
export function pathEntries(t: Trace, path: string): PathEntry[] {
  const key = dirKey(t);
  const addedBy = new Map<string, Assignment | "initial">();
  for (const step of pathSteps(t)) {
    for (const d of step.removed) addedBy.delete(key(d));
    for (const d of step.added) addedBy.set(key(d), step.assignment ?? "initial");
  }
  const first = new Map<string, number>();
  return splitPath(t, path).map((dir, i) => {
    const by = addedBy.get(key(dir));
    const index = i + 1;
    const duplicateOf = first.get(key(dir));
    if (duplicateOf === undefined) first.set(key(dir), index);
    return {
      index,
      dir,
      exists: dir !== "" && isDir(dir),
      duplicateOf,
      source: by === undefined ? "inherited" : by === "initial" ? "initial" : "startup",
      addedBy: by === "initial" ? undefined : by,
    };
  });
}
