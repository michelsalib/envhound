<p align="center">
  <img src="assets/logo.svg" width="128" height="128" alt="envhound logo: a friendly hound peeking over a terminal window, paws on its edge, with a shell prompt inside">
</p>

<h1 align="center">envhound</h1>

<p align="center">Find which startup file (or, on Windows, which registry key) sets each environment variable, audit your <code>PATH</code>, and change them safely.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@michelsalib/envhound"><img src="https://img.shields.io/npm/v/@michelsalib/envhound?color=a8521a" alt="npm version"></a>
  <a href="https://github.com/michelsalib/envhound/actions/workflows/ci.yml"><img src="https://github.com/michelsalib/envhound/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/node/v/@michelsalib/envhound" alt="Node version">
  <img src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-blue" alt="Linux, macOS and Windows">
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/@michelsalib/envhound" alt="MIT license"></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/michelsalib/envhound"><img src="https://api.scorecard.dev/projects/github.com/michelsalib/envhound/badge" alt="OpenSSF Scorecard"></a>
  <a href="https://www.bestpractices.dev/projects/15395"><img src="https://www.bestpractices.dev/projects/15395/badge" alt="OpenSSF Best Practices: passing"></a>
</p>

<p align="center"><a href="https://micheldev.com/envhound"><b>micheldev.com/envhound</b></a></p>

Why is `~/.local/bin` in your `PATH` twice? Which of your dotfiles sets `EDITOR`, and why does a new terminal
not pick up the value you just changed? envhound answers those in one command, by replaying how your shell
starts (or, on Windows, how the registry is read) and pointing at the exact line or key behind every value.

<p align="center">
  <img src="docs/demo.gif" width="860" alt="envhound blame PATH credits each PATH entry to its startup line; envhound why python3 shows the pyenv shim wins over two other copies; envhound blame EDITOR shows ~/.zshrc overrides ~/.zshenv; envhound set EDITOR=code --dry-run warns that ~/.zshrc would still win and shows the diff; envhound edit stages a new variable and a PATH directory, then reviews the diff, writes it and checks a fresh shell gets both">
</p>
When you want to change something, it shows a diff, backs up, writes, and checks the result.

**Try it, nothing to install:**

```sh
npx @michelsalib/envhound blame PATH    # who put each directory in PATH
npx @michelsalib/envhound               # every variable, and where it is set
npx @michelsalib/envhound edit          # browse and change them in your terminal
```

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

