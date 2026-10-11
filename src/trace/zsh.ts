// Replay a zsh login shell from a clean environment with xtrace on. zsh has no BASH_SOURCE: PS4's
// prompt escapes give the file and line (%x, %I) and the function or file running (%N), and with
// PROMPT_SUBST on, funcfiletrace gives where that function was called or that file sourced.
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { Location, Trace, Via } from "../model.ts";
import { words } from "../shellwords.ts";
import {
	type Command,
	type Lookup,
	MARK,
	MARKS,
	RECORD,
	replay,
	runShell,
	SEP,
	type Step,
	type TraceOptions,
} from "./shell.ts";

const PS4 = MARK + ["%x", "%I", "%N", "${funcfiletrace[1]-}"].join(SEP) + SEP;

/** How zsh names the -c command string in %x: not a startup file. */
const COMMAND_STRING = "zsh";

export interface ZshOptions extends TraceOptions {
	/** The zsh to run: a name looked up in PATH, or a path. */
	zsh?: string;
}

/** The zsh to run: the login shell when it is zsh, else the first in PATH. */
export function findZsh(env: Record<string, string | undefined>): string {
	if (env.SHELL && basename(env.SHELL) === "zsh") return env.SHELL;
	const dirs = (env.PATH ?? "").split(":").filter(Boolean);
	return dirs.map((d) => join(d, "zsh")).find((f) => existsSync(f)) ?? "zsh";
}

export function traceZsh(opts: ZshOptions = {}): Trace {
	const { initial, final, stderr } = runShell(
		"zsh",
		opts.zsh ?? "zsh",
		["-o", "promptsubst", "-lixc"],
		PS4,
		opts,
	);
	return parseZshTrace(stderr, initial, final);
}

/** `stderr` as zsh wrote it. */
export function parseZshTrace(
	stderr: string | Buffer,
	initial: Record<string, string>,
	final: Record<string, string>,
): Trace {
	const text = typeof stderr === "string" ? stderr : stderr.toString("utf8");
	// commands are parsed one by one as they are read, so counting steps finds where ~/.zshrc starts
	const parse = zshParser();
	let made = 0;
	let rc = false;
	let afterLogin: number | undefined;
	const count = (cmd: string, get: Lookup) => {
		if (rc) afterLogin ??= made;
		const steps = parse(cmd, get);
		made += steps.filter((s) => !s.bare).length;
		return steps;
	};
	const trace = replay(
		"zsh",
		commands(text, () => {
			rc = true;
		}),
		count,
		initial,
		final,
	);
	return { ...trace, afterLogin };
}

interface ZshFields {
	file: string;
	line: number;
	/** The function running, or the file when at its top level, or "(eval)". */
	fn: string;
	/** undefined: a startup file, or PROMPT_SUBST was turned off */
	caller: Location | undefined;
	/** A startup file, run by zsh itself. */
	startup: boolean;
	cmd: string;
}

/** One trace record (PS4's expansion, then the command), or undefined when it isn't one. */
export function zshFields(record: string): ZshFields | undefined {
	if (!record.startsWith(MARK)) return undefined;
	const parts = record.replace(MARKS, "").split(SEP);
	if (parts.length < 5) return undefined;
	const [file, line, fn, caller] = parts as [string, string, string, string];
	// "file:line", or "zsh:0" for a startup file; left unexpanded when a startup file unset PROMPT_SUBST
	const startup = caller === `${COMMAND_STRING}:0`;
	const c = /^(.*):(\d+)$/.exec(caller);
	return {
		file,
		line: Number(line),
		fn,
		caller: c && !startup ? { file: c[1]!, line: Number(c[2]) } : undefined,
		startup,
		cmd: parts.slice(4).join(SEP).replace(/\n$/, ""),
	};
}

/** ~/.zshrc and ~/.zlogin (and the /etc ones), which run after ~/.zprofile. */
const AFTER_LOGIN = /\/\.?z(shrc|login)$/;

