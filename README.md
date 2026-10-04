# rcenv

Find which startup file sets each environment variable, and audit your `PATH`.

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
| `rcenv completion bash\|zsh\|fish` | a shell completion script (commands, flags, live variable names) |

Options: `--json`, `--show-secrets` (values of `*_TOKEN`, `*_KEY`, … are masked by default), `--home DIR`.

`blame` also tells you when an assignment doesn't stick:

- **not effective**: a fresh shell ends with a different value, e.g. a one-command prefix like `SHELL=/bin/sh lesspipe`
- **not exported**: set as a shell variable only, so programs started from the shell don't see it
- **different in this shell**: the current shell's value differs from what a fresh login shell gets

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

bash only for now. Planned: zsh and fish, `rcenv set`/`unset` writing to a file rcenv owns or to a
`.env` file (the `.env` parser already preserves comments, order and quoting), and an interactive
editor (`rcenv edit`).

## Development

```sh
bun install
bun run dev -- blame PATH   # run from source
bun test                    # unit tests + real bash on test/fixtures/home + built CLI on node
bun run typecheck
bun run build               # dist/rcenv.js, plain JS for node >= 20
```

Source uses only `node:` APIs so the build runs on both Node and Bun.
