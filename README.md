<p align="center">
  <img src="assets/logo.svg" width="128" height="128" alt="envhound logo: a hound with long ears, and a shell prompt">
</p>

<h1 align="center">envhound</h1>

<p align="center">Find which startup file sets each environment variable, audit your <code>PATH</code>, and change them safely.</p>

```
$ envhound blame PATH
(initial)                          +/usr/local/sbin  +/usr/local/bin  +/usr/sbin  +/usr/bin  +/sbin  +/bin
/etc/profile.d/apps-bin-path.sh:5  +/snap/bin
~/.profile:33 pathprepend()        +~/.tfenv/bin
~/.profile:35 pathprepend()        +~/.bun/bin
~/.profile:37 pathprepend()        +~/.local/bin

pathprepend() is defined in ~/.profile

✓ a fresh login shell ends with this value
```

## Install

envhound is a single JavaScript file that runs on Node ≥ 20 or Bun.

```sh
npx envhound blame PATH        # or: bunx envhound blame PATH, nothing to install
npm install -g envhound        # or: bun add -g envhound
curl -fsSL https://github.com/michelsalib/envhound/releases/latest/download/install.sh | sh
```

`install.sh` puts `envhound` in `~/.local/bin` (`ENVHOUND_INSTALL_DIR` to change it, `ENVHOUND_VERSION=0.2.0` to pin
a version), checks it against the release's `SHA256SUMS`, and runs it on Node, or on Bun when there is no
Node ≥ 20. It also installs bash completion where bash-completion loads it, and fish completion when fish
is installed; it never edits your startup files, so for zsh it prints the line to add.

**Updates.** Once a week envhound asks the npm registry, in the background, whether a newer version exists,
and when there is one says so after a command, at most once a week, with the update command for how you
installed it: `envhound upgrade` for `install.sh`, `npm install -g envhound@latest`, `npx envhound@latest`, and so on.
It stays quiet in scripts, CI, with `--json` or `--home`, and with `ENVHOUND_NO_UPDATE_CHECK=1`.

## Commands

