// The weekly update check, install.sh and `envhound upgrade`. Installs use a local
// file:// "release" built from the source, so nothing touches the network.
import { beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import pkg from "../package.json" with { type: "json" };
import {
	decide,
	download,
	installKind,
	latestRelease,
	newer,
	readState,
	replaceScript,
	sumFor,
	tarFile,
	updateNotice,
	upgradeCommand,
	WEEK,
} from "../src/update.ts";

const sha = (
	algorithm: string,
	b: Buffer | string,
	encoding: "hex" | "base64" = "hex",
) => createHash(algorithm).update(b).digest(encoding);

/** A gzipped ustar archive, as npm pack writes one. */
function tgz(files: Record<string, Buffer | string>): Buffer {
	const blocks: Buffer[] = [];
	for (const [name, body] of Object.entries(files)) {
		const data = Buffer.from(body);
		const h = Buffer.alloc(512);
		h.write(name, 0);
		h.write("0000644\0", 100);
		h.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
		h.write("        ", 148);
		h.write("0", 156);
		h.write("ustar\0" + "00", 257);
		let sum = 0;
		for (const b of h) sum += b;
		h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
		blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
	}
	blocks.push(Buffer.alloc(1024));
	return gzipSync(Buffer.concat(blocks));
}

/**
 * A local release of `script` as `version`: the GitHub files, the npm package and the registry's
 * answer, all file: URLs. `npm` replaces the script inside the npm package, `sums` SHA256SUMS.
 */
function fakeRelease(
	script: Buffer | string,
	opts: { version?: string; npm?: string; sums?: string } = {},
): Record<string, string> {
	const dir = mkdtempSync(join(tmpdir(), "envhound-release-"));
	writeFileSync(join(dir, "envhound.js"), script);
	writeFileSync(
		join(dir, "SHA256SUMS"),
		opts.sums ?? `${sha("sha256", script)}  envhound.js\n`,
	);
	const pkgTgz = tgz({
		"package/package.json": "{}",
		"package/dist/envhound.js": opts.npm ?? script,
	});
	writeFileSync(join(dir, "envhound.tgz"), pkgTgz);
	mkdirSync(join(dir, "registry"));
	writeFileSync(
		join(dir, "registry", "latest"),
		JSON.stringify({
			version: opts.version ?? "9.9.9",
			dist: {
				tarball: pathToFileURL(join(dir, "envhound.tgz")).href,
				integrity: `sha512-${sha("sha512", pkgTgz, "base64")}`,
			},
		}),
	);
	return {
		ENVHOUND_BASE_URL: pathToFileURL(dir).href,
		ENVHOUND_REGISTRY: pathToFileURL(join(dir, "registry")).href,
	};
}

describe("verified upgrades", () => {
	const script = "#!/usr/bin/env node\nconsole.log('new')\n";

	test("a release that matches SHA256SUMS and npm", async () => {
		const r = await latestRelease(fakeRelease(script));
		expect(r.version).toBe("9.9.9");
		expect(r.script.toString()).toBe(script);
	});
	test("refuses a checksum mismatch", () =>
		expect(
			latestRelease(
				fakeRelease(script, { sums: `${"0".repeat(64)}  envhound.js\n` }),
			),
		).rejects.toThrow("checksum mismatch"));
	test("refuses a GitHub file that npm didn't publish", () =>
		expect(
			latestRelease(fakeRelease(script, { npm: "console.log('other')\n" })),
		).rejects.toThrow("not the one published on npm"));
	test("refuses plain http", () =>
		expect(
			latestRelease({ ENVHOUND_REGISTRY: "http://registry.example" }),
		).rejects.toThrow("only https is allowed"));
	test("download refuses other schemes", () =>
		expect(download("ftp://x/y")).rejects.toThrow("only https"));
	test("SHA256SUMS lines, with or without the binary-mode star", () => {
		expect(sumFor("AB  envhound.js\ncd  install.sh\n", "envhound.js")).toBe(
			"ab",
		);
		expect(sumFor("ab *envhound.js\r\n", "envhound.js")).toBe("ab");
		expect(sumFor("ab  other.js\n", "envhound.js")).toBeUndefined();
	});

	test("tarFile reads what npm pack writes", () => {
		const dir = mkdtempSync(join(tmpdir(), "envhound-pack-"));
		mkdirSync(join(dir, "dist"));
		writeFileSync(join(dir, "dist", "envhound.js"), script);
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ name: "pack-test", version: "1.0.0", files: ["dist"] }),
		);
		const r = spawnSync("npm", ["pack", "--silent"], {
			cwd: dir,
			encoding: "utf8",
			shell: process.platform === "win32",
		});
		expect(r.status).toBe(0);
		const packed = readFileSync(join(dir, r.stdout.trim()));
		expect(tarFile(packed, "package/dist/envhound.js")?.toString()).toBe(
			script,
		);
		expect(tarFile(packed, "package/nope")).toBeUndefined();
	});

	test.skipIf(process.platform === "win32")(
		"replaceScript keeps the file's mode and install.sh's choice of Bun",
		() => {
			const target = join(
				mkdtempSync(join(tmpdir(), "envhound-bin-")),
				"envhound",
			);
			writeFileSync(target, "#!/usr/bin/env bun\nold\n");
			chmodSync(target, 0o755);
			replaceScript(target, Buffer.from(script));
			expect(readFileSync(target, "utf8")).toBe(
				"#!/usr/bin/env bun\nconsole.log('new')\n",
			);
			expect(statSync(target).mode & 0o777).toBe(0o755);
		},
	);
});

