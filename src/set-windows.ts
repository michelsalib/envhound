// envhound set / unset / path add / path remove on Windows: changes go to the
// user's variables (HKCU\Environment), which need no administrator, and removals also
// to the machine's (HKLM), for every user, through Windows' administrator prompt. The
// machine's come first in PATH and lose to the user's for other variables.
import { chain, dirKey, lookup, splitPath } from "./analyze.ts";
import type { FileChange } from "./edit.ts";
import { holdsSecret } from "./format.ts";
import type { Trace } from "./model.ts";
import type { Check, EditOp, Plan } from "./set.ts";
import {
	expand,
	MACHINE,
	type Registry,
	type RegistryValue,
	type RegistryWrite,
	type Scope,
	USER,
} from "./trace/windows.ts";

const isPathName = (name: string) => name.toUpperCase() === "PATH";
const isText = (v: RegistryValue) =>
	v.kind === "String" || v.kind === "ExpandString";
// a %VAR% reference only expands in an ExpandString value
const hasReference = (value: string) => /%[^%=]+%/.test(value);

/** The user's variables as shown in a diff: NAME=value, and Path one entry per line. */
export function registryText(values: RegistryValue[]): string {
	return values
		.filter(isText)
		.map((v) =>
			isPathName(v.name)
				? [
						`${v.name}=`,
						...v.value
							.split(";")
							.filter(Boolean)
							.map((d) => `    ${d}`),
					].join("\n")
				: `${v.name}=${v.value}`,
		)
		.join("\n")
		.concat(values.some(isText) ? "\n" : "");
}

/** DIR as stored in the user's Path: under the profile folder it is written %USERPROFILE%\…, which survives a renamed account. */
function storedDir(dir: string, profile: string | undefined): string {
	if (profile && dir.toUpperCase().startsWith(profile.toUpperCase() + "\\"))
		return "%USERPROFILE%" + dir.slice(profile.length);
	return dir;
}

const KEY = { user: USER, machine: MACHINE } as const;

