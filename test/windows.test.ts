// The Windows backend: a made-up registry turned into a Trace runs on every platform;
// reading the real registry only on Windows.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { blame, envRows, pathEntries } from "../src/analyze.ts";
import { renderChange } from "../src/edit.ts";
import { renderBlame, renderList, type RenderOptions } from "../src/format.ts";
import { planWindows, powershellCommands, verifyWindows } from "../src/set-windows.ts";
import type { EditOp } from "../src/set.ts";
import { locations } from "../src/managed.ts";
import { loadData } from "../src/tui/load.ts";
import { handleKey, initialState, varViews, type Key, type State } from "../src/tui/state.ts";
import { MACHINE, SESSION, USER, expand, powershell, readRegistry, windowsTrace, writeRegistry, type Registry } from "../src/trace/windows.ts";

const reg: Registry = {
  machine: [
    { name: "Path", kind: "ExpandString", value: "%SystemRoot%\\system32;%SystemRoot%;C:\\Tools\\" },
    { name: "windir", kind: "ExpandString", value: "%SystemRoot%" },
    { name: "JAVA_HOME", kind: "String", value: "C:\\Java17" },
    { name: "TEMP", kind: "ExpandString", value: "%SystemRoot%\\TEMP" },
    { name: "NUMBER", kind: "DWord", value: "4" },
  ],
  session: [
    { name: "USERPROFILE", kind: "String", value: "C:\\Users\\u" },
    { name: "USERNAME", kind: "String", value: "u" },
  ],
  user: [
    { name: "Path", kind: "ExpandString", value: "%USERPROFILE%\\bin;C:\\tools;%NOPE%\\x" },
    { name: "TEMP", kind: "ExpandString", value: "%TMPBASE%\\Temp" },
    { name: "TMPBASE", kind: "String", value: "C:\\Users\\u\\AppData\\Local" },
    { name: "java_home", kind: "String", value: "C:\\Java21" },
    { name: "EDITOR", kind: "String", value: "code" },
  ],
};
const env = {
  SystemRoot: "C:\\WINDOWS",
  windir: "C:\\WINDOWS",
  Path: "C:\\WINDOWS\\system32;C:\\WINDOWS;C:\\Tools\\;C:\\Users\\u\\bin;C:\\tools;%NOPE%\\x",
  JAVA_HOME: "C:\\Java21",
  EDITOR: "vim",
  WT_SESSION: "1",
};
const t = windowsTrace(reg, env);
const o: RenderOptions = { home: "C:\\Users\\u", color: false, showSecrets: false, shell: "windows" };

describe("windowsTrace", () => {
  test("the user's Path is appended to the machine's, expanded", () =>
    expect(t.final.Path).toBe("C:\\WINDOWS\\system32;C:\\WINDOWS;C:\\Tools\\;C:\\Users\\u\\bin;C:\\tools;%NOPE%\\x"));
  test("user values win; names ignore case and keep the first spelling", () => {
    expect(t.final.JAVA_HOME).toBe("C:\\Java21");
    expect(blame(t, "Java_Home", env).assignments.map((a) => a.at.file)).toEqual([MACHINE, USER]);
  });
  test("plain values are set before the ones that expand", () => expect(t.final.TEMP).toBe("C:\\Users\\u\\AppData\\Local\\Temp"));
  test("only string values are variables", () => expect(t.final.NUMBER).toBeUndefined());
  test("expand keeps unknown references", () => expect(expand("%A%;%B%;100%", (n) => (n === "A" ? "a" : undefined))).toBe("a;%B%;100%"));
});

describe("analysis on Windows", () => {
  test("blame PATH: each key's additions, directories compared without case or trailing \\", () => {
    const r = blame(t, "PATH", env);
    expect(r.pathSteps?.map((s) => [s.assignment?.at.file, s.added])).toEqual([
      [MACHINE, ["C:\\WINDOWS\\system32", "C:\\WINDOWS", "C:\\Tools\\"]],
      [USER, ["C:\\Users\\u\\bin", "%NOPE%\\x"]],
    ]);
    expect(r.status).toBe("effective");
    const text = renderBlame(r, o);
    expect(text).toContain("HKCU\\Environment");
    expect(text).toContain("✓ a new terminal gets this value");
  });
  test("path entries: duplicates ignore case and a trailing \\", () => {
    const entries = pathEntries(t, env.Path);
    expect(entries[4]).toMatchObject({ dir: "C:\\tools", duplicateOf: 3, source: "startup" });
    expect(entries[3]?.addedBy?.at.file).toBe(USER);
  });
  test("list: registry, Windows itself, or inherited; differences from a new terminal", () => {
    const rows = Object.fromEntries(envRows(t, env).map((r) => [r.name, r]));
    expect(rows.SystemRoot?.kind).toBe("shell");
    expect(rows.WT_SESSION?.kind).toBe("inherited");
    expect(rows.EDITOR).toMatchObject({ kind: "startup", differsFromFresh: true });
    expect(rows.JAVA_HOME).toMatchObject({ count: 2, differsFromFresh: false });
    const text = renderList(envRows(t, env), o);
    expect(text).toMatch(/^SystemRoot +\(windows\) +C:\\WINDOWS$/m);
    expect(text).toMatch(/^EDITOR +HKCU\\Environment +vim$/m);
  });
  test("a session value", () => expect(blame(t, "USERNAME", env).assignments[0]?.at.file).toBe(SESSION));
});

