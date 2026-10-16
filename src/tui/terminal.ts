// Terminal driver for `envhound edit`: raw keys in, full redraws out, on the
// alternate screen so the user's scrollback is left as it was.
import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { emitKeypressEvents } from "node:readline";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { Location } from "../model.ts";
import type { EditOp } from "../set.ts";
import {
	type Data,
	handleKey,
	handleMouse,
	initialState,
	type Key,
} from "./state.ts";
import { hitTest, keepScroll, render } from "./view.ts";

// Windows' console hands Node no mouse input, so asking for it would only take text selection away
const MOUSE = process.platform !== "win32";
// alternate screen, hide cursor, report clicks and the wheel (SGR encoding, any width)
const ENTER = `\x1b[?1049h\x1b[?25l${MOUSE ? "\x1b[?1000h\x1b[?1006h" : ""}`;
const LEAVE = `${MOUSE ? "\x1b[?1006l\x1b[?1000l" : ""}\x1b[?25h\x1b[?1049l`;

export interface MouseEvent {
	/** xterm's button code: 0 left, 1 middle, 2 right, 64/65 wheel up/down, +4/8/16 shift/alt/ctrl */
	button: number;
	/** column and line, from 0 */
	x: number;
	y: number;
	release: boolean;
}

// SGR: ESC [ < b ; x ; y M (press) or m (release). X10, for terminals without SGR: ESC [ M and three bytes, each +32.
const MOUSE_SEQ =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching escape sequences is the point
	/\x1b\[<(\d+);(\d+);(\d+)([Mm])|\x1b\[M([\s\S])([\s\S])([\s\S])/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching escape sequences is the point
const PARTIAL = /\x1b\[(<[\d;]*|M[\s\S]{0,2})$/;

/**
 * Mouse reports out of terminal input, so readline doesn't read them as keys (an X10 report's bytes would be
 * typed letters). `pending` is a report cut at the end of `input`, to go before the next input.
 */
export function parseMouse(input: string): {
	keys: string;
	events: MouseEvent[];
	pending: string;
} {
	const events: MouseEvent[] = [];
	const keys = input.replace(
		MOUSE_SEQ,
		(_, b, x, y, end, xb: string, xx: string, xy: string) => {
			if (b !== undefined)
				events.push({
					button: Number(b),
					x: Number(x) - 1,
					y: Number(y) - 1,
					release: end === "m",
				});
			else {
				const button = xb.charCodeAt(0) - 32;
				events.push({
					button,
					x: xx.charCodeAt(0) - 33,
					y: xy.charCodeAt(0) - 33,
					// X10 reports every release as button 3, without saying which
					release: (button & 67) === 3,
				});
			}
			return "";
		},
	);
	const cut = PARTIAL.exec(keys);
	return cut
		? { keys: keys.slice(0, cut.index), events, pending: cut[0] }
		: { keys, events, pending: "" };
}

/** Command line opening `file` at `line` in the user's editor. */
export function editorCommand(
	editor: string,
	at: Location,
): [string, string[]] {
	// a quoted program may contain spaces: "C:\Program Files\...\code.cmd" --wait
	const quoted = /^"([^"]+)"\s*(.*)$/.exec(editor.trim());
	const [cmd = "vi", ...args] = quoted
		? [quoted[1]!, ...quoted[2]!.split(/\s+/).filter(Boolean)]
		: editor.trim().split(/\s+/);
	const base = (cmd.split(/[\\/]/).pop() ?? cmd)
		.replace(/\.(exe|cmd|bat)$/i, "")
		.toLowerCase();
	// VS Code and its forks take file:line; vi, vim, nvim, nano, emacs, micro take +line
	if (/^(code|code-insiders|codium|cursor|windsurf)$/.test(base)) {
		return [
			cmd,
			[
				...args.filter((a) => a !== "--wait"),
				"--wait",
				"-g",
				`${at.file}:${at.line}`,
			],
		];
	}
	// Notepad can't go to a line
	if (base === "notepad") return [cmd, [...args, at.file]];
	return [cmd, [...args, `+${at.line}`, at.file]];
}

// cmd.exe's metacharacters, escaped with ^ as cross-spawn does (https://qntm.org/cmd)
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** One argument as cmd.exe passes it on intact: quoted the way Windows programs split arguments, then ^-escaped. */
export function cmdArg(arg: string): string {
	const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
	return quoted.replace(CMD_META, "^$1");
}

/**
 * How to start an editor on Windows. A program (.exe) starts directly, so Node quotes its arguments; a .cmd or
 * .bat script (code, cursor…) only runs through cmd.exe, so the whole line is escaped for it, never left to
 * `shell: true`, which would let cmd interpret a quote, & or %VAR% in a path.
 */
export function windowsCommand(
	resolved: string,
	args: string[],
): [string, string[], SpawnSyncOptions] {
	if (!/\.(cmd|bat)$/i.test(resolved)) return [resolved, args, {}];
	const line = [resolved.replace(CMD_META, "^$1"), ...args.map(cmdArg)].join(
		" ",
	);
	return [
		process.env.ComSpec || "cmd.exe",
		["/d", "/s", "/c", `"${line}"`],
		{ windowsVerbatimArguments: true },
	];
}

/** The file Windows would run for `cmd`: `code` is code.cmd somewhere in Path. */
function resolveWindows(cmd: string): string {
	if (/\.[^\\/.]+$/.test(cmd)) return cmd;
	const exts = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
		.split(";")
		.filter(Boolean);
	if (/[\\/]/.test(cmd))
		return exts.map((e) => cmd + e).find((f) => existsSync(f)) ?? cmd;
	const r = spawnSync("where", [cmd], { encoding: "utf8", windowsHide: true });
	return (r.status === 0 && r.stdout.split(/\r?\n/)[0]?.trim()) || cmd;
}

/** Without $VISUAL or $EDITOR: vi, or on Windows VS Code when it is installed, else Notepad. */
function defaultEditor(): string {
	if (process.platform !== "win32") return "vi";
	return spawnSync("where", ["code"], { stdio: "ignore", windowsHide: true })
		.status === 0
		? "code"
		: "notepad";
}

/**
 * Run the editor until the user writes or quits. Returns the staged ops to
 * write, or undefined. `load` is called again after the user edits a file.
 */
export function runEditor(
	load: () => Data,
	opts: { color: boolean; showSecrets: boolean; tab?: number },
): Promise<EditOp[] | undefined> {
	const stdin = process.stdin;
	const stdout = process.stdout;
	let state = initialState(load(), {
		showSecrets: opts.showSecrets,
		tab: opts.tab,
	});

	return new Promise((resolve, reject) => {
		let hide: ReturnType<typeof setTimeout> | undefined;
		// the screen as last drawn, to find what a click is on
		let width = 80;
		let height = 24;
		const draw = () => {
			// leave the last column empty: after a full-width line, some terminals
			// (Windows Terminal) let the \x1b[K below erase the character in it
			width = Math.max(1, (stdout.columns || 80) - 1);
			height = stdout.rows || 24;
			state = keepScroll(
				{ ...state, pageSize: Math.max(1, height - 8) },
				width,
				height,
			);
			const lines = render(state, width, height, { color: opts.color });
			stdout.write(
				"\x1b[H" + lines.map((l) => l + "\x1b[K").join("\r\n") + "\x1b[J",
			);
			// a just-typed secret character shows for a second, then is masked
			clearTimeout(hide);
			if (state.prompt?.reveal)
				hide = setTimeout(() => {
					if (state.prompt)
						state = { ...state, prompt: { ...state.prompt, reveal: false } };
					draw();
				}, 1000);
		};
		const start = () => {
			stdout.write(ENTER);
			stdin.setRawMode(true);
			stdin.resume();
			draw();
		};
		const stop = () => {
			clearTimeout(hide);
			stdin.setRawMode(false);
			stdin.pause();
			stdout.write(LEAVE);
		};
		const finish = (result: EditOp[] | undefined) => {
			stdin.off("data", onData);
			stdout.off("resize", draw);
			stop();
			resolve(result);
		};

		const openEditor = (at: Location) => {
			stop();
			const windows = process.platform === "win32";
			const [cmd, args] = editorCommand(
				process.env.VISUAL || process.env.EDITOR || defaultEditor(),
				at,
			);
			const [file, argv, extra] = windows
				? windowsCommand(resolveWindows(cmd), args)
				: [cmd, args, {}];
			const r = spawnSync(file, argv, { ...extra, stdio: "inherit" });
			start();
			if (r.error) {
				state = {
					...state,
					message: {
						text: `could not run ${cmd}: ${r.error.message}`,
						error: true,
					},
				};
			} else {
				stdout.write("\x1b[H\x1b[Jreloading…");
				state = {
					...state,
					data: load(),
					message: { text: "reloaded after editing" },
				};
			}
			draw();
		};

		const apply = (step: () => ReturnType<typeof handleKey>) => {
			try {
				const [next, effect] = step();
				state = next;
				if (effect?.kind === "quit") return finish(undefined);
				if (effect?.kind === "write") return finish(state.ops);
				if (effect?.kind === "open") return openEditor(effect.at);
				draw();
			} catch (e) {
				stdin.off("data", onData);
				stop();
				reject(e);
			}
		};

		const onKey = (
			str: string | undefined,
			key: { name?: string; ctrl?: boolean; meta?: boolean } | undefined,
		) => {
			const printable =
				str &&
				!key?.ctrl &&
				!key?.meta &&
				[...str].length === 1 &&
				str >= " " &&
				str !== "\x7f"
					? str
					: undefined;
			const k: Key = { name: key?.name, ch: printable, ctrl: key?.ctrl };
			apply(() => handleKey(state, k));
		};

		// a click is a left press and its release on the same cell; released elsewhere, it was a drag
		let press: { x: number; y: number } | undefined;
		const onMouse = (m: MouseEvent) => {
			if (m.button & 64 && !m.release) {
				const lines = m.button & 1 ? 3 : -3;
				return apply(() => handleMouse(state, { kind: "wheel", lines }));
			}
			if (!m.release) {
				// other buttons, and moves with a button down, do nothing
				press = (m.button & 35) === 0 ? { x: m.x, y: m.y } : undefined;
				return;
			}
			const from = press;
			press = undefined;
			if (!from) return;
			if (from.x !== m.x || from.y !== m.y)
				return apply(() => handleMouse(state, { kind: "drag" }));
			const hit = hitTest(state, width, height, m.x, m.y);
			if (hit) apply(() => handleMouse(state, hit));
		};

		// keys go on to readline once mouse reports are taken out
		const keys = new PassThrough();
		const decoder = new StringDecoder("utf8");
		let pending = "";
		const onData = (chunk: Buffer) => {
			const input = parseMouse(pending + decoder.write(chunk));
			pending = input.pending;
			if (input.keys) keys.write(input.keys);
			for (const m of input.events) onMouse(m);
		};

		emitKeypressEvents(keys);
		keys.on("keypress", onKey);
		stdin.on("data", onData);
		stdout.on("resize", draw);
		start();
	});
}