/** `rc` is called just before the first command of a file that runs after ~/.zprofile. */
function* commands(text: string, rc: () => void): Generator<Command> {
	let seenRc = false;
	// Lines without the marker (shell warnings, output) belong to the previous record.
	for (const record of text.split(RECORD)) {
		const f = zshFields(record);
		if (!f || f.file === COMMAND_STRING) continue; // our own `env` command
		const { file, line, fn, caller, cmd } = f;
		if (!seenRc && f.startup && fn === file && AFTER_LOGIN.test(file)) {
			seenRc = true;
			rc();
		}
		// eval: %I is not the line of the eval, the caller is
		if (fn === "(eval)") {
			yield { at: caller ?? { file, line }, cmd };
			continue;
		}
		const via: Via | undefined =
			fn === file
				? caller && { kind: "source", name: "source", at: caller }
				: // a caller lost with PROMPT_SUBST: the line in the function is all we know
					{ kind: "function", name: fn, at: caller ?? { file, line } };
		yield { at: { file, line }, via, cmd };
	}
}

/** zsh keeps these arrays and the colon-separated variables in step (typeset -T makes more). */
const TIED: Record<string, string> = {
	path: "PATH",
	manpath: "MANPATH",
	fpath: "FPATH",
	cdpath: "CDPATH",
	mailpath: "MAILPATH",
	module_path: "MODULE_PATH",
	fignore: "FIGNORE",
	psvar: "PSVAR",
};

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?(\+?=)([\s\S]*)$/;
const DECLARE = new Set([
	"export",
	"typeset",
	"declare",
	"local",
	"readonly",
	"integer",
	"float",
]);

interface Assign {
	name: string;
	subscript?: string;
	op: "=" | "+=";
	/** an array for name=( a b ) */
	value: string | string[];
}

/** Assignment words from `i` on; zsh traces an array as `name=(`, its elements, then `)`. */
function assignWords(
	ws: string[],
	i: number,
): { assigns: Assign[]; names: string[]; next: number } {
	const assigns: Assign[] = [];
	const names: string[] = [];
	while (i < ws.length) {
		const m = ASSIGN.exec(ws[i]!);
		if (!m) break;
		i++;
		const [, name, subscript, op, rest] = m as unknown as [
			string,
			string,
			string | undefined,
			"=" | "+=",
			string,
		];
		let value: string | string[] = rest;
		if (rest === "(") {
			const end = ws.indexOf(")", i);
			const stop = end < 0 ? ws.length : end;
			value = ws.slice(i, stop);
			i = stop + 1;
		}
		assigns.push({ name, subscript, op, value });
		names.push(name);
	}
	return { assigns, names, next: i };
}

/** zsh array index (1-based, negative from the end) as a 0-based one. */
const index = (k: number, length: number) => (k < 0 ? length + k : k - 1);

