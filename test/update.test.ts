// The weekly update check, install.sh and `envhound upgrade`. Installs use a local
// file:// "release" built from the source, so nothing touches the network.
import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import pkg from "../package.json" with { type: "json" };
import { decide, installKind, newer, readState, updateNotice, upgradeCommand, WEEK } from "../src/update.ts";

describe("installKind", () => {
  const cases: [string, string][] = [
    ["/home/u/.npm/_npx/0d1f/node_modules/envhound/dist/envhound.js", "npx"],
    ["/tmp/bunx-1000-envhound@latest/node_modules/envhound/dist/envhound.js", "bunx"],
    ["/home/u/.bun/install/global/node_modules/envhound/dist/envhound.js", "bun"],
    ["/usr/lib/node_modules/envhound/dist/envhound.js", "npm"],
    ["/home/u/.nvm/versions/node/v24/lib/node_modules/envhound/dist/envhound.js", "npm"],
    ["/home/u/.local/bin/envhound", "standalone"],
    ["C:\\Users\\u\\AppData\\Local\\Programs\\envhound\\envhound.mjs", "standalone"],
    ["C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\envhound\\dist\\envhound.js", "npm"],
    ["C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\1a2b\\node_modules\\envhound\\dist\\envhound.js", "npx"],
    ["/home/u/projects/envhound/src/cli.ts", "dev"],
    ["/home/u/projects/envhound/dist/envhound.js", "dev"],
  ];
  for (const [path, kind] of cases) test(kind + ": " + path, () => expect(installKind(path)).toBe(kind as never));
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
  test("first run checks, nothing to say", () => expect(decide({}, "0.1.0", now)).toEqual({ check: true, notify: false }));
  test("checked recently: no check", () => expect(decide({ checkedAt: now - 1000 }, "0.1.0", now).check).toBe(false));
  test("checked a week ago: check", () => expect(decide({ checkedAt: now - WEEK }, "0.1.0", now).check).toBe(true));
  test("clock went back: check", () => expect(decide({ checkedAt: now + 1000 }, "0.1.0", now).check).toBe(true));
  test("newer known: notify", () => expect(decide({ checkedAt: now, latest: "0.2.0" }, "0.1.0", now).notify).toBe(true));
  test("same version: quiet", () => expect(decide({ checkedAt: now, latest: "0.1.0" }, "0.1.0", now).notify).toBe(false));
  test("notified this week: quiet", () =>
    expect(decide({ checkedAt: now, latest: "0.2.0", notifiedAt: now - 1000 }, "0.1.0", now).notify).toBe(false));
  test("notified last week: again", () =>
    expect(decide({ checkedAt: now, latest: "0.2.0", notifiedAt: now - WEEK }, "0.1.0", now).notify).toBe(true));
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
    expect(updateNotice("0.1.0", script, state, now)).toBe("envhound 9.0.0 is available (you have 0.1.0). Update with: envhound upgrade");
    expect(readState(state).notifiedAt).toBe(now);
    expect(updateNotice("0.1.0", script, state, now + 1000)).toBeUndefined();
    expect(updateNotice("0.1.0", script, state, now + WEEK - 1)).toBeUndefined();
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
describe.skipIf(process.platform === "win32")("install.sh and envhound upgrade", () => {
  const root = join(import.meta.dir, "..");
  const release = mkdtempSync(join(tmpdir(), "envhound-release-"));
  const base = `file://${release}`;
  // completion files land in this home, never the real one
  const homeEnv = (home: string) => ({ HOME: home, XDG_DATA_HOME: "", XDG_CONFIG_HOME: "" });
  const hasFish = spawnSync("sh", ["-c", "command -v fish"]).status === 0;
  const run = (cmd: string, args: string[], env: Record<string, string> = {}) =>
    spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, ENVHOUND_NO_UPDATE_CHECK: "1", ...env } });

  beforeAll(() => {
    const r = spawnSync("bun", ["build", "src/cli.ts", "--target=node", "--minify", "--outfile", join(release, "envhound.js")], {
      cwd: root,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    const sum = createHash("sha256").update(readFileSync(join(release, "envhound.js"))).digest("hex");
    writeFileSync(join(release, "SHA256SUMS"), `${sum}  envhound.js\n`);
    copyFileSync(join(root, "install.sh"), join(release, "install.sh"));
  });

  test("installs with completion, then upgrades in place", () => {
    const home = mkdtempSync(join(tmpdir(), "envhound-bin-"));
    const dir = join(home, "bin");
    const r = run("sh", [join(root, "install.sh")], { ENVHOUND_BASE_URL: base, ENVHOUND_INSTALL_DIR: dir, ...homeEnv(home) });
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain(`installed envhound ${pkg.version} in ${dir} (runs on node)`);
    expect(r.stdout).toContain(`${dir}/envhound path add ${dir}`);
    expect(readFileSync(join(dir, "envhound"), "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(run(join(dir, "envhound"), ["--version"]).stdout.trim()).toBe(pkg.version);
    const completion = join(home, ".local", "share", "bash-completion", "completions", "envhound");
    expect(readFileSync(completion, "utf8")).toContain("envhound __complete");
    expect(r.stdout).toContain("bash completion:");
    expect(existsSync(join(home, ".config", "fish", "completions", "envhound.fish"))).toBe(hasFish);

    // upgrade re-runs install.sh into the same directory
    writeFileSync(join(dir, "envhound"), readFileSync(join(dir, "envhound"), "utf8").replace(/\n/, "\n// old\n"));
    const u = run(join(dir, "envhound"), ["upgrade"], { ENVHOUND_BASE_URL: base, ...homeEnv(home) });
    expect(u.status).toBe(0);
    expect(u.stdout).toContain(`installed envhound ${pkg.version} in ${dir}`);
    expect(readFileSync(join(dir, "envhound"), "utf8")).not.toContain("// old");
  });

  test("refuses a download that doesn't match SHA256SUMS", () => {
    const bad = mkdtempSync(join(tmpdir(), "envhound-bad-"));
    writeFileSync(join(bad, "envhound.js"), "#!/usr/bin/env node\nconsole.log('evil')\n");
    copyFileSync(join(release, "SHA256SUMS"), join(bad, "SHA256SUMS"));
    const dir = join(bad, "bin");
    const r = run("sh", [join(root, "install.sh")], { ENVHOUND_BASE_URL: `file://${bad}`, ENVHOUND_INSTALL_DIR: dir, ...homeEnv(bad) });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("checksum mismatch");
    expect(existsSync(join(dir, "envhound"))).toBe(false);
  });

  // only Bun on PATH: the installed file must run on bun
  // stdout is null without sh: this body still runs on Windows, where the tests are skipped
  const bun = spawnSync("sh", ["-c", "command -v bun"], { encoding: "utf8" }).stdout?.trim() ?? "";
  const noNode = (path: string) => spawnSync("sh", ["-c", "command -v node"], { env: { PATH: path } }).status !== 0;
  const bunPath = `${dirname(bun)}:/usr/bin:/bin`;
  test.skipIf(!bun || !noNode(bunPath))("falls back to bun without node", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "envhound-bun-")), "bin");
    const r = run("sh", [join(root, "install.sh")], {
      PATH: bunPath,
      ENVHOUND_BASE_URL: base,
      ENVHOUND_INSTALL_DIR: dir,
      ...homeEnv(dirname(dir)),
    });
    expect(r.stdout).toContain("(runs on bun)");
    expect(readFileSync(join(dir, "envhound"), "utf8").startsWith("#!/usr/bin/env bun\n")).toBe(true);
  });

  test("other installs are told their own command", () => {
    const r = run("bun", [join(root, "src", "cli.ts"), "upgrade"]);
    expect(r.stdout).toContain("git pull && bun run build");
  });
});

