#!/usr/bin/env bash
# Puts one published image into service. Runs on the server, normally from the Deploy workflow (docs/09 §9):
#   deploy/release.sh <commit-sha>
# The image is built and pushed by CI; nothing is built here. The server's .env is never touched.
set -euo pipefail

TAG="${1:?usage: deploy/release.sh <image tag, normally a commit sha>}"
[[ "$TAG" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo "not an image tag: $TAG" >&2; exit 1; }

cd "$(dirname "$0")/.."

export APP_IMAGE="ghcr.io/nanobyteruata/saakuu:$TAG"
COMPOSE="docker compose -f docker-compose.prod.yml"

# Pull first so the old containers keep serving until the new image is on disk; migrate runs before app and worker.
$COMPOSE pull migrate app worker
$COMPOSE up -d --remove-orphans

# `up -d` returns once the containers are started, not once the app answers.
for _ in $(seq 1 60); do
  health="$(docker inspect --format '{{.State.Health.Status}}' "$($COMPOSE ps -q app)" 2>/dev/null || true)"
  [ "$health" = "healthy" ] && break
  sleep 5
done

if [ "$health" != "healthy" ]; then
  echo "app is not healthy after 5 minutes (status: ${health:-none})" >&2
  $COMPOSE ps >&2
  $COMPOSE logs --tail 80 migrate app >&2
  exit 1
fi

echo "$TAG" > .release
docker image prune -f > /dev/null
$COMPOSE ps
echo "$(date -u +%FT%TZ) released $TAG"
