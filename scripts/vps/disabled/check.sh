#!/bin/sh
set -eu
cd "$(dirname "$0")"
[ "$(node -p 'process.versions.node.split(".")[0]')" = 22 ] || { echo 'Node 22 required' >&2; exit 78; }
sha256sum -c SHA256SUMS
config=$(cat disabled.json)
result=$(env -i PATH="$PATH" node --require ./offline-deny.cjs ./main.cjs --check-composition "$config")
[ "$result" = '{"state":"disabled","publishingEnabled":false,"databaseConnected":false,"maySend":false}' ] || exit 78
printf '%s\n' "$result"