| Command | What it shows |
|---|---|
| `envhound` / `envhound list` | every exported variable, with the startup `file:line` that sets it |
| `envhound blame VAR` | every startup `file:line` that assigns `VAR`, in order; for `PATH`, what each step added or removed |
| `envhound path` | the current `PATH` one entry per line, who added each entry, missing directories and duplicates |
| `envhound dotenv [FILE…]` | for each key of a `.env` file (default `./.env`): new, same as your shell, or in conflict (with the startup line behind the shell's value); plus syntax problems, duplicates and `$VAR` expansion. Exits 1 if there are problems |
| `envhound set NAME=value…` | set variables for future login shells (see below) |
| `envhound unset NAME…` | remove variables `envhound set` added |
| `envhound path add DIR [--append]` / `envhound path remove DIR` | put a directory in `PATH` (front by default), or take it out |
| `envhound upgrade` | update an `install.sh` install; for others, prints the update command |
| `envhound edit [FILE…]` | interactive editor for variables, `PATH` and `.env` files (see below) |
| `envhound completion bash\|zsh\|fish` | a shell completion script (commands, flags, live variable names) |

Options: `--json`, `--show-secrets` (values of `*_TOKEN`, `*_KEY`, … are masked by default), `--home DIR`,
and for changes `--file FILE`, `--yes`, `--dry-run`, `--append`.

`blame` also tells you when an assignment doesn't stick:

- **not effective**: a fresh shell ends with a different value, e.g. a one-command prefix like `SHELL=/bin/sh lesspipe`
- **not exported**: set as a shell variable only, so programs started from the shell don't see it
- **different in this shell**: the current shell's value differs from what a fresh login shell gets

## Changing variables

```
$ envhound set EDITOR=vim
note: EDITOR is also set at ~/.bashrc:12; envhound's line runs last, so it wins in login shells
note: ~/.bashrc runs again in every non-login shell and will set EDITOR back there; consider removing that line

~/.config/envhound/env.sh
  # Hand edits are fine: envhound keeps lines it does not recognise.
+ export EDITOR=vim

Write these changes? [y/N] y
wrote ~/.config/envhound/env.sh
✓ a fresh login shell now gets EDITOR

This shell is unchanged. To apply it here too, run:
  export EDITOR=vim
```

- envhound writes **its own file**, `~/.config/envhound/env.sh` (mode 600), and never rewrites your startup
  files. The first time, it appends one line to your login file (`~/.bash_profile`, `~/.bash_login` or
  `~/.profile`, whichever bash reads) to load it. Being last, envhound's values win.
- Every change is shown as a **diff** (secrets masked) and confirmed; `--yes` skips the question,
  `--dry-run` only shows it. Changed files are **backed up** to `~/.local/state/envhound/backups/`.
- After writing, envhound **re-traces** a fresh login shell to check the change took effect, and names the
  line that overrides it if not.
- With `--file .env`, `set` and `unset` edit a `.env` file instead, changing only that key's line and keeping
  comments, `export`, quote style and inline comments.
- A program can't change the shell that started it, so envhound prints the commands to apply the change in
  the current shell.

## Interactive editor

`envhound edit [FILE…]` opens a full-screen editor with tabs for **Variables**, **PATH** and each `.env` file:

```
envhound edit   1 Variables   2 PATH    2 staged · w to write
──────────────────────────────────────────────────────────────────────────────
  NAME            SET BY                    VALUE
* EDITOR          ~/.bash_profile:1         vim → code
  NVM_DIR         ~/.profile:23             ~/.nvm
+ MY_TOKEN        envhound                     ********
──────────────────────────────────────────────────────────────────────────────
EDITOR: set at ~/.bash_profile:1, staged: set
↑↓ move  / filter  enter edit  n new  d unset  o open  u undo  w write  tab PATH  ? help  q quit
```

Changes are staged, never written directly: <kbd>w</kbd> leaves the editor and goes through the same diff,
confirmation, backup and verification as `envhound set`. <kbd>o</kbd> opens `$VISUAL`/`$EDITOR` at the line that sets
the selected variable or adds the selected directory, then reloads. Lines in your own startup files are
yours to change there; envhound only writes its own file. <kbd>?</kbd> lists every key.

`.env` files get a tab each: `./.env` when it exists, or the files you name (which then open first). Each key
shows its line, its value and how it compares with your shell (same, or the shell's value when they differ),
plus syntax problems and duplicates. Edits there go through the same diff and confirmation, but only change
that key's line, as `envhound set --file` does. One session can stage both: on <kbd>w</kbd>, shell variables go
to envhound's file and `.env` keys to their file.

## Shell completion

`install.sh` sets up bash and fish completion for you. Otherwise:

```sh
eval "$(envhound completion bash)"                                # in ~/.bashrc
eval "$(envhound completion zsh)"                                 # in ~/.zshrc, after compinit
envhound completion fish > ~/.config/fish/completions/envhound.fish
```

Completion is dynamic: on each <kbd>Tab</kbd> the script asks `envhound` for candidates, so `envhound blame <Tab>`
offers the variables of the shell you are typing in.

## How it works

envhound starts `bash -lixc` with a clean environment and a custom `PS4`, so bash's own trace reports the
file, line and function of every command its startup files run. envhound parses the assignments from that
trace and compares them with the environment the shell ends up with.

This runs your startup files once, as opening a terminal would. Startup files that `exec` another
program or wait for input stop the trace (envhound gives up after 15 seconds).

Values labelled `(inherited)` come from whatever launched your shell (terminal, WSL, IDE), not from startup files.

## Status

bash only for now. Planned: zsh and fish, and a `.deb`.

## Development

```sh
bun install
bun run dev -- blame PATH   # run from source
bun test                    # unit tests + real bash on test/fixtures/home + built CLI on node
bun run typecheck
bun run build               # dist/envhound.js, plain JS for node >= 20
```

Source uses only `node:` APIs so the build runs on both Node and Bun.

## Releasing

```sh
npm version patch           # or minor/major: bumps package.json, commits, tags vX.Y.Z
git push --follow-tags
```

The tag starts [`.github/workflows/release.yml`](.github/workflows/release.yml): tests, then `npm publish`
with provenance, then a GitHub release with `envhound.js`, `install.sh` and `SHA256SUMS`. npm needs either
an `NPM_TOKEN` repository secret or trusted publishing configured for this workflow on npmjs.com.