export function planWindows(
	ops: EditOp[],
	stored: RegistryValue[],
	trace: Trace,
	scope: Scope = "user",
): Plan {
	let values = stored.filter(isText);
	const notes: string[] = [];
	const here = KEY[scope];
	const other = scope === "user" ? MACHINE : USER;
	const mine = scope === "user" ? "your" : "the machine's";
	const key = dirKey(trace);
	const get = (name: string) => lookup(trace, trace.final, name);
	const find = (name: string) =>
		values.find((v) => v.name.toUpperCase() === name.toUpperCase());
	const inOther = (name: string) =>
		chain(trace, name).some((a) => a.at.file === other);
	const inOtherPath = (dir: string) =>
		// the stored value, not the result: the user's Path result includes the machine's
		chain(trace, "PATH").some(
			(a) =>
				a.at.file === other &&
				splitPath(trace, a.value).some((d) => expanded(d) === key(dir)),
		);
	const put = (v: RegistryValue) =>
		(values = find(v.name)
			? values.map((x) => (x === find(v.name) ? { ...v, name: x.name } : x))
			: [...values, v]);
	const writes = new Map<string, RegistryWrite>();
	const pathOf = () => find("Path");
	const entries = () => splitPath(trace, pathOf()?.value ?? "").filter(Boolean);
	const expanded = (d: string) => key(expand(d, get));
	const setPath = (dirs: string[]) => {
		// a Path stored as a plain String (setx writes those) must become ExpandString to hold %USERPROFILE%\…
		const kind = dirs.some(hasReference)
			? "ExpandString"
			: ((pathOf()?.kind as RegistryWrite["kind"]) ?? "ExpandString");
		put({ name: pathOf()?.name ?? "Path", kind, value: dirs.join(";") });
		writes.set("PATH", { name: pathOf()!.name, kind, value: dirs.join(";") });
	};

	for (const op of ops) {
		switch (op.kind) {
			case "set": {
				const kind = hasReference(op.value)
					? "ExpandString"
					: ((find(op.name)?.kind as RegistryWrite["kind"]) ?? "String");
				if (inOther(op.name))
					notes.push(
						scope === "user"
							? `${op.name} is also set at ${MACHINE}, for every user; yours wins in your new terminals`
							: `${op.name} is also set in your own variables (${USER}), which win in your terminals; this sets it for the other users`,
					);
				put({ name: op.name, kind, value: op.value });
				writes.set(op.name.toUpperCase(), {
					name: find(op.name)!.name,
					kind,
					value: op.value,
				});
				break;
			}
			case "unset": {
				const current = find(op.name);
				if (!current) {
					notes.push(`${op.name} is not in ${mine} variables (${here})`);
					break;
				}
				values = values.filter((v) => v !== current);
				writes.set(op.name.toUpperCase(), { name: current.name });
				break;
			}
			case "path-add": {
				const dirs = entries();
				// %USERPROFILE% only means the right folder in your own Path
				const stored =
					scope === "user" ? storedDir(op.dir, get("USERPROFILE")) : op.dir;
				const rest = dirs.filter((d) => expanded(d) !== key(op.dir));
				const next =
					op.position === "front" ? [stored, ...rest] : [...rest, stored];
				if (next.join(";") !== dirs.join(";")) setPath(next);
				break;
			}
			case "path-remove": {
				const dirs = entries();
				// removing a duplicate keeps the first copy: the machine's when there is one (it comes
				// first in PATH), else the first one here
				const first = dirs.findIndex((d) => expanded(d) === key(op.dir));
				const keepFirst =
					op.duplicate && !(scope === "user" && inOtherPath(op.dir));
				const rest = dirs.filter(
					(d, i) => expanded(d) !== key(op.dir) || (keepFirst && i === first),
				);
				if (rest.length !== dirs.length) setPath(rest);
				else notes.push(`${op.dir} is not in ${mine} Path (${here})`);
				break;
			}
		}
	}

	const before = registryText(stored);
	const after = registryText(values);
	const changes: FileChange[] =
		writes.size && after !== before
			? [{ path: here, before, after, registry: [...writes.values()], scope }]
			: [];
	return { changes, notes };
}

/**
 * Route each change to the variables it concerns, then plan each scope. Removing (unset, path
 * remove) acts wherever the value is, yours and the machine's, so new terminals really lose it;
 * setting and adding go to yours, which need no administrator, unless an edit is of the machine's
 * own value (`machine`). Changes to the machine's come first: if Windows' administrator prompt is
 * declined, nothing is written.
 */
export function planRegistry(ops: EditOp[], reg: Registry, trace: Trace): Plan {
	const key = dirKey(trace);
	const get = (name: string) => lookup(trace, trace.final, name);
	const has = (vals: RegistryValue[], name: string) =>
		vals.some((v) => isText(v) && v.name.toUpperCase() === name.toUpperCase());
	const inPath = (vals: RegistryValue[], dir: string) =>
		splitPath(
			trace,
			vals.find((v) => isText(v) && isPathName(v.name))?.value ?? "",
		).some((d) => d && key(expand(d, get)) === key(dir));
	const user: EditOp[] = [];
	const machine: EditOp[] = [];
	const notes: string[] = [];
	for (const op of ops) {
		switch (op.kind) {
			case "set":
				(op.machine ? machine : user).push(op);
				break;
			case "path-add":
				user.push(op);
				break;
			case "unset": {
				const [u, m] = [has(reg.user, op.name), has(reg.machine, op.name)];
				if (u) user.push(op);
				if (m) machine.push(op);
				if (!u && !m)
					notes.push(`${op.name} is not in your variables or the machine's`);
				break;
			}
			case "path-remove": {
				const [u, m] = [inPath(reg.user, op.dir), inPath(reg.machine, op.dir)];
				if (op.duplicate) {
					// the first copy stays: the machine's when it has one, as it comes first
					if (u && m) user.push({ kind: "path-remove", dir: op.dir });
					else if (m) machine.push(op);
					else if (u) user.push(op);
				} else {
					if (u) user.push(op);
					if (m) machine.push(op);
				}
				if (!u && !m)
					notes.push(`${op.dir} is not in your Path or the machine's`);
				break;
			}
		}
	}
	const pm = machine.length
		? planWindows(machine, reg.machine, trace, "machine")
		: { changes: [], notes: [] };
	const pu = user.length
		? planWindows(user, reg.user, trace, "user")
		: { changes: [], notes: [] };
	if (pm.changes.length)
		notes.push(
			`this changes the machine's variables (${MACHINE}), for every user: Windows will ask for administrator rights`,
		);
	return {
		changes: [...pm.changes, ...pu.changes],
		notes: [...notes, ...pm.notes, ...pu.notes],
	};
}

