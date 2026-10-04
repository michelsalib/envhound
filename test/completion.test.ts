import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { complete, completionScript } from "../src/completion.ts";

const env = { PATH: "/bin", PAGER: "less", EDITOR: "vim" };
const names = (words: string[]) => complete(words, env).map((c) => c.split("\t")[0]);

describe("complete", () => {
  test("commands first", () => expect(names([""])).toEqual(["list", "blame", "path", "dotenv", "completion"]));
  test("prefix filter", () => expect(names(["b"])).toEqual(["blame"]));
  test("flags", () => expect(names(["--j"])).toEqual(["--json"]));
  test("variable names after blame, live from env", () => expect(names(["blame", "PA"])).toEqual(["PAGER", "PATH"]));
  test("flags before the command don't count", () => expect(names(["--json", "blame", "E"])).toEqual(["EDITOR"]));
  test("--home value is left to the shell", () => expect(names(["--home", ""])).toEqual([]));
  test("--home value is not a command", () => expect(names(["--home", "blame", ""])).toContain("list"));
  test("nothing after a complete blame", () => expect(names(["blame", "PATH", ""])).toEqual([]));
  test("shells after completion", () => expect(names(["completion", ""])).toEqual(["bash", "zsh", "fish"]));
  test("descriptions are tab-separated", () => expect(complete(["pa"], env)).toEqual([expect.stringMatching(/^path\t\S/)]));
});

const has = (cmd: string) => spawnSync(cmd, ["--version"]).status === 0;

describe("generated scripts parse", () => {
  test("bash", () => expect(spawnSync("bash", ["-n"], { input: completionScript("bash") }).status).toBe(0));
  test.skipIf(!has("zsh"))("zsh", () => expect(spawnSync("zsh", ["-n"], { input: completionScript("zsh") }).status).toBe(0));
  test.skipIf(!has("fish"))("fish", () => expect(spawnSync("fish", ["-n"], { input: completionScript("fish") }).status).toBe(0));

  test("bash completion end to end", () => {
    // load the script with a stub `rcenv`, then complete `rcenv blame PA`
    const script = `
      rcenv() { bun ${process.cwd()}/src/cli.ts "$@"; }
      ${completionScript("bash")}
      COMP_WORDS=(rcenv blame PA); COMP_CWORD=2; _rcenv
      printf '%s\\n' "\${COMPREPLY[@]}"`;
    const r = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, PAGER: "less" } });
    expect(r.stdout.split("\n")).toContain("PAGER");
    expect(r.stdout).not.toContain("\t");
  });
});
