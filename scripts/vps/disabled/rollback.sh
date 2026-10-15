#!/bin/sh
set -eu
[ "$(id -un)" = showwork ] || exit 1
[ "$#" = 1 ] || { echo 'Usage: rollback.sh PREVIOUS_RELEASE_ID' >&2; exit 1; }
case "$1" in sw-disabled-*) ;; *) exit 1;; esac
case "$1" in *[!a-zA-Z0-9._-]*) exit 1;; esac
base=/home/showwork/releases
app=/home/showwork/app
target="$base/$1"
[ -d "$target" ] && [ ! -L "$target" ]
[ -L "$app/publishing-disabled" ]
case "$(readlink "$app/publishing-disabled")" in "$base"/sw-disabled-*) ;; *) exit 1;; esac
(cd "$target" && ./check.sh)
[ ! -e "$app/.publishing-disabled-next" ] && [ ! -L "$app/.publishing-disabled-next" ]
ln -s "$target" "$app/.publishing-disabled-next"
mv -Tf "$app/.publishing-disabled-next" "$app/publishing-disabled"
echo 'Disabled artifact link rolled back; no services, database or ownership changed'
