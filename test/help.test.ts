import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { COMMANDS } from "../src/completion.ts";
import { COMMAND_HELP, commandHelp, helpTopic, overview } from "../src/help.ts";

const root = join(import.meta.dir, "..");
const envhound = (...args: string[]) =>
	spawnSync(process.execPath, ["src/cli.ts", ...args], {
		cwd: root,
		encoding: "utf8",
		env: { ...process.env, ENVHOUND_NO_UPDATE_CHECK: "1" },
	});

test("every command has a page, and the overview lists it", () => {
	const text = overview();
	for (const name of Object.keys(COMMANDS)) {
		expect(commandHelp(name)).toStartWith(
			`Usage: envhound ${name === "list" ? "[list]" : name}`,
		);
		expect(text).toContain(
			`  ${COMMAND_HELP[name]!.brief ?? COMMAND_HELP[name]!.usage[0]}`,
		);
	}
	expect(text).toContain("  path add DIR...");
	expect(text).toContain("envhound COMMAND --help");
});

test("a page lists only the options its command takes", () => {
	const blame = commandHelp("blame")!;
	expect(blame).toContain("--json");
	expect(blame).not.toContain("--append");
	expect(blame).not.toContain("--stdin");
	const add = commandHelp("path add")!;
	expect(add).toContain("--append");
	expect(add).not.toContain("--json");
	expect(commandHelp("set")).toContain("--stdin");
	expect(commandHelp("upgrade")).not.toContain("--home");
});

test("every line fits in 80 columns", () => {
	for (const text of [
		overview(),
		...Object.keys(COMMAND_HELP).map((k) => commandHelp(k)!),
	])
		for (const line of text.split("\n"))
			expect(line.length).toBeLessThanOrEqual(80);
});

test("the topic: path add and path remove are their own pages", () => {
	expect(helpTopic([])).toBeUndefined();
	expect(helpTopic(["path"])).toBe("path");
	expect(helpTopic(["path", "add", "~/bin"])).toBe("path add");
	expect(helpTopic(["blame", "PATH"])).toBe("blame");
});

test("--help, COMMAND --help, help COMMAND, and usage errors pointing at the page", () => {
	const all = envhound("--help");
	expect(all.status).toBe(0);
	expect(all.stdout).toContain("See where your environment comes from:");
	const set = envhound("set", "--help");
	expect(set.stdout).toBe(commandHelp("set")!);
	expect(envhound("help", "path", "add").stdout).toBe(commandHelp("path add")!);
	expect(envhound("path", "add", "--help").stdout).toBe(
		commandHelp("path add")!,
	);
	const nope = envhound("help", "nope");
	expect(nope.status).toBe(2);
	expect(nope.stderr).toContain("no command 'nope'");
	const blame = envhound("blame");
	expect(blame.status).toBe(2);
	expect(blame.stderr).toContain("Run 'envhound blame --help' for usage.");
});
