// Planned file changes: preview as a diff, confirm, back up, write.
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { hunks, lineDiff } from "./diff.ts";
import { isSecret, tilde, type RenderOptions } from "./format.ts";

export interface FileChange {
  path: string;
  /** undefined: the file does not exist yet */
  before: string | undefined;
  after: string;
  /** file mode to enforce, e.g. 0o600 for files that may hold secrets */
  mode?: number;
}

export function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

const ASSIGNMENT = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_.-]*)(\s*=\s*)(.*)$/;

/** Hide values of secret-looking variables in a diff line. */
function maskLine(line: string, o: RenderOptions): string {
  if (o.showSecrets) return line;
  return line.replace(ASSIGNMENT, (m, pre: string, key: string, eq: string) => (isSecret(key) ? `${pre}${key}${eq}********` : m));
}

export function renderChange(change: FileChange, o: RenderOptions): string {
  const color = (code: string) => (s: string) => (o.color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const [bold, red, green, dim] = [color("1"), color("31"), color("32"), color("2")];
  const lines = (s: string | undefined) => (s === undefined || s === "" ? [] : s.replace(/\n$/, "").split("\n"));
  const title = `${tilde(change.path, o.home)}${change.before === undefined ? " (new file)" : ""}`;
  const body = hunks(lineDiff(lines(change.before), lines(change.after))).map((d) => {
    if (d === null) return dim("  …");
    const text = `${d.op} ${maskLine(d.text, o)}`;
    return d.op === "+" ? green(text) : d.op === "-" ? red(text) : dim(text);
  });
  return [bold(title), ...body].join("\n");
}

export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

/** Write every change, backing up existing files first. Refuses if a file changed since it was read. */
export function applyChanges(changes: FileChange[], backupDir: string): string[] {
  for (const c of changes)
    if (readIfExists(c.path) !== c.before) throw new Error(`${c.path} changed while rcenv was running; nothing was written`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backups: string[] = [];
  for (const c of changes) {
    if (c.before !== undefined) {
      mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      const backup = join(backupDir, `${stamp}-${basename(c.path)}`);
      copyFileSync(c.path, backup);
      backups.push(backup);
    }
    mkdirSync(dirname(c.path), { recursive: true });
    writeFileSync(c.path, c.after, { mode: c.mode });
    if (c.mode !== undefined) chmodSync(c.path, c.mode);
  }
  return backups;
}
