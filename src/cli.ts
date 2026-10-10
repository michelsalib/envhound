#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { blame, envRows, pathEntries } from "./analyze.ts";
import { completionScript, complete, SHELLS, type CompletionShell } from "./completion.ts";
import { compareDotenv, dotenvProblems, errorCount, parseDotenv } from "./dotenv.ts";
import { applyChanges, confirm, renderChange } from "./edit.ts";
import {
  blameJson,
  listJson,
  paint,
  renderBlame,
  renderDotenv,
  renderList,
  renderPath,
  shown,
  tilde,
  type DotenvReport,
  type RenderOptions,
} from "./format.ts";
import { banner } from "./logo.ts";
import { locations } from "./managed.ts";
import type { Trace } from "./model.ts";
import { currentShellCommands, planDotenv, planShell, verify, type EditOp } from "./set.ts";
import { traceBash } from "./trace/bash.ts";
import { readRegistry, traceWindows, windowsTrace } from "./trace/windows.ts";
import { planWindows, powershellCommands, verifyWindows } from "./set-windows.ts";
import { loadData } from "./tui/load.ts";
import { runEditor } from "./tui/terminal.ts";
import { fetchLatest, installKind, installerUrl, upgradeCommand, updateNotice } from "./update.ts";

const TAGLINE = "find which startup file sets each environment variable, and change it";

const HELP = `Usage:
  envhound [list]        every exported variable, with the startup file:line that sets it
  envhound blame VAR     every startup file:line that assigns VAR, in order
                         (for PATH: what each step added or removed)
  envhound path          current PATH, one entry per line, with who added it,
                         flagging missing directories and duplicates
  envhound dotenv [FILE...]
                         check .env files (default ./.env): keys that are new,
                         already set, or conflicting with your shell, and syntax
                         problems; exits 1 if there are problems

  envhound set NAME=value...       set variables for future login shells
  envhound unset NAME...           remove variables envhound set
  envhound path add DIR [--append] put DIR in PATH (at the front unless --append)
  envhound path remove DIR         remove a directory envhound added
                         These write ~/.config/envhound/env.sh, loaded by one line
                         envhound adds to your login file; on Windows, your user
                         variables (HKCU\\Environment). With --file FILE, set and
                         unset edit a .env file instead. Every change is shown as
                         a diff and confirmed first; changed files are backed up.

  envhound edit [FILE...]
                         interactive editor for variables, PATH and .env files
                         (./.env is included when it exists): stage changes,
                         then review them as a diff and write

  envhound completion SHELL
                         print a completion script for bash, zsh, fish or
                         powershell, e.g. eval "$(envhound completion bash)" in
                         ~/.bashrc, or in your PowerShell $PROFILE:
                         envhound completion powershell | Out-String | Invoke-Expression
  envhound upgrade       update envhound (installed with install.sh; otherwise
                         shows the command for npm, bun, npx or bunx)

Options:
  --json              machine-readable output (list, blame, path, dotenv)
  --show-secrets      don't mask values of variables like *_TOKEN or *_KEY
  --home DIR          act as if HOME were DIR (on Windows: only for backups)
  -f, --file FILE     set/unset: edit this .env file instead of the shell
  -y, --yes           set/unset/path: write without asking
  --dry-run           set/unset/path: show the diff, write nothing
  --append            path add: put DIR at the end of PATH
  -h, --help          show this help
  -v, --version       show the version

envhound replays a bash login shell from a clean environment with tracing on,
so it only sees what startup files do. That runs your startup files once.
On Windows, envhound reads the registry instead: the machine's and your
variables, as a new terminal gets them.

Once a week envhound asks npm in the background whether a newer version exists,
and says so after a command. ENVHOUND_NO_UPDATE_CHECK=1 turns this off.
`;

type Values = {
  json?: boolean;
  "show-secrets"?: boolean;
  home?: string;
  file?: string;
  yes?: boolean;
  "dry-run"?: boolean;
  append?: boolean;
};

