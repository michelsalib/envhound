# rcenv

Find which startup file sets each environment variable, audit your `PATH`, and change them safely.

```
$ rcenv blame PATH
(initial)                          +/usr/local/sbin  +/usr/local/bin  +/usr/sbin  +/usr/bin  +/sbin  +/bin
/etc/profile.d/apps-bin-path.sh:5  +/snap/bin
~/.profile:33 pathprepend()        +~/.tfenv/bin
~/.profile:35 pathprepend()        +~/.bun/bin
~/.profile:37 pathprepend()        +~/.local/bin

pathprepend() is defined in ~/.profile

✓ a fresh login shell ends with this value
```

## Commands

| Command | What it shows |
|---|---|
| `rcenv` / `rcenv list` | every exported variable, with the startup `file:line` that sets it |
| `rcenv blame VAR` | every startup `file:line` that assigns `VAR`, in order; for `PATH`, what each step added or removed |
| `rcenv path` | the current `PATH` one entry per line, who added each entry, missing directories and duplicates |
| `rcenv dotenv [FILE…]` | for each key of a `.env` file (default `./.env`): new, same as your shell, or in conflict (with the startup line behind the shell's value); plus syntax problems, duplicates and `$VAR` expansion. Exits 1 if there are problems |
| `rcenv set NAME=value…` | set variables for future login shells (see below) |
| `rcenv unset NAME…` | remove variables `rcenv set` added |
| `rcenv path add DIR [--append]` / `rcenv path remove DIR` | put a directory in `PATH` (front by default), or take it out |
| `rcenv completion bash\|zsh\|fish` | a shell completion script (commands, flags, live variable names) |

Options: `--json`, `--show-secrets` (values of `*_TOKEN`, `*_KEY`, … are masked by default), `--home DIR`,
and for changes `--file FILE`, `--yes`, `--dry-run`, `--append`.

`blame` also tells you when an assignment doesn't stick:

- **not effective**: a fresh shell ends with a different value, e.g. a one-command prefix like `SHELL=/bin/sh lesspipe`
- **not exported**: set as a shell variable only, so programs started from the shell don't see it
- **different in this shell**: the current shell's value differs from what a fresh login shell gets

## Changing variables

```
$ rcenv set EDITOR=vim
note: EDITOR is also set at ~/.bashrc:12; rcenv's line runs last, so it wins in login shells
note: ~/.bashrc runs again in every non-login shell and will set EDITOR back there; consider removing that line

~/.config/rcenv/env.sh
  # Hand edits are fine: rcenv keeps lines it does not recognise.
+ export EDITOR=vim

Write these changes? [y/N] y
wrote ~/.config/rcenv/env.sh
✓ a fresh login shell now gets EDITOR

This shell is unchanged. To apply it here too, run:
  export EDITOR=vim
```

- rcenv writes **its own file**, `~/.config/rcenv/env.sh` (mode 600), and never rewrites your startup
  files. The first time, it appends one line to your login file (`~/.bash_profile`, `~/.bash_login` or
  `~/.profile`, whichever bash reads) to load it. Being last, rcenv's values win.
- Every change is shown as a **diff** (secrets masked) and confirmed; `--yes` skips the question,
  `--dry-run` only shows it. Changed files are **backed up** to `~/.local/state/rcenv/backups/`.
- After writing, rcenv **re-traces** a fresh login shell to check the change took effect, and names the
  line that overrides it if not.
- With `--file .env`, `set` and `unset` edit a `.env` file instead, changing only that key's line and keeping
  comments, `export`, quote style and inline comments.
- A program can't change the shell that started it, so rcenv prints the commands to apply the change in
  the current shell.

## Shell completion

```sh
eval "$(rcenv completion bash)"                                # in ~/.bashrc
eval "$(rcenv completion zsh)"                                 # in ~/.zshrc, after compinit
rcenv completion fish > ~/.config/fish/completions/rcenv.fish
```

Completion is dynamic: on each <kbd>Tab</kbd> the script asks `rcenv` for candidates, so `rcenv blame <Tab>`
offers the variables of the shell you are typing in.

## How it works

rcenv starts `bash -lixc` with a clean environment and a custom `PS4`, so bash's own trace reports the
file, line and function of every command its startup files run. rcenv parses the assignments from that
trace and compares them with the environment the shell ends up with.

This runs your startup files once, as opening a terminal would. Startup files that `exec` another
program or wait for input stop the trace (rcenv gives up after 15 seconds).

Values labelled `(inherited)` come from whatever launched your shell (terminal, WSL, IDE), not from startup files.

## Status

bash only for now. Planned: an interactive editor (`rcenv edit`), then zsh and fish.

## Development

```sh
bun install
bun run dev -- blame PATH   # run from source
bun test                    # unit tests + real bash on test/fixtures/home + built CLI on node
bun run typecheck
bun run build               # dist/rcenv.js, plain JS for node >= 20
```

Source uses only `node:` APIs so the build runs on both Node and Bun.
