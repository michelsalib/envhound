import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compareDotenv, dotenvProblems, parseDotenv, serializeDotenv } from "../src/dotenv.ts";

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
      "10: uses $VAR expansion, which not every loader supports",
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

test("rcenv dotenv: conflicts point at the startup line, secrets masked, exit 1 on problems", () => {
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
