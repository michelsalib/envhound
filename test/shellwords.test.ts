import { describe, expect, test } from "bun:test";
import { words } from "../src/shellwords.ts";

describe("words", () => {
  test("plain words", () => expect(words("export A=1  B=2")).toEqual(["export", "A=1", "B=2"]));
  test("single quotes and '\\'' escapes", () => expect(words(`D='it'\\''s'`)).toEqual(["D=it's"]));
  test("quotes keep newlines", () => expect(words("C='line1\nline2'")).toEqual(["C=line1\nline2"]));
  test("ANSI-C escapes", () => expect(words("$'a\\tb\\x41\\u00e9'")).toEqual(["a\tbAé"]));
  test("octal bytes decode as UTF-8", () => expect(words("$'caf\\303\\251'")).toEqual(["café"]));
  test("double quotes and backslashes", () => expect(words(`"a \\"b\\"" c\\ d`)).toEqual(['a "b"', "c d"]));
  test("empty quoted word", () => expect(words("''")).toEqual([""]));
});
