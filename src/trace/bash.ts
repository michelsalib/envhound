// Replay a bash login shell from a clean environment with xtrace on, and turn
// the trace into a list of assignments.
import type { Op, Trace, Via } from "../model.ts";
import { words } from "../shellwords.ts";
import {
	type Command,
	MARK,
	MARKS,
	RECORD,
	replay,
	runShell,
	SEP,
	type Step,
	type TraceOptions,
} from "./shell.ts";

export {
	BASE_PATH,
	canTrace,
	NO_TRACE_ON_WINDOWS,
	parseEnv0,
	type TraceOptions,
} from "./shell.ts";

// bash repeats the first character of PS4 once per nesting level, which makes it a safe record marker.
// The short fields come first, and the caller's file only inside a function, as "=" when it is the
// same file (or "=" and the rest when it starts with it): bash 3.2 (macOS's /bin/bash) cuts the
// expanded prefix at TRUNCATED bytes, so it must stay short, and long paths go last.
const PS4 =
	MARK +
	[
		"${LINENO}",
		"${FUNCNAME[0]:-}",
		"${BASH_LINENO[0]:-}",
		"${BASH_SOURCE[0]:-}",
		'${FUNCNAME[0]:+${BASH_SOURCE[1]/#"${BASH_SOURCE[0]}"/=}}',
	].join(SEP) +
	SEP;
const TRUNCATED = 99;

export function traceBash(opts: TraceOptions = {}): Trace {
	const { initial, final, stderr } = runShell(
		"bash",
		"bash",
		["-lixc"],
		PS4,
		opts,
	);
	return parseTrace(stderr, initial, final);
}

const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)(\+?=)/;
const DECL_ARG = /^([A-Za-z_][A-Za-z0-9_]*)(?:(\+?=)([\s\S]*))?$/;

/** Variable changes made by one traced command. */
export function parseCommand(cmd: string): Step[] {
	const m = ASSIGN.exec(cmd);
	if (m) {
		const rest = cmd.slice(m[0].length);
		if (rest.startsWith("(")) return []; // array assignment: not part of the environment
		return [
			{
				name: m[1]!,
				op: m[2] as Op,
				value: words(rest)[0] ?? "",
				local: false,
				bare: false,
			},
		];
	}
	// `export` and `readonly` are skipped: bash traces each of their assignments again as a plain line.
	const [head, ...args] = words(cmd);
	const flags = args.filter((a) => a.startsWith("-")).join("");
	const names = args.filter((a) => !a.startsWith("-"));
	if (head === "unset") {
		if (flags.includes("f")) return [];
		return names.map((name) => ({
			name,
			op: "unset",
			value: "",
			local: false,
			bare: false,
		}));
	}
	if (head === "local" || head === "declare" || head === "typeset") {
		if (/[aAfF]/.test(flags)) return [];
		const local = head === "local" || !flags.includes("g");
		return names.flatMap((arg) => {
			const d = DECL_ARG.exec(arg);
			if (!d) return [];
			return [
				{
					name: d[1]!,
					op: (d[2] ?? "=") as Op,
					value: d[3] ?? "",
					local,
					bare: d[2] === undefined,
				},
			];
		});
	}
	return [];
}

/** `stderr` as bash wrote it; a string is taken as its UTF-8 bytes. */
export function parseTrace(
	stderr: string | Buffer,
	initial: Record<string, string>,
	final: Record<string, string>,
): Trace {
	return replay("bash", commands(stderr), parseCommand, initial, final);
}

function* commands(stderr: string | Buffer): Generator<Command> {
	// Lines without the marker (shell warnings, multi-line values) belong to the previous record.
	// one char per byte, so bash 3.2's byte count can be applied; fields are decoded once cut
	const bytes = typeof stderr === "string" ? Buffer.from(stderr) : stderr;
	for (const record of bytes.toString("latin1").split(RECORD)) {
		const fields = traceFields(record);
		if (!fields) continue;
		const { line, fn, callerLine, file, callerFile, cmd } = fields;
		if (!file) continue; // our own `env` command
		const via: Via | undefined = fn
			? {
					kind: fn === "source" || fn === "." ? "source" : "function",
					name: fn,
					// a caller cut off by bash 3.2: the line in the function is all we know
					at:
						callerFile === undefined
							? { file, line: Number(line) }
							: { file: callerFile, line: Number(callerLine) },
				}
			: undefined;
		yield { at: { file, line: Number(line) }, via, cmd };
	}
}

interface TraceFields {
	line: string;
	fn: string;
	callerLine: string;
	file: string;
	/** undefined: bash 3.2 cut it off */
	callerFile: string | undefined;
	cmd: string;
}

const utf8 = (latin1: string) => Buffer.from(latin1, "latin1").toString("utf8");

/**
 * One trace record (PS4's expansion, then the command), or undefined when it isn't one.
 * `record` holds one char per byte (latin1), as parseTrace splits it.
 */
export function traceFields(record: string): TraceFields | undefined {
	if (!record.startsWith(MARK)) return undefined;
	const parts = record.replace(MARKS, "").split(SEP);
	if (parts.length >= 6) {
		const [line, fn, callerLine, file, callerFile] = parts.map(utf8) as [
			string,
			string,
			string,
			string,
			string,
		];
		const cmd = utf8(parts.slice(5).join(SEP)).replace(/\n$/, "");
		const caller = callerFile.startsWith("=")
			? file + callerFile.slice(1)
			: callerFile;
		return { line, fn, callerLine, file, callerFile: caller, cmd };
	}
	// bash 3.2 keeps only the first TRUNCATED bytes of the expanded PS4 (marks included), so the
	// command starts right there. Usable when the file name survived; the caller's may not have.
	if (record.length <= TRUNCATED) return undefined;
	const head = record.slice(0, TRUNCATED).replace(MARKS, "").split(SEP);
	if (head.length < 5) return undefined; // the file name itself was cut
	const [line, fn, callerLine, file] = head.map(utf8) as [
		string,
		string,
		string,
		string,
	];
	const cmd = utf8(record.slice(TRUNCATED)).replace(/\n$/, "");
	return { line, fn, callerLine, file, callerFile: undefined, cmd };
}
