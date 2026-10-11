// envhound set / unset / path add / path remove on Windows: changes go to the
// user's variables (HKCU\Environment), which need no administrator, or with --machine
// from an administrator terminal to the machine's (HKLM), for every user. The machine's
// come first in PATH and lose to the user's for other variables.
import { chain, dirKey, lookup, splitPath } from "./analyze.ts";
import type { FileChange } from "./edit.ts";
import { holdsSecret } from "./format.ts";
import type { Trace } from "./model.ts";
import type { Check, EditOp, Plan } from "./set.ts";
import {
	expand,
	MACHINE,
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
	/** The other scope's value stays: how to change it. */
	const elsewhere = (subject: string) =>
		scope === "user"
			? `${subject} (${MACHINE}), for every user; envhound leaves it, unless you run it with --machine from an administrator terminal`
			: `${subject} (${USER}), which wins in your terminals; envhound leaves it (run it without --machine to change it)`;

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
				if (inOther(op.name))
					notes.push(
						elsewhere(
							scope === "user"
								? `${op.name} is set for the machine`
								: `${op.name} is also set in your own variables`,
						),
					);
				if (!current) {
					if (!inOther(op.name))
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
				// the stored value, not the result: the user's Path result includes the machine's
				const inOtherPath = chain(trace, "PATH").some(
					(a) =>
						a.at.file === other &&
						splitPath(trace, a.value).some((d) => expanded(d) === key(op.dir)),
				);
				// removing a duplicate keeps the first copy: the machine's when there is one (it comes
				// first in PATH), else the first one here
				const first = dirs.findIndex((d) => expanded(d) === key(op.dir));
				const keepFirst = op.duplicate && !(scope === "user" && inOtherPath);
				const rest = dirs.filter(
					(d, i) => expanded(d) !== key(op.dir) || (keepFirst && i === first),
				);
				if (rest.length !== dirs.length) setPath(rest);
				else if (!inOtherPath)
					notes.push(`${op.dir} is not in ${mine} Path (${here})`);
				if (inOtherPath && !op.duplicate)
					notes.push(
						elsewhere(
							scope === "user"
								? `${op.dir} is in the machine's Path`
								: `${op.dir} is also in your own Path`,
						),
					);
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

/** Compare the ops against the registry read again after writing. */
export function verifyWindows(
	ops: EditOp[],
	trace: Trace,
	scope: Scope = "user",
): Check[] {
	const key = dirKey(trace);
	const path = splitPath(trace, lookup(trace, trace.final, "PATH")).map(key);
	const last = (name: string) => chain(trace, name).at(-1);
	const stored = (name: string) =>
		chain(trace, name).find((a) => a.at.file === KEY[scope]);
	// biome-ignore lint/suspicious/useIterableCallbackReturn: the switch covers every op kind, and each case returns
	return ops.map((op): Check => {
		switch (op.kind) {
			case "set": {
				const a = last(op.name);
				if (a?.at.file === KEY[scope] && a.value === op.value)
					return { ok: true, message: `new terminals now get ${op.name}` };
				// the machine's value is written, but yours overrides it in your terminals
				if (scope === "machine" && stored(op.name)?.value === op.value)
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
