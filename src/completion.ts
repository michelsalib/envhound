// Shell completion. The scripts are thin: on every <Tab> they call
// `rcenv __complete <words...>`, so candidates (like variable names) are always live.

export const COMMANDS: Record<string, string> = {
  list: "every exported variable and where it is set",
  blame: "every startup line that assigns a variable",
  path: "PATH entries, who added them, missing and duplicates",
  dotenv: "check .env files against your shell",
  set: "set variables for future login shells (or a .env file)",
  unset: "remove variables rcenv set",
  edit: "interactive editor for variables, PATH and .env files",
  completion: "print a shell completion script",
  upgrade: "update rcenv to the latest release",
};

const FLAGS: Record<string, string> = {
  "--json": "machine-readable output",
  "--show-secrets": "don't mask secret values",
  "--home": "act as if HOME were DIR",
  "--file": "set/unset: edit this .env file",
  "--yes": "write without asking",
  "--dry-run": "show the diff, write nothing",
  "--append": "path add: put DIR at the end",
  "--help": "show help",
  "--version": "show the version",
};

export const SHELLS = ["bash", "zsh", "fish"] as const;
export type CompletionShell = (typeof SHELLS)[number];

/** Flags that take a value: the next word is not a positional. */
const TAKES_VALUE = new Set(["--home", "--file", "-f"]);

const PATH_COMMANDS: Record<string, string> = { add: "put a directory in PATH", remove: "remove a directory rcenv added" };

/**
 * Candidates for the last word of `words` (the words after `rcenv`, the last one being typed),
 * as `name` or `name<TAB>description`.
 */
export function complete(words: string[], env: Record<string, string | undefined>): string[] {
  const cur = words.at(-1) ?? "";
  const before = words.slice(0, -1);
  if (TAKES_VALUE.has(before.at(-1) ?? "")) return []; // the shell script completes paths
  const positionals = before.filter((w, i) => !w.startsWith("-") && !TAKES_VALUE.has(before[i - 1] ?? ""));

  let candidates: [string, string?][] = [];
  if (cur.startsWith("-")) candidates = Object.entries(FLAGS);
  else if (positionals.length === 0) candidates = Object.entries(COMMANDS);
  else if (positionals[0] === "blame" && positionals.length === 1) candidates = Object.keys(env).sort().map((n) => [n]);
  else if (positionals[0] === "unset") candidates = Object.keys(env).sort().map((n) => [n]);
  // `NAME=` so the user only types the value
  else if (positionals[0] === "set" && !cur.includes("=")) candidates = Object.keys(env).filter((n) => n !== "PATH").sort().map((n) => [`${n}=`]);
  else if (positionals[0] === "path" && positionals.length === 1) candidates = Object.entries(PATH_COMMANDS);
  else if (positionals.length === 1 && positionals[0] === "completion") candidates = SHELLS.map((s) => [s]);

  return candidates.filter(([name]) => name.startsWith(cur)).map(([name, desc]) => (desc ? `${name}\t${desc}` : name));
}

export function completionScript(shell: CompletionShell): string {
  switch (shell) {
    case "bash":
      return `# rcenv completion for bash. Add to ~/.bashrc:  eval "$(rcenv completion bash)"
_rcenv() {
    local cur=\${COMP_WORDS[COMP_CWORD]}
    case \${COMP_WORDS[COMP_CWORD-1]} in
        --home) COMPREPLY=($(compgen -d -- "$cur")); return ;;
        --file|-f) COMPREPLY=($(compgen -f -- "$cur")); return ;;
    esac
    local IFS=$'\\n'
    COMPREPLY=($(rcenv __complete "\${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null | cut -f1))
    [[ \${COMPREPLY[0]} == *= ]] && compopt -o nospace
}
complete -o default -F _rcenv rcenv
`;
    case "zsh":
      return `# rcenv completion for zsh. Add to ~/.zshrc (after compinit):  eval "$(rcenv completion zsh)"
_rcenv() {
    case \${words[CURRENT-1]} in
        --home) _directories; return ;;
        --file|-f) _files; return ;;
    esac
    local -a lines candidates
    local line name
    lines=("\${(@f)$(rcenv __complete "\${(@)words[2,CURRENT]}" 2>/dev/null)}")
    for line in $lines; do
        [[ -n $line ]] || continue
        name=\${\${line%%$'\\t'*}//:/\\\\:}
        if [[ $line == *$'\\t'* ]]; then candidates+=("$name:\${line#*$'\\t'}"); else candidates+=("$name"); fi
    done
    if (( \${#candidates} )); then _describe rcenv candidates; else _files; fi
}
compdef _rcenv rcenv
`;
    case "fish":
      return `# rcenv completion for fish. Save as ~/.config/fish/completions/rcenv.fish:
#   rcenv completion fish > ~/.config/fish/completions/rcenv.fish
complete -c rcenv -f -a '(rcenv __complete (commandline -opc)[2..-1] (commandline -ct) 2>/dev/null)'
complete -c rcenv -n '__fish_seen_subcommand_from dotenv' -F
complete -c rcenv -l file -s f -r -F
complete -c rcenv -l home -x -a '(__fish_complete_directories (commandline -ct))'
`;
  }
}
