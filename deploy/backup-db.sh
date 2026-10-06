#!/usr/bin/env bash
# Nightly database dump to the backup bucket (docs/09 §2). Runs on the server, from cron:
#   15 2 * * * /opt/saakuu/deploy/backup-db.sh >> /var/log/saakuu-backup.log 2>&1
# Retention is the bucket's lifecycle rule, not this script.
set -euo pipefail

cd "$(dirname "$0")/.."

# .env is not shell syntax (EMAIL_FROM has spaces and <>), so read single values instead of sourcing it.
env_value() { grep -E "^$1=" .env | head -n 1 | cut -d= -f2-; }

endpoint="$(env_value S3_ENDPOINT)"
bucket="$(env_value BACKUP_S3_BUCKET)"
[ -n "$endpoint" ] && [ -n "$bucket" ] || { echo "S3_ENDPOINT and BACKUP_S3_BUCKET must be set in .env" >&2; exit 1; }

name="saakuu-$(date -u +%Y%m%dT%H%MZ).dump"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Dump to a file first: a failed pg_dump must not leave a truncated object in the bucket.
docker compose -f docker-compose.prod.yml exec -T postgres pg_dump -U saakuu -d saakuu -Fc > "$tmp/$name"

docker run --rm -v "$tmp:/backup:ro" \
  -e AWS_ACCESS_KEY_ID="$(env_value S3_ACCESS_KEY_ID)" \
  -e AWS_SECRET_ACCESS_KEY="$(env_value S3_SECRET_ACCESS_KEY)" \
  -e AWS_DEFAULT_REGION=auto \
  -e AWS_REQUEST_CHECKSUM_CALCULATION=when_required \
  amazon/aws-cli s3 cp "/backup/$name" "s3://$bucket/$name" --endpoint-url "$endpoint" --only-show-errors

echo "$(date -u +%FT%TZ) uploaded $name ($(du -h "$tmp/$name" | cut -f1))"
