#!/usr/bin/env bash
set -euo pipefail

env_file=${ONBOARDING_ENV_FILE:-/home/admin/ocr-config/onboarding.env}
compose=(docker compose --project-name ocr-onboarding --env-file "$env_file" -f compose.yaml)
test -f "$env_file" || { echo "Missing private environment file: $env_file" >&2; exit 1; }
data_dir=$(sed -n 's/^ONBOARDING_DATA_DIR=//p' "$env_file" | tail -n 1)
case "$data_dir" in /*) ;; *) echo "ONBOARDING_DATA_DIR must be an absolute persistent path" >&2; exit 1 ;; esac
public_url=$(sed -n 's/^PUBLIC_BASE_URL=//p' "$env_file" | tail -n 1)
case "$public_url" in https://*example*) echo "Set the real PUBLIC_BASE_URL" >&2; exit 1 ;; https://*) ;; *) echo "PUBLIC_BASE_URL must use HTTPS" >&2; exit 1 ;; esac
mkdir -p "$data_dir/traces" "$data_dir/admin"

"${compose[@]}" config --quiet
"${compose[@]}" build backend worker frontend
"${compose[@]}" up -d postgres minio backend worker frontend

for attempt in $(seq 1 36); do
  if curl --fail --silent --show-error --output /dev/null http://127.0.0.1:8090/healthz \
    && curl --fail --silent --show-error --output /dev/null http://127.0.0.1:3000/; then
    if ! "${compose[@]}" exec -T backend node -e \
      'fetch(process.env.OCR_BASE_URL + "/readyz", { signal: AbortSignal.timeout(5000) }).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'; then
      echo "Onboarding cannot reach the Gateway from its backend container" >&2
      exit 1
    fi
    "${compose[@]}" ps
    exit 0
  fi
  sleep 5
done
"${compose[@]}" logs --tail=100 backend worker frontend >&2
echo "Onboarding did not become healthy" >&2
exit 1
