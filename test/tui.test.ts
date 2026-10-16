import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Data,
	dotenvViews,
	handleKey,
	handleMouse,
	initialState,
	type Key,
	pathViews,
	type State,
	varViews,
} from "../src/tui/state.ts";
import {
	cmdArg,
	editorCommand,
	parseMouse,
	windowsCommand,
} from "../src/tui/terminal.ts";
import { hitTest, keepScroll, render, wrap } from "../src/tui/view.ts";

const ENV = join(process.cwd(), ".env");
const data = (): Data => ({
	home: "/home/u",
	vars: [
		{
			name: "EDITOR",
			value: "vim",
			by: "~/.profile:3",
			source: { file: "/home/u/.profile", line: 3 },
			managed: false,
		},
		{
			name: "MINE",
			value: "1",
			by: "envhound",
			source: { file: "/home/u/.config/envhound/env.sh", line: 4 },
			managed: true,
		},
		{ name: "API_TOKEN", value: "s3cret", by: "envhound", managed: true },
		{ name: "TERM", value: "xterm", by: "(inherited)", managed: false },
	],
	path: [
		{ dir: "/home/u/bin", by: "envhound", managed: true, exists: true },
		{ dir: "/usr/bin", by: "(initial)", managed: false, exists: true },
		{
			dir: "/gone",
			by: "~/.profile:9",
			source: { file: "/home/u/.profile", line: 9 },
			managed: false,
			exists: false,
		},
	],
	dotenv: [
		{
			file: ENV,
			exists: true,
			problems: 1,
			rows: [
				{ key: "PORT", value: "3000", line: 1, status: "new", count: 1 },
				{
					key: "EDITOR",
					value: "nano",
					line: 2,
					status: "conflict",
					current: "vim",
					count: 1,
				},
				{
					key: "DUP",
					value: "2",
					line: 4,
					status: "new",
					count: 2,
					problem: "duplicate of line 3; most loaders keep the last one",
				},
			],
		},
	],
});

const type = (t: string): Key[] => [...t].map((ch) => ({ ch }));
function press(
	s: State,
	...keys: Key[]
): [State, ReturnType<typeof handleKey>[1]] {
	let effect: ReturnType<typeof handleKey>[1];
	for (const k of keys) [s, effect] = handleKey(s, k);
	return [s, effect];
}
const at = (s: State, name: string) =>
	varViews(s).findIndex((r) => r.name === name);
const goTo = (s: State, name: string) => ({
	...s,
	cursor: { ...s.cursor, vars: at(s, name) },
});

