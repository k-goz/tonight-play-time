#!/usr/bin/env bash
set -euo pipefail

deployment="${1:-}"
confirmation="${2:-}"

if [[ -z "$deployment" || "$confirmation" != "--confirm" ]]; then
  echo "Usage: scripts/rollback-vercel.sh <deployment-url-or-id> --confirm" >&2
  exit 1
fi

vercel rollback "$deployment" --scope k-gozs-projects --yes
