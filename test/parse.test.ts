import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCommand, parseTrace, traceFields } from "../src/trace/bash.ts";

const rec = (
	file: string,
	line: number,
	cmd: string,
	fn = "",
	caller = "",
	callerLine: number | "" = "",
) => `\x1f${[line, fn, callerLine, file, caller].join("\x1e")}\x1e${cmd}\n`;

describe("parseCommand", () => {
	test("plain and append assignments", () => {
		expect(parseCommand("A=1")).toMatchObject([
			{ name: "A", op: "=", value: "1" },
		]);
		expect(parseCommand("PATH+=:/opt/x")).toMatchObject([
			{ name: "PATH", op: "+=", value: ":/opt/x" },
		]);
	});
	test("export lines are skipped: bash traces their assignments again", () =>
		expect(parseCommand("export A=1 'B=two words'")).toEqual([]));
	test("declare -gx is global, local is local", () => {
		expect(parseCommand("declare -gx H=h")).toMatchObject([
			{ name: "H", value: "h", local: false },
		]);
		expect(parseCommand("local L=1")).toMatchObject([
			{ name: "L", local: true },
		]);
	});
	test("arrays and functions are ignored", () => {
		expect(parseCommand("ARR=(a b)")).toEqual([]);
		expect(parseCommand("declare -a ARR=(a b)")).toEqual([]);
		expect(parseCommand("unset -f fn")).toEqual([]);
	});
	test("unset", () =>
		expect(parseCommand("unset A B")).toMatchObject([
			{ name: "A", op: "unset" },
			{ name: "B", op: "unset" },
		]));
});

describe("parseTrace", () => {
	test("simulates appends and tracks locals per function call", () => {
		const stderr =
			"bash: no job control in this shell\n" +
			rec("/h/.profile", 1, "P=a") +
			rec("/h/.profile", 2, "P+=b") +
			rec("/h/.profile", 9, "local P=x", "f", "/h/.profile", 3) +
			rec("/h/.profile", 9, "P=y", "f", "/h/.profile", 3) +
			rec("/h/.profile", 4, "M='one\ntwo'");
		const t = parseTrace(stderr, {}, {});
		const p = t.assignments.filter((a) => a.name === "P");
		expect(p.map((a) => [a.result, a.local])).toEqual([
			["a", false],
			["ab", false],
			["x", true],
			["y", true],
		]);
		expect(t.assignments.find((a) => a.name === "M")?.value).toBe("one\ntwo");
	});
});

describe("bash 3.2 cuts PS4 at 99 bytes (macOS's /bin/bash)", () => {
	// what bash 3.2 prints: the expansion's first 99 bytes, then the command
	const cut = (marks: number, fields: string[], cmd: string) => {
		const prefix = Buffer.from(
			`${"\x1f".repeat(marks)}${fields.join("\x1e")}\x1e`,
		);
		return Buffer.concat([
			prefix.subarray(0, 99),
			Buffer.from(`${cmd}\n`),
		]).toString("latin1"); // one char per byte, as parseTrace hands records to traceFields
	};
	const long = `/Users/someone/work/a-rather-long-checkout-name/${"x".repeat(20)}/.bashrc`;

	test("the caller's file is cut: the assignment still counts, credited to the function's line", () => {
		const record = cut(2, ["7", "add_path", "3", long, long], "PATH=/a:/b");
		expect(traceFields(record)).toMatchObject({
			line: "7",
			fn: "add_path",
			file: long,
			callerFile: undefined,
			cmd: "PATH=/a:/b",
		});
		const t = parseTrace(Buffer.from(record, "latin1"), { PATH: "/a" }, {});
		expect(t.assignments[0]).toMatchObject({
			name: "PATH",
			result: "/a:/b",
			at: { file: long, line: 7 },
			via: { at: { file: long, line: 7 } },
		});
	});
	test("the file itself is cut: the record is dropped rather than credited to a wrong file", () => {
		const longer = `/${"y".repeat(120)}/.bashrc`;
		expect(
			traceFields(cut(1, ["3", "", "0", longer, ""], "A=1")),
		).toBeUndefined();
	});
	test('"=" stands for the caller\'s file when it is the same file, or starts with it', () => {
		const t = parseTrace(
			rec("/h/.bashrc", 0, "P=1", "f", "=", 2) +
				rec("/h/.bashrc", 0, "Q=1", "g", "=.d/x", 5),
			{},
			{},
		);
		expect(t.assignments.map((a) => a.via?.at)).toEqual([
			{ file: "/h/.bashrc", line: 2 },
			{ file: "/h/.bashrc.d/x", line: 5 },
		]);
	});
	test("a non-ASCII path is cut by bytes, not characters", () => {
		const path = `/Users/zoë/${"é".repeat(30)}/.profile`;
		const record = cut(1, ["2", "f", "9", path, path], "A=1");
		expect(traceFields(record)).toMatchObject({ file: path, cmd: "A=1" });
	});
});

test("a real bash 3.2 trace with long paths, as macOS's /bin/bash prints it", () => {
	// test/fixtures/home traced by bash 3.2.57 under /Users/runner/work/…, where PS4 gets cut
	const t = parseTrace(
		readFileSync(join(import.meta.dir, "fixtures", "bash-3.2.trace")),
		{},
		{},
	);
	const names = t.assignments
		.filter((a) => a.at.file.endsWith("/.bashrc"))
		.map((a) => a.name);
	expect(names).toEqual([
		"PATH",
		"PATH",
		"QUOTED",
		"MULTI",
		"UNICODE",
		"SHELL",
		"LOCALVAR",
		"LOCALVAR",
		"API_TOKEN",
		"TEMP",
		"TEMP",
		"SHELLONLY",
		"GREETING",
		"GREETING",
	]);
	const viaFn = t.assignments.find((a) => a.via?.name === "add_path");
	expect(viaFn?.via?.at).toEqual({
		file: "/Users/runner/work/envhound/envhound/test/fixtures/home/.bashrc",
		line: 2,
	});
	expect(t.assignments.find((a) => a.name === "UNICODE")?.result).toBe(
		"café ☕",
	);
});
