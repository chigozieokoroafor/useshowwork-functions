#!/bin/sh
# Offline integrity/default-off check. Does not load credentials or dependencies.
set -eu
cd "$(dirname "$0")"
[ "$(node -p 'process.versions.node.split(".")[0]')" = 22 ] || exit 78
sha256sum -c SHA256SUMS
for command in --check --run --reconcile; do
  result=$(env -i PATH="$PATH" node --require ./offline-deny.cjs ./run.cjs "$command")
  [ "$result" = '{"state":"disabled","publishingEnabled":false,"databaseConnected":false,"maySend":false}' ] || exit 78
done
printf '%s\n' "$result"
