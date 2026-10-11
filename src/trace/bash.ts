// Replay a bash login shell from a clean environment with xtrace on, and turn
// the trace into a list of assignments. The clean environment means we only
// see what startup files do, never what the terminal passed in.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import type { Assignment, Op, Trace, Via } from "../model.ts";
import { words } from "../shellwords.ts";

const MARK = "\x1f";
const SEP = "\x1e";
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

// env by its full path: `command -p env` would do, but bash 3.2 then runs it with the default PATH
const ENV = ["/usr/bin/env", "/bin/env"].find((f) => existsSync(f)) ?? "env";

export const BASE_PATH =
	"/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** Native Windows has no bash startup files to replay: it keeps variables in the registry. */
export const canTrace = process.platform !== "win32";
export const NO_TRACE_ON_WINDOWS =
	"bash startup files can't be traced on Windows; envhound reads the registry there";

export interface TraceOptions {
	/** Trace startup files as if HOME were this directory. */
	home?: string;
	timeoutMs?: number;
}

export function traceBash(opts: TraceOptions = {}): Trace {
	if (!canTrace) throw new Error(NO_TRACE_ON_WINDOWS);
	const home = resolve(opts.home ?? process.env.HOME ?? userInfo().homedir);
	const user = process.env.USER ?? userInfo().username;
	const initial: Record<string, string> = {
		HOME: home,
		USER: user,
		LOGNAME: user,
		SHELL: process.env.SHELL ?? "/bin/bash",
		TERM: process.env.TERM ?? "xterm",
		PATH: BASE_PATH,
	};
	const dir = mkdtempSync(join(tmpdir(), "envhound-"));
	const envFile = join(dir, "env");
	try {
		// Startup files may print to stdout, so the final env goes to a file instead. Its path comes in through
		// the environment, never spliced into the command (a ' in TMPDIR); env runs by its full path, so a
		// PATH the startup files broke doesn't matter.
		const r = spawnSync("bash", ["-lixc", `${ENV} -0 > "$ENVHOUND_ENV_FILE"`], {
			env: { ...initial, PS4, ENVHOUND_ENV_FILE: envFile },
			cwd: home,
			stdio: ["ignore", "ignore", "pipe"],
			timeout: opts.timeoutMs ?? 15_000,
			// bytes: bash 3.2 cuts PS4 at a byte count, maybe inside a character
			maxBuffer: 256 * 1024 * 1024,
		});
		if (r.error) {
			if ((r.error as NodeJS.ErrnoException).code === "ETIMEDOUT")
				throw new Error(
					"bash startup files did not finish in time (is something waiting for input?)",
				);
			throw r.error;
		}
		let env = "";
		try {
			env = readFileSync(envFile, "utf8");
		} catch {}
		if (!env)
			throw new Error(
				`bash startup files did not finish (exit status ${r.status}); an 'exec' or 'exit' in a startup file stops the trace`,
			);
		const final = parseEnv0(env);
		delete final.PS4;
		delete final.ENVHOUND_ENV_FILE;
		return parseTrace(r.stderr, initial, final);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

export function parseEnv0(s: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const entry of s.split("\0")) {
		const eq = entry.indexOf("=");
		if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
	}
	return env;
}

interface Step {
	name: string;
	op: Op;
	value: string;
	/** Declared with `local` (or declare without -g): only local if inside a function. */
	local: boolean;
	/** `local X` / `declare X` with no value: changes scope, not value. */
	bare: boolean;
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
	const assignments: Assignment[] = [];
	const values = new Map<string, string | undefined>(Object.entries(initial));
	const frames = new Map<string, Set<string>>(); // function call -> its local names

	// Lines without the marker (shell warnings, multi-line values) belong to the previous record.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: \x1f is the record marker PS4 starts with
	// one char per byte, so bash 3.2's byte count can be applied; fields are decoded once cut
	const bytes = typeof stderr === "string" ? Buffer.from(stderr) : stderr;
	for (const record of bytes.toString("latin1").split(/\n(?=\x1f)/)) {
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
		const frame =
			via?.kind === "function"
				? `${via.name}@${via.at.file}:${via.at.line}`
				: undefined;

		for (const step of parseCommand(cmd)) {
			let local = false;
			if (frame) {
				const names = frames.get(frame) ?? new Set();
				frames.set(frame, names);
				if (step.local) names.add(step.name);
				local = names.has(step.name);
			}
			if (step.bare) continue;
			const previous = local ? undefined : values.get(step.name);
			const result =
				step.op === "unset"
					? undefined
					: step.op === "+="
						? (previous ?? "") + step.value
						: step.value;
			if (!local) values.set(step.name, result);
			const { name, op, value } = step;
			assignments.push({
				name,
				op,
				value,
				previous,
				result,
				at: { file, line: Number(line) },
				via,
				local,
			});
		}
	}
	return { shell: "bash", initial, final, assignments };
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
	const parts = record.replace(/^\x1f+/, "").split(SEP);
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
	const head = record
		.slice(0, TRUNCATED)
		.replace(/^\x1f+/, "")
		.split(SEP);
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
