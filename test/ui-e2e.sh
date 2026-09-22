#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
npx vite build
exec node scripts/run-electron-ui-suite.js "$@"