describe("variables tab", () => {
	test("edit stages a set, shown as old → new", () => {
		let [s] = press(
			goTo(initialState(data()), "EDITOR"),
			{ name: "return" },
			{ ctrl: true, name: "u" },
			...type("code"),
			{ name: "return" },
		);
		expect(s.ops).toEqual([{ kind: "set", name: "EDITOR", value: "code" }]);
		expect(render(s, 80, 12, { color: false }).join("\n")).toContain(
			"vim → code",
		);
		// editing again replaces the staged op instead of adding one
		[s] = press(
			s,
			{ name: "return" },
			{ name: "backspace" },
			{ name: "return" },
		);
		expect(s.ops).toEqual([{ kind: "set", name: "EDITOR", value: "cod" }]);
	});

	test("new variable, validated", () => {
		let [s] = press(initialState(data()), { ch: "n" }, ...type("1bad"), {
			name: "return",
		});
		expect(s.message?.error).toBe(true);
		expect(s.prompt).toBeDefined(); // still asking
		[s] = press(
			s,
			{ ctrl: true, name: "u" },
			...type("NEW_ONE"),
			{ name: "return" },
			...type("x y"),
			{ name: "return" },
		);
		expect(s.ops).toEqual([{ kind: "set", name: "NEW_ONE", value: "x y" }]);
		expect(varViews(s).find((r) => r.name === "NEW_ONE")?.pending).toBe("new");
	});

	test("d unsets envhound's variables, refuses others and says where they come from", () => {
		let [s] = press(goTo(initialState(data()), "MINE"), { ch: "d" });
		expect(s.ops).toEqual([{ kind: "unset", name: "MINE" }]);
		[s] = press(goTo(s, "EDITOR"), { ch: "d" });
		expect(s.message).toMatchObject({
			error: true,
			text: expect.stringContaining("~/.profile:3"),
		});
		[s] = press(goTo(s, "TERM"), { ch: "d" });
		expect(s.message?.text).toContain("program that started this shell");
	});

	test("filter as you type; esc clears", () => {
		let [s] = press(initialState(data()), { ch: "/" }, ...type("edi"));
		expect(varViews(s).map((r) => r.name)).toEqual(["EDITOR"]);
		[s] = press(s, { name: "return" }, { name: "escape" });
		expect(s.filter).toBe("");
	});

	test("secrets are masked, in the list and while typing", () => {
		let [s] = press(goTo(initialState(data()), "API_TOKEN"));
		expect(render(s, 80, 12, { color: false }).join("\n")).not.toContain(
			"s3cret",
		);
		[s] = press(s, { name: "return" });
		expect(render(s, 80, 12, { color: false }).at(-1)).toContain("••••••");
		[s] = press(s, { name: "escape" }, { ch: "s" });
		expect(render(s, 80, 12, { color: false }).join("\n")).toContain("s3cret");
	});

	test("a just-typed secret character shows until the reveal is cleared", () => {
		let [s] = press(
			goTo(initialState(data()), "API_TOKEN"),
			{ name: "return" },
			{ ch: "Z" },
		);
		expect(render(s, 80, 12, { color: false }).at(-1)).toContain("••••••Z");
		expect(
			render({ ...s, prompt: { ...s.prompt!, reveal: false } }, 80, 12, {
				color: false,
			}).at(-1),
		).not.toContain("Z");
		[s] = press(s, { name: "backspace" });
		expect(s.prompt?.reveal).toBe(false);
	});

	test("typing into a masked value wider than the screen still changes the prompt", () => {
		const long = data();
		long.vars[2]!.value = "x".repeat(200);
		let [s] = press(goTo(initialState(long), "API_TOKEN"), { name: "return" });
		const before = render(s, 40, 12, { color: false }).at(-1)!;
		expect(before).toContain("(200 characters)");
		expect([...before].length).toBeLessThanOrEqual(40);
		[s] = press(s, { ch: "y" });
		expect(render(s, 40, 12, { color: false }).at(-1)).toContain(
			"(201 characters)",
		);
	});

	test("o opens the source line, or explains why not", () => {
		expect(press(goTo(initialState(data()), "EDITOR"), { ch: "o" })[1]).toEqual(
			{ kind: "open", at: { file: "/home/u/.profile", line: 3 } },
		);
		expect(
			press(goTo(initialState(data()), "TERM"), { ch: "o" })[1],
		).toBeUndefined();
	});
});

// POSIX paths; on Windows, edit doesn't reach the PATH tab yet
describe.skipIf(process.platform === "win32")("PATH tab", () => {
	test("add front / end, refuse duplicates, d drops a staged add", () => {
		let [s] = press(
			initialState(data()),
			{ name: "tab" },
			{ ch: "a" },
			...type("~/tools"),
			{ name: "return" },
		);
		expect(s.ops).toEqual([
			{ kind: "path-add", dir: "/home/u/tools", position: "front" },
		]);
		expect(pathViews(s)[0]).toMatchObject({
			dir: "/home/u/tools",
			pending: "add",
		});
		[s] = press(s, { ch: "A" }, ...type("/usr/bin"), { name: "return" });
		expect(s.message?.text).toBe("/usr/bin is already in PATH");
		[s] = press(s, { name: "home" }, { ch: "d" });
		expect(s.ops).toEqual([]);
	});

	test("remove only what envhound added", () => {
		let [s] = press(initialState(data()), { ch: "2" }, { ch: "d" }); // /home/u/bin, envhound's
		expect(s.ops).toEqual([{ kind: "path-remove", dir: "/home/u/bin" }]);
		[s] = press(s, { ch: "G" }, { ch: "d" }); // /gone, from ~/.profile
		expect(s.message?.text).toContain("press o to open");
		expect(render(s, 100, 12, { color: false }).join("\n")).toContain(
			"missing",
		);
	});
});

