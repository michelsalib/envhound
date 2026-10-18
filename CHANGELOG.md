# Changelog

All notable changes to envhound. Versions follow [semantic versioning](https://semver.org).

## Unreleased

### Changed

- The npm package is now [`@michelsalib/envhound`](https://www.npmjs.com/package/@michelsalib/envhound),
  next to its sibling `@michelsalib/nethound`; the command is still `envhound`. An install of the
  `envhound` package updates to this release, then gets the command to switch with its next update
  notice: `npm uninstall -g envhound && npm install -g @michelsalib/envhound`.
- The pack's other tool, netbeagle, is now nethound (`npx @michelsalib/nethound`).

## 0.6.1 (2026-10-17)

### Fixed

- `envhound edit` takes the mouse on Windows too: 0.6.0 left it off there by mistake.

## 0.6.0 (2026-10-16)

### Added

- `envhound --help` and the README point to netbeagle, envhound's sibling: which process or
  container listens on each port, and who can reach it.
- `envhound edit` takes the mouse: click a tab or a row, click the selected row again to edit it,
  scroll with the wheel. Shift-drag still selects text. Not on Windows, where Node gets no mouse
  input from the console.

## 0.5.0 (2026-10-12)

### Added

- `envhound doctor`: every problem with the environment a new shell gets, each with the startup
  line it comes from and how to fix it, with the `envhound` command when envhound can do it. It
  checks PATH (missing, duplicated, relative or empty, world-writable entries; version managers
  fighting over a language; a shell older than its startup files) and variables (not exported,
  no effect, set in several of your files, zsh exports only `~/.zshrc` makes, secrets in startup
  files others can read). `--json`; exits 1 on errors.

### Changed

- `--help` is contextual: `envhound --help` lists the commands grouped by what they are for, and
  `envhound COMMAND --help` (or `envhound help COMMAND`, `envhound path add --help`) shows that
  command's usage, what it does, only the options it takes, and examples. A usage error points
  at the command's own help.

## 0.4.3 (2026-10-12)

### Changed

- A friendlier logo: the hound now peeks over a terminal window, paws on its edge, with the prompt
  inside. The banner of `envhound --version` and `--help` shows the same dog.
- Releases update the Homebrew tap and the Scoop bucket on their own: a pull request in each, merged
  once its install checks pass.

## 0.4.2 (2026-10-12)

### Added

- Each GitHub release also carries its signed build provenance as a file, `envhound.intoto.jsonl`,
  for tools that look at the release itself (OpenSSF Scorecard, slsa-verifier).
- CodeQL analyses the sources and workflows on every pull request, and envhound holds the OpenSSF
  Best Practices passing badge.

## 0.4.1 (2026-10-11)

### Fixed

- With zsh as login shell, `set`, `unset`, `path add|remove` and `edit` stopped (suspended by the
  terminal) as soon as they asked a question or opened the editor: the traced interactive zsh took
  the terminal over for job control. Startup files could also ask questions on the terminal while
  envhound traced them (zsh's compinit about insecure directories), and wait for an answer. The
  traced shell now runs in a session of its own, without the terminal.

### Changed

- The README shows a demo of `blame`, `why`, `set` and `edit`.
- The note when `~/.zshrc` or `~/.zlogin` sets a variable after envhound's line is shorter.
- After a change, the checks name directories under your home as `~/…`, and the command to apply a
  PATH change in the current shell uses `$HOME` (`export PATH="$HOME/bin:$PATH"`).

## 0.4.0 (2026-10-11)

### Added

- **zsh support.** When your login shell is zsh (the default on macOS), `list`, `blame`, `path` and
  `edit` replay zsh's startup files (`.zshenv`, `.zprofile`, `.zshrc`, `.zlogin`, and the ones in
  `/etc`), including what `path=(…)`, `path+=(…)`, `path[1,0]=(…)` and `typeset -U path` do to
  `PATH`. `set`, `unset` and `path add|remove` load envhound's file from `~/.zprofile` (or
  `$ZDOTDIR/.zprofile`), and say when `~/.zshrc` or `~/.zlogin` sets the same variable later.
- `--shell bash|zsh` replays that shell instead of your login shell.
- `envhound why COMMAND`: which file a command runs, from which `PATH` entry and the startup line
  that added it, which files of the same name it hides (and which are the same file through a
  symlink), and whether a fresh login shell would run another one. On Windows it tries each
  `PATHEXT` extension, as cmd does.
- Standalone binaries for Linux and macOS (x64, arm64) and Windows (x64), built with
  `bun build --compile`: no Node or Bun needed. `install.sh` and `install.ps1` install one when
  neither is there, or with `ENVHOUND_BINARY=1`; `envhound upgrade` updates it, checked against
  `SHA256SUMS` on GitHub and the copy now published in the npm package. They are attested like the
  other release files.
- `envhound upgrade` names the command for Homebrew, Scoop and winget installs.
- `scripts/packages.ts` writes the Homebrew formula, Scoop manifest and winget manifests of a
  release from its `SHA256SUMS`.

### Changed

- `set` no longer adds the loading line when envhound's file is already loaded, wherever from.

## 0.3.3 (2026-10-11)

### Fixed

- `envhound edit`: the PATH table cut directories at 60 characters even on a wide screen; the
  column now takes the room the screen has, and cuts a path only when it can't fit.
- `envhound edit` on Windows: the line under the table names the machine's registry key in full
  (`HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment`), not `HKLM\…\Environment`.

## 0.3.2 (2026-10-11)

### Fixed

- `envhound edit`: a long path or value was cut in the table and in the line below it, so it
  could not be read; the selected entry's detail now wraps onto up to four lines, and shows the
  variable's value too.

## 0.3.1 (2026-10-11)

0.3.0 was tagged but never published; everything it was to contain is here.

### Added

- Windows: the machine's variables (`HKLM`) can change too, through Windows' administrator prompt
  when the terminal isn't elevated. `unset` and `path remove` remove a value wherever it is set,
  yours and the machine's; in `envhound edit`, `d` removes a machine variable or Path entry and `e`
  edits a machine variable's value. `set` and `path add` still go to your own variables.

### Fixed

- macOS: the PATH a fresh shell ends with was reported as the system default (since 0.2.1), so
  `blame PATH` and the checks after `path add` were wrong.
- macOS: assignments in sourced files were missed when their paths were long, because macOS's
  bash 3.2 cuts its trace prefix at 99 bytes.
- macOS: bash completion offered nothing, because of how bash 3.2 expands an array slice.
- `envhound edit`: deleting a PATH entry that is a duplicate removed every copy of it; now only
  that copy goes and the first one stays.
- `.env` values holding the Unicode line or paragraph separator (U+2028, U+2029) were not read.

### Security

- `envhound upgrade` no longer runs a downloaded installer. It downloads `envhound.js` over https,
  checks it against the release's `SHA256SUMS`, requires it to be byte for byte the file in the npm
  package of the same version, and replaces itself with one rename.
- More secrets are masked: names ending in `_PAT`, `_PASS` or `_DSN`, containing `AUTH` as a word,
  `PASSPHRASE` or `COOKIE`, and the password in any URL (`postgres://user:********@host`), in
  every output including diffs and the "apply it here too" commands.
- `envhound set NAME --stdin` reads a value from standard input, or lets you type it unseen, so it
  stays out of shell history and the process list.
- Only the 50 most recent backups are kept, since they may hold secrets.
- `install.sh` runs nothing if its download is cut short, and both installers accept only https
  and a well-formed `ENVHOUND_VERSION`.
- Releases are published from an approved environment, with signed build provenance for every
  file (`gh attestation verify`) and npm trusted publishing. See [SECURITY.md](SECURITY.md).

## 0.2.1 (2026-10-10)

### Fixed

- Windows: `envhound set Path=…` replaced your whole user `Path`; `Path` is now refused like `PATH`.
- Windows: a value holding `%VAR%` is written as an expandable value, even where the stored one
  was a plain string, so `%USERPROFILE%\…` in `Path` works.
- Changed files are written to a temporary file and renamed into place, through symlinks and
  keeping their mode, so a full disk or a crash can't leave them half-written. Backups never
  overwrite each other.
- The "apply it here too" commands no longer print secret values.
- Windows: opening a file in your editor from `envhound edit` escapes paths for `cmd.exe`.
- A `'` in `TMPDIR` no longer breaks tracing.
- `install.ps1` no longer closes your PowerShell window when it fails under `irm | iex`.

### Changed

- With a login shell other than bash (zsh, the default on macOS), envhound says that it replays
  bash, and that its changes reach your shell only if your startup files load its file.

## 0.2.0 (2026-10-10)

### Added

- Native Windows support: variables from the registry, `install.ps1`, and PowerShell completion.

## 0.1.5 (2026-10-06)

### Added

- `$VAR` expansion in `.env` files, reported as a warning, and the file's values in
  `envhound dotenv`.

## 0.1.4 (2026-10-05)

### Changed

- Typing a masked secret in `envhound edit` shows each character for a moment.

## 0.1.0 – 0.1.3 (2026-10-04)

First releases: `list`, `blame`, `path`, `dotenv`, `set`, `unset`, `path add|remove`, the
`edit` terminal editor, shell completion, `install.sh` and the weekly update check.