/** Printed to stderr when the command ends; see update.ts. */
let notice: string | undefined;

/** On Windows, variables come from the registry instead of bash startup files. */
const WINDOWS = process.platform === "win32";

const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DOTENV_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

async function main(argv: string[]): Promise<number> {
  // hidden, called by the completion scripts on every <Tab>; raw words, so no option parsing
  if (argv[0] === "__complete") {
    for (const c of complete(argv.slice(1), process.env, { ignoreCase: WINDOWS })) console.log(c);
    return 0;
  }
  // the PowerShell script's form: "_" + the word being typed, then the words before it
  if (argv[0] === "__complete-powershell") {
    for (const c of complete([...argv.slice(2), (argv[1] ?? "_").slice(1)], process.env, { ignoreCase: WINDOWS })) console.log(c);
    return 0;
  }
  // hidden, started in the background by updateNotice
  if (argv[0] === "__update-check") {
    await fetchLatest(argv[1]!);
    return 0;
  }
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      "show-secrets": { type: "boolean" },
      home: { type: "string" },
      file: { type: "string", short: "f" },
      yes: { type: "boolean", short: "y" },
      "dry-run": { type: "boolean" },
      append: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  // the logo only for a person at a terminal; scripts get the plain text, e.g. $(envhound --version)
  const art = process.stdout.isTTY;
  const logo = () =>
    banner([`envhound ${pkg.version}`, "", "find which startup file", "sets each environment", "variable, and change it"], {
      color: !process.env.NO_COLOR,
      truecolor: /^(truecolor|24bit)$/i.test(process.env.COLORTERM ?? ""),
      columns: process.stdout.columns,
    });
  if (values.help) {
    process.stdout.write(art ? `${logo()}\n${HELP}` : `envhound ${pkg.version}: ${TAGLINE}\n\n${HELP}`);
    return 0;
  }
  if (values.version) {
    process.stdout.write(art ? logo() : `${pkg.version}\n`);
    return 0;
  }

  const [command = "list", ...args] = positionals;
  const trace = () => (WINDOWS ? traceWindows() : traceBash({ home: values.home }));
  // only for a person at a terminal using their real home; never in scripts, CI or tests
  const env = process.env;
  if (
    process.stderr.isTTY &&
    values.home === undefined &&
    !values.json &&
    !env.CI &&
    !env.ENVHOUND_NO_UPDATE_CHECK &&
    !env.NO_UPDATE_NOTIFIER &&
    !["completion", "upgrade"].includes(command)
  )
    notice = updateNotice(pkg.version, process.argv[1]!, locations(homedir(), env, false).updateState);
  const tty = process.stdout.isTTY;
  const opts: RenderOptions = {
    home: resolve(values.home ?? homedir()),
    color: tty && !process.env.NO_COLOR,
    width: tty ? process.stdout.columns : undefined,
    showSecrets: values["show-secrets"] ?? false,
    shell: WINDOWS ? "windows" : "bash",
  };
  const print = (render: () => string, data: () => unknown) =>
    console.log(values.json ? JSON.stringify(data(), null, 2) : render());

  switch (command) {
    case "list": {
      const rows = envRows(trace(), process.env);
      print(() => renderList(rows, opts), () => listJson(rows, opts));
      return 0;
    }
    case "blame": {
      const name = args[0];
      if (!name) return usage("blame needs a variable name, e.g. envhound blame PATH");
      const report = blame(trace(), name, process.env);
      print(() => renderBlame(report, opts), () => blameJson(report, opts));
      return 0;
    }
    case "path": {
      const [sub, ...dirs] = args;
      if (sub === "add" || sub === "remove") {
        if (!dirs.length) return usage(`path ${sub} needs a directory`);
        const ops: EditOp[] = dirs.map((d) =>
          sub === "add"
            ? { kind: "path-add", dir: resolve(d), position: values.append ? "back" : "front" }
            : { kind: "path-remove", dir: resolve(d) },
        );
        if (values.file) return usage("--file only applies to set and unset");
        return edit(ops, values, opts);
      }
      if (sub !== undefined) return usage(`unknown path command '${sub}' (add, remove)`);
      const entries = pathEntries(trace(), process.env.PATH ?? "");
      print(() => renderPath(entries, opts), () => entries);
      return 0;
    }
    case "set":
    case "unset": {
      if (!args.length) return usage(command === "set" ? "set needs NAME=value" : "unset needs a NAME");
      const valid = values.file ? DOTENV_NAME : SHELL_NAME;
      const ops: EditOp[] = [];
      for (const arg of args) {
        const eq = arg.indexOf("=");
        const name = command === "set" ? arg.slice(0, eq) : arg;
        if (command === "set" && eq < 0) return usage(`expected NAME=value, got '${arg}'`);
        if (!valid.test(name)) return usage(`'${name}' is not a valid variable name`);
        if (name === "PATH" && !values.file) return usage("use 'envhound path add DIR' to change PATH");
        const file = values.file && resolve(values.file);
        ops.push(command === "set" ? { kind: "set", name, value: arg.slice(eq + 1), file } : { kind: "unset", name, file });
      }
      return edit(ops, values, opts);
    }
    case "edit": {
      if (!process.stdin.isTTY || !process.stdout.isTTY) return usage("edit needs a terminal");
      const loc = locations(opts.home, process.env, values.home !== undefined);
      // files given on the command line (or --file) open first; otherwise ./.env if there is one
      const named = [...args, ...(values.file ? [values.file] : [])].map((f) => resolve(f));
      const files = named.length ? [...new Set(named)] : existsSync(".env") ? [resolve(".env")] : [];
      process.stderr.write(WINDOWS ? "reading the registry…\r" : "tracing startup files…\r");
      const load = () => loadData(trace(), process.env, loc, files);
      const ops = await runEditor(load, { ...opts, tab: named.length ? 2 : 0 });
      process.stderr.write("\x1b[K");
      if (!ops?.length) return 0;
      return edit(ops, values, opts);
    }
    case "dotenv": {
      const files = args.length ? args : [".env"];
      // trace only when needed: it runs the startup files
      let shellTrace: Trace | undefined;
      const reports: DotenvReport[] = files.map((file) => {
        const path = resolve(file);
        const doc = parseDotenv(readFileSync(path, "utf8"));
        const keys = compareDotenv(doc, process.env);
        const conflicts = keys.filter((k) => k.status === "conflict");
        if (conflicts.length) shellTrace ??= trace();
        const shellOrigin = Object.fromEntries(conflicts.map((k) => [k.key, blame(shellTrace!, k.key, process.env).assignments.at(-1)]));
        return { file: path, keys, problems: dotenvProblems(doc, process.env), shellOrigin };
      });
      const json = reports.map((r) => ({
        ...r,
        keys: r.keys.map((k) => ({ ...k, value: shown(k.key, k.value, opts), expanded: shown(k.key, k.expanded, opts), template: shown(k.key, k.template, opts), current: shown(k.key, k.current, opts) })),
      }));
      print(() => reports.map((r) => renderDotenv(r, opts)).join("\n\n"), () => json);
      return reports.some((r) => errorCount(r.problems)) ? 1 : 0;
    }
    case "completion": {
      const shell = args[0] as CompletionShell;
      if (!SHELLS.includes(shell)) return usage(`completion needs a shell: ${SHELLS.join(", ")}`);
      process.stdout.write(completionScript(shell));
      return 0;
    }
    case "upgrade":
      return upgrade();
    default:
      return usage(`unknown command '${command}'`);
  }
}

