import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editorCommand } from "../src/tui/terminal.ts";
import { dotenvViews, handleKey, initialState, pathViews, varViews, type Data, type Key, type State } from "../src/tui/state.ts";
import { render } from "../src/tui/view.ts";

const ENV = join(process.cwd(), ".env");
const data = (): Data => ({
  home: "/home/u",
  vars: [
    { name: "EDITOR", value: "vim", by: "~/.profile:3", source: { file: "/home/u/.profile", line: 3 }, managed: false },
    { name: "MINE", value: "1", by: "envhound", source: { file: "/home/u/.config/envhound/env.sh", line: 4 }, managed: true },
    { name: "API_TOKEN", value: "s3cret", by: "envhound", managed: true },
    { name: "TERM", value: "xterm", by: "(inherited)", managed: false },
  ],
  path: [
    { dir: "/home/u/bin", by: "envhound", managed: true, exists: true },
    { dir: "/usr/bin", by: "(initial)", managed: false, exists: true },
    { dir: "/gone", by: "~/.profile:9", source: { file: "/home/u/.profile", line: 9 }, managed: false, exists: false },
  ],
  dotenv: [
    {
      file: ENV,
      exists: true,
      problems: 1,
      rows: [
        { key: "PORT", value: "3000", line: 1, status: "new", count: 1 },
        { key: "EDITOR", value: "nano", line: 2, status: "conflict", current: "vim", count: 1 },
        { key: "DUP", value: "2", line: 4, status: "new", count: 2, problem: "duplicate of line 3; most loaders keep the last one" },
      ],
    },
  ],
});

const type = (t: string): Key[] => [...t].map((ch) => ({ ch }));
function press(s: State, ...keys: Key[]): [State, ReturnType<typeof handleKey>[1]] {
  let effect;
  for (const k of keys) [s, effect] = handleKey(s, k);
  return [s, effect];
}
const at = (s: State, name: string) => varViews(s).findIndex((r) => r.name === name);
const goTo = (s: State, name: string) => ({ ...s, cursor: { ...s.cursor, vars: at(s, name) } });

