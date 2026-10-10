// Planned file changes: preview as a diff, confirm, back up, write.
import { chmodSync, constants, copyFileSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { hunks, lineDiff } from "./diff.ts";
import { isSecret, tilde, type RenderOptions } from "./format.ts";
import { registryText } from "./set-windows.ts";
import { readRegistry, writeRegistry, type RegistryWrite } from "./trace/windows.ts";

export interface FileChange {
  path: string;
  /** undefined: the file does not exist yet */
  before: string | undefined;
  after: string;
  /** file mode to enforce, e.g. 0o600 for files that may hold secrets */
  mode?: number;
  /** Windows: path is HKCU\Environment and these writes make the change; before and after are only shown. */
  registry?: RegistryWrite[];
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
  } catch {
    return false; // ctrl-d or end of input: no
  } finally {
    rl.close();
  }
}

/**
 * Write every change, backing up existing files first. Refuses if a file changed since it was read.
 * Each file is written to a temporary file next to it, then renamed over it, so a failure leaves it as it was;
 * every temporary file is written before the first rename, so a full disk stops the whole change.
 */
export function applyChanges(changes: FileChange[], backupDir: string): string[] {
  const now = (c: FileChange) => (c.registry ? registryText(readRegistry().user) : readIfExists(c.path));
  for (const c of changes)
    if (now(c) !== c.before) throw new Error(`${c.path} changed while envhound was running; nothing was written`);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backups: string[] = [];
  const staged = new Map<FileChange, Staged>();
  try {
    for (const c of changes) if (!c.registry) staged.set(c, stage(c));
    for (const c of changes) {
      if (c.registry) {
        mkdirSync(backupDir, { recursive: true, mode: 0o700 });
        const backup = join(backupDir, `${stamp}-HKCU-Environment.reg`);
        writeRegistry(c.registry, { backup });
        backups.push(backup);
        continue;
      }
      if (c.before !== undefined) backups.push(backUp(c.path, backupDir, stamp));
      const s = staged.get(c)!;
      renameSync(s.tmp, s.target);
      staged.delete(c);
    }
  } finally {
    for (const s of staged.values()) rmSync(s.tmp, { force: true });
  }
  return backups;
}

interface Staged {
  tmp: string;
  target: string;
}

/** The new content in a temporary file beside the target. A symlinked file (stow, a dotfiles repo) is written through the link, which stays. */
function stage(c: FileChange): Staged {
  let target = c.path;
  try {
    target = realpathSync(c.path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  mkdirSync(dirname(target), { recursive: true });
  // keep an existing file's mode unless the change sets one
  const mode = c.mode ?? (c.before !== undefined ? statSync(target).mode & 0o7777 : undefined);
  const tmp = join(dirname(target), `.${basename(target)}.envhound-${process.pid}`);
  rmSync(tmp, { force: true });
  writeFileSync(tmp, c.after, { mode, flag: "wx" });
  if (mode !== undefined) chmodSync(tmp, mode); // the umask may have narrowed it
  return { tmp, target };
}

/** Copy `path` into `dir`, never over an earlier backup: two files named .env in one run get distinct names. */
function backUp(path: string, dir: string, stamp: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (let n = 1; ; n++) {
    const backup = join(dir, `${stamp}${n > 1 ? `-${n}` : ""}-${basename(path)}`);
    try {
      copyFileSync(path, backup, constants.COPYFILE_EXCL);
      return backup;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
}
