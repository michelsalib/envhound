# Contributing to envhound

Bug reports, ideas and pull requests are welcome. For anything bigger than a fix, open an issue
first so we can agree on the approach.

## Setting up

You need [Bun](https://bun.sh) (the version in `.bun-version`) and Node 20 or newer.

```sh
bun install
bun run dev -- blame PATH   # run from source
bun test                    # unit tests, real bash on test/fixtures/home, the built file on node
bun run typecheck
bun run lint                # Biome: formatting and lint; `bunx biome check --write` fixes most of it
```

On Windows, the tests read and write a scratch registry key instead of tracing bash.

## Pull requests

- Keep each pull request to one change, with a test that fails without it.
- CI must pass on Linux, macOS and Windows; `main` only accepts pull requests with green checks.
- Write commit messages that say what changed and why, in plain sentences.
- User-visible changes go in `CHANGELOG.md`, under "Unreleased".

## Releasing (maintainers)

1. In a pull request, move the "Unreleased" notes of `CHANGELOG.md` under the new version and bump
   `version` in `package.json`.
2. Once it's merged, tag the merge commit and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. The release workflow tests on every OS and builds the files, then waits for approval in the
   `release` environment. Approve it to publish to npm and create the GitHub release.
4. Package managers: `bun scripts/packages.ts X.Y.Z` writes, from the release's `SHA256SUMS`, the
   Homebrew formula (`Formula/envhound.rb`, for the `michelsalib/homebrew-envhound` tap), the Scoop
   manifest (`envhound.json`, for the `michelsalib/scoop-envhound` bucket) and the winget manifests
   (a pull request to `microsoft/winget-pkgs`) under `dist/packages/`. Scoop's `autoupdate` can also
   update its manifest on its own.