describe("variables tab", () => {
  test("edit stages a set, shown as old → new", () => {
    let [s] = press(goTo(initialState(data()), "EDITOR"), { name: "return" }, { ctrl: true, name: "u" }, ...type("code"), { name: "return" });
    expect(s.ops).toEqual([{ kind: "set", name: "EDITOR", value: "code" }]);
    expect(render(s, 80, 12, { color: false }).join("\n")).toContain("vim → code");
    // editing again replaces the staged op instead of adding one
    [s] = press(s, { name: "return" }, { name: "backspace" }, { name: "return" });
    expect(s.ops).toEqual([{ kind: "set", name: "EDITOR", value: "cod" }]);
  });

  test("new variable, validated", () => {
    let [s] = press(initialState(data()), { ch: "n" }, ...type("1bad"), { name: "return" });
    expect(s.message?.error).toBe(true);
    expect(s.prompt).toBeDefined(); // still asking
    [s] = press(s, { ctrl: true, name: "u" }, ...type("NEW_ONE"), { name: "return" }, ...type("x y"), { name: "return" });
    expect(s.ops).toEqual([{ kind: "set", name: "NEW_ONE", value: "x y" }]);
    expect(varViews(s).find((r) => r.name === "NEW_ONE")?.pending).toBe("new");
  });

  test("d unsets envhound's variables, refuses others and says where they come from", () => {
    let [s] = press(goTo(initialState(data()), "MINE"), { ch: "d" });
    expect(s.ops).toEqual([{ kind: "unset", name: "MINE" }]);
    [s] = press(goTo(s, "EDITOR"), { ch: "d" });
    expect(s.message).toMatchObject({ error: true, text: expect.stringContaining("~/.profile:3") });
    [s] = press(goTo(s, "TERM"), { ch: "d" });
    expect(s.message?.text).toContain("program that started this shell");
  });

  test("filter as you type; esc clears", () => {
    let [s] = press(initialState(data()), { ch: "/" }, ...type("edi"));
    expect(varViews(s).map((r) => r.name)).toEqual(["EDITOR"]);
    [s] = press(s, { name: "return" }, { name: "escape" });
    expect(s.filter).toBe("");
  });

  test("secrets are masked, in the list and while typing", () => {
    let [s] = press(goTo(initialState(data()), "API_TOKEN"));
    expect(render(s, 80, 12, { color: false }).join("\n")).not.toContain("s3cret");
    [s] = press(s, { name: "return" });
    expect(render(s, 80, 12, { color: false }).at(-1)).toContain("••••••");
    [s] = press(s, { name: "escape" }, { ch: "s" });
    expect(render(s, 80, 12, { color: false }).join("\n")).toContain("s3cret");
  });

  test("a just-typed secret character shows until the reveal is cleared", () => {
    let [s] = press(goTo(initialState(data()), "API_TOKEN"), { name: "return" }, { ch: "Z" });
    expect(render(s, 80, 12, { color: false }).at(-1)).toContain("••••••Z");
    expect(render({ ...s, prompt: { ...s.prompt!, reveal: false } }, 80, 12, { color: false }).at(-1)).not.toContain("Z");
    [s] = press(s, { name: "backspace" });
    expect(s.prompt?.reveal).toBe(false);
  });

  test("typing into a masked value wider than the screen still changes the prompt", () => {
    const long = data();
    long.vars[2]!.value = "x".repeat(200);
    let [s] = press(goTo(initialState(long), "API_TOKEN"), { name: "return" });
    const before = render(s, 40, 12, { color: false }).at(-1)!;
    expect(before).toContain("(200 characters)");
    expect([...before].length).toBeLessThanOrEqual(40);
    [s] = press(s, { ch: "y" });
    expect(render(s, 40, 12, { color: false }).at(-1)).toContain("(201 characters)");
  });

  test("o opens the source line, or explains why not", () => {
    expect(press(goTo(initialState(data()), "EDITOR"), { ch: "o" })[1]).toEqual({ kind: "open", at: { file: "/home/u/.profile", line: 3 } });
    expect(press(goTo(initialState(data()), "TERM"), { ch: "o" })[1]).toBeUndefined();
  });
});

// POSIX paths; on Windows, edit doesn't reach the PATH tab yet
describe.skipIf(process.platform === "win32")("PATH tab", () => {
  test("add front / end, refuse duplicates, d drops a staged add", () => {
    let [s] = press(initialState(data()), { name: "tab" }, { ch: "a" }, ...type("~/tools"), { name: "return" });
    expect(s.ops).toEqual([{ kind: "path-add", dir: "/home/u/tools", position: "front" }]);
    expect(pathViews(s)[0]).toMatchObject({ dir: "/home/u/tools", pending: "add" });
    [s] = press(s, { ch: "A" }, ...type("/usr/bin"), { name: "return" });
    expect(s.message?.text).toBe("/usr/bin is already in PATH");
    [s] = press(s, { name: "home" }, { ch: "d" });
    expect(s.ops).toEqual([]);
  });

  test("remove only what envhound added", () => {
    let [s] = press(initialState(data()), { ch: "2" }, { ch: "d" }); // /home/u/bin, envhound's
    expect(s.ops).toEqual([{ kind: "path-remove", dir: "/home/u/bin" }]);
    [s] = press(s, { ch: "G" }, { ch: "d" }); // /gone, from ~/.profile
    expect(s.message?.text).toContain("press o to open");
    expect(render(s, 100, 12, { color: false }).join("\n")).toContain("missing");
  });
});

