// The README's demo: real envhound commands on demo/home, recorded as an asciicast with typing,
// then rendered to docs/demo.gif with agg (https://github.com/asciinema/agg).
//   bun run build && bun scripts/demo.ts [path/to/agg]
// Needs zsh, node and python3 (for a pseudo-terminal, so the output has its colors).
// Typing pauses are pseudo-random from a fixed seed: the same input gives the same recording.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COLS = 120;
const ROWS = 24;
const root = join(import.meta.dir, "..");

/** Each scene: a comment saying what we want to know, then the command. */
const SCENES: [string, string][] = [
	["where does my PATH come from?", "envhound blame PATH"],
	["which python3 runs, and why?", "envhound why python3"],
	["why isn't EDITOR what I set?", "envhound blame EDITOR"],
	[
		"change it, and see what will happen first",
		"envhound set EDITOR=code --dry-run",
	],
];

// runs argv in a pseudo-terminal of COLS x ROWS and prints what it wrote
const PTY = `
import fcntl, os, pty, struct, sys, termios
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[3], sys.argv[3:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", int(sys.argv[2]), int(sys.argv[1]), 0, 0))
out = b""
while True:
    try:
        chunk = os.read(fd, 65536)
    except OSError:
        break
    if not chunk:
        break
    out += chunk
os.waitpid(pid, 0)
sys.stdout.buffer.write(out)
`;

function which(cmd: string): string {
	const found = Bun.which(cmd);
	if (!found) throw new Error(`${cmd} is needed to record the demo`);
	return found;
}

const zsh = which("zsh");
const node = which("node");
const python = which("python3");
const agg = process.argv[2] ?? which("agg");

// a copy, so nothing envhound writes ends up in demo/home
const home = mkdtempSync(join(tmpdir(), "envhound-demo-"));
cpSync(join(root, "demo", "home"), home, { recursive: true });
try {
	const base = {
		HOME: home,
		USER: "demo",
		SHELL: zsh,
		TERM: "xterm-256color",
		LANG: "C.UTF-8",
		PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	};
	// the terminal the commands run in: what a login zsh in that home ends up with
	const login = spawnSync(zsh, ["-lic", "env"], {
		env: base,
		cwd: home,
		encoding: "utf8",
	});
	const shell: Record<string, string> = { ...base };
	for (const line of login.stdout.split("\n")) {
		const m = /^(PATH|EDITOR|GOPATH|PYENV_ROOT)=(.*)$/.exec(line);
		if (m) shell[m[1]!] = m[2]!;
	}
	shell.ENVHOUND_NO_UPDATE_CHECK = "1";

	let seed = 42;
	const random = () => {
		seed = (seed * 1103515245 + 12345) % 2 ** 31;
		return seed / 2 ** 31;
	};
	const events: [number, "o", string][] = [];
	let t = 0.5;
	const out = (s: string, after = 0) => {
		events.push([Number(t.toFixed(3)), "o", s]);
		t += after;
	};
	const type = (s: string) => {
		for (const ch of s) out(ch, 0.035 + random() * 0.06);
	};
	const PROMPT = "\x1b[1;32m$\x1b[0m ";

	for (const [i, [comment, command]] of SCENES.entries()) {
		if (i) out("\x1b[2J\x1b[H");
		out(PROMPT, 0.4);
		out("\x1b[2m");
		type(`# ${comment}`);
		out("\x1b[0m\r\n", 0.3);
		out(PROMPT, 0.3);
		type(command);
		out("\r\n", 0.3);
		const args = command.split(" ").slice(1);
		const r = spawnSync(
			python,
			[
				"-I",
				"-c",
				PTY,
				String(COLS),
				String(ROWS),
				node,
				join(root, "dist", "envhound.js"),
				...args,
			],
			{ env: shell, cwd: home, encoding: "utf8" },
		);
		if (r.status !== 0) throw new Error(r.stderr);
		for (const line of r.stdout.replace(/\r?\n$/, "").split(/\r?\n/))
			out(`${line}\r\n`, 0.04);
		out(PROMPT, 3.5);
	}

	const cast = join(root, "docs", "demo.cast");
	const header = {
		version: 2,
		width: COLS,
		height: ROWS,
		env: { TERM: "xterm-256color", SHELL: "/bin/zsh" },
	};
	writeFileSync(
		cast,
		[header, ...events].map((e) => JSON.stringify(e)).join("\n") + "\n",
	);
	const gif = join(root, "docs", "demo.gif");
	const r = spawnSync(
		agg,
		[
			"--font-family",
			"DejaVu Sans Mono",
			"--font-size",
			"14",
			"--theme",
			"monokai",
			"--last-frame-duration",
			"4",
			cast,
			gif,
		],
		{ stdio: "inherit" },
	);
	if (r.status !== 0) process.exit(r.status ?? 1);
	console.log(`wrote ${cast} and ${gif}`);
} finally {
	rmSync(home, { recursive: true, force: true });
}
