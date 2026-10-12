import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor, type Finding } from "../src/doctor.ts";
import { renderDoctor } from "../src/format.ts";
import type { Assignment, Trace } from "../src/model.ts";

const unix = process.platform !== "win32";
// resolved: on macOS the temp dir is under /var, a symlink to /private/var
const home = realpathSync(mkdtempSync(join(tmpdir(), "envhound-doctor-")));
const managed = join(home, ".config", "envhound", "env.sh");
const dir = (name: string, ...programs: string[]) => {
	const d = join(home, name);
	mkdirSync(d, { recursive: true });
	for (const p of programs) {
		writeFileSync(join(d, p), "#!/bin/sh\n");
		chmodSync(join(d, p), 0o755);
	}
	return d;
};

/** One assignment per [name, value, file, line, op]; previous and result follow from the order. */
function trace(
	shell: Trace["shell"],
	steps: [string, string | undefined, string, number, Assignment["op"]?][],
	initial: Record<string, string>,
	final: Record<string, string>,
	extra: Partial<Trace> = {},
): Trace {
	const values = new Map(Object.entries(initial));
	const assignments: Assignment[] = steps.map(
		([name, value, file, line, op = "="]) => {
			const previous = values.get(name);
			const result = op === "unset" ? undefined : value;
			if (result === undefined) values.delete(name);
			else values.set(name, result);
			return {
				name,
				op,
				value: value ?? "",
				previous,
				result,
				at: { file, line },
				local: false,
			};
		},
	);
	return { shell, initial, final, assignments, ...extra };
}

const rules = (fs: Finding[]) => fs.map((f) => f.rule);
const find = (fs: Finding[], rule: string) => fs.find((f) => f.rule === rule)!;

describe.skipIf(!unix)("PATH rules", () => {
	const bin = dir("bin");
	const zprofile = join(home, ".zprofile");
	test("missing, duplicated, relative, empty and world-writable entries", () => {
		const open = dir("open");
		chmodSync(open, 0o777);
		const gone = join(home, "gone");
		const path = `${bin}:${gone}:/usr/bin:${bin}:rel:${open}:`;
		const t = trace(
			"zsh",
			[
				["PATH", `${bin}:/usr/bin`, zprofile, 1],
				["PATH", `${bin}:${gone}:/usr/bin`, zprofile, 2],
				["PATH", path, zprofile, 3],
			],
			{ PATH: "/usr/bin" },
			{ PATH: path },
		);
		const fs = doctor({ trace: t, env: { PATH: path }, home, managed });
		expect(rules(fs)).toEqual([
			"path-relative",
			"path-relative",
			"path-writable",
			"path-missing",
			"path-duplicate",
		]);
		expect(fs[0]!.title).toContain("#5 (rel) is relative");
		expect(fs[1]!.title).toContain("#7 is empty");
		expect(find(fs, "path-missing")).toMatchObject({
			title: `${gone} is in PATH but doesn't exist`,
			at: { file: zprofile, line: 2 },
		});
		// the line that added the second copy
		expect(find(fs, "path-duplicate")).toMatchObject({
			title: `${bin} is in PATH 2 times (#1, #4)`,
			at: { line: 3 },
		});
	});

	test("envhound's own lines come with the envhound command that fixes them", () => {
		const gone = join(home, "gone too");
		const t = trace(
			"bash",
			[["PATH", `/usr/bin:${gone}`, managed, 3]],
			{ PATH: "/usr/bin" },
			{ PATH: `/usr/bin:${gone}` },
		);
		const f = find(
			doctor({ trace: t, env: { PATH: `/usr/bin:${gone}` }, home, managed }),
			"path-missing",
		);
		expect(f.command).toBe(`envhound path remove '${gone}'`);
		expect(f.fix).toBe(`run envhound path remove '${gone}'`);
	});

	test("an entry from whatever started the shell, and a stale shell", () => {
		const t = trace(
			"bash",
			[["PATH", `${bin}:/usr/bin`, zprofile, 1]],
			{ PATH: "/usr/bin" },
			{ PATH: `${bin}:/usr/bin` },
		);
		const fs = doctor({
			trace: t,
			env: { PATH: `/usr/bin:${join(home, "from-ide")}` },
			home,
			managed,
		});
		expect(find(fs, "path-missing").fix).toContain(
			"whatever started this shell",
		);
		expect(find(fs, "stale-shell").title).toBe(
			`this shell lacks 1 PATH directory a new one gets: ${bin}`,
		);
	});

	test("two version managers for one language: the first in PATH wins", () => {
		const nvm = dir(".nvm/versions/node/v20/bin", "node");
		const volta = dir(".volta/bin", "node");
		const pyenv = dir(".pyenv/shims", "python3");
		const path = `${volta}:${nvm}:${pyenv}:/usr/bin`;
		const t = trace(
			"zsh",
			[["PATH", path, join(home, ".zshrc"), 4]],
			{ PATH: "/usr/bin" },
			{ PATH: path },
		);
		const fs = doctor({ trace: t, env: { PATH: path }, home, managed });
		expect(rules(fs)).toEqual(["version-managers"]);
		expect(fs[0]!.title).toBe(
			"node comes from 2 version managers (volta, nvm): volta wins, being first in PATH",
		);
	});
});