describe("quit, undo, write", () => {
  test("quit asks once when changes are staged", () => {
    const [staged] = press(goTo(initialState(data()), "MINE"), { ch: "d" });
    const [asked, e1] = press(staged, { ch: "q" });
    expect(e1).toBeUndefined();
    expect(press(asked, { ch: "q" })[1]).toEqual({ kind: "quit" });
    expect(press(asked, { name: "down" })[0].confirmQuit).toBe(false);
    expect(press(staged, { ctrl: true, name: "c" })[1]).toEqual({ kind: "quit" });
  });
  test("u undoes, w writes only when something is staged", () => {
    const [staged] = press(goTo(initialState(data()), "MINE"), { ch: "d" });
    expect(press(staged, { ch: "w" })[1]).toEqual({ kind: "write" });
    const [undone] = press(staged, { ch: "u" });
    expect(undone.ops).toEqual([]);
    expect(press(undone, { ch: "w" })[1]).toBeUndefined();
  });
});

describe(".env tabs", () => {
  const onEnv = () => initialState(data(), { tab: 2 });
  const goToKey = (s: State, key: string) => ({ ...s, cursor: { ...s.cursor, [`dotenv:${ENV}`]: dotenvViews(s, ENV).findIndex((r) => r.key === key) } });

  test("tab label, conflicts, duplicates", () => {
    const screen = render(onEnv(), 120, 14, { color: false }).join("\n");
    expect(screen).toContain(" 3 .env ");
    expect(screen).toContain("shell has vim");
    expect(screen).toContain("duplicate of line 3");
  });

  test("edits are staged against the file, separately from the shell", () => {
    let [s] = press(goToKey(onEnv(), "EDITOR"), { name: "return" }, { ctrl: true, name: "u" }, ...type("code"), { name: "return" });
    [s] = press(goTo({ ...s, tab: 0 }, "EDITOR"), { name: "return" }, { ctrl: true, name: "u" }, ...type("emacs"), { name: "return" });
    expect(s.ops).toEqual([
      { kind: "set", name: "EDITOR", value: "code", file: ENV },
      { kind: "set", name: "EDITOR", value: "emacs", file: undefined },
    ]);
    expect(dotenvViews(s, ENV).find((r) => r.key === "EDITOR")).toMatchObject({ pending: "set", newValue: "code" });
  });

  test("new keys may use dots and dashes; d deletes, d again drops it", () => {
    let [s] = press(onEnv(), { ch: "n" }, ...type("app.name"), { name: "return" }, ...type("x"), { name: "return" });
    expect(s.ops).toEqual([{ kind: "set", name: "app.name", value: "x", file: ENV }]);
    [s] = press(goToKey(s, "PORT"), { ch: "d" });
    expect(s.ops.at(-1)).toEqual({ kind: "unset", name: "PORT", file: ENV });
    [s] = press(s, { ch: "d" });
    expect(s.ops).toHaveLength(1);
  });

  test("o opens the file at the key's line; new keys have none yet", () => {
    expect(press(goToKey(onEnv(), "DUP"), { ch: "o" })[1]).toEqual({ kind: "open", at: { file: ENV, line: 4 } });
    const [s] = press(onEnv(), { ch: "n" }, ...type("NEW"), { name: "return" }, { name: "return" });
    const [opened, effect] = press(goToKey(s, "NEW"), { ch: "o" });
    expect(effect).toBeUndefined();
    expect(opened.message?.text).toContain("write first");
  });

  test("tab cycles through every tab, digits jump", () => {
    const [s] = press(initialState(data()), { name: "tab" }, { name: "tab" });
    expect(s.tab).toBe(2);
    expect(press(s, { name: "tab" })[0].tab).toBe(0);
    expect(press(s, { ch: "9" })[0].tab).toBe(2); // no tab 9
  });
});

test("render fits the screen exactly", () => {
  for (const [w, h] of [[30, 8], [40, 8], [80, 24], [200, 50]] as const)
    for (const tab of [0, 1, 2]) {
      const lines = render(initialState(data(), { tab }), w, h, { color: false });
      expect(lines).toHaveLength(h);
      for (const l of lines) expect([...l].length).toBeLessThanOrEqual(w);
    }
});