describe("installKind", () => {
	const cases: [string, string][] = [
		["/home/u/.npm/_npx/0d1f/node_modules/envhound/dist/envhound.js", "npx"],
		[
			"/tmp/bunx-1000-envhound@latest/node_modules/envhound/dist/envhound.js",
			"bunx",
		],
		[
			"/home/u/.bun/install/global/node_modules/envhound/dist/envhound.js",
			"bun",
		],
		["/usr/lib/node_modules/envhound/dist/envhound.js", "npm"],
		[
			"/home/u/.nvm/versions/node/v24/lib/node_modules/envhound/dist/envhound.js",
			"npm",
		],
		["/home/u/.local/bin/envhound", "standalone"],
		[
			"C:\\Users\\u\\AppData\\Local\\Programs\\envhound\\envhound.mjs",
			"standalone",
		],
		[
			"C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\envhound\\dist\\envhound.js",
			"npm",
		],
		[
			"C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\1a2b\\node_modules\\envhound\\dist\\envhound.js",
			"npx",
		],
		["/home/u/projects/envhound/src/cli.ts", "dev"],
		["/home/u/projects/envhound/dist/envhound.js", "dev"],
	];
	for (const [path, kind] of cases)
		test(kind + ": " + path, () =>
			expect(installKind(path)).toBe(kind as never),
		);
	test("commands", () => {
		expect(upgradeCommand("npx")).toBe("npx envhound@latest");
		expect(upgradeCommand("standalone")).toBe("envhound upgrade");
	});
});

test("newer", () => {
	expect(newer("0.2.0", "0.1.9")).toBe(true);
	expect(newer("1.0.0", "0.99.99")).toBe(true);
	expect(newer("0.10.0", "0.9.0")).toBe(true);
	expect(newer("0.1.0", "0.1.0")).toBe(false);
	expect(newer("0.1.0", "0.2.0")).toBe(false);
	expect(newer("v0.2.0", "0.1.0")).toBe(true);
	expect(newer("garbage", "0.1.0")).toBe(false);
});

