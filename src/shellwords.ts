// Unquote the command text bash prints in an xtrace line. xtrace only emits
// plain words, '...' strings (with '\'' for embedded quotes), $'...' ANSI-C
// strings and backslash escapes, so this is not a general shell parser.
import { Buffer } from "node:buffer";

const SIMPLE: Record<string, number> = {
  n: 10, t: 9, r: 13, a: 7, b: 8, e: 27, E: 27, f: 12, v: 11, "\\": 92, "'": 39, '"': 34, "?": 63,
};

/** Decode a $'...' body starting at `i` (just past the opening quote). Returns the text and the index after the closing quote. */
function ansiC(s: string, i: number): [string, number] {
  // \nnn escapes are raw bytes (bash runs in the C locale here), so decode UTF-8 at the end
  const bytes: number[] = [];
  const push = (text: string) => bytes.push(...Buffer.from(text, "utf8"));
  while (i < s.length && s[i] !== "'") {
    if (s[i] !== "\\" || i + 1 >= s.length) {
      const ch = String.fromCodePoint(s.codePointAt(i)!);
      push(ch);
      i += ch.length;
      continue;
    }
    const c = s[i + 1]!;
    const rest = s.slice(i + 2);
    let m: string | undefined;
    if (c in SIMPLE) {
      bytes.push(SIMPLE[c]!);
      i += 2;
    } else if ((m = /^[0-7]{1,3}/.exec(s.slice(i + 1))?.[0])) {
      bytes.push(parseInt(m, 8) & 255);
      i += 1 + m.length;
    } else if (c === "x" && (m = /^[0-9a-fA-F]{1,2}/.exec(rest)?.[0])) {
      bytes.push(parseInt(m, 16));
      i += 2 + m.length;
    } else if ((c === "u" || c === "U") && (m = (c === "u" ? /^[0-9a-fA-F]{1,4}/ : /^[0-9a-fA-F]{1,8}/).exec(rest)?.[0])) {
      const cp = parseInt(m, 16);
      push(cp <= 0x10ffff ? String.fromCodePoint(cp) : "�");
      i += 2 + m.length;
    } else if (c === "c" && rest.length > 0) {
      bytes.push(rest.charCodeAt(0) & 31);
      i += 3;
    } else {
      push("\\" + c);
      i += 2;
    }
  }
  return [Buffer.from(bytes).toString("utf8"), i + 1];
}

/** Split an xtrace command line into unquoted words. */
export function words(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inWord = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === " " || c === "\t" || c === "\n") {
      if (inWord) out.push(cur);
      cur = "";
      inWord = false;
      i++;
      continue;
    }
    inWord = true;
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      const stop = end < 0 ? s.length : end;
      cur += s.slice(i + 1, stop);
      i = stop + 1;
    } else if (c === "$" && s[i + 1] === "'") {
      const [text, next] = ansiC(s, i + 2);
      cur += text;
      i = next;
    } else if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && '"\\$`'.includes(s[i + 1] ?? "x")) i++;
        cur += s[i] ?? "";
        i++;
      }
      i++;
    } else if (c === "\\" && i + 1 < s.length) {
      cur += s[i + 1];
      i += 2;
    } else {
      cur += c;
      i++;
    }
  }
  if (inWord) out.push(cur);
  return out;
}