test("editorCommand", () => {
  const at = { file: "/f", line: 7 };
  expect(editorCommand("vim", at)).toEqual(["vim", ["+7", "/f"]]);
  expect(editorCommand("code --wait", at)).toEqual(["code", ["--wait", "-g", "/f:7"]]);
  expect(editorCommand("/usr/bin/nano -w", at)).toEqual(["/usr/bin/nano", ["-w", "+7", "/f"]]);
  expect(editorCommand('"C:\\Program Files\\VS Code\\bin\\code.cmd" --wait', at)).toEqual(["C:\\Program Files\\VS Code\\bin\\code.cmd", ["--wait", "-g", "/f:7"]]);
  expect(editorCommand("notepad", at)).toEqual(["notepad", ["/f"]]);
});

test.skipIf(spawnSync("script", ["--version"]).status !== 0)("envhound edit in a real terminal: stage, write, verify", () => {
  // `script` gives envhound a pty; keys are fed through it, `y` answers the write confirmation
  const fixture = join(import.meta.dir, "fixtures", "home");
  const home = mkdtempSync(join(tmpdir(), "envhound-edit-"));
  for (const f of [".bash_profile", ".bashrc"]) copyFileSync(join(fixture, f), join(home, f));
  // keys arrive with pauses, as typed: the editor first, then the confirmation after it
  const keys = `sleep 2; printf 'nFROM_TUI\\rhello\\rw'; sleep 3; printf 'y\\r'; sleep 4`;
  const cmd = `bun ${join(import.meta.dir, "..", "src", "cli.ts")} --home ${home} edit`;
  const r = spawnSync("bash", ["-c", `(${keys}) | script -qec '${cmd}' /dev/null`], {
    encoding: "utf8",
    env: { ...process.env, XDG_CONFIG_HOME: "", XDG_STATE_HOME: "", TERM: "xterm" },
    timeout: 20_000,
  });
  expect(r.stdout).toContain("+ export FROM_TUI=hello");
  expect(r.stdout).toContain("✓ a fresh login shell now gets FROM_TUI");
  expect(readFileSync(join(home, ".config", "envhound", "env.sh"), "utf8")).toContain("export FROM_TUI=hello");
}, 30_000);

test.skipIf(spawnSync("script", ["--version"]).status !== 0)("envhound edit FILE: .env and shell changes in one write", () => {
  const fixture = join(import.meta.dir, "fixtures", "home");
  const home = mkdtempSync(join(tmpdir(), "envhound-edit-env-"));
  for (const f of [".bash_profile", ".bashrc"]) copyFileSync(join(fixture, f), join(home, f));
  const project = mkdtempSync(join(tmpdir(), "envhound-project-"));
  writeFileSync(join(project, ".env"), "# app\nA=1   # first\nB=2\n");
  // starts on the .env tab: edit A, then tab 1: new shell variable, then write and confirm
  const keys = [
    "sleep 2",
    "printf '\\r'", "sleep 0.3", "printf '\\025'", "printf '9\\r'",
    "printf '1n'", "printf 'MIXED\\r'", "printf 'v\\r'", "sleep 0.3",
    "printf 'w'", "sleep 3", "printf 'y\\r'", "sleep 4",
  ].join("; ");
  const cmd = `bun ${join(import.meta.dir, "..", "src", "cli.ts")} --home ${home} edit .env`;
  const r = spawnSync("bash", ["-c", `(${keys}) | script -qec '${cmd}' /dev/null`], {
    cwd: project,
    encoding: "utf8",
    env: { ...process.env, XDG_CONFIG_HOME: "", XDG_STATE_HOME: "", TERM: "xterm" },
    timeout: 25_000,
  });
  expect(readFileSync(join(project, ".env"), "utf8")).toBe("# app\nA=9   # first\nB=2\n");
  expect(readFileSync(join(home, ".config", "envhound", "env.sh"), "utf8")).toContain("export MIXED=v");
  expect(r.stdout).toContain("✓ a fresh login shell now gets MIXED");
}, 30_000);
