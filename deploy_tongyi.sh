#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKDIR="$ROOT_DIR/workers/tongyi"

if [[ -z "${CF_API_TOKEN_TONGYI:-}" ]]; then
  echo "Missing CF_API_TOKEN_TONGYI. Export the old-account token first." >&2
  echo "Example: export CF_API_TOKEN_TONGYI='cfp_xxx'" >&2
  exit 1
fi

cd "$WORKDIR"
CLOUDFLARE_API_TOKEN="$CF_API_TOKEN_TONGYI" npx wrangler deploy "$@"
