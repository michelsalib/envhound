# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately, through GitHub:
**[Report a vulnerability](https://github.com/michelsalib/envhound/security/advisories/new)**.
Don't open a public issue for them.

You'll get an answer within a week. Once a fix is released, the advisory is published with credit
to you, unless you'd rather not be named.

Only the latest release gets security fixes.

## What envhound does with your machine

These are worth knowing when you judge what counts as a vulnerability:

- **It runs your startup files.** `envhound list`, `blame`, `why` and `path` start your login shell
  (`bash -lixc` or `zsh -lixc`) with a clean environment, so your `~/.bash_profile`, `~/.bashrc`,
  `~/.zprofile`, `~/.zshrc` and what they source run once, as when you open a terminal. That shell
  runs without access to your terminal.
- **It writes only after you confirm** (or pass `--yes`). Shell changes go to its own file,
  `~/.config/envhound/env.sh` (mode 600), plus one line that loads it in your login file; `.env`
  files only with `--file` or `edit`. Every changed file is backed up first. On Windows it writes
  only your own variables, `HKCU\Environment`.
- **Secret values are masked** in every output (names like `*_TOKEN`, `*_KEY`, `*_PAT`, and
  passwords in URLs) unless you pass `--show-secrets`.
- **Network:** once a week a background process asks the npm registry for the latest version
  (`ENVHOUND_NO_UPDATE_CHECK=1` turns it off), and `envhound upgrade` downloads the new release.

## Verifying a release

Every release is built by GitHub Actions from the tagged commit, and its files carry signed build
provenance, also attached to the release as `envhound.intoto.jsonl`:

```sh
# the GitHub release files: envhound.js, the installers and the standalone binaries
gh attestation verify envhound.js -R michelsalib/envhound
sha256sum --check --ignore-missing SHA256SUMS
# the npm package
npm audit signatures
```

The build is reproducible: `git checkout vX.Y.Z && bun install --frozen-lockfile && bun run build`
gives the same `dist/envhound.js` as the release's `SHA256SUMS` (with the Bun version in
`.bun-version`).

`envhound upgrade` checks this for you before replacing itself: the file must match the release's
`SHA256SUMS` and be byte for byte the one in the npm package of the same version. A standalone
binary must match `SHA256SUMS` on GitHub and the copy of `SHA256SUMS` published in the npm package.

The sources are analysed by CodeQL on every pull request, and the project's practices are tracked by
[OpenSSF Scorecard](https://scorecard.dev/viewer/?uri=github.com/michelsalib/envhound) and hold the
[OpenSSF Best Practices](https://www.bestpractices.dev/projects/15395) passing badge.