/** Preview, confirm, write, then check the result in a fresh login shell. */
async function edit(ops: EditOp[], values: Values, opts: RenderOptions): Promise<number> {
  const c = paint(opts);
  const loc = locations(opts.home, process.env, values.home !== undefined);
  // shell changes go to envhound's file (on Windows, the user's variables); the others to their .env file
  const shellOps = ops.filter((op) => !("file" in op && op.file));
  const files = [...new Set(ops.flatMap((op) => ("file" in op && op.file ? [op.file] : [])))];
  const planShellOps = () => {
    if (!WINDOWS) return planShell(shellOps, loc, traceBash({ home: values.home }));
    const reg = readRegistry();
    return planWindows(shellOps, reg.user, windowsTrace(reg, process.env));
  };
  const plans = [
    ...(shellOps.length ? [planShellOps()] : []),
    ...files.map((f) => planDotenv(ops.filter((op) => "file" in op && op.file === f), f, process.env)),
  ];
  const plan = { changes: plans.flatMap((p) => p.changes), notes: plans.flatMap((p) => p.notes) };

  for (const note of plan.notes) console.log(c.yellow(`note: ${note}`));
  if (!plan.changes.length) {
    console.log("Nothing to change.");
    return 0;
  }
  if (plan.notes.length) console.log();
  console.log(plan.changes.map((ch) => renderChange(ch, opts)).join("\n\n") + "\n");
  if (values["dry-run"]) return 0;
  if (!values.yes) {
    if (!process.stdin.isTTY) {
      console.error("envhound: not a terminal, so envhound can't ask; pass --yes to write without asking");
      return 1;
    }
    if (!(await confirm("Write these changes? [y/N] "))) {
      console.log("Nothing written.");
      return 1;
    }
  }

  const backups = applyChanges(plan.changes, loc.backups);
  for (const ch of plan.changes) console.log(`wrote ${tilde(ch.path, opts.home)}`);
  if (backups.length) console.log(c.dim(`backups in ${tilde(loc.backups, opts.home)}`));
  if (!shellOps.length) return 0;

  const checks = WINDOWS ? verifyWindows(shellOps, traceWindows()) : verify(shellOps, traceBash({ home: values.home }), loc);
  for (const check of checks) console.log(check.ok ? c.green(`✓ ${check.message}`) : c.yellow(`! ${check.message}`));
  const commands = WINDOWS ? powershellCommands(shellOps) : currentShellCommands(shellOps);
  const how = WINDOWS ? "This terminal is unchanged. To apply it here too, run in PowerShell:" : "This shell is unchanged. To apply it here too, run:";
  if (commands.length) console.log(c.dim(`\n${how}\n`) + commands.map((x) => `  ${x}`).join("\n"));
  return checks.every((x) => x.ok) ? 0 : 1;
}

