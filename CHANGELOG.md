# Changelog

All notable changes to envhound. Versions follow [semantic versioning](https://semver.org).

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
