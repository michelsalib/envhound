import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { complete, completionScript } from "../src/completion.ts";

const env = { PATH: "/bin", PAGER: "less", EDITOR: "vim" };
const names = (words: string[]) => complete(words, env).map((c) => c.split("\t")[0]);

describe("complete", () => {
  test("commands first", () => expect(names([""])).toEqual(["list", "blame", "path", "dotenv", "set", "unset", "edit", "completion", "upgrade"]));
  test("prefix filter", () => expect(names(["b"])).toEqual(["blame"]));
  test("flags", () => expect(names(["--j"])).toEqual(["--json"]));
  test("variable names after blame, live from env", () => expect(names(["blame", "PA"])).toEqual(["PAGER", "PATH"]));
  test("flags before the command don't count", () => expect(names(["--json", "blame", "E"])).toEqual(["EDITOR"]));
  test("--home value is left to the shell", () => expect(names(["--home", ""])).toEqual([]));
  test("--home value is not a command", () => expect(names(["--home", "blame", ""])).toContain("list"));
  test("nothing after a complete blame", () => expect(names(["blame", "PATH", ""])).toEqual([]));
  test("shells after completion", () => expect(names(["completion", ""])).toEqual(["bash", "zsh", "fish", "powershell"]));
  test("Windows ignores case", () => {
    const winEnv = { Path: "C:\\x", PATHEXT: ".EXE", EDITOR: "code" };
    expect(complete(["blame", "pa"], winEnv, { ignoreCase: true })).toEqual(["PATHEXT", "Path"]);
    expect(complete(["set", ""], winEnv, { ignoreCase: true })).toEqual(["EDITOR=", "PATHEXT="]);
  });
  test("descriptions are tab-separated", () => expect(complete(["pa"], env)).toEqual([expect.stringMatching(/^path\t\S/)]));
});

const has = (cmd: string) => spawnSync(cmd, ["--version"]).status === 0;

// on Windows, `bash` may be the WSL launcher
describe.skipIf(process.platform === "win32")("generated scripts parse", () => {
  test("bash", () => expect(spawnSync("bash", ["-n"], { input: completionScript("bash") }).status).toBe(0));
  test.skipIf(!has("zsh"))("zsh", () => expect(spawnSync("zsh", ["-n"], { input: completionScript("zsh") }).status).toBe(0));
  test.skipIf(!has("fish"))("fish", () => expect(spawnSync("fish", ["-n"], { input: completionScript("fish") }).status).toBe(0));

  test("bash completion end to end", () => {
    // load the script with a stub `envhound`, then complete `envhound blame PA`
    const script = `
      envhound() { bun ${process.cwd()}/src/cli.ts "$@"; }
      ${completionScript("bash")}
      COMP_WORDS=(envhound blame PA); COMP_CWORD=2; _envhound
      printf '%s\\n' "\${COMPREPLY[@]}"`;
    const r = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, PAGER: "less" } });
    expect(r.stdout.split("\n")).toContain("PAGER");
    expect(r.stdout).not.toContain("\t");
  });
});

// a stub envhound.cmd on PATH, then PowerShell's own completion engine
test.skipIf(process.platform !== "win32")("powershell completion end to end", () => {
  const dir = mkdtempSync(join(tmpdir(), "envhound-"));
  writeFileSync(join(dir, "envhound.cmd"), `@bun "${join(process.cwd(), "src", "cli.ts")}" %*\r\n`);
  const script = `
    ${completionScript("powershell")}
    foreach ($line in 'envhound blame PA', 'envhound bl', 'envhound --json ') {
      (TabExpansion2 $line $line.Length).CompletionMatches.CompletionText -join ','
    }`;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, PAGER: "less" },
  });
  const [blame, commands, afterFlag] = r.stdout.trim().split(/\r?\n/);
  expect(blame?.split(",")).toContain("PAGER");
  expect(commands).toBe("blame");
  expect(afterFlag?.split(",")).toContain("list");
});