/** A parser for one trace: it remembers ties (typeset -T) and unique arrays (typeset -U). */
export function zshParser(): (cmd: string, get: Lookup) => Step[] {
	const ties = new Map(
		Object.entries(TIED).map(([array, scalar]) => [
			array,
			{ scalar, sep: ":" },
		]),
	);
	const unique = new Set<string>(); // scalar names
	const scalarOf = (name: string) => ties.get(name)?.scalar ?? name;
	const sepOf = (scalar: string) =>
		[...ties.values()].find((t) => t.scalar === scalar)?.sep ?? ":";
	const dedupe = (scalar: string, xs: string[]) =>
		unique.has(scalar) ? [...new Set(xs)] : xs;
	const split = (scalar: string, v: string | undefined) =>
		v ? v.split(sepOf(scalar)) : [];

	const assign = (a: Assign, get: Lookup, local: boolean): Step[] => {
		const step = (s: Omit<Step, "local" | "bare">): Step[] => [
			{ ...s, local, bare: false },
		];
		const tie = ties.get(a.name);
		if (tie) {
			const { scalar, sep } = tie;
			const cur = split(scalar, get(scalar));
			const vals = Array.isArray(a.value) ? a.value : [a.value];
			let next: string[];
			if (a.subscript) {
				// path[1,0]=(dir) puts dir first; path[2]=dir replaces the second
				const ks = a.subscript.slice(1, -1).split(",").map(Number);
				if (a.op === "+=" || ks.some((k) => !Number.isInteger(k))) return [];
				const start = Math.max(0, index(ks[0]!, cur.length));
				const end = index(ks[1] ?? ks[0]!, cur.length);
				next = cur.slice();
				next.splice(start, Math.max(0, end - start + 1), ...vals);
			} else next = a.op === "+=" ? [...cur, ...vals] : vals;
			const result = dedupe(scalar, next).join(sep);
			return a.op === "+=" && !a.subscript
				? step({
						name: scalar,
						op: "+=",
						value: (cur.length ? sep : "") + vals.join(sep),
						result,
					})
				: step({ name: scalar, op: "=", value: result, result });
		}
		// other arrays are not part of the environment
		if (Array.isArray(a.value) || a.subscript) return [];
		if (!unique.has(a.name))
			return step({ name: a.name, op: a.op, value: a.value });
		const whole = a.op === "+=" ? (get(a.name) ?? "") + a.value : a.value;
		const result = dedupe(a.name, split(a.name, whole)).join(sepOf(a.name));
		return step({ name: a.name, op: a.op, value: a.value, result });
	};

	return (cmd, get) => {
		const ws = words(cmd);
		if (!ws.length) return [];
		if (ASSIGN.test(ws[0]!)) {
			const { assigns, next } = assignWords(ws, 0);
			// `A=1 cmd`: A is only in cmd's environment
			if (next < ws.length) return [];
			return assigns.flatMap((a) => assign(a, get, false));
		}
		const [head] = ws as [string];
		if (head === "unset") {
			const args = ws.slice(1);
			if (args.some((a) => /^-[a-zA-Z]*[fm]/.test(a))) return [];
			return args
				.filter((a) => !a.startsWith("-"))
				.map((a) => ({
					name: scalarOf(a),
					op: "unset",
					value: "",
					local: false,
					bare: false,
				}));
		}
		if (!DECLARE.has(head)) return [];
		let i = 1;
		let flags = "";
		while (i < ws.length && /^[-+]/.test(ws[i]!)) {
			if (ws[i]!.startsWith("-")) flags += ws[i]!.slice(1);
			i++;
		}
		if (/[fA]/.test(flags)) return [];
		// export is typeset -gx: global even inside a function
		const local = head !== "export" && !flags.includes("g");
		// typeset -T SCALAR array [sep]: ties a new pair, like PATH and path
		if (flags.includes("T")) {
			const { assigns, next } = assignWords(ws, i);
			const scalar = assigns[0]?.name ?? ws[i++];
			const array = assigns.length ? ws[next] : ws[i];
			const sep = (assigns.length ? ws[next + 1] : ws[i + 1])?.charAt(0);
			if (!scalar || !array) return [];
			ties.set(array, { scalar, sep: sep || ":" });
			return assigns.slice(0, 1).flatMap((a) => assign(a, get, local));
		}
		const steps: Step[] = [];
		const named: string[] = [];
		while (i < ws.length) {
			const { assigns, names, next } = assignWords(ws, i);
			if (assigns.length) {
				for (const a of assigns) steps.push(...assign(a, get, local));
				named.push(...names);
				i = next;
				continue;
			}
			const name = ws[i++]!;
			if (!NAME.test(name)) continue;
			named.push(name);
			steps.push({
				name: scalarOf(name),
				op: "=",
				value: "",
				local,
				bare: true,
			});
		}
		// typeset -U path: from now on only the first copy of each entry stays, the current value included
		if (flags.includes("U"))
			for (const name of new Set(named.map(scalarOf))) {
				unique.add(name);
				const cur = get(name);
				const deduped = dedupe(name, split(name, cur)).join(sepOf(name));
				if (cur !== undefined && deduped !== cur)
					steps.push({
						name,
						op: "=",
						value: deduped,
						local: false,
						bare: false,
						result: deduped,
					});
			}
		return steps;
	};
}