// reads the real registry; checks its shape only, so no value is ever printed
test.skipIf(process.platform !== "win32")("readRegistry on Windows", () => {
  const r = readRegistry();
  expect(r.machine.some((v) => v.name.toUpperCase() === "PATH")).toBe(true);
  expect(Array.isArray(r.user) && Array.isArray(r.session)).toBe(true);
});

describe("planWindows", () => {
  const plan = (...ops: EditOp[]) => planWindows(ops, reg.user, t);
  test("set: a new value, %VAR% makes it expand, the diff shows NAME=value", () => {
    const p = plan({ kind: "set", name: "GOPATH", value: "%USERPROFILE%\\go" }, { kind: "set", name: "API_TOKEN", value: "x" });
    expect(p.changes[0]?.registry).toEqual([
      { name: "GOPATH", kind: "ExpandString", value: "%USERPROFILE%\\go" },
      { name: "API_TOKEN", kind: "String", value: "x" },
    ]);
    expect(p.changes[0]?.path).toBe(USER);
    expect(renderChange(p.changes[0]!, o)).toContain("+ API_TOKEN=********");
  });
  test("set keeps the stored spelling and kind, and notes the machine's value", () => {
    const p = plan({ kind: "set", name: "JAVA_HOME", value: "C:\\Java22" });
    expect(p.changes[0]?.registry).toEqual([{ name: "java_home", kind: "String", value: "C:\\Java22" }]);
    expect(p.notes[0]).toContain(`also set at ${MACHINE}`);
  });
  test("unset: only the user's; the machine's needs an administrator", () => {
    expect(plan({ kind: "unset", name: "editor" }).changes[0]?.registry).toEqual([{ name: "EDITOR" }]);
    const p = plan({ kind: "unset", name: "windir" });
    expect(p.changes).toEqual([]);
    expect(p.notes[0]).toContain("needs an administrator");
  });
  test("path add: under the profile it is stored as %USERPROFILE%; a present directory moves", () => {
    const front = plan({ kind: "path-add", dir: "C:\\Users\\u\\go\\bin", position: "front" });
    expect(front.changes[0]?.registry).toEqual([{ name: "Path", kind: "ExpandString", value: "%USERPROFILE%\\go\\bin;%USERPROFILE%\\bin;C:\\tools;%NOPE%\\x" }]);
    expect(renderChange(front.changes[0]!, o)).toContain("+     %USERPROFILE%\\go\\bin");
    const back = plan({ kind: "path-add", dir: "c:\\users\\u\\bin\\", position: "back" });
    expect(back.changes[0]?.registry?.[0]?.value).toBe("C:\\tools;%NOPE%\\x;%USERPROFILE%\\bin\\");
    expect(plan({ kind: "path-add", dir: "C:\\TOOLS", position: "back" }).changes).toHaveLength(1);
  });
  test("path remove: matches the expanded entry; the machine's Path is left alone", () => {
    expect(plan({ kind: "path-remove", dir: "C:\\Users\\u\\bin" }).changes[0]?.registry?.[0]?.value).toBe("C:\\tools;%NOPE%\\x");
    const p = plan({ kind: "path-remove", dir: "C:\\WINDOWS" });
    expect(p.changes).toEqual([]);
    expect(p.notes).toEqual([expect.stringContaining("machine's Path")]);
  });
  test("verify reads the outcome from a new trace", () => {
    const after = windowsTrace({ ...reg, user: [...reg.user, { name: "NEW", kind: "String", value: "1" }] }, env);
    expect(verifyWindows([{ kind: "set", name: "NEW", value: "1" }, { kind: "unset", name: "EDITOR" }], after).map((c) => c.ok)).toEqual([true, false]);
  });
  test("a reference makes the value ExpandString, even where the stored one is a plain String", () => {
    const plain = { ...reg, user: reg.user.map((v) => (v.name === "Path" ? { ...v, kind: "String" as const, value: "C:\\tools" } : v)) };
    const p = planWindows([{ kind: "path-add", dir: "C:\\Users\\u\\go\\bin", position: "front" }], plain.user, windowsTrace(plain, env));
    expect(p.changes[0]?.registry).toEqual([{ name: "Path", kind: "ExpandString", value: "%USERPROFILE%\\go\\bin;C:\\tools" }]);
    expect(plan({ kind: "set", name: "TMPBASE", value: "%USERPROFILE%\\x" }).changes[0]?.registry).toEqual([
      { name: "TMPBASE", kind: "ExpandString", value: "%USERPROFILE%\\x" },
    ]);
    // a plain String stays one when nothing in it needs expanding
    expect(plan({ kind: "path-add", dir: "D:\\bin", position: "front" }).changes[0]?.registry?.[0]?.kind).toBe("ExpandString");
    expect(planWindows([{ kind: "path-add", dir: "D:\\bin", position: "front" }], plain.user, windowsTrace(plain, env)).changes[0]?.registry?.[0]?.kind).toBe("String");
  });
  test("PowerShell commands hide secret values unless asked", () => {
    const ops: EditOp[] = [{ kind: "set", name: "API_TOKEN", value: "s3cret" }];
    expect(powershellCommands(ops)).toEqual(["# $env:API_TOKEN = …  (value hidden; --show-secrets prints this command)"]);
    expect(powershellCommands(ops, true)).toEqual(["$env:API_TOKEN = 's3cret'"]);
  });
  test("PowerShell commands for this terminal", () =>
    expect(powershellCommands([{ kind: "set", name: "A", value: "it's" }, { kind: "path-add", dir: "C:\\x", position: "front" }])).toEqual([
      "$env:A = 'it''s'",
      "$env:Path = 'C:\\x;' + $env:Path",
    ]));
});

