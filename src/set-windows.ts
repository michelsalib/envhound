// envhound set / unset / path add / path remove on Windows: changes go to the
// user's variables (HKCU\Environment), which need no administrator. The machine's
// (HKLM) come first in PATH and lose to the user's for other variables.
import { chain, dirKey, lookup, splitPath } from "./analyze.ts";
import type { FileChange } from "./edit.ts";
import { isSecret } from "./format.ts";
import type { Trace } from "./model.ts";
import type { Check, EditOp, Plan } from "./set.ts";
import { expand, MACHINE, USER, type RegistryValue, type RegistryWrite } from "./trace/windows.ts";

const isPathName = (name: string) => name.toUpperCase() === "PATH";
const isText = (v: RegistryValue) => v.kind === "String" || v.kind === "ExpandString";
// a %VAR% reference only expands in an ExpandString value
const hasReference = (value: string) => /%[^%=]+%/.test(value);

/** The user's variables as shown in a diff: NAME=value, and Path one entry per line. */
export function registryText(values: RegistryValue[]): string {
  return values
    .filter(isText)
    .map((v) => (isPathName(v.name) ? [`${v.name}=`, ...v.value.split(";").filter(Boolean).map((d) => `    ${d}`)].join("\n") : `${v.name}=${v.value}`))
    .join("\n")
    .concat(values.some(isText) ? "\n" : "");
}

/** DIR as stored in the user's Path: under the profile folder it is written %USERPROFILE%\…, which survives a renamed account. */
function storedDir(dir: string, profile: string | undefined): string {
  if (profile && dir.toUpperCase().startsWith(profile.toUpperCase() + "\\")) return "%USERPROFILE%" + dir.slice(profile.length);
  return dir;
}

export function planWindows(ops: EditOp[], user: RegistryValue[], trace: Trace): Plan {
  let values = user.filter(isText);
  const notes: string[] = [];
  const key = dirKey(trace);
  const get = (name: string) => lookup(trace, trace.final, name);
  const find = (name: string) => values.find((v) => v.name.toUpperCase() === name.toUpperCase());
  const machine = (name: string) => chain(trace, name).some((a) => a.at.file === MACHINE);
  const put = (v: RegistryValue) => (values = find(v.name) ? values.map((x) => (x === find(v.name) ? { ...v, name: x.name } : x)) : [...values, v]);
  const writes = new Map<string, RegistryWrite>();
  const pathOf = () => find("Path");
  const entries = () => splitPath(trace, pathOf()?.value ?? "").filter(Boolean);
  const expanded = (d: string) => key(expand(d, get));
  const setPath = (dirs: string[]) => {
    // a Path stored as a plain String (setx writes those) must become ExpandString to hold %USERPROFILE%\…
    const kind = dirs.some(hasReference) ? "ExpandString" : ((pathOf()?.kind as RegistryWrite["kind"]) ?? "ExpandString");
    put({ name: pathOf()?.name ?? "Path", kind, value: dirs.join(";") });
    writes.set("PATH", { name: pathOf()!.name, kind, value: dirs.join(";") });
  };

  for (const op of ops) {
    switch (op.kind) {
      case "set": {
        const kind = hasReference(op.value) ? "ExpandString" : ((find(op.name)?.kind as RegistryWrite["kind"]) ?? "String");
        if (machine(op.name)) notes.push(`${op.name} is also set at ${MACHINE}, for every user; yours wins in your new terminals`);
        put({ name: op.name, kind, value: op.value });
        writes.set(op.name.toUpperCase(), { name: find(op.name)!.name, kind, value: op.value });
        break;
      }
      case "unset": {
        const current = find(op.name);
        if (machine(op.name))
          notes.push(`${op.name} is set at ${MACHINE}, for every user; changing that needs an administrator, so envhound leaves it`);
        if (!current) {
          if (!machine(op.name)) notes.push(`${op.name} is not in your variables (${USER})`);
          break;
        }
        values = values.filter((v) => v !== current);
        writes.set(op.name.toUpperCase(), { name: current.name });
        break;
      }
      case "path-add": {
        const dirs = entries();
        const stored = storedDir(op.dir, get("USERPROFILE"));
        const rest = dirs.filter((d) => expanded(d) !== key(op.dir));
        const next = op.position === "front" ? [stored, ...rest] : [...rest, stored];
        if (next.join(";") !== dirs.join(";")) setPath(next);
        break;
      }
      case "path-remove": {
        const dirs = entries();
        const rest = dirs.filter((d) => expanded(d) !== key(op.dir));
        const inMachine = chain(trace, "PATH").some((a) => a.at.file === MACHINE && splitPath(trace, a.result).some((d) => key(d) === key(op.dir)));
        if (rest.length !== dirs.length) setPath(rest);
        else if (!inMachine) notes.push(`${op.dir} is not in your Path (${USER})`);
        if (inMachine) notes.push(`${op.dir} is in the machine's Path (${MACHINE}); changing that needs an administrator, so envhound leaves it`);
        break;
      }
    }
  }

  const before = registryText(user);
  const after = registryText(values);
  const changes: FileChange[] = writes.size && after !== before ? [{ path: USER, before, after, registry: [...writes.values()] }] : [];
  return { changes, notes };
}

/** Compare the ops against the registry read again after writing. */
export function verifyWindows(ops: EditOp[], trace: Trace): Check[] {
  const key = dirKey(trace);
  const path = splitPath(trace, lookup(trace, trace.final, "PATH")).map(key);
  const last = (name: string) => chain(trace, name).at(-1);
  return ops.map((op): Check => {
    switch (op.kind) {
      case "set": {
        const a = last(op.name);
        return a?.at.file === USER && a.value === op.value
          ? { ok: true, message: `new terminals now get ${op.name}` }
          : { ok: false, message: `new terminals don't get ${op.name} (envhound blame ${op.name} shows why)` };
      }
      case "unset":
        return last(op.name)
          ? { ok: false, message: `${op.name} is still set for new terminals (envhound blame ${op.name} shows where)` }
          : { ok: true, message: `${op.name} is no longer set for new terminals` };
      case "path-add":
        return path.includes(key(op.dir))
          ? { ok: true, message: `${op.dir} is now in PATH for new terminals` }
          : { ok: false, message: `${op.dir} is not in PATH for new terminals (envhound blame PATH shows why)` };
      case "path-remove":
        return path.includes(key(op.dir))
          ? { ok: false, message: `${op.dir} is still in PATH (envhound path shows who adds it)` }
          : { ok: true, message: `${op.dir} is no longer in PATH for new terminals` };
    }
  });
}

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** PowerShell commands that make the same change in the current terminal. Secret values are left out unless `showSecrets`. */
export function powershellCommands(ops: EditOp[], showSecrets = false): string[] {
  return ops.flatMap((op) => {
    switch (op.kind) {
      case "set":
        if (!showSecrets && isSecret(op.name)) return [`# $env:${op.name} = …  (value hidden; --show-secrets prints this command)`];
        return [`$env:${op.name} = ${op.value.includes("%") ? `[Environment]::ExpandEnvironmentVariables(${psQuote(op.value)})` : psQuote(op.value)}`];
      case "unset":
        return [`Remove-Item Env:${op.name}`];
      case "path-add":
        return [op.position === "front" ? `$env:Path = ${psQuote(op.dir + ";")} + $env:Path` : `$env:Path += ${psQuote(";" + op.dir)}`];
      case "path-remove":
        return [];
    }
  });
}
