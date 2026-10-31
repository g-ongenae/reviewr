#!/usr/bin/env bash
set -euo pipefail
: "${BACKUP_DIR:?Set BACKUP_DIR}" "${EXPORT_REPO:?Set EXPORT_REPO}" "${OFFHOST_TARGET:?Set OFFHOST_TARGET (rsync destination)}"
mkdir -p "$BACKUP_DIR"
tmp=$(mktemp "$BACKUP_DIR/.dump.XXXXXX")
trap 'rm -f "$tmp"' EXIT
docker compose exec -T postgres sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$tmp"
[ -s "$tmp" ]
mv "$tmp" "$BACKUP_DIR/$(date -u +%Y%m%dT%H%M%SZ).dump"
# JSON avoids filename injection and preserves arbitrary document contents.
docker compose exec -T postgres sh -c 'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "SELECT coalesce(json_agg(json_build_object('\''id'\'', id, '\''content'\'', content)), '\''[]'\''::json) FROM documents"' | python3 scripts/export-documents.py "$EXPORT_REPO"
git -C "$EXPORT_REPO" add -A -- documents
if ! git -C "$EXPORT_REPO" diff --cached --quiet; then git -C "$EXPORT_REPO" commit -m "Document export $(date -u +%FT%TZ)"; fi
rsync -a "$BACKUP_DIR/" "$OFFHOST_TARGET/dumps/"
rsync -a "$EXPORT_REPO/" "$OFFHOST_TARGET/export/"
