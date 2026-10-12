// envhound doctor: every problem with the environment a new shell gets, each with where it comes
// from and how to fix it. Each rule is a function from the facts to findings, so adding one is
// adding a function to RULES.
import { existsSync, statSync } from "node:fs";
import { release } from "node:os";
import { basename, join } from "node:path";
import {
	chain,
	dirKey,
	lookup,
	origin,
	pathEntries,
	splitPath,
	status,
} from "./analyze.ts";
import { isSecret } from "./format.ts";
import type { Assignment, Location, Trace } from "./model.ts";
import { shellQuote } from "./quote.ts";

export type Severity = "error" | "warning" | "info";

export interface Finding {
	/** Which rule found it, e.g. "path-missing". */
	rule: string;
	severity: Severity;
	/** One line: what is wrong. */
	title: string;
	/** Where it comes from: a startup file and line, or a registry key. */
	at?: Location;
	/** A function that made the assignment, named in `at`'s line. */
	fn?: string;
	/** What to do about it; `command` is one envhound can run for you. */
	fix: string;
	command?: string;
}

export interface DoctorFacts {
	trace: Trace;
	/** This shell's environment. */
	env: Record<string, string | undefined>;
	home: string;
	/** envhound's own file: lines there are changed with envhound's commands. */
	managed: string;
}

type Rule = (f: DoctorFacts) => Finding[];

/** Set by one of your own files (or a function they call), not a system one. */
const mine = (f: DoctorFacts, a: Assignment) =>
	a.at.file.startsWith(f.home) || !!a.via?.at.file.startsWith(f.home);

/** A directory that doesn't depend on the current directory. */
const absolute = (t: Trace, d: string) =>
	windows(t)
		? /^([A-Za-z]:[\\/]|\\\\)/.test(d) || /^%/.test(d)
		: d.startsWith("/");

/** This shell's PATH, entry by entry; none when it has no PATH at all. */
const currentPath = (f: DoctorFacts) => {
	const path = lookup(f.trace, f.env, "PATH");
	return path === undefined ? [] : pathEntries(f.trace, path);
};

const windows = (t: Trace) => t.shell === "windows";
/** A directory as a command argument: PowerShell on Windows, a POSIX shell elsewhere. */
const arg = (t: Trace, s: string) =>
	windows(t) ? (/^[\w.:\\-]+$/.test(s) ? s : `"${s}"`) : shellQuote(s);

/** Where an assignment is, and the fix that goes with it. */
function source(
	f: DoctorFacts,
	a: Assignment | undefined,
	remove: string,
	command?: string,
): Pick<Finding, "at" | "fn" | "fix" | "command"> {
	if (!a)
		return {
			fix: "it comes from whatever started this shell (terminal, IDE, desktop session), not from a startup file",
		};
	const at = origin(a);
	const fn = a.via?.kind === "function" ? a.via.name : undefined;
	// envhound's own file, or on Windows the registry: envhound changes it for you
	if (command && (a.at.file === f.managed || windows(f.trace)))
		return { at, fn, fix: `run ${command}`, command };
	return { at, fn, fix: remove };
}

/** Directories in this shell's PATH that don't exist. */
const pathMissing: Rule = (f) => {
	const entries = currentPath(f);
	return (
		entries
			// relative entries are a problem of their own (pathRelative)
			.filter((e) => absolute(f.trace, e.dir) && !e.exists && !e.duplicateOf)
			.filter((e) => e.source !== "initial")
			// a system file's directory (/etc/profile.d adding /snap/bin): harmless, and not yours to edit
			.filter((e) => !e.addedBy || windows(f.trace) || mine(f, e.addedBy))
			.map((e) => ({
				rule: "path-missing",
				severity: "warning",
				title: `${e.dir} is in PATH but doesn't exist`,
				...source(
					f,
					e.addedBy,
					"remove that line, or create the directory",
					`envhound path remove ${arg(f.trace, e.dir)}`,
				),
			}))
	);
};

/** The PATH assignment that first made `dir` appear twice, if a startup file did it. */
function duplicatedBy(t: Trace, dir: string): Assignment | undefined {
	const key = dirKey(t);
	const count = (p: string | undefined) =>
		splitPath(t, p).filter((d) => key(d) === key(dir)).length;
	return chain(t, "PATH").find(
		(a) => count(a.result) > 1 && count(a.result) > count(a.previous),
	);
}

