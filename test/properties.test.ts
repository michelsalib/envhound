// Property-based tests: the parsers and quoting, on many generated inputs rather than examples.
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { parseDotenv, serializeDotenv, setKey } from "../src/dotenv.ts";
import { maskUrlPasswords } from "../src/format.ts";
import { dotenvQuote, shellQuote } from "../src/quote.ts";
import { words } from "../src/shellwords.ts";
import { parseTrace } from "../src/trace/bash.ts";

// environment values: any Unicode text except NUL, which no variable can hold
const value = fc.string({ unit: "binary" }).filter((s) => !s.includes("\0"));
const key = fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,15}$/);
const runs = { numRuns: 2000 };

describe("quoting", () => {
	test("shellQuote round-trips through the shell word parser, on one line", () =>
		fc.assert(
			fc.property(value, (v) => {
				expect(words(shellQuote(v))).toEqual([v]);
				expect(shellQuote(v)).not.toContain("\n");
			}),
			runs,
		));
	test("dotenvQuote round-trips through the .env parser", () =>
		fc.assert(
			fc.property(value, (v) => {
				expect(parseDotenv(`K=${dotenvQuote(v)}\n`).lines[0]?.value).toBe(v);
			}),
			runs,
		));
});

describe(".env files", () => {
	test("parsing then writing back keeps any text as it was", () =>
		fc.assert(
			fc.property(fc.string({ unit: "binary" }), (text) => {
				expect(serializeDotenv(parseDotenv(text))).toBe(text);
			}),
			runs,
		));
	test("setKey stores the value, and leaves the other lines alone", () =>
		fc.assert(
			fc.property(fc.string({ unit: "binary" }), key, value, (text, k, v) => {
				const before = parseDotenv(text);
				const after = parseDotenv(serializeDotenv(setKey(before, k, v)));
				expect(after.lines.findLast((l) => l.key === k)?.value).toBe(v);
				const others = (d: typeof before) =>
					d.lines
						.filter((l) => l.kind === "entry" && l.key !== k)
						.map((l) => l.raw);
				expect(others(after)).toEqual(others(before));
			}),
			runs,
		));
});

test("parseTrace never throws, whatever bash prints", () =>
	fc.assert(
		fc.property(fc.string({ unit: "binary" }), (stderr) => {
			parseTrace(stderr, {}, {});
		}),
		runs,
	));

test("masking a URL password never shows it", () =>
	fc.assert(
		fc.property(
			fc.stringMatching(/^[a-z]{1,8}$/),
			fc.stringMatching(/^[A-Za-z0-9._~-]{0,12}$/),
			fc.stringMatching(/^[A-Za-z0-9!$&'()*+,;=._~-]{6,24}$/),
			(scheme, user, password) => {
				const shown = maskUrlPasswords(
					`${scheme}://${user}:${password}@host/db`,
				);
				expect(shown).toBe(`${scheme}://${user}:********@host/db`);
			},
		),
		runs,
	));
