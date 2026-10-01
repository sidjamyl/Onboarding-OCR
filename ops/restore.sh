#!/bin/sh
set -eu

if [ "${CONFIRM_RESTORE:-}" != "RESTORE_ONBOARDING" ]; then
  echo "Set CONFIRM_RESTORE=RESTORE_ONBOARDING to confirm the destructive restore." >&2
  exit 2
fi

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${MINIO_ENDPOINT:?MINIO_ENDPOINT is required}"
: "${MINIO_ACCESS_KEY:?MINIO_ACCESS_KEY is required}"
: "${MINIO_SECRET_KEY:?MINIO_SECRET_KEY is required}"
: "${MINIO_BUCKET:?MINIO_BUCKET is required}"
: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is required}"
: "${RESTIC_PASSWORD:?RESTIC_PASSWORD is required}"

RESTORE_ROOT="/tmp/ocr-onboarding-restore"
SNAPSHOT="${RESTIC_SNAPSHOT:-latest}"
umask 077
trap 'rm -rf /tmp/ocr-onboarding-restore' EXIT INT TERM
rm -rf /tmp/ocr-onboarding-restore
mkdir -p "$RESTORE_ROOT"
restic restore "$SNAPSHOT" --tag onboarding --target "$RESTORE_ROOT"

psql --dbname "$DATABASE_URL" --set ON_ERROR_STOP=1 <<'SQL'
DROP SCHEMA IF EXISTS pgboss CASCADE;
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
SQL
pg_restore --dbname "$DATABASE_URL" --exit-on-error --no-owner "$RESTORE_ROOT/tmp/ocr-onboarding-backup/postgres/onboarding.dump"
mc alias set destination "$MINIO_ENDPOINT" "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY"
mc mirror --overwrite --remove "$RESTORE_ROOT/tmp/ocr-onboarding-backup/minio" "destination/$MINIO_BUCKET"

echo "Onboarding restore completed"