describe.skipIf(!unix)("variable rules", () => {
	const zshenv = join(home, ".zshenv");
	const zshrc = join(home, ".zshrc");

	test("not exported: only for variables programs read", () => {
		const t = trace(
			"bash",
			[
				["JAVA_HOME", "/opt/java", zshenv, 1],
				["HISTSIZE", "1000", zshenv, 2],
			],
			{},
			{},
		);
		const fs = doctor({ trace: t, env: {}, home, managed });
		expect(rules(fs)).toEqual(["not-exported"]);
		expect(fs[0]).toMatchObject({
			title: expect.stringContaining("JAVA_HOME"),
			at: { line: 1 },
		});
	});

	test("no effect, but not for a one-command prefix (A=1 cmd)", () => {
		const t = trace(
			"bash",
			[
				["SHELL", "/bin/sh", zshrc, 3],
				["GOPATH", "/go", zshrc, 4],
			],
			{ SHELL: "/bin/bash" },
			{ SHELL: "/bin/bash", GOPATH: "/other" },
		);
		const fs = doctor({ trace: t, env: {}, home, managed });
		expect(rules(fs)).toEqual(["no-effect"]);
		expect(fs[0]!.title).toStartWith("GOPATH is set here");
	});

	test("set in several of your files: the last one wins", () => {
		const t = trace(
			"zsh",
			[
				["EDITOR", "vi", "/etc/profile", 9],
				["EDITOR", "vim", zshenv, 1],
				["EDITOR", "nvim", zshrc, 5],
			],
			{},
			{ EDITOR: "nvim" },
		);
		const f = find(doctor({ trace: t, env: {}, home, managed }), "overridden");
		expect(f.title).toBe(
			`EDITOR is set in 2 of your files; ${zshrc.replace(home, "~")}:5 wins over ${zshenv.replace(home, "~")}:1`,
		);
	});

	test("zsh: exported only by ~/.zshrc", () => {
		const t = trace(
			"zsh",
			[
				["EARLY", "1", zshenv, 1],
				["LATE", "1", zshrc, 2],
			],
			{},
			{ EARLY: "1", LATE: "1" },
			{ afterLogin: 1 },
		);
		const fs = doctor({ trace: t, env: {}, home, managed });
		expect(rules(fs)).toEqual(["interactive-only"]);
		expect(fs[0]!.title).toStartWith("LATE is only set by ~/.zshrc");
	});

	test("a secret in a file other users can read", () => {
		const file = join(home, ".secretrc");
		writeFileSync(file, "export API_TOKEN=x\n");
		chmodSync(file, 0o644);
		const t = trace(
			"bash",
			[["API_TOKEN", "x", file, 1]],
			{},
			{ API_TOKEN: "x" },
		);
		expect(rules(doctor({ trace: t, env: {}, home, managed }))).toEqual([
			"readable-secret",
		]);
		chmodSync(file, 0o600);
		expect(doctor({ trace: t, env: {}, home, managed })).toEqual([]);
	});
});

test("Windows: the registry's own fix, no POSIX-only rules", () => {
	const gone = "C:\\Tools\\Gone";
	const t = trace(
		"windows",
		[["Path", `C:\\Windows;${gone}`, "HKCU\\Environment", 0]],
		{},
		{ Path: `C:\\Windows;${gone}` },
	);
	const f = doctor({
		trace: t,
		env: { Path: `C:\\Windows;${gone}` },
		home,
		managed,
	}).find((x) => x.title.startsWith(gone))!;
	expect(f.command).toBe(`envhound path remove ${gone}`);
});

test("rendering: errors first, a fix under each, and a count", () => {
	const fs: Finding[] = [
		{ rule: "a", severity: "info", title: "a note", fix: "nothing to do" },
		{
			rule: "b",
			severity: "error",
			title: "/home/u/x is wrong",
			at: { file: "/home/u/.zshrc", line: 3 },
			fn: "add_path",
			fix: "remove it",
		},
	];
	const text = renderDoctor(fs, {
		home: "/home/u",
		color: false,
		showSecrets: false,
	});
	expect(text).toBe(
		"· a note\n  fix: nothing to do\n\n✗ ~/x is wrong\n  at ~/.zshrc:3 add_path()\n  fix: remove it\n\n1 error, 1 note",
	);
	expect(renderDoctor([], { home, color: false, showSecrets: false })).toBe(
		"✓ no problems found",
	);
});

test.skipIf(!unix)("envhound doctor on the bash fixture home", () => {
	const root = join(import.meta.dir, "..");
	const r = spawnSync(
		process.execPath,
		[
			"src/cli.ts",
			"--home",
			join(import.meta.dir, "fixtures", "home"),
			"--json",
			"doctor",
		],
		{
			cwd: root,
			encoding: "utf8",
			// this shell's PATH, with the directory the fixture adds
			env: {
				...process.env,
				SHELL: "/bin/bash",
				PATH: "/usr/bin:/bin:/opt/envhound-test/bin",
			},
		},
	);
	const fs = JSON.parse(r.stdout) as Finding[];
	// add_path adds a directory that doesn't exist; SHELL=/bin/sh true is a prefix, not a problem
	expect(
		fs.filter((f) => f.rule === "path-missing").map((f) => f.title),
	).toContain("/opt/envhound-test/bin is in PATH but doesn't exist");
	expect(fs.filter((f) => f.title.startsWith("SHELL "))).toEqual([]);
});
