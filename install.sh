#!/bin/sh
# Install rcenv into ~/.local/bin:
#   curl -fsSL https://github.com/michelsalib/rcenv/releases/latest/download/install.sh | sh
#
# RCENV_INSTALL_DIR  where to put `rcenv` (default ~/.local/bin)
# RCENV_VERSION      a version such as 0.2.0 (default: the latest release)
# RCENV_BASE_URL     where rcenv.js and SHA256SUMS are downloaded from (mirrors, tests)
# RCENV_NO_COMPLETION=1  don't install shell completion
#
# rcenv is one JavaScript file: it needs Node >= 20 or Bun, whichever is installed.
set -eu

repo=michelsalib/rcenv
dir=${RCENV_INSTALL_DIR:-$HOME/.local/bin}
version=${RCENV_VERSION:-latest}
version=${version#v}
if [ -n "${RCENV_BASE_URL:-}" ]; then
  base=$RCENV_BASE_URL
elif [ "$version" = latest ]; then
  base=https://github.com/$repo/releases/latest/download
else
  base=https://github.com/$repo/releases/download/v$version
fi

say() { printf '%s\n' "$*"; }
fail() { printf 'rcenv install: %s\n' "$*" >&2; exit 1; }

# the runtime: Node >= 20 first, then Bun
if command -v node >/dev/null 2>&1 &&
  node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' 2>/dev/null; then
  runtime=node
elif command -v bun >/dev/null 2>&1; then
  runtime=bun
else
  fail "rcenv needs Node >= 20 or Bun. Install one (https://nodejs.org, https://bun.sh), or run it with npx rcenv / bunx rcenv"
fi

if command -v curl >/dev/null 2>&1; then
  download() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  download() { wget -qO "$2" "$1"; }
else
  fail "needs curl or wget to download rcenv"
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  fail "needs sha256sum or shasum to check the download"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

download "$base/rcenv.js" "$tmp/rcenv.js" || fail "could not download $base/rcenv.js"
download "$base/SHA256SUMS" "$tmp/SHA256SUMS" || fail "could not download $base/SHA256SUMS"
expected=$(awk '$2 == "rcenv.js" || $2 == "*rcenv.js" { print $1 }' "$tmp/SHA256SUMS")
[ -n "$expected" ] || fail "SHA256SUMS has no entry for rcenv.js"
[ "$(sha256 "$tmp/rcenv.js")" = "$expected" ] || fail "checksum mismatch for rcenv.js; nothing was installed"

# the build starts with `#!/usr/bin/env node`
if [ "$runtime" = bun ]; then
  sed '1s|.*|#!/usr/bin/env bun|' "$tmp/rcenv.js" >"$tmp/rcenv"
else
  cp "$tmp/rcenv.js" "$tmp/rcenv"
fi
chmod 755 "$tmp/rcenv"

mkdir -p "$dir"
# copy next to the target, then rename: a running rcenv is never left half-written
cp "$tmp/rcenv" "$dir/.rcenv.new"
mv -f "$dir/.rcenv.new" "$dir/rcenv"

say "installed rcenv $("$dir/rcenv" --version) in $dir (runs on $runtime)"

# completion goes where shells load it by themselves; startup files are never edited
if [ -z "${RCENV_NO_COMPLETION:-}" ]; then
  data=${XDG_DATA_HOME:-$HOME/.local/share}
  config=${XDG_CONFIG_HOME:-$HOME/.config}
  mkdir -p "$data/bash-completion/completions"
  "$dir/rcenv" completion bash >"$data/bash-completion/completions/rcenv"
  bash_completion=
  for f in /usr/share/bash-completion/bash_completion /etc/bash_completion \
    /opt/homebrew/etc/profile.d/bash_completion.sh /usr/local/etc/profile.d/bash_completion.sh; do
    if [ -r "$f" ]; then bash_completion=$f; break; fi
  done
  if [ -n "$bash_completion" ]; then
    say "bash completion: installed (new shells)"
  else
    say "bash completion: bash-completion isn't installed; add this to ~/.bashrc instead:"
    say "  eval \"\$(rcenv completion bash)\""
  fi
  if command -v fish >/dev/null 2>&1; then
    mkdir -p "$config/fish/completions"
    "$dir/rcenv" completion fish >"$config/fish/completions/rcenv.fish"
    say "fish completion: installed"
  fi
  if command -v zsh >/dev/null 2>&1; then
    say "zsh completion: add this to ~/.zshrc, after compinit:"
    say "  eval \"\$(rcenv completion zsh)\""
  fi
fi

case ":$PATH:" in
  *":$dir:"*) ;;
  *) say "$dir is not in your PATH. To add it for new shells, run:"
     say "  $dir/rcenv path add $dir" ;;
esac