describe("decide", () => {
	const now = 100 * WEEK;
	test("first run checks, nothing to say", () =>
		expect(decide({}, "0.1.0", now)).toEqual({ check: true, notify: false }));
	test("checked recently: no check", () =>
		expect(decide({ checkedAt: now - 1000 }, "0.1.0", now).check).toBe(false));
	test("checked a week ago: check", () =>
		expect(decide({ checkedAt: now - WEEK }, "0.1.0", now).check).toBe(true));
	test("clock went back: check", () =>
		expect(decide({ checkedAt: now + 1000 }, "0.1.0", now).check).toBe(true));
	test("newer known: notify", () =>
		expect(
			decide({ checkedAt: now, latest: "0.2.0" }, "0.1.0", now).notify,
		).toBe(true));
	test("same version: quiet", () =>
		expect(
			decide({ checkedAt: now, latest: "0.1.0" }, "0.1.0", now).notify,
		).toBe(false));
	test("notified this week: quiet", () =>
		expect(
			decide(
				{ checkedAt: now, latest: "0.2.0", notifiedAt: now - 1000 },
				"0.1.0",
				now,
			).notify,
		).toBe(false));
	test("notified last week: again", () =>
		expect(
			decide(
				{ checkedAt: now, latest: "0.2.0", notifiedAt: now - WEEK },
				"0.1.0",
				now,
			).notify,
		).toBe(true));
});

describe("updateNotice", () => {
	const dir = mkdtempSync(join(tmpdir(), "envhound-update-"));
	const script = join(dir, "envhound");
	writeFileSync(script, "");
	const state = join(dir, "state", "update.json");
	const now = 100 * WEEK;

	test("shows once a week, with the command for the install", () => {
		// checked just now, so no background check starts
		mkdirSync(dirname(state), { recursive: true });
		writeFileSync(state, JSON.stringify({ checkedAt: now, latest: "9.0.0" }));
		expect(updateNotice("0.1.0", script, state, now)).toBe(
			"envhound 9.0.0 is available (you have 0.1.0). Update with: envhound upgrade",
		);
		expect(readState(state).notifiedAt).toBe(now);
		expect(updateNotice("0.1.0", script, state, now + 1000)).toBeUndefined();
		expect(
			updateNotice("0.1.0", script, state, now + WEEK - 1),
		).toBeUndefined();
	});

	test("a checkout never checks", () => {
		const src = join(dir, "cli.ts");
		writeFileSync(src, "");
		const fresh = join(dir, "other.json");
		expect(updateNotice("0.1.0", src, fresh, now)).toBeUndefined();
		expect(existsSync(fresh)).toBe(false);
	});

	test("a broken state file is ignored", () => {
		writeFileSync(state, "{not json");
		expect(readState(state)).toEqual({});
	});
});

