// envhound set / unset / path add / path remove: plan the file changes, then check
// them against a fresh trace once written.
import { join } from "node:path";
import { chain, pathEntries } from "./analyze.ts";
import { parseDotenv, serializeDotenv, setKey, unsetKey } from "./dotenv.ts";
import { readIfExists, type FileChange } from "./edit.ts";
import { where } from "./format.ts";
import {
  HEADER,
  HOOK,
  addPath,
  hasHook,
  loginFile,
  parseManaged,
  removePath,
  serializeManaged,
  setVar,
  unsetVar,
  type Locations,
} from "./managed.ts";
import type { Assignment, Trace } from "./model.ts";
import { shellQuote } from "./quote.ts";

export type EditOp =
  /** `file`: a .env file to edit instead of the shell */
  | { kind: "set"; name: string; value: string; file?: string }
  | { kind: "unset"; name: string; file?: string }
  | { kind: "path-add"; dir: string; position: "front" | "back" }
  | { kind: "path-remove"; dir: string };

export interface Plan {
  changes: FileChange[];
  /** Things to know before confirming. */
  notes: string[];
}

const fromEnvhound = (a: Assignment, loc: Locations) => a.at.file === loc.managed;

export function planShell(ops: EditOp[], loc: Locations, trace: Trace): Plan {
  const before = readIfExists(loc.managed);
  let lines = parseManaged(before ?? HEADER, loc.home);
  const notes: string[] = [];
  const bashrc = join(loc.home, ".bashrc");
  const others = (name: string) => chain(trace, name).filter((a) => !fromEnvhound(a, loc));
  const at = (as: Assignment[]) => [...new Set(as.map((a) => where(a, loc.home)))].join(", ");

  for (const op of ops) {
    switch (op.kind) {
      case "set": {
        lines = setVar(lines, op.name, op.value);
        const elsewhere = others(op.name);
        if (elsewhere.length) notes.push(`${op.name} is also set at ${at(elsewhere)}; envhound's line runs last, so it wins in login shells`);
        if (elsewhere.some((a) => a.at.file === bashrc))
          notes.push(`~/.bashrc runs again in every non-login shell and will set ${op.name} back there; consider removing that line`);
        break;
      }
      case "unset": {
        if (!lines.some((l) => l.kind === "var" && l.name === op.name)) notes.push(`${op.name} is not set by envhound`);
        lines = unsetVar(lines, op.name);
        const elsewhere = others(op.name);
        if (elsewhere.length) notes.push(`${op.name} is still set at ${at(elsewhere)}; envhound only edits its own file, remove that line yourself`);
        break;
      }
      case "path-add":
        lines = addPath(lines, op.dir, op.position, loc.home);
        break;
      case "path-remove": {
        if (!lines.some((l) => l.kind === "path" && l.dir === op.dir)) notes.push(`${op.dir} is not added by envhound`);
        lines = removePath(lines, op.dir);
        const entry = pathEntries(trace, trace.final.PATH ?? "").find((e) => e.dir === op.dir && e.addedBy && !fromEnvhound(e.addedBy, loc));
        if (entry) notes.push(`${op.dir} is also added at ${where(entry.addedBy!, loc.home)}; remove that line yourself`);
        break;
      }
    }
  }

  const changes: FileChange[] = [];
  const after = serializeManaged(lines);
  if (after !== before) changes.push({ path: loc.managed, before, after, mode: 0o600 });
  if (changes.length) {
    const login = loginFile(loc.home);
    const text = readIfExists(login);
    if (!hasHook(text ?? "")) {
      const sep = text && !text.endsWith("\n") ? "\n" : "";
      changes.push({ path: login, before: text, after: (text ?? "") + sep + HOOK });
    }
  }
  return { changes, notes };
}

export function planDotenv(ops: EditOp[], file: string, env: Record<string, string | undefined>): Plan {
  const before = readIfExists(file);
  let doc = parseDotenv(before ?? "");
  const notes: string[] = [];
  for (const op of ops) {
    if (op.kind === "set") {
      doc = setKey(doc, op.name, op.value);
      const current = env[op.name];
      if (current !== undefined && current !== op.value)
        notes.push(`your shell already has ${op.name} with another value; loaders such as dotenv keep the shell's value`);
    } else if (op.kind === "unset") {
      if (!doc.lines.some((l) => l.kind === "entry" && l.key === op.name)) notes.push(`${op.name} is not in this file`);
      doc = unsetKey(doc, op.name);
    } else {
      throw new Error("PATH changes only apply to the shell, not to a .env file");
    }
  }
  const after = serializeDotenv(doc);
  return { changes: after === (before ?? "") ? [] : [{ path: file, before, after }], notes };
}

export interface Check {
  ok: boolean;
  message: string;
}

/** Compare the ops against a fresh trace taken after writing. */
export function verify(ops: EditOp[], trace: Trace, loc: Locations): Check[] {
  const later = (name: string) => {
    const c = chain(trace, name);
    const ours = c.findLastIndex((a) => fromEnvhound(a, loc));
    return c.slice(ours + 1).map((a) => where(a, loc.home));
  };
  const path = (trace.final.PATH ?? "").split(":");
  return ops.map((op): Check => {
    switch (op.kind) {
      case "set": {
        if (trace.final[op.name] === op.value) return { ok: true, message: `a fresh login shell now gets ${op.name}` };
        const l = later(op.name);
        return { ok: false, message: `a fresh login shell does not get ${op.name}${l.length ? `: ${l.join(", ")} sets it again after envhound` : ""}` };
      }
      case "unset":
        if (trace.final[op.name] === undefined) return { ok: true, message: `${op.name} is no longer set in a fresh login shell` };
        return { ok: false, message: `${op.name} is still set in a fresh login shell (envhound blame ${op.name} shows where)` };
      case "path-add":
        return path.includes(op.dir)
          ? { ok: true, message: `${op.dir} is now in PATH for fresh login shells` }
          : { ok: false, message: `${op.dir} is not in PATH of a fresh login shell (envhound blame PATH shows why)` };
      case "path-remove":
        return path.includes(op.dir)
          ? { ok: false, message: `${op.dir} is still in PATH (envhound path shows who adds it)` }
          : { ok: true, message: `${op.dir} is no longer in PATH for fresh login shells` };
    }
  });
}

/** Commands that make the same change in the current shell, which envhound cannot reach. */
export function currentShellCommands(ops: EditOp[]): string[] {
  return ops.flatMap((op) => {
    switch (op.kind) {
      case "set":
        return [`export ${op.name}=${shellQuote(op.value)}`];
      case "unset":
        return [`unset ${op.name}`];
      case "path-add":
        return [op.position === "front" ? `export PATH=${shellQuote(op.dir)}:"$PATH"` : `export PATH="$PATH":${shellQuote(op.dir)}`];
      case "path-remove":
        return [];
    }
  });
}