/** Re-runs install.sh (install.ps1 on Windows) into the same directory; other installs get their own command. */
async function upgrade(): Promise<number> {
  const script = realpathSync(process.argv[1]!);
  const kind = installKind(script);
  if (kind !== "standalone") {
    console.log(`This envhound was not installed with ${WINDOWS ? "install.ps1" : "install.sh"}. Update it with:\n  ${upgradeCommand(kind)}`);
    return 0;
  }
  const url = installerUrl(process.env, WINDOWS);
  let installer: string;
  try {
    if (url.startsWith("file:")) installer = readFileSync(fileURLToPath(url), "utf8");
    else {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      installer = await res.text();
    }
  } catch (e) {
    console.error(`envhound: could not download ${url}: ${e instanceof Error ? e.message : e}`);
    return 1;
  }
  const env = { ...process.env, ENVHOUND_INSTALL_DIR: dirname(script) };
  if (!WINDOWS) return spawnSync("sh", ["-s"], { input: installer, stdio: ["pipe", "inherit", "inherit"], env }).status ?? 1;
  // PowerShell runs a script file, so the installer goes to a temporary one
  const dir = mkdtempSync(join(tmpdir(), "envhound-"));
  try {
    writeFileSync(join(dir, "install.ps1"), installer);
    const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(dir, "install.ps1")];
    return spawnSync("powershell.exe", args, { stdio: "inherit", env }).status ?? 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function usage(message: string): number {
  console.error(`envhound: ${message}\nRun 'envhound --help' for usage.`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
    if (notice) process.stderr.write(`\n${notice}\n`);
  },
  (e) => {
    console.error(`envhound: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  },
);
