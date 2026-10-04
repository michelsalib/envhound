// Quoting for the two formats rcenv writes: shell (bash/zsh) and .env.
import type { Quote } from "./dotenv.ts";

const SAFE = /^[A-Za-z0-9_./:@%+,=-]+$/;
const CONTROL = /[\x00-\x1f\x7f]/g;

const escapeControl = (c: string) =>
  ({ "\n": "\\n", "\t": "\\t", "\r": "\\r" })[c] ?? "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0");

/** A shell word that evaluates to exactly `v` in bash and zsh, and stays on one line. */
export function shellQuote(v: string): string {
  if (SAFE.test(v)) return v;
  if (/[\x00-\x1f\x7f]/.test(v)) return "$'" + v.replace(/[\\']/g, "\\$&").replace(CONTROL, escapeControl) + "'";
  return "'" + v.replace(/'/g, "'\\''") + "'";
}

/** A .env value that parses back to `v`, keeping the `prefer`red quote style when it can hold `v`. */
export function dotenvQuote(v: string, prefer: Quote = ""): string {
  const singleOk = !v.includes("'") && !/[\r\n]/.test(v);
  if (prefer === "'" && singleOk) return `'${v}'`;
  if (prefer !== '"') {
    if (SAFE.test(v)) return v;
    if (singleOk) return `'${v}'`;
  }
  return '"' + v.replace(/[\\"$]/g, "\\$&").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + '"';
}