/** Compare the ops against the registry read again after writing. */
export function verifyWindows(ops: EditOp[], trace: Trace): Check[] {
	const key = dirKey(trace);
	const path = splitPath(trace, lookup(trace, trace.final, "PATH")).map(key);
	const last = (name: string) => chain(trace, name).at(-1);
	const stored = (name: string, scope: Scope) =>
		chain(trace, name).find((a) => a.at.file === KEY[scope]);
	// biome-ignore lint/suspicious/useIterableCallbackReturn: the switch covers every op kind, and each case returns
	return ops.map((op): Check => {
		switch (op.kind) {
			case "set": {
				const a = last(op.name);
				const scope: Scope = op.machine ? "machine" : "user";
				if (a?.at.file === KEY[scope] && a.value === op.value)
					return { ok: true, message: `new terminals now get ${op.name}` };
				// the machine's value is written, but yours overrides it in your terminals
				if (scope === "machine" && stored(op.name, scope)?.value === op.value)
					return {
						ok: true,
						message: `${op.name} is set for every user; your own value (${USER}) still wins in your terminals`,
					};
				return {
					ok: false,
					message: `new terminals don't get ${op.name} (envhound blame ${op.name} shows why)`,
				};
			}
			case "unset":
				return last(op.name)
					? {
							ok: false,
							message: `${op.name} is still set for new terminals (envhound blame ${op.name} shows where)`,
						}
					: {
							ok: true,
							message: `${op.name} is no longer set for new terminals`,
						};
			case "path-add":
				return path.includes(key(op.dir))
					? { ok: true, message: `${op.dir} is now in PATH for new terminals` }
					: {
							ok: false,
							message: `${op.dir} is not in PATH for new terminals (envhound blame PATH shows why)`,
						};
			case "path-remove":
				if (op.duplicate)
					return path.filter((d) => d === key(op.dir)).length > 1
						? {
								ok: false,
								message: `${op.dir} is still in PATH more than once (envhound path shows who adds it)`,
							}
						: {
								ok: true,
								message: `${op.dir} is in PATH once for new terminals`,
							};
				return path.includes(key(op.dir))
					? {
							ok: false,
							message: `${op.dir} is still in PATH (envhound path shows who adds it)`,
						}
					: {
							ok: true,
							message: `${op.dir} is no longer in PATH for new terminals`,
						};
		}
	});
}

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** PowerShell commands that make the same change in the current terminal. Secret values are left out unless `showSecrets`. */
export function powershellCommands(
	ops: EditOp[],
	showSecrets = false,
): string[] {
	// biome-ignore lint/suspicious/useIterableCallbackReturn: the switch covers every op kind, and each case returns
	return ops.flatMap((op) => {
		switch (op.kind) {
			case "set":
				if (!showSecrets && holdsSecret(op.name, op.value))
					return [
						`# $env:${op.name} = …  (value hidden; --show-secrets prints this command)`,
					];
				return [
					`$env:${op.name} = ${op.value.includes("%") ? `[Environment]::ExpandEnvironmentVariables(${psQuote(op.value)})` : psQuote(op.value)}`,
				];
			case "unset":
				return [`Remove-Item Env:${op.name}`];
			case "path-add":
				return [
					op.position === "front"
						? `$env:Path = ${psQuote(op.dir + ";")} + $env:Path`
						: `$env:Path += ${psQuote(";" + op.dir)}`,
				];
			case "path-remove":
				return [];
		}
	});
}