// install.sh is POSIX sh only
describe.skipIf(process.platform === "win32")(
	"install.sh and envhound upgrade",
	() => {
		const root = join(import.meta.dir, "..");
		const release = mkdtempSync(join(tmpdir(), "envhound-release-"));
		const base = `file://${release}`;
		// completion files land in this home, never the real one
		const homeEnv = (home: string) => ({
			HOME: home,
			XDG_DATA_HOME: "",
			XDG_CONFIG_HOME: "",
		});
		const hasFish = spawnSync("sh", ["-c", "command -v fish"]).status === 0;
		const run = (
			cmd: string,
			args: string[],
			env: Record<string, string> = {},
		) =>
			spawnSync(cmd, args, {
				encoding: "utf8",
				env: { ...process.env, ENVHOUND_NO_UPDATE_CHECK: "1", ...env },
			});

		beforeAll(() => {
			const r = spawnSync(
				"bun",
				[
					"build",
					"src/cli.ts",
					"--target=node",
					"--minify",
					"--outfile",
					join(release, "envhound.js"),
				],
				{
					cwd: root,
					encoding: "utf8",
				},
			);
			expect(r.status).toBe(0);
			const sum = createHash("sha256")
				.update(readFileSync(join(release, "envhound.js")))
				.digest("hex");
			writeFileSync(join(release, "SHA256SUMS"), `${sum}  envhound.js\n`);
			copyFileSync(join(root, "install.sh"), join(release, "install.sh"));
		});

		test("installs with completion, then upgrades in place", () => {
			const home = mkdtempSync(join(tmpdir(), "envhound-bin-"));
			const dir = join(home, "bin");
			const r = run("sh", [join(root, "install.sh")], {
				ENVHOUND_BASE_URL: base,
				ENVHOUND_INSTALL_DIR: dir,
				...homeEnv(home),
			});
			expect(r.stderr).toBe("");
			expect(r.stdout).toContain(
				`installed envhound ${pkg.version} in ${dir} (runs on node)`,
			);
			expect(r.stdout).toContain(`${dir}/envhound path add ${dir}`);
			expect(
				readFileSync(join(dir, "envhound"), "utf8").startsWith(
					"#!/usr/bin/env node\n",
				),
			).toBe(true);
			expect(run(join(dir, "envhound"), ["--version"]).stdout.trim()).toBe(
				pkg.version,
			);
			const completion = join(
				home,
				".local",
				"share",
				"bash-completion",
				"completions",
				"envhound",
			);
			expect(readFileSync(completion, "utf8")).toContain("envhound __complete");
			expect(r.stdout).toContain("bash completion:");
			expect(
				existsSync(
					join(home, ".config", "fish", "completions", "envhound.fish"),
				),
			).toBe(hasFish);

			// upgrade replaces the file in place, checked against SHA256SUMS and npm
			const built = readFileSync(join(release, "envhound.js"));
			writeFileSync(
				join(dir, "envhound"),
				readFileSync(join(dir, "envhound"), "utf8").replace(/\n/, "\n// old\n"),
			);
			const same = run(join(dir, "envhound"), ["upgrade"], {
				...fakeRelease(built, { version: pkg.version }),
				...homeEnv(home),
			});
			expect(same.stdout).toContain(
				`envhound ${pkg.version} is the latest version`,
			);
			const u = run(join(dir, "envhound"), ["upgrade"], {
				...fakeRelease(built),
				...homeEnv(home),
			});
			expect(u.status).toBe(0);
			expect(u.stdout).toContain(
				`upgraded envhound ${pkg.version} to 9.9.9 in ${dir}`,
			);
			expect(readFileSync(join(dir, "envhound"), "utf8")).not.toContain(
				"// old",
			);
			const bad = run(join(dir, "envhound"), ["upgrade"], {
				...fakeRelease(built, { npm: "console.log('evil')\n" }),
				...homeEnv(home),
			});
			expect(bad.status).toBe(1);
			expect(bad.stderr).toContain("nothing was changed");
		});

		test("refuses a download that doesn't match SHA256SUMS", () => {
			const bad = mkdtempSync(join(tmpdir(), "envhound-bad-"));
			writeFileSync(
				join(bad, "envhound.js"),
				"#!/usr/bin/env node\nconsole.log('evil')\n",
			);
			copyFileSync(join(release, "SHA256SUMS"), join(bad, "SHA256SUMS"));
			const dir = join(bad, "bin");
			const r = run("sh", [join(root, "install.sh")], {
				ENVHOUND_BASE_URL: `file://${bad}`,
				ENVHOUND_INSTALL_DIR: dir,
				...homeEnv(bad),
			});
			expect(r.status).toBe(1);
			expect(r.stderr).toContain("checksum mismatch");
			expect(existsSync(join(dir, "envhound"))).toBe(false);
		});

		// only Bun on PATH: the installed file must run on bun
		// stdout is null without sh: this body still runs on Windows, where the tests are skipped
		const bun =
			spawnSync("sh", ["-c", "command -v bun"], {
				encoding: "utf8",
			}).stdout?.trim() ?? "";
		const noNode = (path: string) =>
			spawnSync("sh", ["-c", "command -v node"], { env: { PATH: path } })
				.status !== 0;
		const bunPath = `${dirname(bun)}:/usr/bin:/bin`;
		test.skipIf(!bun || !noNode(bunPath))(
			"falls back to bun without node",
			() => {
				const dir = join(mkdtempSync(join(tmpdir(), "envhound-bun-")), "bin");
				const r = run("sh", [join(root, "install.sh")], {
					PATH: bunPath,
					ENVHOUND_BASE_URL: base,
					ENVHOUND_INSTALL_DIR: dir,
					...homeEnv(dirname(dir)),
				});
				expect(r.stdout).toContain("(runs on bun)");
				expect(
					readFileSync(join(dir, "envhound"), "utf8").startsWith(
						"#!/usr/bin/env bun\n",
					),
				).toBe(true);
			},
		);

		test("other installs are told their own command", () => {
			const r = run("bun", [join(root, "src", "cli.ts"), "upgrade"]);
			expect(r.stdout).toContain("git pull && bun run build");
		});
	},
);

