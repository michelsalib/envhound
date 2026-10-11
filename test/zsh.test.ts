// zsh: the parser on hand-written traces, then real zsh on test/fixtures/zhome when zsh is installed.
import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blame, pathEntries, status } from "../src/analyze.ts";
import type { Trace } from "../src/model.ts";
import { canTrace } from "../src/trace/shell.ts";
import { parseZshTrace, traceZsh, zshParser } from "../src/trace/zsh.ts";

const rec = (
	file: string,
	line: number,
	cmd: string,
	fn = file,
	caller = "zsh:0",
) => `\x1f${[file, line, fn, caller].join("\x1e")}\x1e${cmd}\n`;

/** Steps for each command in turn, from PATH=/usr/bin:/bin. */
function run(...cmds: string[]) {
	const parse = zshParser();
	const values = new Map<string, string | undefined>([
		["PATH", "/usr/bin:/bin"],
	]);
	return cmds.map((cmd) => {
		const steps = parse(cmd, (n) => values.get(n));
		for (const s of steps)
			if (!s.bare)
				values.set(
					s.name,
					s.op === "unset"
						? undefined
						: (s.result ??
								(s.op === "+="
									? (values.get(s.name) ?? "") + s.value
									: s.value)),
				);
		return steps;
	});
}

describe("zshParser", () => {
	test("export, typeset and plain assignments; several on one line", () => {
		expect(run("export A=1 B='x y'")[0]).toMatchObject([
			{ name: "A", value: "1", local: false },
			{ name: "B", value: "x y" },
		]);
		expect(run("A=1 B=2 ")[0]).toMatchObject([{ name: "A" }, { name: "B" }]);
		expect(run("typeset -x C=$'tab\\there'")[0]).toMatchObject([
			{ name: "C", value: "tab\there", local: true },
		]);
		expect(run("typeset -gx G=1")[0]).toMatchObject([{ local: false }]);
	});
	test("a prefix assignment only reaches its command", () =>
		expect(run("A=1 /usr/bin/true")[0]).toEqual([]));
	test("bare export and plain arrays change nothing", () => {
		expect(run("export V")[0]).toMatchObject([{ name: "V", bare: true }]);
		expect(
			run(
				"arr=( 1 2 ) ",
				"typeset -a arr=( 1 2 )",
				"typeset -A h=( k v )",
			).flat(),
		).toEqual([]);
	});
	test("path arrays change PATH", () => {
		const [set, add, first, nth] = run(
			"path=( /a /usr/bin ) ",
			"path+=( /b ) ",
			"path[1,0]=( /z ) ",
			"path[2]=/y ",
		);
		expect(set).toMatchObject([
			{ name: "PATH", op: "=", result: "/a:/usr/bin" },
		]);
		expect(add).toMatchObject([
			{ name: "PATH", op: "+=", value: ":/b", result: "/a:/usr/bin:/b" },
		]);
		expect(first?.[0]?.result).toBe("/z:/a:/usr/bin:/b");
		expect(nth?.[0]?.result).toBe("/z:/y:/usr/bin:/b");
	});
	test("typeset -U keeps the first copy, now and from then on", () => {
		const [, unique, add, scalar] = run(
			"PATH=/a:/b:/a ",
			"typeset -U path",
			"path+=( /b /c ) ",
			"PATH=/c:/c ",
		);
		expect(unique?.filter((s) => !s.bare)).toMatchObject([
			{ name: "PATH", result: "/a:/b" },
		]);
		expect(add?.[0]?.result).toBe("/a:/b:/c");
		expect(scalar?.[0]?.result).toBe("/c");
	});
	test("typeset -T ties a new pair", () => {
		const [tie, add] = run(
			"typeset -T LD_LIBRARY_PATH=/x ld_library_path",
			"ld_library_path+=( /y ) ",
		);
		expect(tie).toMatchObject([{ name: "LD_LIBRARY_PATH", value: "/x" }]);
		expect(add?.[0]).toMatchObject({
			name: "LD_LIBRARY_PATH",
			result: "/x:/y",
		});
	});
	test("unset, but not of functions", () => {
		expect(run("unset A path")[0]).toMatchObject([
			{ name: "A", op: "unset" },
			{ name: "PATH", op: "unset" },
		]);
		expect(run("unset -f fn")[0]).toEqual([]);
	});
});

