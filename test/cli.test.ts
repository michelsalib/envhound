// The published build must run on plain Node, not only Bun.
import { beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const home = join(import.meta.dir, "fixtures", "home");
const hasNode = spawnSync("node", ["--version"]).status === 0;

beforeAll(() => {
  const r = spawnSync("bun", ["run", "build"], { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
});

test.skipIf(!hasNode)("built CLI runs on node", () => {
  const r = spawnSync("node", ["dist/rcenv.js", "--home", home, "--json", "blame", "API_TOKEN"], { cwd: root, encoding: "utf8" });
  expect(r.status).toBe(0);
  const out = JSON.parse(r.stdout);
  expect(out.status).toBe("effective");
  expect(out.assignments[0].value).toBe("********");
});

test.skipIf(!hasNode)("unknown command exits with usage error", () => {
  const r = spawnSync("node", ["dist/rcenv.js", "nope"], { cwd: root, encoding: "utf8" });
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("unknown command");
});
