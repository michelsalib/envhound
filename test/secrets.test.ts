// Secret values must not reach any output unless --show-secrets: by name (*_TOKEN, *_PAT…),
// or as the password in a URL whatever the variable is called.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { holdsSecret, isSecret, masked } from "../src/format.ts";

test("secret-looking names", () => {
	for (const name of [
		"API_TOKEN",
		"GH_PAT",
		"NPM_CONFIG__AUTH",
		"BASIC_AUTH",
		"DB_PASS",
		"GPG_PASSPHRASE",
		"SENTRY_DSN",
		"AWS_SECRET_ACCESS_KEY",
		"SESSION_COOKIE",
	])
		expect(isSecret(name)).toBe(true);
	for (const name of [
		"GIT_AUTHOR_NAME",
		"PATH",
		"EDITOR",
		"PASSAGE",
		"XDG_SESSION_TYPE",
		"OAUTHOR",
	])
		expect(isSecret(name)).toBe(false);
});

test("URL passwords are masked whatever the name", () => {
	expect(masked("DATABASE_URL", "postgres://app:hunter2@db:5432/x")).toBe(
		"postgres://app:********@db:5432/x",
	);
	expect(masked("PROXY", "http://:hunter2@proxy")).toBe(
		"http://:********@proxy",
	);
	expect(masked("HOMEPAGE", "https://example.com:8080/a")).toBe(
		"https://example.com:8080/a",
	);
	expect(holdsSecret("DATABASE_URL", "postgres://app:hunter2@db/x")).toBe(true);
	expect(holdsSecret("EDITOR", "vim")).toBe(false);
});

describe.skipIf(process.platform === "win32")(
	"no output shows a secret",
	() => {
		const root = join(import.meta.dir, "..");
		const home = mkdtempSync(join(tmpdir(), "envhound-secrets-"));
		writeFileSync(
			join(home, ".bash_profile"),
			"export DATABASE_URL='postgres://app:hunter2@db/x'\nexport GH_PAT=hunter2\nexport EDITOR=vim\n",
		);
		const dotenv = join(home, ".env");
		writeFileSync(
			dotenv,
			"DATABASE_URL=postgres://app:hunter2@db/x\nGH_PAT=hunter2\n",
		);
		const env = {
			...process.env,
			XDG_CONFIG_HOME: "/nonexistent",
			XDG_STATE_HOME: "/nonexistent",
			ENVHOUND_NO_UPDATE_CHECK: "1",
		};
		const run = (...args: string[]) => {
			const r = spawnSync("bun", ["src/cli.ts", "--home", home, ...args], {
				cwd: root,
				encoding: "utf8",
				env,
				stdio: ["ignore", "pipe", "pipe"],
			});
			return r.stdout + r.stderr;
		};
		const commands = [
			["list"],
			["list", "--json"],
			["blame", "DATABASE_URL"],
			["blame", "GH_PAT", "--json"],
			["dotenv", dotenv],
			["dotenv", dotenv, "--json"],
			[
				"set",
				"DATABASE_URL=postgres://app:hunter2@db/y",
				"GH_PAT=hunter2b",
				"--dry-run",
			],
			[
				"set",
				"--file",
				dotenv,
				"DATABASE_URL=postgres://app:hunter2@db/z",
				"--dry-run",
			],
			[
				"set",
				"DATABASE_URL=postgres://app:hunter2@db/y",
				"GH_PAT=hunter2b",
				"--yes",
			],
		];
		test.each(commands)("envhound %s", (...args) =>
			expect(run(...args)).not.toContain("hunter2"),
		);
		test("--show-secrets shows them", () =>
			expect(run("blame", "GH_PAT", "--show-secrets")).toContain("hunter2"));
	},
);