describe("parseZshTrace", () => {
	const f = (s: string) => `/h/${s}`;
	const trace = parseZshTrace(
		rec(f(".zshenv"), 1, "export A=1") +
			rec(f(".zprofile"), 2, "add") +
			rec(f("lib.zsh"), 1, "local L=1", "add", `${f(".zprofile")}:2`) +
			rec(f("lib.zsh"), 2, "export FN=1", "add", `${f(".zprofile")}:2`) +
			rec(
				f("vars.zsh"),
				1,
				"export SRC=1",
				f("vars.zsh"),
				`${f(".zprofile")}:3`,
			) +
			rec(f(".zprofile"), 9, "export EV=1", "(eval)", `${f(".zprofile")}:4`) +
			"a warning\n" +
			rec(f(".zshrc"), 1, "export A=2") +
			rec("zsh", 1, "/usr/bin/env -0", "zsh", ""),
		{ PATH: "/usr/bin" },
		{},
	);
	const a = (name: string) => trace.assignments.find((x) => x.name === name)!;
	test("functions, sourced files and eval, with their callers", () => {
		expect(trace.shell).toBe("zsh");
		expect(a("L").local).toBe(true);
		expect(a("FN")).toMatchObject({
			at: { file: f("lib.zsh"), line: 2 },
			via: {
				kind: "function",
				name: "add",
				at: { file: f(".zprofile"), line: 2 },
			},
		});
		expect(a("SRC").via).toMatchObject({ kind: "source", at: { line: 3 } });
		expect(a("EV")).toMatchObject({ at: { file: f(".zprofile"), line: 4 } });
		expect(a("EV").via).toBeUndefined();
		expect(a("A").via).toBeUndefined();
	});
	test("knows where ~/.zshrc starts", () => {
		const names = trace.assignments.map((x) => x.name);
		expect(trace.afterLogin).toBe(names.lastIndexOf("A"));
	});
	test("a caller left unexpanded (PROMPT_SUBST turned off) falls back to the function's line", () => {
		const t = parseZshTrace(
			rec(f("lib.zsh"), 5, "export X=1", "add", "${funcfiletrace[1]-}"),
			{},
			{},
		);
		expect(t.assignments[0]?.via?.at).toEqual({ file: f("lib.zsh"), line: 5 });
	});
});

// real zsh: in PATH, or $SHELL
const zsh = Bun.which("zsh");
const zshTest = test.skipIf(!canTrace || !zsh);

describe.skipIf(!canTrace || !zsh)("fixture zsh home", () => {
	const home = join(import.meta.dir, "fixtures", "zhome");
	let t: Trace;
	beforeAll(() => {
		t = traceZsh({ home, zsh: zsh! });
	});
	const last = (name: string) => blame(t, name, {}).assignments.at(-1);
	const where = (name: string) => {
		const a = last(name);
		return a && `${a.at.file.replace(home, "~")}:${a.at.line}`;
	};

	test("finds the line that sets a variable, ~/.zshrc last", () => {
		expect(
			blame(t, "EDITOR", {}).assignments.map((a) =>
				a.at.file.replace(home, "~"),
			),
		).toEqual(["~/.zshenv", "~/.zshrc"]);
		expect(status(t, "EDITOR")).toBe("effective");
		expect(t.final.EDITOR).toBe("nano");
	});
	test("decodes quoted, multi-line and non-ASCII values", () => {
		expect(last("QUOTED")?.result).toBe(`it's "quoted"`);
		expect(last("MULTI")?.result).toBe("line1\nline2");
		expect(last("UNICODE")?.result).toBe("café ☕");
		expect(status(t, "GREETING")).toBe("effective");
	});
	test("locals, prefixes, unset, unexported", () => {
		expect(blame(t, "LOCALVAR", {}).assignments).toEqual([]);
		expect(blame(t, "PREFIXED", {}).assignments).toEqual([]);
		expect(status(t, "TEMP")).toBe("unset");
		expect(status(t, "SHELLONLY")).toBe("not-exported");
		expect(where("EVALED")).toBe("~/.zprofile:16");
		expect(last("SOURCED")?.via).toMatchObject({
			kind: "source",
			at: { line: 1 },
		});
	});
	test("PATH is simulated exactly, typeset -U included", () => {
		expect(status(t, "PATH")).toBe("effective");
		const entries = pathEntries(t, t.final.PATH!);
		const by = (d: string) => entries.find((e) => e.dir === d)?.addedBy;
		expect(by(`${home}/bin`)?.at.file).toBe(join(home, ".zshenv"));
		expect(by("/opt/envhound-test/bin")?.via).toMatchObject({
			kind: "function",
			name: "add_path",
			at: { file: join(home, ".zprofile"), line: 2 },
		});
		expect(entries.filter((e) => e.duplicateOf).map((e) => e.dir)).toEqual([]);
	});
});

