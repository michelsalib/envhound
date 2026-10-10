import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lineDiff } from "../src/diff.ts";
import { parseDotenv, serializeDotenv, setKey, unsetKey } from "../src/dotenv.ts";
import { HEADER, addPath, parseManaged, removePath, serializeManaged, setVar, unsetVar } from "../src/managed.ts";
import { dotenvQuote, shellQuote } from "../src/quote.ts";
import { words } from "../src/shellwords.ts";

const TRICKY = ["plain", "", "with space", "it's", 'a "b" $c `d`', "tab\there", "multi\nline", "~/not-expanded", "#hash", "café ☕", "back\\slash"];

describe("quoting round-trips", () => {
  test.each(TRICKY)("shell: %j", (v) => {
    expect(words(shellQuote(v))).toEqual([v]);
    expect(shellQuote(v)).not.toContain("\n");
  });
  test.skipIf(process.platform === "win32").each(TRICKY)("real bash agrees: %j", (v) => {
    const r = spawnSync("bash", ["-c", `printf %s ${shellQuote(v)}`], { encoding: "utf8" });
    expect(r.stdout).toBe(v);
  });
  test.each(TRICKY)(".env: %j", (v) => expect(parseDotenv(`K=${dotenvQuote(v)}\n`).lines[0]?.value).toBe(v));
});

describe("managed file", () => {
  const home = "/home/u";
  test("set, replace, unset", () => {
    let lines = parseManaged(HEADER, home);
    lines = setVar(lines, "A", "1");
    lines = setVar(lines, "B", "x y");
    lines = setVar(lines, "A", "2");
    expect(serializeManaged(lines)).toBe(HEADER + "export A=2\nexport B='x y'\n");
    expect(serializeManaged(unsetVar(lines, "A"))).toBe(HEADER + "export B='x y'\n");
  });
  test("PATH lines parse back, use $HOME, and are not added twice", () => {
    let lines = addPath(parseManaged("", home), "/home/u/bin", "front", home);
    lines = addPath(lines, "/opt/x y", "back", home);
    const reparsed = parseManaged(serializeManaged(lines), home);
    expect(reparsed.map((l) => [l.kind, l.dir, l.position])).toEqual([
      ["path", "/home/u/bin", "front"],
      ["path", "/opt/x y", "back"],
    ]);
    expect(reparsed[0]?.raw).toContain('"$HOME/bin:$PATH"');
    expect(addPath(reparsed, "/home/u/bin", "front", home)).toBe(reparsed);
    expect(removePath(reparsed, "/home/u/bin").map((l) => l.dir)).toEqual(["/opt/x y"]);
  });
  test("unrecognised lines survive", () => {
    const text = "# mine\nalias ll='ls -l'\nexport A=1\n";
    expect(serializeManaged(setVar(parseManaged(text, home), "A", "2"))).toBe("# mine\nalias ll='ls -l'\nexport A=2\n");
  });
});

describe(".env edits", () => {
  const text = "# top\nexport A='old'   # keep me\nB=1\nB=2\nC=3";
  test("set keeps export, quote style, inline comment and every other byte", () => {
    const out = serializeDotenv(setKey(parseDotenv(text), "A", "new"));
    expect(out).toBe("# top\nexport A='new'   # keep me\nB=1\nB=2\nC=3");
  });
  test("set changes the last duplicate, the one loaders use", () =>
    expect(serializeDotenv(setKey(parseDotenv(text), "B", "9"))).toBe("# top\nexport A='old'   # keep me\nB=1\nB=9\nC=3"));
  test("append adds a newline after a last line that had none", () =>
    expect(serializeDotenv(setKey(parseDotenv(text), "D", "4"))).toEndWith("C=3\nD=4\n"));
  test("set into an empty file", () => expect(serializeDotenv(setKey(parseDotenv(""), "K", "v"))).toBe("K=v\n"));
  test("unset removes every line for the key", () =>
    expect(serializeDotenv(unsetKey(parseDotenv(text), "B"))).toBe("# top\nexport A='old'   # keep me\nC=3"));
});