describe("quit, undo, write", () => {
	test("quit asks once when changes are staged", () => {
		const [staged] = press(goTo(initialState(data()), "MINE"), { ch: "d" });
		const [asked, e1] = press(staged, { ch: "q" });
		expect(e1).toBeUndefined();
		expect(press(asked, { ch: "q" })[1]).toEqual({ kind: "quit" });
		expect(press(asked, { name: "down" })[0].confirmQuit).toBe(false);
		expect(press(staged, { ctrl: true, name: "c" })[1]).toEqual({
			kind: "quit",
		});
	});
	test("u undoes, w writes only when something is staged", () => {
		const [staged] = press(goTo(initialState(data()), "MINE"), { ch: "d" });
		expect(press(staged, { ch: "w" })[1]).toEqual({ kind: "write" });
		const [undone] = press(staged, { ch: "u" });
		expect(undone.ops).toEqual([]);
		expect(press(undone, { ch: "w" })[1]).toBeUndefined();
	});
});

describe(".env tabs", () => {
	const onEnv = () => initialState(data(), { tab: 2 });
	const goToKey = (s: State, key: string) => ({
		...s,
		cursor: {
			...s.cursor,
			[`dotenv:${ENV}`]: dotenvViews(s, ENV).findIndex((r) => r.key === key),
		},
	});

	test("tab label, conflicts, duplicates", () => {
		const screen = render(onEnv(), 120, 14, { color: false }).join("\n");
		expect(screen).toContain(" 3 .env ");
		expect(screen).toContain("shell has vim");
		expect(screen).toContain("duplicate of line 3");
	});

	test("edits are staged against the file, separately from the shell", () => {
		let [s] = press(
			goToKey(onEnv(), "EDITOR"),
			{ name: "return" },
			{ ctrl: true, name: "u" },
			...type("code"),
			{ name: "return" },
		);
		[s] = press(
			goTo({ ...s, tab: 0 }, "EDITOR"),
			{ name: "return" },
			{ ctrl: true, name: "u" },
			...type("emacs"),
			{ name: "return" },
		);
		expect(s.ops).toEqual([
			{ kind: "set", name: "EDITOR", value: "code", file: ENV },
			{ kind: "set", name: "EDITOR", value: "emacs", file: undefined },
		]);
		expect(dotenvViews(s, ENV).find((r) => r.key === "EDITOR")).toMatchObject({
			pending: "set",
			newValue: "code",
		});
	});

	test("new keys may use dots and dashes; d deletes, d again drops it", () => {
		let [s] = press(
			onEnv(),
			{ ch: "n" },
			...type("app.name"),
			{ name: "return" },
			...type("x"),
			{ name: "return" },
		);
		expect(s.ops).toEqual([
			{ kind: "set", name: "app.name", value: "x", file: ENV },
		]);
		[s] = press(goToKey(s, "PORT"), { ch: "d" });
		expect(s.ops.at(-1)).toEqual({ kind: "unset", name: "PORT", file: ENV });
		[s] = press(s, { ch: "d" });
		expect(s.ops).toHaveLength(1);
	});

	test("o opens the file at the key's line; new keys have none yet", () => {
		expect(press(goToKey(onEnv(), "DUP"), { ch: "o" })[1]).toEqual({
			kind: "open",
			at: { file: ENV, line: 4 },
		});
		const [s] = press(
			onEnv(),
			{ ch: "n" },
			...type("NEW"),
			{ name: "return" },
			{ name: "return" },
		);
		const [opened, effect] = press(goToKey(s, "NEW"), { ch: "o" });
		expect(effect).toBeUndefined();
		expect(opened.message?.text).toContain("write first");
	});

	test("tab cycles through every tab, digits jump", () => {
		const [s] = press(initialState(data()), { name: "tab" }, { name: "tab" });
		expect(s.tab).toBe(2);
		expect(press(s, { name: "tab" })[0].tab).toBe(0);
		expect(press(s, { ch: "9" })[0].tab).toBe(2); // no tab 9
	});
});

test("render fits the screen exactly", () => {
	for (const [w, h] of [
		[30, 8],
		[40, 8],
		[80, 24],
		[200, 50],
	] as const)
		for (const tab of [0, 1, 2]) {
			const lines = render(initialState(data(), { tab }), w, h, {
				color: false,
			});
			expect(lines).toHaveLength(h);
			for (const l of lines) expect([...l].length).toBeLessThanOrEqual(w);
		}
});

