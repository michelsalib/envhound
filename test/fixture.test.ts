// End-to-end against a fake HOME: runs real bash on test/fixtures/home.
import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { blame, envRows, pathEntries, status } from "../src/analyze.ts";
import type { Trace } from "../src/model.ts";
import { canTrace, traceBash } from "../src/trace/bash.ts";

const home = join(import.meta.dir, "fixtures", "home");
let t: Trace;
beforeAll(() => {
  if (canTrace) t = traceBash({ home });
});

const last = (name: string) => blame(t, name, {}).assignments.at(-1);
const where = (name: string) => {
  const a = last(name);
  return a && `${a.at.file.replace(home, "~")}:${a.at.line}`;
};

describe.skipIf(!canTrace)("fixture home", () => {
  test("finds the line that sets a variable", () => {
    expect(where("EDITOR")).toBe("~/.bash_profile:1");
    expect(status(t, "EDITOR")).toBe("effective");
  });

  test("decodes quoted, multi-line and non-ASCII values", () => {
    expect(t.final.QUOTED).toBe(`it's "quoted"`);
    expect(last("QUOTED")?.result).toBe(t.final.QUOTED!);
    expect(last("MULTI")?.result).toBe("line1\nline2");
    expect(last("UNICODE")?.result).toBe("café ☕");
  });

  test("follows += appends", () => {
    expect(blame(t, "GREETING", {}).assignments.map((a) => a.op)).toEqual(["=", "+="]);
    expect(status(t, "GREETING")).toBe("effective");
  });

  test("flags one-command prefixes as not effective", () => expect(status(t, "SHELL")).toBe("not-effective"));
  test("ignores function locals", () => expect(blame(t, "LOCALVAR", {}).assignments).toEqual([]));
  test("knows about unset", () => expect(status(t, "TEMP")).toBe("unset"));
  test("flags shell variables that are never exported", () => expect(status(t, "SHELLONLY")).toBe("not-exported"));

  test("PATH steps credit the call site of helper functions", () => {
    const steps = blame(t, "PATH", {}).pathSteps!;
    const byDir = (d: string) => steps.find((s) => s.added.includes(d))?.assignment;
    expect(byDir(`${home}/bin`)?.at.line).toBe(2);
    const viaFn = byDir("/opt/envhound-test/bin")!;
    expect(viaFn.via).toMatchObject({ kind: "function", name: "add_path", at: { line: 2 } });
    expect(steps.at(-1)?.added).toEqual([]); // PATH+=":$HOME/bin" repeats ~/bin
  });

  test("path entries: who added each, duplicates, missing", () => {
    const entries = pathEntries(t, `${home}/bin:/usr/bin:/opt/envhound-test/bin:/usr/bin:/from/terminal`);
    expect(entries.map((e) => e.source)).toEqual(["startup", "initial", "startup", "initial", "inherited"]);
    expect(entries[3]?.duplicateOf).toBe(2);
    expect(entries[2]?.exists).toBe(false);
  });

  test("list mode labels where each variable comes from", () => {
    const rows = envRows(t, { EDITOR: "nano", HOME: home, FROM_TERMINAL: "1" });
    const row = (n: string) => rows.find((r) => r.name === n)!;
    expect(row("EDITOR")).toMatchObject({ kind: "startup", differsFromFresh: true });
    expect(row("HOME").kind).toBe("shell");
    expect(row("FROM_TERMINAL").kind).toBe("inherited");
  });
});
