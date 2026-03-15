#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKDIR="$ROOT_DIR/worker2"

if [[ -z "${CF_API_TOKEN_WORKER2:-}" ]]; then
  echo "Missing CF_API_TOKEN_WORKER2. Export the new-account token first." >&2
  echo "Example: export CF_API_TOKEN_WORKER2='cfp_xxx'" >&2
  exit 1
fi

cd "$WORKDIR"
CLOUDFLARE_API_TOKEN="$CF_API_TOKEN_WORKER2" npx wrangler deploy "$@"