test("editorCommand", () => {
	const at = { file: "/f", line: 7 };
	expect(editorCommand("vim", at)).toEqual(["vim", ["+7", "/f"]]);
	expect(editorCommand("code --wait", at)).toEqual([
		"code",
		["--wait", "-g", "/f:7"],
	]);
	expect(editorCommand("/usr/bin/nano -w", at)).toEqual([
		"/usr/bin/nano",
		["-w", "+7", "/f"],
	]);
	expect(
		editorCommand('"C:\\Program Files\\VS Code\\bin\\code.cmd" --wait', at),
	).toEqual([
		"C:\\Program Files\\VS Code\\bin\\code.cmd",
		["--wait", "-g", "/f:7"],
	]);
	expect(editorCommand("notepad", at)).toEqual(["notepad", ["/f"]]);
});

test.skipIf(spawnSync("script", ["--version"]).status !== 0)(
	"envhound edit in a real terminal: stage, write, verify",
	() => {
		// `script` gives envhound a pty; keys are fed through it, `y` answers the write confirmation
		const fixture = join(import.meta.dir, "fixtures", "home");
		const home = mkdtempSync(join(tmpdir(), "envhound-edit-"));
		for (const f of [".bash_profile", ".bashrc"])
			copyFileSync(join(fixture, f), join(home, f));
		// keys arrive with pauses, as typed: the editor first, then the confirmation after it
		const keys = `sleep 2; printf 'nFROM_TUI\\rhello\\rw'; sleep 3; printf 'y\\r'; sleep 4`;
		const cmd = `bun ${join(import.meta.dir, "..", "src", "cli.ts")} --home ${home} edit`;
		const r = spawnSync(
			"bash",
			["-c", `(${keys}) | script -qec '${cmd}' /dev/null`],
			{
				encoding: "utf8",
				env: {
					...process.env,
					XDG_CONFIG_HOME: "",
					XDG_STATE_HOME: "",
					TERM: "xterm",
				},
				timeout: 20_000,
			},
		);
		expect(r.stdout).toContain("+ export FROM_TUI=hello");
		expect(r.stdout).toContain("✓ a fresh login shell now gets FROM_TUI");
		expect(
			readFileSync(join(home, ".config", "envhound", "env.sh"), "utf8"),
		).toContain("export FROM_TUI=hello");
	},
	30_000,
);

test.skipIf(spawnSync("script", ["--version"]).status !== 0)(
	"envhound edit FILE: .env and shell changes in one write",
	() => {
		const fixture = join(import.meta.dir, "fixtures", "home");
		const home = mkdtempSync(join(tmpdir(), "envhound-edit-env-"));
		for (const f of [".bash_profile", ".bashrc"])
			copyFileSync(join(fixture, f), join(home, f));
		const project = mkdtempSync(join(tmpdir(), "envhound-project-"));
		writeFileSync(join(project, ".env"), "# app\nA=1   # first\nB=2\n");
		// starts on the .env tab: edit A, then tab 1: new shell variable, then write and confirm
		const keys = [
			"sleep 2",
			"printf '\\r'",
			"sleep 0.3",
			"printf '\\025'",
			"printf '9\\r'",
			"printf '1n'",
			"printf 'MIXED\\r'",
			"printf 'v\\r'",
			"sleep 0.3",
			"printf 'w'",
			"sleep 3",
			"printf 'y\\r'",
			"sleep 4",
		].join("; ");
		const cmd = `bun ${join(import.meta.dir, "..", "src", "cli.ts")} --home ${home} edit .env`;
		const r = spawnSync(
			"bash",
			["-c", `(${keys}) | script -qec '${cmd}' /dev/null`],
			{
				cwd: project,
				encoding: "utf8",
				env: {
					...process.env,
					XDG_CONFIG_HOME: "",
					XDG_STATE_HOME: "",
					TERM: "xterm",
				},
				timeout: 25_000,
			},
		);
		expect(readFileSync(join(project, ".env"), "utf8")).toBe(
			"# app\nA=9   # first\nB=2\n",
		);
		expect(
			readFileSync(join(home, ".config", "envhound", "env.sh"), "utf8"),
		).toContain("export MIXED=v");
		expect(r.stdout).toContain("✓ a fresh login shell now gets MIXED");
	},
	30_000,
);