envhound is a single JavaScript file that runs on Node ≥ 20 or Bun, on Linux, macOS and Windows. Without
either, the installers fetch a standalone binary instead, which needs nothing.
On Linux and macOS it reads the startup files of your login shell, **bash** or **zsh** (the default on
macOS); with another one, such as fish, it shows what a bash login shell gets and says so; see
[Status](#status).

```sh
npx @michelsalib/envhound blame PATH        # or: bunx @michelsalib/envhound blame PATH, nothing to install
npm install -g @michelsalib/envhound        # or: bun add -g @michelsalib/envhound
curl -fsSL https://github.com/michelsalib/envhound/releases/latest/download/install.sh | sh
```

Up to 0.6.1 the npm package was `envhound`; the command hasn't changed. To move an install of it:
`npm uninstall -g envhound && npm install -g @michelsalib/envhound`.

To pin a version, or to read the script before running it:

```sh
curl -fsSL https://github.com/michelsalib/envhound/releases/download/v0.7.1/install.sh -o install.sh
less install.sh && sh install.sh
gh attestation verify install.sh -R michelsalib/envhound   # optional: proves GitHub Actions built it
```

The binaries are release files too (`envhound-linux-x64`, `envhound-linux-arm64`, `envhound-darwin-x64`,
`envhound-darwin-arm64`, `envhound-windows-x64.exe`), listed in `SHA256SUMS` and attested like the rest;
`envhound upgrade` checks a new one against that file on GitHub and against the copy in the npm package.

On Windows, in PowerShell:

```powershell
irm https://github.com/michelsalib/envhound/releases/latest/download/install.ps1 | iex
```

With a package manager, which installs the standalone binary:

```sh
brew install michelsalib/envhound/envhound                    # Homebrew, macOS and Linux
scoop bucket add envhound https://github.com/michelsalib/scoop-envhound
scoop install envhound/envhound                               # Scoop, Windows
```

`install.sh` puts `envhound` in `~/.local/bin` (`ENVHOUND_INSTALL_DIR` to change it, `ENVHOUND_VERSION=0.7.1` to pin
a version), checks it against the release's `SHA256SUMS`, and runs it on Node, or on Bun when there is no
Node ≥ 20. With neither, or with `ENVHOUND_BINARY=1`, it installs the standalone binary for your system
(Linux and macOS, x64 and arm64; about 70 to 90 MB, as it carries the Bun runtime). It also installs bash completion where bash-completion loads it, and fish completion when fish
is installed; it never edits your startup files, so for zsh it prints the line to add.

`install.ps1` does the same on Windows: it puts `envhound.mjs` and an `envhound.cmd` launcher (or, without
Node or Bun, `envhound.exe`) in `%LOCALAPPDATA%\Programs\envhound` (same `ENVHOUND_INSTALL_DIR` and `ENVHOUND_VERSION`), checks it against
`SHA256SUMS`, and prints the line for PowerShell completion and, if needed, the `envhound path add` command
that puts it in your `Path`. It never edits your profile or your `Path` itself.

**Updates.** Once a week envhound asks the npm registry, in the background, whether a newer version exists,
and when there is one says so after a command, at most once a week, with the update command for how you
installed it: `envhound upgrade` for `install.sh` and `install.ps1`, `npm install -g @michelsalib/envhound@latest`, `npx @michelsalib/envhound@latest`, and so on.
It stays quiet in scripts, CI, with `--json` or `--home`, and with `ENVHOUND_NO_UPDATE_CHECK=1`.

`envhound upgrade` never runs anything it downloads. It fetches the latest `envhound.js` from the GitHub
release, checks it against the release's `SHA256SUMS`, and requires it to be byte for byte the file
published in the npm package of the same version (whose integrity npm vouches for), so a tampered
release would have to be tampered with on both GitHub and npm. Only then does it replace itself, in one
rename. Downloads are https only.

## Commands

| Command | What it shows |
|---|---|
| `envhound` / `envhound list` | every exported variable, with the startup `file:line` (on Windows, the registry key) that sets it |
| `envhound blame VAR` | every startup `file:line` (on Windows, registry key) that assigns `VAR`, in order; for `PATH`, what each step added or removed |
| `envhound doctor` | every problem with the environment a new shell gets, each with the startup line it comes from and how to fix it (a ready `envhound` command when envhound can do it): PATH entries that are missing, duplicated, relative or writable by anyone, version managers fighting over a language (nvm and volta, pyenv and conda…), variables programs read but never exported, lines with no effect, values set in several of your files, zsh exports only `~/.zshrc` makes, secrets in startup files other users can read. Exits 1 on errors |
| `envhound why COMMAND` | which file `COMMAND` runs (on Windows, with `PATHEXT`), the `PATH` entry and startup line that put it first, the files it hides, and whether a fresh login shell would run another one. Exits 1 when it is not found |
| `envhound path` | the current `PATH` one entry per line, who added each entry, missing directories and duplicates |
| `envhound dotenv [FILE…]` | for each key of a `.env` file (default `./.env`): its value (with `$VAR`, `${VAR}` and `${VAR:-default}` expanded from your shell, then from the lines above), and whether it is new, same as your shell, or in conflict (with the startup line behind the shell's value); plus syntax problems and duplicates, and warnings for expansion. Exits 1 on problems, not on warnings |
| `envhound set NAME=value…` | set variables for future login shells (see below) |
| `envhound unset NAME…` | remove variables `envhound set` added |
| `envhound path add DIR [--append]` / `envhound path remove DIR` | put a directory in `PATH` (front by default), or take it out |
| `envhound upgrade` | update an `install.sh` or `install.ps1` install; for others, prints the update command |
| `envhound edit [FILE…]` | interactive editor for variables, `PATH` and `.env` files (see below) |
| `envhound completion bash\|zsh\|fish\|powershell` | a shell completion script (commands, flags, live variable names) |

`envhound COMMAND --help` (or `envhound help COMMAND`) shows one command's usage, options and examples.

Options: `--json`, `--show-secrets` (values of `*_TOKEN`, `*_KEY`, `*_PAT`, … and passwords in URLs such as `postgres://user:********@host` are masked by default), `--home DIR`, `--shell bash|zsh`,
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
  files. The first time, it appends one line to your login file to load it: for bash `~/.bash_profile`,
  `~/.bash_login` or `~/.profile`, whichever bash reads; for zsh `~/.zprofile` (in `$ZDOTDIR` if you set
  one). Being last, envhound's values win, except over `~/.zshrc` and `~/.zlogin`, which zsh runs after
  `~/.zprofile`: envhound tells you when one of them sets the same variable.
- Every change is shown as a **diff** (secrets masked) and confirmed; `--yes` skips the question,
  `--dry-run` only shows it. Changed files are **backed up** to `~/.local/state/envhound/backups/` (the 50
  most recent are kept, since they may hold secrets).
- For a secret, `envhound set GH_TOKEN --stdin` reads the value from standard input, or lets you type it
  unseen, so it stays out of your shell history and the process list.
- After writing, envhound **re-traces** a fresh login shell to check the change took effect, and names the
  line that overrides it if not.
- With `--file .env`, `set` and `unset` edit a `.env` file instead, changing only that key's line and keeping
  comments, `export`, quote style and inline comments.
- A program can't change the shell that started it, so envhound prints the commands to apply the change in
  the current shell.

On Windows, `set`, `unset` and `path add/remove` change **your user variables** (`HKCU\Environment`, the
"User variables" of Windows' Environment Variables dialog), which need no administrator:

```
PS> envhound path add C:\Users\me\go\bin
HKCU\Environment
  OneDrive=C:\Users\me\OneDrive
  Path=
+     %USERPROFILE%\go\bin
      %USERPROFILE%\.local\bin

Write these changes? [y/N] y
wrote HKCU\Environment
backups in ~\AppData\Local\envhound\backups
✓ C:\Users\me\go\bin is now in PATH for new terminals

This terminal is unchanged. To apply it here too, run in PowerShell:
  $env:Path = 'C:\Users\me\go\bin;' + $env:Path
```

`unset` and `path remove` also remove the value from **the machine's variables** (`HKLM\…\Environment`, the
"System variables" of that dialog) when it is set there, so new terminals really lose it; in
`envhound edit`, `d` does the same on a machine row and `e` edits a machine variable's value. Those
changes apply to every user, so the diff is followed by Windows' administrator prompt (UAC) when the
terminal isn't already elevated; declining it writes nothing. The machine's key is backed up to a
`.reg` file first, like yours.

- The diff shows each `Path` entry on its own line. Directories under your profile are stored as
  `%USERPROFILE%\…`, and values with a `%VAR%` reference are stored so that Windows expands them.
- Before writing, envhound saves the key as a `.reg` file in `%LOCALAPPDATA%\envhound\backups`
  (double-click it to restore), then tells running programs that the environment changed, so new
  terminals get the new values.
- `set` and `path add` go to your own variables, which need no administrator. Your `Path` comes after
  the machine's, so `path add` puts a directory first among yours, not before the machine's.

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

The mouse works too: click a tab or a row, click the selected row again to edit it, and scroll with the
wheel. Hold <kbd>Shift</kbd> (<kbd>Option</kbd> in iTerm2) while dragging to select text; a plain drag reminds you.

`.env` files get a tab each: `./.env` when it exists, or the files you name (which then open first). Each key
shows its line, its value and how it compares with your shell (same, or the shell's value when they differ),
plus syntax problems and duplicates. Edits there go through the same diff and confirmation, but only change
that key's line, as `envhound set --file` does. One session can stage both: on <kbd>w</kbd>, shell variables go
to envhound's file and `.env` keys to their file.

On Windows, the editor shows where each variable comes from in the registry; yours and the machine's can
be changed, the machine's through Windows' administrator prompt when you write. <kbd>o</kbd> opens `.env` files in `$VISUAL`/`$EDITOR`,
or VS Code when it is installed, or Notepad.

## Shell completion

`install.sh` sets up bash and fish completion for you. Otherwise:

```sh
eval "$(envhound completion bash)"                                # in ~/.bashrc
eval "$(envhound completion zsh)"                                 # in ~/.zshrc, after compinit
envhound completion fish > ~/.config/fish/completions/envhound.fish
```

In PowerShell, save the script next to your profile, and load it from there:

```powershell
envhound completion powershell > "$(Split-Path $PROFILE)\envhound.ps1"
Add-Content $PROFILE '. "$PSScriptRoot\envhound.ps1"'
```

The second line runs once; after an upgrade, rerun the first. Loading a saved script doesn't start envhound
in every new shell, as the older `envhound completion powershell | Out-String | Invoke-Expression` line
did, which was slow on the first shell after a reboot: replace that line if your profile has it.

Completion is dynamic: on each <kbd>Tab</kbd> the script asks `envhound` for candidates, so `envhound blame <Tab>`
offers the variables of the shell you are typing in.

## How it works

envhound starts `bash -lixc` (or `zsh -lixc`) with a clean environment and a custom `PS4`, so the shell's
own trace reports the file, line and function of every command its startup files run. envhound parses the
assignments from that trace and compares them with the environment the shell ends up with. For zsh it also
replays what `path=(…)`, `path+=(…)` and `typeset -U path` do to `PATH`. `--shell bash|zsh` replays the
other shell than your `$SHELL`.

This runs your startup files once, as opening a terminal would. Startup files that `exec` another
program or wait for input stop the trace (envhound gives up after 15 seconds).

Values labelled `(inherited)` come from whatever launched your shell (terminal, WSL, IDE), not from startup files.

**On Windows**, there are no startup files: a new terminal gets its variables from the registry. envhound
reads the machine's variables (`HKLM\…\Environment`), the logon session's (`HKCU\Volatile Environment`) and
yours (`HKCU\Environment`) through PowerShell, and replays how Windows combines them: yours win, your `Path`
is appended to the machine's, and `%VAR%` references are expanded. Values labelled `(windows)` are set by
Windows itself (`SystemRoot`, `USERPROFILE`, …). Changes made by a PowerShell profile only show up as a
difference between this terminal and a new one.

## Status

- **Linux and macOS**: bash and zsh startup files. With another login shell, such as fish, envhound replays
  bash and warns you: `list`, `blame` and `path` show what a bash login shell gets, and `set`, `unset` and
  `path add|remove` write a file that only reaches your shell if its startup files load `~/.profile` (or
  `~/.bash_profile`).
- **Windows**: the registry, in PowerShell or cmd. In WSL, envhound reads bash startup files, as on Linux.

Planned: fish, PowerShell profiles, and a `.deb`.

## The pack

envhound has a sibling, built the same way: one small file for Node or Bun, or a standalone binary,
nothing to configure.

| Tool | What it finds | Try it |
|---|---|---|
| **envhound** | which startup file (or registry key) sets each environment variable, and your `PATH` | `npx @michelsalib/envhound` |
| **[nethound](https://github.com/michelsalib/nethound)** | which process or container listens on each port, who can reach it, and how everything on your machine connects | `npx @michelsalib/nethound` |

## Development

```sh
bun install
bun run dev -- blame PATH   # run from source
bun test                    # unit tests + real bash on test/fixtures/home + built CLI on node
                            # (on Windows: the registry, install.ps1 and PowerShell completion instead of bash)
bun run typecheck
bun run lint                # Biome: formatting and lint
bun run build               # dist/envhound.js, plain JS for node >= 20
```

Source uses only `node:` APIs so the build runs on both Node and Bun. See [CONTRIBUTING.md](CONTRIBUTING.md)
for pull requests and releases, and [SECURITY.md](SECURITY.md) to report a vulnerability or verify a release.

## Releasing

A pull request bumps `package.json` and the changelog; pushing a `vX.Y.Z` tag on the merged commit starts
[`.github/workflows/release.yml`](.github/workflows/release.yml): tests on Linux, macOS and Windows, a
read-only build, then, once approved in the `release` environment, signed build provenance for every file,
`npm publish` through trusted publishing, and a GitHub release with `envhound.js`, `install.sh`,
`install.ps1` and `SHA256SUMS`.
