// Replay a bash login shell from a clean environment with xtrace on, and turn
// the trace into a list of assignments. The clean environment means we only
// see what startup files do, never what the terminal passed in.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import type { Assignment, Op, Trace, Via } from "../model.ts";
import { words } from "../shellwords.ts";

const MARK = "\x1f";
const SEP = "\x1e";
// bash repeats the first character of PS4 once per nesting level, which makes it a safe record marker.
const PS4 =
  MARK +
  ["${BASH_SOURCE[0]:-}", "${LINENO}", "${FUNCNAME[0]:-}", "${BASH_SOURCE[1]:-}", "${BASH_LINENO[0]:-}"].join(SEP) +
  SEP;

export const BASE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export interface TraceOptions {
  /** Trace startup files as if HOME were this directory. */
  home?: string;
  timeoutMs?: number;
}

export function traceBash(opts: TraceOptions = {}): Trace {
  const home = resolve(opts.home ?? process.env.HOME ?? userInfo().homedir);
  const user = process.env.USER ?? userInfo().username;
  const initial: Record<string, string> = {
    HOME: home,
    USER: user,
    LOGNAME: user,
    SHELL: process.env.SHELL ?? "/bin/bash",
    TERM: process.env.TERM ?? "xterm",
    PATH: BASE_PATH,
  };
  const dir = mkdtempSync(join(tmpdir(), "rcenv-"));
  const envFile = join(dir, "env");
  try {
    // Startup files may print to stdout, so the final env goes to a file instead.
    const r = spawnSync("bash", ["-lixc", `env -0 > '${envFile}'`], {
      env: { ...initial, PS4 },
      cwd: home,
      stdio: ["ignore", "ignore", "pipe"],
      timeout: opts.timeoutMs ?? 15_000,
      maxBuffer: 256 * 1024 * 1024,
      encoding: "utf8",
    });
    if (r.error) {
      if ((r.error as NodeJS.ErrnoException).code === "ETIMEDOUT")
        throw new Error("bash startup files did not finish in time (is something waiting for input?)");
      throw r.error;
    }
    let env = "";
    try {
      env = readFileSync(envFile, "utf8");
    } catch {}
    if (!env)
      throw new Error(
        `bash startup files did not finish (exit status ${r.status}); an 'exec' or 'exit' in a startup file stops the trace`,
      );
    const final = parseEnv0(env);
    delete final.PS4;
    return parseTrace(r.stderr, initial, final);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function parseEnv0(s: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of s.split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

interface Step {
  name: string;
  op: Op;
  value: string;
  /** Declared with `local` (or declare without -g): only local if inside a function. */
  local: boolean;
  /** `local X` / `declare X` with no value: changes scope, not value. */
  bare: boolean;
}

const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)(\+?=)/;
const DECL_ARG = /^([A-Za-z_][A-Za-z0-9_]*)(?:(\+?=)([\s\S]*))?$/;

/** Variable changes made by one traced command. */
export function parseCommand(cmd: string): Step[] {
  const m = ASSIGN.exec(cmd);
  if (m) {
    const rest = cmd.slice(m[0].length);
    if (rest.startsWith("(")) return []; // array assignment: not part of the environment
    return [{ name: m[1]!, op: m[2] as Op, value: words(rest)[0] ?? "", local: false, bare: false }];
  }
  // `export` and `readonly` are skipped: bash traces each of their assignments again as a plain line.
  const [head, ...args] = words(cmd);
  const flags = args.filter((a) => a.startsWith("-")).join("");
  const names = args.filter((a) => !a.startsWith("-"));
  if (head === "unset") {
    if (flags.includes("f")) return [];
    return names.map((name) => ({ name, op: "unset", value: "", local: false, bare: false }));
  }
  if (head === "local" || head === "declare" || head === "typeset") {
    if (/[aAfF]/.test(flags)) return [];
    const local = head === "local" || !flags.includes("g");
    return names.flatMap((arg) => {
      const d = DECL_ARG.exec(arg);
      if (!d) return [];
      return [{ name: d[1]!, op: (d[2] ?? "=") as Op, value: d[3] ?? "", local, bare: d[2] === undefined }];
    });
  }
  return [];
}

export function parseTrace(stderr: string, initial: Record<string, string>, final: Record<string, string>): Trace {
  const assignments: Assignment[] = [];
  const values = new Map<string, string | undefined>(Object.entries(initial));
  const frames = new Map<string, Set<string>>(); // function call -> its local names

  // Lines without the marker (shell warnings, multi-line values) belong to the previous record.
  for (const record of stderr.split(/(?:^|\n)\x1f+/).slice(1)) {
    const fields = record.split(SEP);
    if (fields.length < 6) continue;
    const [file, line, fn, callerFile, callerLine] = fields as [string, string, string, string, string];
    if (!file) continue; // our own `env` command
    const cmd = fields.slice(5).join(SEP).replace(/\n$/, "");
    const via: Via | undefined = fn
      ? {
          kind: fn === "source" || fn === "." ? "source" : "function",
          name: fn,
          at: { file: callerFile, line: Number(callerLine) },
        }
      : undefined;
    const frame = via?.kind === "function" ? `${via.name}@${via.at.file}:${via.at.line}` : undefined;

    for (const step of parseCommand(cmd)) {
      let local = false;
      if (frame) {
        const names = frames.get(frame) ?? new Set();
        frames.set(frame, names);
        if (step.local) names.add(step.name);
        local = names.has(step.name);
      }
      if (step.bare) continue;
      const previous = local ? undefined : values.get(step.name);
      const result = step.op === "unset" ? undefined : step.op === "+=" ? (previous ?? "") + step.value : step.value;
      if (!local) values.set(step.name, result);
      const { name, op, value } = step;
      assignments.push({ name, op, value, previous, result, at: { file, line: Number(line) }, via, local });
    }
  }
  return { shell: "bash", initial, final, assignments };
}