test("cmdArg: quoted for the program, ^-escaped for cmd.exe", () => {
	expect(cmdArg("C:\\a b\\.env")).toBe('^"C:\\a^ b\\.env^"');
	expect(cmdArg("C:\\x (86)\\%PATH%&y")).toBe('^"C:\\x^ ^(86^)\\^%PATH^%^&y^"');
	expect(cmdArg("dir\\")).toBe('^"dir\\\\^"');
});

test("windowsCommand: programs start directly, scripts through cmd.exe with every part escaped", () => {
	expect(windowsCommand("C:\\Windows\\notepad.exe", ["C:\\a b\\.env"])).toEqual(
		["C:\\Windows\\notepad.exe", ["C:\\a b\\.env"], {}],
	);
	const [file, args, opts] = windowsCommand(
		"C:\\Program Files\\VS Code\\bin\\code.cmd",
		["--wait", "-g", "C:\\p\\.env:7"],
	);
	expect(file).toMatch(/cmd\.exe$/i);
	expect(args).toEqual([
		"/d",
		"/s",
		"/c",
		'"C:\\Program^ Files\\VS^ Code\\bin\\code.cmd ^"--wait^" ^"-g^" ^"C:\\p\\.env:7^""',
	]);
	expect(opts).toEqual({ windowsVerbatimArguments: true });
});

test("the selected entry's detail wraps, so a long path is shown whole", () => {
	const long = `/opt/${"very-long-directory-name/".repeat(6)}bin`;
	const d = data();
	d.path = [
		{ dir: long, by: "~/.profile:3", managed: false, exists: true },
		...d.path,
	];
	const s: State = { ...initialState(d), tab: 1 };
	const lines = render(s, 40, 20, { color: false });
	expect(lines).toHaveLength(20);
	expect(lines.every((l) => [...l].length <= 40)).toBe(true);
	// the table cuts it, the detail lines below the rule hold all of it
	const rule = lines.lastIndexOf("─".repeat(40));
	const detail = lines
		.slice(rule + 1, -2)
		.map((l) => l.trimEnd())
		.join("");
	expect(detail).toContain(long);
	expect(wrap("abcdefgh", 3, 2)).toEqual(["abc", "de…"]);
});

test("on a wide screen a long path is shown whole in the table too", () => {
	const long = `/opt/${"very-long-directory-name/".repeat(4)}bin`; // 109 characters
	const d = data();
	d.path = [
		{ dir: long, by: "~/.profile:3", managed: false, exists: true },
		...d.path,
	];
	const s: State = { ...initialState(d), tab: 1 };
	const table = (width: number) =>
		render(s, width, 20, { color: false }).slice(0, 8).join("\n");
	expect(table(160)).toContain(long);
	// on a narrow one it is cut from the left, and the detail below has it whole
	expect(table(80)).not.toContain(long);
	expect(table(80)).toContain("…");
});

