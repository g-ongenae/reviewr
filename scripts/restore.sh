#!/usr/bin/env bash
set -euo pipefail
: "${1:?Usage: restore.sh dump-file}"
# Restoring replaces all application tables. Stop API first; use a fresh database.
docker compose exec -T postgres sh -c 'exec pg_restore --clean --if-exists --no-owner --exit-on-error -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < "$1"
