import { statSync } from "node:fs";
import type { Assignment, Location, Trace } from "./model.ts";

export type Status = "effective" | "not-effective" | "not-exported" | "unset";

/** Assignments to `name` that can outlive the startup files (function locals excluded). */
export function chain(t: Trace, name: string): Assignment[] {
  return t.assignments.filter((a) => a.name === name && !a.local);
}

/** Whether the last assignment is what a fresh shell actually ends up with. */
export function status(t: Trace, name: string): Status | undefined {
  const last = chain(t, name).at(-1);
  if (!last) return undefined;
  const fresh = t.final[name];
  if (last.result === undefined) return fresh === undefined ? "unset" : "not-effective";
  if (fresh === undefined) return "not-exported";
  return last.result === fresh ? "effective" : "not-effective";
}

/** The line to point a user at: the call site when a helper function made the assignment. */
export function origin(a: Assignment): Location {
  return a.via?.kind === "function" ? a.via.at : a.at;
}

// Variables the shell changes on its own after startup; a difference there means nothing.
const VOLATILE = new Set(["PWD", "OLDPWD", "SHLVL", "_"]);

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
        kind: c.length ? "startup" : name in t.final ? "shell" : "inherited",
        last: c.at(-1),
        count: c.length,
        status: status(t, name),
        differsFromFresh: !VOLATILE.has(name) && name in t.final && t.final[name] !== value,
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
}

export function blame(t: Trace, name: string, env: Record<string, string | undefined>): BlameReport {
  return {
    name,
    assignments: chain(t, name),
    status: status(t, name),
    fresh: t.final[name],
    current: env[name],
    pathSteps: name === "PATH" ? pathSteps(t) : undefined,
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

const dirs = (path: string | undefined) => (path === undefined ? [] : path.split(":"));
const unique = (xs: string[]) => [...new Set(xs)];

export function pathSteps(t: Trace): PathStep[] {
  let prev = t.initial.PATH ?? "";
  const steps: PathStep[] = [{ value: prev, added: unique(dirs(prev)), removed: [], reordered: false }];
  for (const a of chain(t, "PATH")) {
    const cur = a.result ?? "";
    const before = new Set(dirs(prev));
    const after = new Set(dirs(cur));
    const added = unique(dirs(cur).filter((d) => !before.has(d)));
    const removed = unique(dirs(prev).filter((d) => !after.has(d)));
    const reordered = !added.length && !removed.length && [...before].join(":") !== [...after].join(":");
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
  const addedBy = new Map<string, Assignment | "initial">();
  for (const step of pathSteps(t)) {
    for (const d of step.removed) addedBy.delete(d);
    for (const d of step.added) addedBy.set(d, step.assignment ?? "initial");
  }
  const first = new Map<string, number>();
  return dirs(path).map((dir, i) => {
    const by = addedBy.get(dir);
    const index = i + 1;
    const duplicateOf = first.get(dir);
    if (duplicateOf === undefined) first.set(dir, index);
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
