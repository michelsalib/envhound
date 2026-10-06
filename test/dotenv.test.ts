import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareDotenv, dotenvProblems, expandValue, parseDotenv, serializeDotenv } from "../src/dotenv.ts";

const sample = readFileSync(join(import.meta.dir, "fixtures", "sample.env"), "utf8");
const doc = parseDotenv(sample);
const entry = (key: string) => doc.lines.find((l) => l.kind === "entry" && l.key === key);

describe("parseDotenv", () => {
  test("round-trips byte for byte", () => {
    expect(serializeDotenv(doc)).toBe(sample);
    const crlf = "A=1\r\n# c\r\nB=\"x\r\ny\"\r\n";
    expect(serializeDotenv(parseDotenv(crlf))).toBe(crlf);
    expect(serializeDotenv(parseDotenv("A=1"))).toBe("A=1");
  });
  test("unquoted values drop inline comments", () => expect(entry("DATABASE_URL")?.value).toBe("postgres://localhost/app"));
  test("export prefix and spaces around =", () => {
    expect(entry("EDITOR")).toMatchObject({ value: "nano", exported: true });
    expect(entry("PORT")?.value).toBe("3000");
  });
  test("double quotes unescape, single quotes are literal", () => {
    expect(entry("GREETING")?.value).toBe("hello\nworld");
    expect(entry("SINGLE")).toMatchObject({ value: "no $EXPANSION here", expands: false });
  });
  test("multi-line quoted values", () => expect(entry("CERT")).toMatchObject({ line: 7, endLine: 9, value: "-----BEGIN-----\nabc\n-----END-----" }));
  test("unterminated quote does not swallow the rest of the file", () => {
    expect(doc.lines.find((l) => l.key === "OPEN")).toMatchObject({ kind: "invalid", problem: 'unterminated " quote' });
    expect(entry("API_TOKEN")?.value).toBe("s3cret");
  });
});

describe("dotenvProblems", () => {
  const messages = dotenvProblems(doc).map((p) => `${p.line}: ${p.message}`);
  test("reports every problem in line order", () => {
    expect(messages).toEqual([
      "10: expands HOST, which not every loader does; HOST is not set and expands to empty",
      "11: duplicate of line 4; most loaders keep the last one",
      "12: not a KEY=value line",
      "13: invalid key '1BAD'",
      '14: unterminated " quote',
    ]);
  });
});

describe("compareDotenv", () => {
  test("new, same and conflict, using the last duplicate", () => {
    const keys = compareDotenv(doc, { EDITOR: "vim", DATABASE_URL: "postgres://localhost/app" });
    const s = Object.fromEntries(keys.map((k) => [k.key, k.status]));
    expect(s).toMatchObject({ EDITOR: "conflict", DATABASE_URL: "same", GREETING: "new" });
    expect(keys.find((k) => k.key === "PORT")).toMatchObject({ line: 11, value: "3001" });
  });
});

test("envhound dotenv: conflicts point at the startup line, secrets masked, exit 1 on problems", () => {
  const home = join(import.meta.dir, "fixtures", "home");
  const r = spawnSync("bun", ["src/cli.ts", "--home", home, "--json", "dotenv", "test/fixtures/sample.env"], {
    cwd: join(import.meta.dir, ".."),
    encoding: "utf8",
    env: { ...process.env, EDITOR: "vim", API_TOKEN: "other" },
  });
  expect(r.status).toBe(1);
  const [report] = JSON.parse(r.stdout);
  expect(report.shellOrigin.EDITOR.at.file).toEndWith(".bash_profile");
  expect(report.keys.find((k: { key: string }) => k.key === "API_TOKEN")).toMatchObject({ status: "conflict", value: "********", current: "********" });
});

test("envhound dotenv: text output shows the file's values, masked secrets, and the shell's value on conflict", () => {
  const home = join(import.meta.dir, "fixtures", "home");
  const r = spawnSync("bun", ["src/cli.ts", "--home", home, "dotenv", "test/fixtures/sample.env"], {
    cwd: join(import.meta.dir, ".."),
    encoding: "utf8",
    env: { ...process.env, EDITOR: "vim" },
  });
  expect(r.stdout).toMatch(/^EDITOR +3 +conflict +nano {2}\(shell has vim, set at .*\.bash_profile:\d+\)$/m);
  expect(r.stdout).toMatch(/^PORT +11 +new +3001$/m);
  expect(r.stdout).toMatch(/^API_TOKEN +15 +new +\*{8}$/m);
});

describe("expansion", () => {
  const expand = (src: string, quote: "" | '"' = "", env: Record<string, string> = {}) => expandValue(src, quote, (n) => env[n]);
  test("$NAME, ${NAME} and defaults", () => {
    const env = { A: "a", EMPTY: "" };
    expect(expand("$A/${A}x", "", env).value).toBe("a/ax");
    expect(expand("${NOPE:-d}|${EMPTY:-d}|${EMPTY-d}|${NOPE-${A}}", "", env).value).toBe("d|d||a");
    expect(expand("$NOPE-${NOPE}", "", env)).toMatchObject({ value: "-", missing: ["NOPE", "NOPE"] });
  });
  test("\\$ is a literal dollar; double quotes unescape in the same pass", () => {
    expect(expand("\\$A", "", { A: "a" }).value).toBe("$A");
    expect(expand("$A\\n\\$A", '"', { A: "a" }).value).toBe("a\n$A");
    expect(parseDotenv('X="\\$HOME"').lines[0]).toMatchObject({ value: "$HOME", expands: false });
  });
  test("a lone or malformed $ stays as is", () => expect(expand("5$ ${ ${1x} $", "").value).toBe("5$ ${ ${1x} $"));

  const doc = parseDotenv("BASE=http://x\nURL=${BASE}/api\nOTHER=$UNSET/y\n");
  test("references resolve from the shell first, then from lines above", () => {
    const keys = compareDotenv(doc, { URL: "http://x/api" });
    expect(keys[1]).toMatchObject({ value: "${BASE}/api", expanded: "http://x/api", template: "${BASE}/api", status: "same" });
    expect(compareDotenv(doc, { BASE: "http://shell" })[1]).toMatchObject({ expanded: "http://shell/api", status: "new" });
  });
  test("expansion is a warning, not an error", () => {
    expect(dotenvProblems(doc).map((p) => [p.line, p.severity])).toEqual([
      [2, "warning"],
      [3, "warning"],
    ]);
  });
});

test("envhound dotenv: expanded values shown, warnings alone exit 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "envhound-"));
  writeFileSync(join(dir, ".env"), "BASE=http://x\nURL=${BASE}/api\n");
  // bun itself would load ./.env into the environment
  const r = spawnSync("bun", ["--no-env-file", join(import.meta.dir, "..", "src", "cli.ts"), "dotenv"], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH } });
  expect(r.status).toBe(0);
  expect(r.stdout).toMatch(/^URL +2 +new +http:\/\/x\/api {2}\(from \$\{BASE\}\/api\)$/m);
  expect(r.stdout).toContain("Warnings\nline 2 URL: expands BASE, which not every loader does");
});