// a scratch key, never the real HKCU\Environment
test.skipIf(process.platform !== "win32")("writeRegistry and readRegistry on a scratch key", () => {
  const userKey = `Software\\envhound-test-${process.pid}`;
  const backup = join(mkdtempSync(join(tmpdir(), "envhound-")), "backup.reg");
  try {
    writeRegistry([{ name: "A", kind: "String", value: "café ☕ 'q' \"d\"" }, { name: "P", kind: "ExpandString", value: "%USERPROFILE%\\x" }], { userKey, notify: false });
    writeRegistry([{ name: "P" }, { name: "B", kind: "String", value: "b" }], { userKey, backup, notify: false });
    expect(readRegistry(userKey).user).toEqual([
      { name: "A", kind: "String", value: "café ☕ 'q' \"d\"" },
      { name: "B", kind: "String", value: "b" },
    ]);
    // the backup is the key before the second write; .reg files store ExpandString as hex(2)
    expect(readFileSync(backup, "utf16le")).toContain('"P"=hex(2):');
  } finally {
    powershell(`Remove-Item -LiteralPath 'HKCU:\\${userKey}' -Recurse -ErrorAction SilentlyContinue`);
  }
});

describe("envhound edit on Windows", () => {
  const loc = locations("C:\\Users\\u", {}, true);
  const data = loadData(t, env, loc);
  const press = (s: State, ...keys: Key[]) => keys.reduce<State>((st, k) => handleKey(st, k)[0], s);
  const at = (name: string) => data.vars.findIndex((v) => v.name === name);
  const on = (name: string): State => ({ ...initialState(data), cursor: { vars: varViews(initialState(data)).findIndex((v) => v.name === name) } });

  test("rows: the user's variables can change; registry rows have no line to open", () => {
    expect(data.windows).toBe(true);
    expect(data.vars.find((v) => v.name === "EDITOR")).toMatchObject({ by: USER, managed: true, source: undefined });
    expect(data.vars.find((v) => v.name === "SystemRoot")).toMatchObject({ by: "(windows)", managed: false });
    expect(data.vars.some((v) => v.name === "Path")).toBe(false);
    expect(data.path.find((p) => p.dir === "C:\\Users\\u\\bin")?.managed).toBe(true);
    expect(data.path.find((p) => p.dir === "C:\\WINDOWS")?.managed).toBe(false);
    expect(at("TMPBASE")).toBeGreaterThan(-1); // in the registry, not in this terminal yet
  });
  test("d unsets the user's; the machine's needs an administrator; o has nothing to open", () => {
    expect(press(on("EDITOR"), { ch: "d" }).ops).toEqual([{ kind: "unset", name: "EDITOR" }]);
    expect(press(on("windir"), { ch: "d" }).message?.text).toContain("needs an administrator");
    expect(press(on("EDITOR"), { ch: "o" }).message?.text).toContain("nothing to open");
  });
});

test("on Windows, backups and the update check's state live in %LOCALAPPDATA%\\envhound", () => {
  const loc = locations("C:\\Users\\u", { LOCALAPPDATA: "D:\\Local" }, false, true);
  expect(loc.updateState).toBe(join("D:\\Local", "envhound", "update.json"));
  expect(loc.backups).toBe(join("D:\\Local", "envhound", "backups"));
  expect(locations("C:\\Users\\u", { LOCALAPPDATA: "D:\\Local" }, true, true).backups).toBe(join("C:\\Users\\u", "AppData", "Local", "envhound", "backups"));
});
