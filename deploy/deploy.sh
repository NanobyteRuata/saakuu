#!/usr/bin/env bash
# Copies this checkout to the server and rebuilds the stack there. Run from the repo root:
#   DEPLOY_HOST=root@203.0.113.10 deploy/deploy.sh
# The server's own .env is never sent, overwritten or deleted.
set -euo pipefail

HOST="${DEPLOY_HOST:?set DEPLOY_HOST, e.g. root@203.0.113.10}"
DIR="${DEPLOY_DIR:-/opt/saakuu}"
COMPOSE="docker compose -f docker-compose.prod.yml"

cd "$(dirname "$0")/.."

ssh "$HOST" "mkdir -p '$DIR'"
rsync -az --delete \
  --exclude=.git --exclude=node_modules --exclude=.next \
  --exclude='.env' --exclude='.env.*' \
  --exclude=test-results --exclude=playwright-report --exclude=coverage \
  --exclude='*.tsbuildinfo' --exclude=.DS_Store \
  ./ "$HOST:$DIR/"

# Build first so the old containers keep serving until the new image exists; migrate runs before app and worker.
ssh "$HOST" "cd '$DIR' && $COMPOSE build && $COMPOSE up -d --remove-orphans && docker image prune -f"
ssh "$HOST" "cd '$DIR' && $COMPOSE ps"