describe("mouse", () => {
	const W = 80;
	const H = 12;
	/** The screen line render draws `text` on, and the row a click there lands on. */
	const click = (s: State, text: string) => {
		const y = render(s, W, H, { color: false }).findIndex((l) =>
			l.includes(text),
		);
		expect(y).toBeGreaterThan(0);
		return hitTest(s, W, H, 4, y);
	};

	test("a click on a row is that row, as drawn", () => {
		const s = initialState(data());
		for (const name of ["API_TOKEN", "EDITOR", "TERM"])
			expect(click(s, ` ${name} `)).toEqual({
				kind: "row",
				index: at(s, name),
			});
		// column headings, rules, detail and footer are not rows
		expect(click(s, "SET BY")).toBeUndefined();
		expect(hitTest(s, W, H, 4, H - 1)).toBeUndefined();
	});

	test("rows scrolled off the top are counted", () => {
		const many: Data = {
			...data(),
			vars: Array.from({ length: 30 }, (_, i) => ({
				name: `V${String(i).padStart(2, "0")}`,
				value: "x",
				by: "envhound",
				managed: true,
			})),
		};
		const s = { ...initialState(many), cursor: { vars: 20 } };
		expect(click(s, " V20 ")).toEqual({ kind: "row", index: 20 });
		expect(click(s, " V18 ")).toEqual({ kind: "row", index: 18 });
	});

	test("a click selects in place: the list doesn't scroll under the pointer", () => {
		const many: Data = {
			...data(),
			vars: Array.from({ length: 30 }, (_, i) => ({
				name: `V${String(i).padStart(2, "0")}`,
				value: "x",
				by: "envhound",
				managed: true,
			})),
		};
		// as the driver does before each draw
		const shown = (s: State) => keepScroll(s, W, H);
		let s = shown({ ...initialState(many), cursor: { vars: 12 } });
		const body = (s: State) => render(s, W, H, { color: false }).slice(3, 7);
		const before = body(s);
		const hit = click(s, " V10 ");
		expect(hit).toEqual({ kind: "row", index: 10 });
		[s] = handleMouse(s, hit!);
		s = shown(s);
		expect(body(s)).toEqual(before);
		// the list still follows the cursor past its edge
		[s] = press(s, { name: "pageup" });
		s = shown(s);
		expect(render(s, W, H, { color: false }).join("\n")).toContain(" V00 ");
	});

	test("a click on a tab label is that tab", () => {
		const s = initialState(data());
		const top = render(s, W, H, { color: false })[0]!;
		expect(hitTest(s, W, H, top.indexOf("PATH"), 0)).toEqual({
			kind: "tab",
			tab: 1,
		});
		expect(hitTest(s, W, H, top.indexOf(".env"), 0)).toEqual({
			kind: "tab",
			tab: 2,
		});
		expect(hitTest(s, W, H, 0, 0)).toBeUndefined(); // the title
	});

	test("click selects, a second click edits, the wheel moves", () => {
		let s = initialState(data());
		[s] = handleMouse(s, { kind: "row", index: at(s, "EDITOR") });
		expect(s.cursor.vars).toBe(at(s, "EDITOR"));
		expect(s.prompt).toBeUndefined();
		expect(s.message?.text).toBe("click again to edit");
		[s] = handleMouse(s, { kind: "row", index: at(s, "EDITOR") });
		expect(s.prompt?.label).toBe("EDITOR=");
		// a prompt keeps the mouse out
		expect(handleMouse(s, { kind: "tab", tab: 1 })[0]).toBe(s);

		s = initialState(data());
		[s] = handleMouse(s, { kind: "wheel", lines: 3 });
		expect(s.cursor.vars).toBe(3);
		[s] = handleMouse(s, { kind: "wheel", lines: 3 });
		expect(s.cursor.vars).toBe(3); // the last row
		[s] = handleMouse(s, { kind: "tab", tab: 1 });
		expect(s.tab).toBe(1);
		// no editing on PATH, so no hint
		[s] = handleMouse(s, { kind: "row", index: 1 });
		expect(s.message).toBeUndefined();
		[s] = handleMouse(s, { kind: "drag" });
		expect(s.message?.text).toContain("hold shift");
	});

	test("parseMouse takes reports out of the keys", () => {
		expect(parseMouse("j\x1b[<0;5;7Mk\x1b[<0;5;7m\x1b[<65;1;1M")).toEqual({
			keys: "jk",
			events: [
				{ button: 0, x: 4, y: 6, release: false },
				{ button: 0, x: 4, y: 6, release: true },
				{ button: 65, x: 0, y: 0, release: false },
			],
			pending: "",
		});
		// X10: three bytes, each +32, whose letters must not be typed
		expect(parseMouse("\x1b[M dq\x1b[M#dq")).toEqual({
			keys: "",
			events: [
				{ button: 0, x: 67, y: 80, release: false },
				{ button: 3, x: 67, y: 80, release: true },
			],
			pending: "",
		});
		// a report cut between reads waits for the rest; a lone escape is a key
		expect(parseMouse("a\x1b[<0;1")).toEqual({
			keys: "a",
			events: [],
			pending: "\x1b[<0;1",
		});
		expect(parseMouse("\x1b").keys).toBe("\x1b");
	});
});
