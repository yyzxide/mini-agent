#!/usr/bin/env bash
set -euo pipefail

cd /workspace

{
  echo "mini-agent sandbox"
  node --version || true
  git --version || true
  rg --version | head -n 1 || true
  java -version 2>&1 | head -n 1 || true
  mvn --version | head -n 1 || true
  python3 --version || true
} >&2

exec "$@"
