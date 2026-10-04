// The published build must run on plain Node, not only Bun.
import { beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { banner } from "../src/logo.ts";

const root = join(import.meta.dir, "..");
const home = join(import.meta.dir, "fixtures", "home");
const hasNode = spawnSync("node", ["--version"]).status === 0;

beforeAll(() => {
  const r = spawnSync("bun", ["run", "build"], { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
});

test.skipIf(!hasNode)("built CLI runs on node", () => {
  const r = spawnSync("node", ["dist/envhound.js", "--home", home, "--json", "blame", "API_TOKEN"], { cwd: root, encoding: "utf8" });
  expect(r.status).toBe(0);
  const out = JSON.parse(r.stdout);
  expect(out.status).toBe("effective");
  expect(out.assignments[0].value).toBe("********");
});

test.skipIf(!hasNode)("--version and --help print plain text, without the logo, when piped", () => {
  const version = spawnSync("node", ["dist/envhound.js", "--version"], { cwd: root, encoding: "utf8" });
  expect(version.stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
  const help = spawnSync("node", ["dist/envhound.js", "--help"], { cwd: root, encoding: "utf8" });
  expect(help.stdout).toStartWith("envhound ");
  expect(help.stdout).not.toContain("$_");
});

test("banner puts the text beside the logo, or under it on a narrow terminal", () => {
  const wide = banner(["envhound 1.2.3"], { color: false, truecolor: false, columns: 100 });
  expect(wide).toMatch(/\S +envhound 1\.2\.3\n/);
  expect(wide).toContain("$_");
  expect(wide).not.toContain("\x1b[");
  expect(banner(["envhound 1.2.3"], { color: false, truecolor: false, columns: 40 })).toEndWith("\n\n  envhound 1.2.3\n");
  expect(banner([], { color: true, truecolor: false })).toContain("\x1b[38;5;130m");
  expect(banner([], { color: true, truecolor: true })).toContain("\x1b[38;2;168;82;26m");
});

test.skipIf(!hasNode)("unknown command exits with usage error", () => {
  const r = spawnSync("node", ["dist/envhound.js", "nope"], { cwd: root, encoding: "utf8" });
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("unknown command");
});