describe.skipIf(!canTrace || !zsh)("envhound set with zsh", () => {
	const root = join(import.meta.dir, "..");
	const fixture = join(import.meta.dir, "fixtures", "zhome");
	const envhound = (home: string, ...args: string[]) =>
		spawnSync("bun", ["src/cli.ts", "--home", home, ...args], {
			cwd: root,
			encoding: "utf8",
			env: {
				...process.env,
				SHELL: zsh!,
				XDG_CONFIG_HOME: "/nonexistent",
				XDG_STATE_HOME: "/nonexistent",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
	const freshHome = () => {
		const home = mkdtempSync(join(tmpdir(), "envhound-zhome-"));
		cpSync(fixture, home, { recursive: true });
		return home;
	};

	zshTest("hooks ~/.zprofile, and says when ~/.zshrc wins", () => {
		const home = freshHome();
		const r = envhound(home, "set", "MSG=hi", "EDITOR=code", "--yes");
		expect(r.stdout).toContain("✓ a fresh login shell now gets MSG");
		expect(r.stdout).toContain(
			"EDITOR is also set at ~/.zshrc:1, which runs after ~/.zprofile",
		);
		expect(r.stdout).toContain("does not get EDITOR: ~/.zshrc:1 sets it again");
		expect(r.status).toBe(1);
		expect(readFileSync(join(home, ".zprofile"), "utf8")).toContain(
			"envhound/env.sh",
		);
		expect(spawnSync("test", ["-e", join(home, ".profile")]).status).toBe(1);
		expect(envhound(home, "set", "MSG=again", "--yes").status).toBe(0);
		expect(
			readFileSync(join(home, ".zprofile"), "utf8").match(/envhound\/env\.sh/g),
		).toHaveLength(2);
	});

	zshTest("follows ZDOTDIR", () => {
		const home = freshHome();
		cpSync(join(home, ".zprofile"), join(home, "lib", ".zprofile"));
		writeFileSync(join(home, ".zshenv"), "ZDOTDIR=$HOME/lib\n");
		const r = envhound(home, "path", "add", "/opt/zdot", "--yes");
		expect(r.stdout).toContain("/opt/zdot is now in PATH");
		expect(readFileSync(join(home, "lib", ".zprofile"), "utf8")).toContain(
			"envhound/env.sh",
		);
	});

	zshTest("--shell bash replays bash instead", () => {
		const r = envhound(
			fixture,
			"--shell",
			"bash",
			"--json",
			"blame",
			"SOURCED",
		);
		expect(JSON.parse(r.stdout).assignments).toEqual([]);
		expect(envhound(fixture, "--shell", "fish", "list").status).toBe(2);
	});
});

// A traced interactive zsh opens the terminal for job control: it must not keep it, or envhound
// is stopped (SIGTTOU) the moment it asks a question.
describe.skipIf(!canTrace || !zsh || !Bun.which("python3"))(
	"zsh at a real terminal",
	() => {
		zshTest(
			"set asks, then writes",
			() => {
				const root = join(import.meta.dir, "..");
				const home = mkdtempSync(join(tmpdir(), "envhound-zhome-"));
				cpSync(join(import.meta.dir, "fixtures", "zhome"), home, {
					recursive: true,
				});
				const r = spawnSync(
					"python3",
					[
						"-I",
						join(root, "scripts", "pty.py"),
						"100",
						"30",
						JSON.stringify([
							["wait", "[y/N]"],
							["send", "y\r"],
						]),
						process.execPath,
						join(root, "src", "cli.ts"),
						"--home",
						home,
						"set",
						"MSG=hi",
					],
					{
						encoding: "utf8",
						timeout: 60_000,
						env: {
							...process.env,
							SHELL: zsh!,
							XDG_CONFIG_HOME: "/nonexistent",
							XDG_STATE_HOME: "/nonexistent",
						},
					},
				);
				const out = (JSON.parse(r.stdout || "[]") as [number, string][])
					.map(([, text]) => text)
					.join("");
				// the screen too, when the prompt never came
				expect({ stderr: r.stderr, out }).toMatchObject({ stderr: "" });
				expect(out).toContain("✓ a fresh login shell now gets MSG");
			},
			90_000,
		);
	},
);
