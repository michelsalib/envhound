import { expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { why } from "../src/analyze.ts";
import { renderWhy } from "../src/format.ts";
import type { Trace } from "../src/model.ts";

const root = mkdtempSync(join(tmpdir(), "envhound-why-"));
const dir = (name: string, ...files: string[]) => {
	const d = join(root, name);
	mkdirSync(d, { recursive: true });
	for (const f of files) {
		writeFileSync(join(d, f), "#!/bin/sh\n");
		chmodSync(join(d, f), 0o755);
	}
	return d;
};
const local = dir("local", "tool");
const usr = dir("usr", "tool", "other");
const plain = dir("plain");
writeFileSync(join(plain, "tool"), "not executable"); // not run, so not found
const linked = join(root, "linked");
symlinkSync(usr, linked);

const unix = process.platform !== "win32";
const opts = { home: "/nowhere", color: false, showSecrets: false };

const trace = (fresh: string): Trace => ({
	shell: "bash",
	initial: { PATH: usr },
	final: { PATH: fresh },
	assignments: [
		{
			name: "PATH",
			op: "=",
			value: `${local}:${usr}`,
			previous: usr,
			result: `${local}:${usr}`,
			at: { file: "/h/.profile", line: 3 },
			local: false,
		},
	],
});

test.skipIf(!unix)(
	"the first match runs, later ones are hidden, with who added each",
	() => {
		const t = trace(`${local}:${usr}`);
		const r = why(t, "tool", { PATH: `${plain}:${local}:${usr}:${linked}` });
		expect(r.matches.map((m) => m.file)).toEqual([
			join(local, "tool"),
			join(usr, "tool"),
			join(linked, "tool"),
		]);
		expect(r.matches[0]?.entry).toMatchObject({ index: 2, source: "startup" });
		expect(r.matches[2]?.target).toBe(join(usr, "tool"));
		expect(r.fresh).toBeUndefined();
		const text = renderWhy(r, opts);
		expect(text).toStartWith(`tool runs ${join(local, "tool")}\n`);
		expect(text).toContain(`from PATH #2 ${local}, added at /h/.profile:3`);
		expect(text).toContain("in the PATH the shell started with");
		expect(text).toContain("(the same file as PATH #3)");
		expect(text).toContain("type tool shows them");
	},
);

test.skipIf(!unix)(
	"a fresh login shell that runs another file, or none",
	() => {
		const t = trace(usr);
		const r = why(t, "tool", { PATH: `${local}:${usr}` });
		expect(r.fresh?.file).toBe(join(usr, "tool"));
		expect(renderWhy(r, opts)).toContain(
			`! a fresh login shell runs ${join(usr, "tool")} instead`,
		);
		const gone = why(trace(local), "other", { PATH: usr });
		expect(gone.fresh).toBeNull();
		expect(renderWhy(gone, opts)).toContain(
			"! a fresh login shell doesn't find other",
		);
	},
);

test("not found", () => {
	const r = why(trace(usr), "nope", { PATH: usr });
	expect(r.matches).toEqual([]);
	expect(renderWhy(r, opts)).toStartWith("nope is not in PATH");
});

test("Windows tries each PATHEXT extension, and ignores case", () => {
	const bin = dir("win", "py.exe", "py.cmd", "node.EXE");
	const t: Trace = {
		shell: "windows",
		initial: {},
		final: { Path: bin },
		assignments: [],
	};
	const env = { Path: bin, PATHEXT: ".COM;.EXE;.CMD" };
	expect(why(t, "py", env).matches.map((m) => m.file)).toEqual([
		join(bin, "py.exe"),
		join(bin, "py.cmd"),
	]);
	expect(why(t, "py.cmd", env).matches.map((m) => m.file)).toEqual([
		join(bin, "py.cmd"),
	]);
	expect(why(t, "py", env).fresh).toBeUndefined();
});