/** Directories listed more than once: only the first copy is ever searched. */
const pathDuplicates: Rule = (f) => {
	const entries = currentPath(f);
	const seen = new Set<number>();
	return entries
		.filter((e) => e.dir && e.duplicateOf && !seen.has(e.duplicateOf))
		.map((e) => {
			seen.add(e.duplicateOf!);
			const copies = entries
				.filter(
					(x) => x.index === e.duplicateOf || x.duplicateOf === e.duplicateOf,
				)
				.map((x) => `#${x.index}`);
			const by = duplicatedBy(f.trace, e.dir);
			return {
				rule: "path-duplicate",
				// not from a startup file: nothing there to fix
				severity: by ? ("warning" as const) : ("info" as const),
				title: `${e.dir} is in PATH ${copies.length} times (${copies.join(", ")})`,
				...(by
					? source(
							f,
							by,
							"this line adds it again: guard it, or remove it",
							// envhound's own copy only; on Windows the command would remove every copy
							windows(f.trace)
								? undefined
								: `envhound path remove ${arg(f.trace, e.dir)}`,
						)
					: {
							fix: "a new shell has it once: whatever started this shell added it again (a terminal opened from another shell, an IDE)",
						}),
			};
		});
};

/** Empty or relative entries: commands are then looked up in whatever the current directory is. */
const pathRelative: Rule = (f) => {
	const entries = currentPath(f);
	return entries
		.filter((e) => !absolute(f.trace, e.dir))
		.map((e) => ({
			rule: "path-relative",
			severity: "error" as const,
			title:
				e.dir === ""
					? `PATH entry #${e.index} is empty: the current directory is searched for commands`
					: `PATH entry #${e.index} (${e.dir}) is relative: what it finds depends on the current directory`,
			...source(
				f,
				e.addedBy,
				e.dir === ""
					? "look for a stray separator (a leading, trailing or doubled ':') in that line"
					: "use an absolute path there",
			),
		}));
};

// WSL shows Windows drives (/mnt/c) with permissions that mean nothing: every file looks 777
const WSL = release().toLowerCase().includes("microsoft");
const WINDOWS_DRIVE = /^\/mnt\/[a-z]\//i;

/** Directories anyone can write to: anyone can then put a program there that runs as you. */
const pathWritable: Rule = (f) => {
	if (windows(f.trace)) return [];
	const entries = currentPath(f);
	return entries
		.filter((e) => e.dir.startsWith("/") && e.exists && !e.duplicateOf)
		.filter((e) => !(WSL && WINDOWS_DRIVE.test(e.dir)))
		.filter((e) => {
			try {
				return (statSync(e.dir).mode & 0o002) !== 0;
			} catch {
				return false;
			}
		})
		.map((e) => ({
			rule: "path-writable",
			severity: "error" as const,
			title: `${e.dir} is in PATH and anyone on this machine can write to it`,
			...source(
				f,
				e.addedBy,
				`remove it from PATH, or run chmod o-w ${arg(f.trace, e.dir)}`,
			),
		}));
};

/** Version managers by the directories they put in PATH; asdf and mise manage every language. */
const MANAGERS: { name: string; dir: RegExp; tools: string[] }[] = [
	{
		name: "nvm",
		dir: /[\\/]\.nvm[\\/]versions[\\/]node[\\/]/,
		tools: ["node"],
	},
	{ name: "fnm", dir: /fnm[_-]multishells|[\\/]fnm[\\/]/, tools: ["node"] },
	{ name: "volta", dir: /[\\/]\.?volta[\\/]bin$/i, tools: ["node"] },
	{ name: "nodenv", dir: /[\\/]\.nodenv[\\/]shims$/, tools: ["node"] },
	{
		name: "pyenv",
		dir: /[\\/]\.?pyenv([\\/]pyenv-win)?[\\/]shims$/i,
		tools: ["python3", "python"],
	},
	{
		name: "conda",
		dir: /[\\/](mini|ana)conda3?([\\/]|$)|[\\/](miniforge|mambaforge)3?([\\/]|$)/i,
		tools: ["python3", "python"],
	},
	{ name: "rbenv", dir: /[\\/]\.rbenv[\\/]shims$/, tools: ["ruby"] },
	{ name: "rvm", dir: /[\\/]\.rvm[\\/]/, tools: ["ruby"] },
	{ name: "jenv", dir: /[\\/]\.jenv[\\/]shims$/, tools: ["java"] },
	{
		name: "sdkman",
		dir: /[\\/]\.sdkman[\\/]candidates[\\/]java[\\/]/,
		tools: ["java"],
	},
	{
		name: "asdf",
		dir: /[\\/]\.asdf[\\/]shims$/,
		tools: ["node", "python3", "python", "ruby", "java", "go"],
	},
	{
		name: "mise",
		dir: /[\\/]mise[\\/]shims$/,
		tools: ["node", "python3", "python", "ruby", "java", "go"],
	},
];

