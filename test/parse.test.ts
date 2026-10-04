import { describe, expect, test } from "bun:test";
import { parseCommand, parseTrace } from "../src/trace/bash.ts";

const rec = (file: string, line: number, cmd: string, fn = "", caller = "", callerLine: number | "" = "") =>
  `\x1f${[file, line, fn, caller, callerLine].join("\x1e")}\x1e${cmd}\n`;

describe("parseCommand", () => {
  test("plain and append assignments", () => {
    expect(parseCommand("A=1")).toMatchObject([{ name: "A", op: "=", value: "1" }]);
    expect(parseCommand("PATH+=:/opt/x")).toMatchObject([{ name: "PATH", op: "+=", value: ":/opt/x" }]);
  });
  test("export lines are skipped: bash traces their assignments again", () =>
    expect(parseCommand("export A=1 'B=two words'")).toEqual([]));
  test("declare -gx is global, local is local", () => {
    expect(parseCommand("declare -gx H=h")).toMatchObject([{ name: "H", value: "h", local: false }]);
    expect(parseCommand("local L=1")).toMatchObject([{ name: "L", local: true }]);
  });
  test("arrays and functions are ignored", () => {
    expect(parseCommand("ARR=(a b)")).toEqual([]);
    expect(parseCommand("declare -a ARR=(a b)")).toEqual([]);
    expect(parseCommand("unset -f fn")).toEqual([]);
  });
  test("unset", () => expect(parseCommand("unset A B")).toMatchObject([{ name: "A", op: "unset" }, { name: "B", op: "unset" }]));
});

describe("parseTrace", () => {
  test("simulates appends and tracks locals per function call", () => {
    const stderr =
      "bash: no job control in this shell\n" +
      rec("/h/.profile", 1, "P=a") +
      rec("/h/.profile", 2, "P+=b") +
      rec("/h/.profile", 9, "local P=x", "f", "/h/.profile", 3) +
      rec("/h/.profile", 9, "P=y", "f", "/h/.profile", 3) +
      rec("/h/.profile", 4, "M='one\ntwo'");
    const t = parseTrace(stderr, {}, {});
    const p = t.assignments.filter((a) => a.name === "P");
    expect(p.map((a) => [a.result, a.local])).toEqual([["a", false], ["ab", false], ["x", true], ["y", true]]);
    expect(t.assignments.find((a) => a.name === "M")?.value).toBe("one\ntwo");
  });
});
