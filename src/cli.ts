#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { blame, envRows, pathEntries } from "./analyze.ts";
import { completionScript, complete, SHELLS, type CompletionShell } from "./completion.ts";
import { compareDotenv, dotenvProblems, parseDotenv } from "./dotenv.ts";
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
import { locations } from "./managed.ts";
import { currentShellCommands, planDotenv, planShell, verify, type EditOp } from "./set.ts";
import { traceBash } from "./trace/bash.ts";

const HELP = `rcenv ${pkg.version}: find which startup file sets each environment variable, and change it

Usage:
  rcenv [list]        every exported variable, with the startup file:line that sets it
  rcenv blame VAR     every startup file:line that assigns VAR, in order
                      (for PATH: what each step added or removed)
  rcenv path          current PATH, one entry per line, with who added it,
                      flagging missing directories and duplicates
  rcenv dotenv [FILE...]
                      check .env files (default ./.env): keys that are new,
                      already set, or conflicting with your shell, and syntax
                      problems; exits 1 if there are problems

  rcenv set NAME=value...       set variables for future login shells
  rcenv unset NAME...           remove variables rcenv set
  rcenv path add DIR [--append] put DIR in PATH (at the front unless --append)
  rcenv path remove DIR         remove a directory rcenv added
                      These write ~/.config/rcenv/env.sh, loaded by one line
                      rcenv adds to your login file. With --file FILE, set and
                      unset edit a .env file instead. Every change is shown as
                      a diff and confirmed first; changed files are backed up.

  rcenv completion SHELL
                      print a completion script for bash, zsh or fish, e.g.
                      eval "$(rcenv completion bash)" in ~/.bashrc

Options:
  --json              machine-readable output (list, blame, path, dotenv)
  --show-secrets      don't mask values of variables like *_TOKEN or *_KEY
  --home DIR          act as if HOME were DIR
  -f, --file FILE     set/unset: edit this .env file instead of the shell
  -y, --yes           set/unset/path: write without asking
  --dry-run           set/unset/path: show the diff, write nothing
  --append            path add: put DIR at the end of PATH
  -h, --help          show this help
  -v, --version       show the version

rcenv replays a bash login shell from a clean environment with tracing on,
so it only sees what startup files do. That runs your startup files once.
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

const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DOTENV_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

async function main(argv: string[]): Promise<number> {
  // hidden, called by the completion scripts on every <Tab>; raw words, so no option parsing
  if (argv[0] === "__complete") {
    for (const c of complete(argv.slice(1), process.env)) console.log(c);
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
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    console.log(pkg.version);
    return 0;
  }

  const [command = "list", ...args] = positionals;
  const tty = process.stdout.isTTY;
  const opts: RenderOptions = {
    home: resolve(values.home ?? process.env.HOME ?? ""),
    color: tty && !process.env.NO_COLOR,
    width: tty ? process.stdout.columns : undefined,
    showSecrets: values["show-secrets"] ?? false,
  };
  const print = (render: () => string, data: () => unknown) =>
    console.log(values.json ? JSON.stringify(data(), null, 2) : render());

  switch (command) {
    case "list": {
      const rows = envRows(traceBash({ home: values.home }), process.env);
      print(() => renderList(rows, opts), () => listJson(rows, opts));
      return 0;
    }
    case "blame": {
      const name = args[0];
      if (!name) return usage("blame needs a variable name, e.g. rcenv blame PATH");
      const report = blame(traceBash({ home: values.home }), name, process.env);
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
      const entries = pathEntries(traceBash({ home: values.home }), process.env.PATH ?? "");
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
        if (name === "PATH" && !values.file) return usage("use 'rcenv path add DIR' to change PATH");
        ops.push(command === "set" ? { kind: "set", name, value: arg.slice(eq + 1) } : { kind: "unset", name });
      }
      return edit(ops, values, opts);
    }
    case "dotenv": {
      const files = args.length ? args : [".env"];
      // trace only when needed: it runs the startup files
      let trace: ReturnType<typeof traceBash> | undefined;
      const reports: DotenvReport[] = files.map((file) => {
        const path = resolve(file);
        const doc = parseDotenv(readFileSync(path, "utf8"));
        const keys = compareDotenv(doc, process.env);
        const conflicts = keys.filter((k) => k.status === "conflict");
        if (conflicts.length) trace ??= traceBash({ home: values.home });
        const shellOrigin = Object.fromEntries(conflicts.map((k) => [k.key, blame(trace!, k.key, process.env).assignments.at(-1)]));
        return { file: path, keys, problems: dotenvProblems(doc), shellOrigin };
      });
      const json = reports.map((r) => ({
        ...r,
        keys: r.keys.map((k) => ({ ...k, value: shown(k.key, k.value, opts), current: shown(k.key, k.current, opts) })),
      }));
      print(() => reports.map((r) => renderDotenv(r, opts)).join("\n\n"), () => json);
      return reports.some((r) => r.problems.length) ? 1 : 0;
    }
    case "completion": {
      const shell = args[0] as CompletionShell;
      if (!SHELLS.includes(shell)) return usage(`completion needs a shell: ${SHELLS.join(", ")}`);
      process.stdout.write(completionScript(shell));
      return 0;
    }
    default:
      return usage(`unknown command '${command}'`);
  }
}

/** Preview, confirm, write, then check the result in a fresh login shell. */
async function edit(ops: EditOp[], values: Values, opts: RenderOptions): Promise<number> {
  const c = paint(opts);
  const loc = locations(opts.home, process.env, values.home !== undefined);
  const plan = values.file ? planDotenv(ops, resolve(values.file), process.env) : planShell(ops, loc, traceBash({ home: values.home }));

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
      console.error("rcenv: not a terminal, so rcenv can't ask; pass --yes to write without asking");
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
  if (values.file) return 0;

  const checks = verify(ops, traceBash({ home: values.home }), loc);
  for (const check of checks) console.log(check.ok ? c.green(`✓ ${check.message}`) : c.yellow(`! ${check.message}`));
  const commands = currentShellCommands(ops);
  if (commands.length) console.log(c.dim("\nThis shell is unchanged. To apply it here too, run:\n") + commands.map((x) => `  ${x}`).join("\n"));
  return checks.every((x) => x.ok) ? 0 : 1;
}

function usage(message: string): number {
  console.error(`rcenv: ${message}\nRun 'rcenv --help' for usage.`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => (process.exitCode = code),
  (e) => {
    console.error(`rcenv: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  },
);