/** Two version managers in PATH for the same language: the first in PATH wins, which surprises. */
const managersFight: Rule = (f) => {
	const entries = currentPath(f);
	const exe = (dir: string, tool: string) =>
		[tool, `${tool}.exe`, `${tool}.cmd`].some((n) => existsSync(join(dir, n)));
	const findings: Finding[] = [];
	const done = new Set<string>();
	for (const tool of ["node", "python3", "ruby", "java", "go"]) {
		const found = MANAGERS.flatMap((m) =>
			m.tools.includes(tool)
				? entries
						.filter(
							(e) => !e.duplicateOf && m.dir.test(e.dir) && exe(e.dir, tool),
						)
						.slice(0, 1)
						.map((e) => ({ manager: m.name, entry: e }))
				: [],
		).sort((a, b) => a.entry.index - b.entry.index);
		const managers = [...new Set(found.map((x) => x.manager))];
		if (managers.length < 2 || done.has(managers.join())) continue;
		done.add(managers.join());
		const [first, ...rest] = found;
		findings.push({
			rule: "version-managers",
			severity: "warning",
			title: `${tool} comes from ${managers.length} version managers (${managers.join(", ")}): ${first!.manager} wins, being first in PATH`,
			...source(
				f,
				rest[0]!.entry.addedBy,
				`keep one manager for ${tool}: remove ${rest.map((x) => x.manager).join(" and ")} from PATH here, or uninstall it`,
			),
		});
	}
	return findings;
};

/** This shell's PATH lacks directories a new one gets: it started before they were added. */
const staleShell: Rule = (f) => {
	const current = lookup(f.trace, f.env, "PATH");
	const fresh = lookup(f.trace, f.trace.final, "PATH");
	if (current === undefined || fresh === undefined) return [];
	const key = dirKey(f.trace);
	const have = new Set(splitPath(f.trace, current).map(key));
	const missing = splitPath(f.trace, fresh).filter(
		(d) => d && !have.has(key(d)),
	);
	if (!missing.length) return [];
	return [
		{
			rule: "stale-shell",
			severity: "info",
			title: `this shell lacks ${missing.length} PATH director${missing.length === 1 ? "y" : "ies"} a new one gets: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", …" : ""}`,
			fix: windows(f.trace)
				? "open a new terminal"
				: "open a new terminal, or run exec $SHELL -l",
		},
	];
};

// variables programs read; set without export, they never reach those programs
const PROGRAM_VARS =
	/^(EDITOR|VISUAL|PAGER|BROWSER|LANG|LANGUAGE|TZ|LC_[A-Z]+|[A-Z][A-Z0-9_]*_(HOME|ROOT|PATH|DIR|TOKEN|KEY|URL|HOST|CONFIG))$/;

/** A variable programs read, set but never exported. */
const notExported: Rule = (f) => {
	if (windows(f.trace)) return [];
	const names = [...new Set(f.trace.assignments.map((a) => a.name))];
	return names
		.filter(
			(n) => PROGRAM_VARS.test(n) && status(f.trace, n) === "not-exported",
		)
		.map((n) => ({
			rule: "not-exported",
			severity: "warning" as const,
			title: `${n} is set but not exported: programs you start don't see it`,
			...source(
				f,
				chain(f.trace, n).at(-1),
				`export it there (export ${n}=…), or set it with envhound set`,
			),
		}));
};