describe.skipIf(process.platform !== "win32")("install.ps1 and envhound upgrade on Windows", () => {
  const root = join(import.meta.dir, "..");
  const release = mkdtempSync(join(tmpdir(), "envhound-release-"));
  const base = pathToFileURL(release).href;
  const run = (cmd: string, args: string[], env: Record<string, string> = {}) =>
    spawnSync(cmd, args, { encoding: "utf8", shell: cmd.endsWith(".cmd"), env: { ...process.env, ENVHOUND_NO_UPDATE_CHECK: "1", ...env } });
  const install = (env: Record<string, string>) =>
    run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(root, "install.ps1")], env);

  beforeAll(() => {
    const r = spawnSync("bun", ["build", "src/cli.ts", "--target=node", "--minify", "--outfile", join(release, "envhound.js")], { cwd: root, encoding: "utf8" });
    expect(r.status).toBe(0);
    const sum = createHash("sha256").update(readFileSync(join(release, "envhound.js"))).digest("hex");
    writeFileSync(join(release, "SHA256SUMS"), `${sum}  envhound.js\n`);
    copyFileSync(join(root, "install.ps1"), join(release, "install.ps1"));
  });

  test("installs, then upgrades in place", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "envhound-bin-")), "bin");
    const r = install({ ENVHOUND_BASE_URL: base, ENVHOUND_INSTALL_DIR: dir });
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain(`installed envhound ${pkg.version} in ${dir} (runs on node)`);
    expect(r.stdout).toContain(`path add "${dir}"`);
    const cmd = join(dir, "envhound.cmd");
    expect(run(cmd, ["--version"]).stdout.trim()).toBe(pkg.version);

    // upgrade re-runs install.ps1 into the same directory
    const mjs = join(dir, "envhound.mjs");
    writeFileSync(mjs, readFileSync(mjs, "utf8").replace(/\n/, "\n// old\n"));
    const u = run(cmd, ["upgrade"], { ENVHOUND_BASE_URL: base });
    expect(u.status).toBe(0);
    expect(u.stdout).toContain(`installed envhound ${pkg.version} in ${dir}`);
    expect(readFileSync(mjs, "utf8")).not.toContain("// old");
  });

  test("refuses a download that doesn't match SHA256SUMS", () => {
    const bad = mkdtempSync(join(tmpdir(), "envhound-bad-"));
    writeFileSync(join(bad, "envhound.js"), "console.log('evil')\n");
    copyFileSync(join(release, "SHA256SUMS"), join(bad, "SHA256SUMS"));
    const dir = join(bad, "bin");
    const r = install({ ENVHOUND_BASE_URL: pathToFileURL(bad).href, ENVHOUND_INSTALL_DIR: dir });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("checksum mismatch");
    expect(existsSync(join(dir, "envhound.mjs"))).toBe(false);
  });
});
