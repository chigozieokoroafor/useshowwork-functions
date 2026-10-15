#!/bin/sh
# Local-on-VPS command only, after separate approval. Never starts/enables services.
set -eu
[ "$(id -un)" = showwork ] || { echo 'Run as showwork' >&2; exit 1; }
cd "$(dirname "$0")"
./check.sh
release=$(node -p 'require("./release.json").releaseId')
case "$release" in sw-disabled-*) ;; *) exit 1;; esac
case "$release" in *[!a-zA-Z0-9._-]*) exit 1;; esac
base=/home/showwork/releases
app=/home/showwork/app
[ -d "$base" ] && [ -d "$app" ]
target="$base/$release"
[ ! -e "$target" ] || { echo 'Release already exists; inspect rather than overwrite' >&2; exit 1; }
# Refuse replacement of a directory or an unrelated application link.
if [ -e "$app/publishing-disabled" ] || [ -L "$app/publishing-disabled" ]; then
  [ -L "$app/publishing-disabled" ] || exit 1
  case "$(readlink "$app/publishing-disabled")" in "$base"/sw-disabled-*) ;; *) exit 1;; esac
fi
umask 077
mkdir "$target"
cp ./* "$target/"
chmod 600 "$target"/*
chmod 700 "$target"/*.sh
(cd "$target" && ./check.sh)
[ ! -e "$app/.publishing-disabled-next" ] && [ ! -L "$app/.publishing-disabled-next" ]
ln -s "$target" "$app/.publishing-disabled-next"
mv -Tf "$app/.publishing-disabled-next" "$app/publishing-disabled"
echo "Installed disabled release: $release; no service started"