/** The last assignment isn't what a new shell ends with, and it isn't a one-command prefix. */
const noEffect: Rule = (f) => {
	const names = [...new Set(f.trace.assignments.map((a) => a.name))];
	return names.flatMap((n) => {
		if (status(f.trace, n) !== "not-effective") return [];
		const last = chain(f.trace, n).at(-1)!;
		const fresh = lookup(f.trace, f.trace.final, n);
		// a prefix (A=1 cmd) is traced as an assignment; afterwards the variable is back to before
		if (fresh === last.previous) return [];
		return [
			{
				rule: "no-effect",
				severity: "warning" as const,
				title: `${n} is set here, but a new shell ends up with another value: something the trace can't see changes it afterwards`,
				...source(
					f,
					last,
					`look for a tool that rewrites ${n} after startup (a prompt hook, a direnv or mise hook)`,
				),
			},
		];
	});
};

/** A variable set in several of your own files: the last one wins, the others are dead lines. */
const overridden: Rule = (f) => {
	const mine = (a: Assignment) =>
		a.at.file.startsWith(f.home) && a.at.file !== f.managed;
	const names = [...new Set(f.trace.assignments.map((a) => a.name))];
	return names.flatMap((n) => {
		if (/^PATH$/i.test(n)) return [];
		const sets = chain(f.trace, n).filter((a) => a.op === "=" && mine(a));
		const files = new Set(sets.map((a) => origin(a).file));
		if (files.size < 2) return [];
		const last = sets.at(-1)!;
		const earlier = sets.filter(
			(a) => origin(a).file !== origin(last).file && a.result !== last.result,
		);
		if (!earlier.length) return [];
		const where = (a: Assignment) => {
			const l = origin(a);
			return `${l.file.startsWith(f.home) ? `~${l.file.slice(f.home.length)}` : l.file}:${l.line}`;
		};
		return [
			{
				rule: "overridden",
				severity: "info" as const,
				title: `${n} is set in ${files.size} of your files; ${where(last)} wins over ${earlier.map(where).join(", ")}`,
				...source(
					f,
					last,
					"keep one of these lines, so the value is set in one place",
				),
			},
		];
	});
};

/** zsh: a variable exported only by ~/.zshrc, which scripts and non-interactive shells don't run. */
const interactiveOnly: Rule = (f) => {
	const t = f.trace;
	if (t.shell !== "zsh" || t.afterLogin === undefined) return [];
	const rc = /(^|[\\/])\.?zshrc$/;
	const names = [...new Set(t.assignments.map((a) => a.name))];
	return names.flatMap((n) => {
		if (/^PATH$/.test(n) || lookup(t, t.final, n) === undefined) return [];
		const c = chain(t, n);
		const last = c.at(-1)!;
		if (!c.every((a) => t.assignments.indexOf(a) >= t.afterLogin!)) return [];
		if (!rc.test(basename(origin(last).file))) return [];
		return [
			{
				rule: "interactive-only",
				severity: "info" as const,
				title: `${n} is only set by ~/.zshrc: scripts, zsh -c and ssh host cmd don't get it`,
				...source(
					f,
					last,
					"if programs need it everywhere, move it to ~/.zshenv (or ~/.zprofile), or set it with envhound set",
				),
			},
		];
	});
};

/** A secret value in a startup file that other users of this machine can read. */
const readableSecret: Rule = (f) => {
	if (windows(f.trace)) return [];
	const seen = new Set<string>();
	return f.trace.assignments.flatMap((a) => {
		if (!isSecret(a.name) || !a.value || a.local || seen.has(a.name)) return [];
		let mode: number;
		try {
			mode = statSync(a.at.file).mode;
		} catch {
			return [];
		}
		if (!(mode & 0o044)) return [];
		seen.add(a.name);
		return [
			{
				rule: "readable-secret",
				severity: "warning" as const,
				title: `${a.name} looks like a secret, and ${a.at.file.startsWith(f.home) ? `~${a.at.file.slice(f.home.length)}` : a.at.file} can be read by other users (mode ${(mode & 0o777).toString(8)})`,
				...source(
					f,
					a,
					`run chmod 600 on that file, or move ${a.name} out of it: envhound set ${a.name} --stdin keeps it in a file only you can read`,
				),
			},
		];
	});
};

export const RULES: Rule[] = [
	pathRelative,
	pathWritable,
	pathMissing,
	pathDuplicates,
	managersFight,
	notExported,
	noEffect,
	readableSecret,
	overridden,
	interactiveOnly,
	staleShell,
];

const ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** Every finding, errors first. */
export function doctor(f: DoctorFacts): Finding[] {
	return RULES.flatMap((rule) => rule(f)).sort(
		(a, b) => ORDER[a.severity] - ORDER[b.severity],
	);
}
