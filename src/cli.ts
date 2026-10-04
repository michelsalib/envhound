#!/usr/bin/env node
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { blame, envRows, pathEntries } from "./analyze.ts";
import { completionScript, complete, SHELLS, type CompletionShell } from "./completion.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  blameJson,
  listJson,
  renderBlame,
  renderDotenv,
  renderList,
  renderPath,
  shown,
  type DotenvReport,
  type RenderOptions,
} from "./format.ts";
import { compareDotenv, dotenvProblems, parseDotenv } from "./dotenv.ts";
import { traceBash } from "./trace/bash.ts";

const HELP = `rcenv ${pkg.version}: find which startup file sets each environment variable

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
  rcenv completion SHELL
                      print a completion script for bash, zsh or fish, e.g.
                      eval "$(rcenv completion bash)" in ~/.bashrc

Options:
  --json              machine-readable output
  --show-secrets      don't mask values of variables like *_TOKEN or *_KEY
  --home DIR          trace startup files as if HOME were DIR
  -h, --help          show this help
  -v, --version       show the version

rcenv replays a bash login shell from a clean environment with tracing on,
so it only sees what startup files do. That runs your startup files once.
`;

function main(argv: string[]): number {
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
    home: values.home ?? process.env.HOME ?? "",
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
      const entries = pathEntries(traceBash({ home: values.home }), process.env.PATH ?? "");
      print(() => renderPath(entries, opts), () => entries);
      return 0;
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

function usage(message: string): number {
  console.error(`rcenv: ${message}\nRun 'rcenv --help' for usage.`);
  return 2;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error(`rcenv: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
}
