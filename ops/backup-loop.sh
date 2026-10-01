#!/bin/sh
set -eu

while true; do
  /ops/backup.sh
  sleep "${BACKUP_INTERVAL_SECONDS:-86400}"
done
