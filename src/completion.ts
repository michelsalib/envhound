// Shell completion. The scripts are thin: on every <Tab> they call
// `envhound __complete <words...>`, so candidates (like variable names) are always live.

export const COMMANDS: Record<string, string> = {
  list: "every exported variable and where it is set",
  blame: "every startup line that assigns a variable",
  path: "PATH entries, who added them, missing and duplicates",
  dotenv: "check .env files against your shell",
  set: "set variables for future login shells (or a .env file)",
  unset: "remove variables envhound set",
  edit: "interactive editor for variables, PATH and .env files",
  completion: "print a shell completion script",
  upgrade: "update envhound to the latest release",
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

export const SHELLS = ["bash", "zsh", "fish", "powershell"] as const;
export type CompletionShell = (typeof SHELLS)[number];

/** Flags that take a value: the next word is not a positional. */
const TAKES_VALUE = new Set(["--home", "--file", "-f"]);

const PATH_COMMANDS: Record<string, string> = { add: "put a directory in PATH", remove: "remove a directory envhound added" };

/**
 * Candidates for the last word of `words` (the words after `envhound`, the last one being typed),
 * as `name` or `name<TAB>description`.
 */
export function complete(words: string[], env: Record<string, string | undefined>, opts: { ignoreCase?: boolean } = {}): string[] {
  const norm = (s: string) => (opts.ignoreCase ? s.toUpperCase() : s);
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
  else if (positionals[0] === "set" && !cur.includes("=")) candidates = Object.keys(env).filter((n) => norm(n) !== "PATH").sort().map((n) => [`${n}=`]);
  else if (positionals[0] === "path" && positionals.length === 1) candidates = Object.entries(PATH_COMMANDS);
  else if (positionals.length === 1 && positionals[0] === "completion") candidates = SHELLS.map((s) => [s]);

  return candidates.filter(([name]) => norm(name).startsWith(norm(cur))).map(([name, desc]) => (desc ? `${name}\t${desc}` : name));
}

export function completionScript(shell: CompletionShell): string {
  switch (shell) {
    case "bash":
      return `# envhound completion for bash. Add to ~/.bashrc:  eval "$(envhound completion bash)"
_envhound() {
    local cur=\${COMP_WORDS[COMP_CWORD]}
    case \${COMP_WORDS[COMP_CWORD-1]} in
        --home) COMPREPLY=($(compgen -d -- "$cur")); return ;;
        --file|-f) COMPREPLY=($(compgen -f -- "$cur")); return ;;
    esac
    local IFS=$'\\n'
    COMPREPLY=($(envhound __complete "\${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null | cut -f1))
    [[ \${COMPREPLY[0]} == *= ]] && compopt -o nospace
}
complete -o default -F _envhound envhound
`;
    case "zsh":
      return `# envhound completion for zsh. Add to ~/.zshrc (after compinit):  eval "$(envhound completion zsh)"
_envhound() {
    case \${words[CURRENT-1]} in
        --home) _directories; return ;;
        --file|-f) _files; return ;;
    esac
    local -a lines candidates
    local line name
    lines=("\${(@f)$(envhound __complete "\${(@)words[2,CURRENT]}" 2>/dev/null)}")
    for line in $lines; do
        [[ -n $line ]] || continue
        name=\${\${line%%$'\\t'*}//:/\\\\:}
        if [[ $line == *$'\\t'* ]]; then candidates+=("$name:\${line#*$'\\t'}"); else candidates+=("$name"); fi
    done
    if (( \${#candidates} )); then _describe envhound candidates; else _files; fi
}
compdef _envhound envhound
`;
    case "fish":
      return `# envhound completion for fish. Save as ~/.config/fish/completions/envhound.fish:
#   envhound completion fish > ~/.config/fish/completions/envhound.fish
complete -c envhound -f -a '(envhound __complete (commandline -opc)[2..-1] (commandline -ct) 2>/dev/null)'
complete -c envhound -n '__fish_seen_subcommand_from dotenv' -F
complete -c envhound -l file -s f -r -F
complete -c envhound -l home -x -a '(__fish_complete_directories (commandline -ct))'
`;
    // Windows PowerShell drops empty arguments to programs, so the word being typed
    // goes first, behind a "_" that keeps it from being empty
    case "powershell":
      return `# envhound completion for PowerShell. Add to your profile (notepad $PROFILE):
#   envhound completion powershell | Out-String | Invoke-Expression
Register-ArgumentCompleter -Native -CommandName envhound -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)
    $before = @($commandAst.CommandElements | Select-Object -Skip 1 |
        Where-Object { $_.Extent.EndOffset -lt $cursorPosition } |
        ForEach-Object { $_.Extent.Text })
    if ($before.Count -and $before[-1] -in '--home', '--file', '-f') { return }
    envhound __complete-powershell "_$wordToComplete" @before 2>$null | ForEach-Object {
        $name, $desc = $_ -split "\`t", 2
        [System.Management.Automation.CompletionResult]::new($name, $name, 'ParameterValue', $(if ($desc) { $desc } else { $name }))
    }
}
`;
  }
}
