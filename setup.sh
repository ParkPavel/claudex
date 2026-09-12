#!/usr/bin/env sh
set -eu

if ! command -v node >/dev/null 2>&1; then
  echo 'Claudex needs Node.js 22 or newer. Install Node.js, then run this file again.' >&2
  exit 1
fi

CLAUDEX_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CLAUDEX_WORKSPACE=${1:-"$(dirname -- "$CLAUDEX_DIR")"}
exec node "$CLAUDEX_DIR/bin/claudex.mjs" setup --workspace "$CLAUDEX_WORKSPACE"