test("lineDiff: removals before additions", () =>
  expect(lineDiff(["a", "b", "c"], ["a", "x", "c"]).map((d) => d.op + d.text)).toEqual([" a", "-b", "+x", " c"]));

// shell changes need bash; .env changes work everywhere
const bashTest = test.skipIf(process.platform === "win32");

describe("envhound set / unset / path end to end", () => {
  const root = join(import.meta.dir, "..");
  const fixture = join(import.meta.dir, "fixtures", "home");
  const freshHome = () => {
    const home = mkdtempSync(join(tmpdir(), "envhound-home-"));
    for (const f of [".bash_profile", ".bashrc"]) copyFileSync(join(fixture, f), join(home, f));
    return home;
  };
  const env = { ...process.env, XDG_CONFIG_HOME: "/nonexistent", XDG_STATE_HOME: "/nonexistent" };
  const envhound = (home: string, ...args: string[]) =>
    spawnSync("bun", ["src/cli.ts", "--home", home, ...args], { cwd: root, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });

  bashTest("set writes the managed file and the hook once, and a fresh shell sees it", () => {
    const home = freshHome();
    const r = envhound(home, "set", "EDITOR=code", "MSG=it's here", "--yes");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("✓ a fresh login shell now gets EDITOR");
    expect(r.stdout).toContain("EDITOR is also set at ~/.bash_profile:1");
    const managed = join(home, ".config", "envhound", "env.sh");
    expect(statSync(managed).mode & 0o777).toBe(0o600);
    expect(envhound(home, "set", "EDITOR=vim", "--yes").status).toBe(0);
    expect(readFileSync(join(home, ".bash_profile"), "utf8").match(/envhound\/env\.sh/g)).toHaveLength(2); // one hook line
    expect(readFileSync(managed, "utf8")).toEndWith("export EDITOR=vim\nexport MSG='it'\\''s here'\n");
    expect(spawnSync("ls", [join(home, ".local", "state", "envhound", "backups")], { encoding: "utf8" }).stdout).toContain("env.sh");
  });

  bashTest("a later assignment is reported, with exit 1", () => {
    const home = freshHome();
    // something after the hook overrides envhound
    envhound(home, "set", "LATE=envhound", "--yes");
    writeFileSync(join(home, ".bash_profile"), readFileSync(join(home, ".bash_profile"), "utf8") + "export LATE=other\n");
    const r = envhound(home, "set", "LATE=again", "--yes");
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/does not get LATE: ~\/\.bash_profile:\d+ sets it again after envhound/);
  });

  bashTest("path add / remove", () => {
    const home = freshHome();
    const dir = join(home, "tools");
    mkdirSync(dir);
    expect(envhound(home, "path", "add", dir, "--yes").stdout).toContain("is now in PATH");
    expect(envhound(home, "path", "add", dir, "--yes").stdout).toContain("Nothing to change.");
    expect(envhound(home, "path", "remove", dir, "--yes").stdout).toContain("is no longer in PATH");
  });

  bashTest("refuses to write without a terminal unless --yes; --dry-run writes nothing", () => {
    const home = freshHome();
    expect(envhound(home, "set", "A=1").status).toBe(1);
    expect(envhound(home, "set", "A=1", "--dry-run").stdout).toContain("+ export A=1");
    expect(spawnSync("test", ["-e", join(home, ".config", "envhound", "env.sh")]).status).toBe(1);
  });

  test("bad input", () => {
    const home = freshHome();
    expect(envhound(home, "set", "PATH=/x").stderr).toContain("envhound path add");
    expect(envhound(home, "set", "1BAD=x").status).toBe(2);
    expect(envhound(home, "set", "NOEQUALS").status).toBe(2);
  });

  test("--file edits a .env file and masks secrets in the diff", () => {
    const home = freshHome();
    const file = join(home, ".env");
    writeFileSync(file, "# app\nAPI_TOKEN=old\n");
    const r = envhound(home, "set", "--file", file, "API_TOKEN=new", "PORT=3000", "--yes");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("+ API_TOKEN=********");
    expect(r.stdout).not.toContain("new");
    expect(readFileSync(file, "utf8")).toBe("# app\nAPI_TOKEN=new\nPORT=3000\n");
  });
});