describe.skipIf(process.platform !== "win32")(
	"install.ps1 and envhound upgrade on Windows",
	() => {
		const root = join(import.meta.dir, "..");
		const release = mkdtempSync(join(tmpdir(), "envhound-release-"));
		const base = pathToFileURL(release).href;
		const run = (
			cmd: string,
			args: string[],
			env: Record<string, string> = {},
		) =>
			spawnSync(cmd, args, {
				encoding: "utf8",
				shell: cmd.endsWith(".cmd"),
				env: { ...process.env, ENVHOUND_NO_UPDATE_CHECK: "1", ...env },
			});
		const install = (env: Record<string, string>) =>
			run(
				"powershell.exe",
				[
					"-NoProfile",
					"-NonInteractive",
					"-ExecutionPolicy",
					"Bypass",
					"-File",
					join(root, "install.ps1"),
				],
				env,
			);

		beforeAll(() => {
			const r = spawnSync(
				"bun",
				[
					"build",
					"src/cli.ts",
					"--target=node",
					"--minify",
					"--outfile",
					join(release, "envhound.js"),
				],
				{ cwd: root, encoding: "utf8" },
			);
			expect(r.status).toBe(0);
			const sum = createHash("sha256")
				.update(readFileSync(join(release, "envhound.js")))
				.digest("hex");
			writeFileSync(join(release, "SHA256SUMS"), `${sum}  envhound.js\n`);
			copyFileSync(join(root, "install.ps1"), join(release, "install.ps1"));
		});

		test("installs, then upgrades in place", () => {
			const dir = join(mkdtempSync(join(tmpdir(), "envhound-bin-")), "bin");
			const r = install({ ENVHOUND_BASE_URL: base, ENVHOUND_INSTALL_DIR: dir });
			expect(r.stderr).toBe("");
			expect(r.stdout).toContain(
				`installed envhound ${pkg.version} in ${dir} (runs on node)`,
			);
			expect(r.stdout).toContain(`path add "${dir}"`);
			const cmd = join(dir, "envhound.cmd");
			expect(run(cmd, ["--version"]).stdout.trim()).toBe(pkg.version);

			// upgrade replaces envhound.mjs in place, checked against SHA256SUMS and npm
			const mjs = join(dir, "envhound.mjs");
			writeFileSync(mjs, readFileSync(mjs, "utf8").replace(/\n/, "\n// old\n"));
			const u = run(
				cmd,
				["upgrade"],
				fakeRelease(readFileSync(join(release, "envhound.js"))),
			);
			expect(u.status).toBe(0);
			expect(u.stdout).toContain(
				`upgraded envhound ${pkg.version} to 9.9.9 in ${dir}`,
			);
			expect(readFileSync(mjs, "utf8")).not.toContain("// old");
		});

		test("refuses a download that doesn't match SHA256SUMS", () => {
			const bad = mkdtempSync(join(tmpdir(), "envhound-bad-"));
			writeFileSync(join(bad, "envhound.js"), "console.log('evil')\n");
			copyFileSync(join(release, "SHA256SUMS"), join(bad, "SHA256SUMS"));
			const dir = join(bad, "bin");
			const r = install({
				ENVHOUND_BASE_URL: pathToFileURL(bad).href,
				ENVHOUND_INSTALL_DIR: dir,
			});
			expect(r.status).toBe(1);
			expect(r.stderr).toContain("checksum mismatch");
			expect(existsSync(join(dir, "envhound.mjs"))).toBe(false);
		});
	},
);
