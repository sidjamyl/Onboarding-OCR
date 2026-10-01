#!/bin/sh
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${MINIO_ENDPOINT:?MINIO_ENDPOINT is required}"
: "${MINIO_ACCESS_KEY:?MINIO_ACCESS_KEY is required}"
: "${MINIO_SECRET_KEY:?MINIO_SECRET_KEY is required}"
: "${MINIO_BUCKET:?MINIO_BUCKET is required}"
: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is required}"
: "${RESTIC_PASSWORD:?RESTIC_PASSWORD is required}"

BACKUP_ROOT="/tmp/ocr-onboarding-backup"
umask 077
trap 'rm -rf /tmp/ocr-onboarding-backup' EXIT INT TERM
rm -rf /tmp/ocr-onboarding-backup
mkdir -p "$BACKUP_ROOT/postgres" "$BACKUP_ROOT/minio"

pg_dump --dbname "$DATABASE_URL" --format=custom --file "$BACKUP_ROOT/postgres/onboarding.dump"
mc alias set source "$MINIO_ENDPOINT" "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY"
mc mirror --overwrite "source/$MINIO_BUCKET" "$BACKUP_ROOT/minio"

restic snapshots >/dev/null 2>&1 || restic init
restic backup "$BACKUP_ROOT" --tag onboarding
restic forget --tag onboarding --keep-daily 30 --prune

echo "Encrypted onboarding backup completed"
