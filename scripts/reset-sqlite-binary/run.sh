#!/bin/sh
# Removes the current bundled better-sqlite3 prebuild to reproduce a startup
# validation failure. Reinstall dependencies afterwards to restore it.

rm -f apps/api/node_modules/better-sqlite3/prebuilds/*-"$(uname -m | sed 's/aarch64/arm64/;s/x86_64/x64/')".node
echo "removed bundled better-sqlite3 prebuild for the current architecture"
