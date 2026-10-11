// What tracing bash and zsh share: starting the login shell from a clean environment with xtrace on,
// and replaying the assignments its trace shows. The clean environment means we only see what
// startup files do, never what the terminal passed in.
import { type IOType, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import type { Assignment, Location, Op, Trace, Via } from "../model.ts";

/** Starts each record in PS4 (bash repeats it once per nesting level). */
export const MARK = "\x1f";
/** Between PS4's fields. */
export const SEP = "\x1e";
// a record starts at a line that starts with the marker
export const RECORD = new RegExp(`\\n(?=${MARK})`);
export const MARKS = new RegExp(`^${MARK}+`);

// env by its full path: `command -p env` would do, but bash 3.2 then runs it with the default PATH
const ENV = ["/usr/bin/env", "/bin/env"].find((f) => existsSync(f)) ?? "env";

export const BASE_PATH =
	"/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** Native Windows has no shell startup files to replay: it keeps variables in the registry. */
export const canTrace = process.platform !== "win32";
export const NO_TRACE_ON_WINDOWS =
	"shell startup files can't be traced on Windows; envhound reads the registry there";

export interface TraceOptions {
	/** Trace startup files as if HOME were this directory. */
	home?: string;
	timeoutMs?: number;
}

export interface ShellRun {
	initial: Record<string, string>;
	final: Record<string, string>;
	/** The trace, as the shell wrote it. */
	stderr: Buffer;
}

/** Run `shell` (a name or a path) as a login shell with `flags`, PS4 set, and capture its trace. */
export function runShell(
	name: "bash" | "zsh",
	shell: string,
	flags: string[],
	ps4: string,
	opts: TraceOptions,
): ShellRun {
	if (!canTrace) throw new Error(NO_TRACE_ON_WINDOWS);
	const home = resolve(opts.home ?? process.env.HOME ?? userInfo().homedir);
	const user = process.env.USER ?? userInfo().username;
	const initial: Record<string, string> = {
		HOME: home,
		USER: user,
		LOGNAME: user,
		SHELL: process.env.SHELL ?? `/bin/${name}`,
		TERM: process.env.TERM ?? "xterm",
		PATH: BASE_PATH,
	};
	const dir = mkdtempSync(join(tmpdir(), "envhound-"));
	const envFile = join(dir, "env");
	try {
		// Startup files may print to stdout, so the final env goes to a file instead. Its path comes in through
		// the environment, never spliced into the command (a ' in TMPDIR); env runs by its full path, so a
		// PATH the startup files broke doesn't matter.
		const options = {
			env: { ...initial, PS4: ps4, ENVHOUND_ENV_FILE: envFile },
			cwd: home,
			stdio: ["ignore", "ignore", "pipe"] as IOType[],
			// a session of its own, without the terminal: startup files can't read keys from it
			// (zsh's compinit asks about insecure directories) or take it over for job control.
			// Node and Bun honour it in spawnSync too, though its type only lists it for spawn.
			detached: true,
			timeout: opts.timeoutMs ?? 15_000,
			// bytes: bash 3.2 cuts PS4 at a byte count, maybe inside a character
			maxBuffer: 256 * 1024 * 1024,
		};
		const r = spawnSync(
			shell,
			[...flags, `${ENV} -0 > "$ENVHOUND_ENV_FILE"`],
			options,
		);
		if (r.error) {
			const code = (r.error as NodeJS.ErrnoException).code;
			if (code === "ETIMEDOUT")
				throw new Error(
					`${name} startup files did not finish in time (is something waiting for input?)`,
				);
			if (code === "ENOENT") throw new Error(`${name} was not found`);
			throw r.error;
		}
		let env = "";
		try {
			env = readFileSync(envFile, "utf8");
		} catch {}
		if (!env)
			throw new Error(
				`${name} startup files did not finish (exit status ${r.status}); an 'exec' or 'exit' in a startup file stops the trace`,
			);
		const final = parseEnv0(env);
		delete final.PS4;
		delete final.ENVHOUND_ENV_FILE;
		return { initial, final, stderr: r.stderr };
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

/** One variable change a traced command makes. */
export interface Step {
	name: string;
	op: Op;
	value: string;
	/** Declared with `local` (or declare without -g): only local if inside a function. */
	local: boolean;
	/** `local X` / `declare X` with no value: changes scope, not value. */
	bare: boolean;
	/** The value afterwards, when the shell computes it (zsh's path arrays); else from op and value. */
	result?: string;
}

/** A traced command and where it ran. */
export interface Command {
	at: Location;
	via?: Via;
	cmd: string;
}

/** The current value of a variable, outside any function. */
export type Lookup = (name: string) => string | undefined;

/** Replay `commands` from `initial`, keeping function locals out of the result. */
export function replay(
	shell: Trace["shell"],
	commands: Iterable<Command>,
	parse: (cmd: string, get: Lookup) => Step[],
	initial: Record<string, string>,
	final: Record<string, string>,
): Trace {
	const assignments: Assignment[] = [];
	const values = new Map<string, string | undefined>(Object.entries(initial));
	const frames = new Map<string, Set<string>>(); // function call -> its local names
	const get = (name: string) => values.get(name);
	for (const { at, via, cmd } of commands) {
		const frame =
			via?.kind === "function"
				? `${via.name}@${via.at.file}:${via.at.line}`
				: undefined;
		for (const step of parse(cmd, get)) {
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
					: (step.result ??
						(step.op === "+=" ? (previous ?? "") + step.value : step.value));
			if (!local) values.set(step.name, result);
			const { name, op, value } = step;
			assignments.push({ name, op, value, previous, result, at, via, local });
		}
	}
	return { shell, initial, final, assignments };
}
