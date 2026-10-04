// The shell file rcenv owns (~/.config/rcenv/env.sh) and the hook that loads it.
// Lines rcenv does not recognise are kept verbatim, so hand edits survive.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { shellQuote } from "./quote.ts";
import { words } from "./shellwords.ts";

export interface Locations {
  home: string;
  /** ~/.config/rcenv/env.sh (or under $XDG_CONFIG_HOME) */
  managed: string;
  /** where backups of changed files go */
  backups: string;
  /** the weekly update check's state */
  updateState: string;
}

/** With an explicit home (--home, tests) XDG variables are ignored: they describe the real home. */
export function locations(home: string, env: Record<string, string | undefined>, explicitHome: boolean): Locations {
  const config = (!explicitHome && env.XDG_CONFIG_HOME) || join(home, ".config");
  const state = (!explicitHome && env.XDG_STATE_HOME) || join(home, ".local", "state");
  return { home, managed: join(config, "rcenv", "env.sh"), backups: join(state, "rcenv", "backups"), updateState: join(state, "rcenv", "update.json") };
}

export const HEADER = `# Managed by rcenv: environment variables for your login shell.
# Change them with \`rcenv set NAME=value\`, \`rcenv unset NAME\` and \`rcenv path add DIR\`.
# Hand edits are fine: rcenv keeps lines it does not recognise.
`;

// The hook resolves the file the same way locations() does.
const HOOK_PATH = '"${XDG_CONFIG_HOME:-$HOME/.config}/rcenv/env.sh"';
export const HOOK = `
# Added by rcenv: load variables managed with \`rcenv set\`
[ -f ${HOOK_PATH} ] && . ${HOOK_PATH}
`;

export const hasHook = (text: string) => text.includes("rcenv/env.sh");

/** The file bash reads for login shells: the first that exists, as bash does. */
export function loginFile(home: string): string {
  const candidates = [".bash_profile", ".bash_login", ".profile"].map((f) => join(home, f));
  return candidates.find((f) => existsSync(f)) ?? join(home, ".profile");
}

export interface ManagedLine {
  raw: string;
  kind: "var" | "path" | "other";
  name?: string;
  value?: string;
  dir?: string;
  position?: "front" | "back";
}

const VAR_LINE = /^export ([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
// case ":$PATH:" in *":DIR:"*) ;; *) export PATH="DIR:$PATH" ;; esac
const PATH_LINE = /^case ":\$PATH:" in \*":(.*):"\*\) ;; \*\) export PATH="(?:\$PATH:(.*)|(.*):\$PATH)" ;; esac$/;

/** DIR inside double quotes, written relative to $HOME when it can be. */
function dqDir(dir: string, home: string): string {
  const esc = (s: string) => s.replace(/[\\"$`]/g, "\\$&");
  return dir === home || dir.startsWith(home + "/") ? "$HOME" + esc(dir.slice(home.length)) : esc(dir);
}

function undqDir(s: string, home: string): string {
  return s.replace(/^\$HOME(?=\/|$)/, home).replace(/\\([\\"$`])/g, "$1");
}

export function pathLine(dir: string, position: "front" | "back", home: string): string {
  const d = dqDir(dir, home);
  const value = position === "front" ? `${d}:$PATH` : `$PATH:${d}`;
  // guarded, so nested login shells (tmux, ssh localhost) don't add it twice
  return `case ":$PATH:" in *":${d}:"*) ;; *) export PATH="${value}" ;; esac`;
}

export function parseManaged(text: string, home: string): ManagedLine[] {
  const raws = text === "" ? [] : text.split("\n");
  if (text.endsWith("\n")) raws.pop();
  return raws.map((raw) => {
    const v = VAR_LINE.exec(raw);
    if (v) return { raw, kind: "var", name: v[1]!, value: words(v[2]!)[0] ?? "" };
    const p = PATH_LINE.exec(raw);
    if (p && p[1] === (p[2] ?? p[3]))
      return { raw, kind: "path", dir: undqDir(p[1]!, home), position: p[2] !== undefined ? "back" : "front" };
    return { raw, kind: "other" };
  });
}

export const serializeManaged = (lines: ManagedLine[]) => lines.map((l) => l.raw).join("\n") + "\n";

/** Set NAME in place (dropping any repeats), or append it. */
export function setVar(lines: ManagedLine[], name: string, value: string): ManagedLine[] {
  const line: ManagedLine = { raw: `export ${name}=${shellQuote(value)}`, kind: "var", name, value };
  const i = lines.findIndex((l) => l.kind === "var" && l.name === name);
  if (i < 0) return [...lines, line];
  return lines.flatMap((l, j) => (j === i ? [line] : l.kind === "var" && l.name === name ? [] : [l]));
}

export function unsetVar(lines: ManagedLine[], name: string): ManagedLine[] {
  return lines.filter((l) => !(l.kind === "var" && l.name === name));
}

/** Add DIR to PATH, replacing an earlier entry for the same DIR. */
export function addPath(lines: ManagedLine[], dir: string, position: "front" | "back", home: string): ManagedLine[] {
  if (lines.some((l) => l.kind === "path" && l.dir === dir && l.position === position)) return lines;
  const line: ManagedLine = { raw: pathLine(dir, position, home), kind: "path", dir, position };
  return [...removePath(lines, dir), line];
}

export function removePath(lines: ManagedLine[], dir: string): ManagedLine[] {
  return lines.filter((l) => !(l.kind === "path" && l.dir === dir));
}
