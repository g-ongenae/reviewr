#!/usr/bin/env bash
# CI only: an isolated Compose project and volume, never an existing database.
set -euo pipefail
export COMPOSE_PROJECT_NAME="reviewr-rehearsal-${GITHUB_RUN_ID:-$$}-${GITHUB_RUN_ATTEMPT:-1}"
export POSTGRES_USER=reviewr POSTGRES_PASSWORD=rehearsal POSTGRES_DB=reviewr_test
export PRIVATE_BIND_IP=127.0.0.1 DATABASE_URL=postgres://reviewr:rehearsal@postgres:5432/reviewr_test
work=$(mktemp -d)
trap 'docker compose down -v --remove-orphans; rm -rf "$work"' EXIT
export BACKUP_DIR="$work/dumps" EXPORT_REPO="$work/export" OFFHOST_TARGET="$work/offhost"
mkdir -p "$EXPORT_REPO" "$OFFHOST_TARGET"
git -C "$EXPORT_REPO" init -q
git -C "$EXPORT_REPO" config user.name rehearsal
git -C "$EXPORT_REPO" config user.email rehearsal@example.invalid
docker compose up -d --wait postgres
# Apply the same migrations as the application, inside its built image.
docker compose run --rm --no-deps api pnpm db:migrate
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U reviewr -d reviewr_test <<'SQL'
INSERT INTO documents (id,title,content,revision) VALUES
('11111111-1111-4111-8111-111111111111','Été', E'Bonjour 🌍\nDeuxième ligne\n',2),
('22222222-2222-4222-8222-222222222222','Delete','obsolete',1);
INSERT INTO revisions (document_id,revision,title,content) VALUES
('11111111-1111-4111-8111-111111111111',1,'Été','ancien'),
('11111111-1111-4111-8111-111111111111',2,'Été',E'Bonjour 🌍\nDeuxième ligne\n'),
('22222222-2222-4222-8222-222222222222',1,'Delete','obsolete');
SQL
scripts/backup.sh
python3 - "$EXPORT_REPO" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1]) / 'documents'
assert (p / '11111111-1111-4111-8111-111111111111.md').read_text() == 'Bonjour 🌍\nDeuxième ligne\n'
assert (p / '22222222-2222-4222-8222-222222222222.md').read_text() == 'obsolete'
PY
# Invalid input must leave the existing tree untouched.
if printf '[{"id":"11111111-1111-4111-8111-111111111111","content":"changed"},{"id":"bad","content":null}]' | python3 scripts/export-documents.py "$EXPORT_REPO"; then exit 1; fi
git -C "$EXPORT_REPO" diff --exit-code
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U reviewr -d reviewr_test -c "DELETE FROM documents WHERE id='22222222-2222-4222-8222-222222222222'"
sleep 1
scripts/backup.sh
test ! -e "$EXPORT_REPO/documents/22222222-2222-4222-8222-222222222222.md"
# Destroy the isolated database contents before restoring the latest dump.
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U reviewr -d reviewr_test -c 'DROP SCHEMA public CASCADE; DROP SCHEMA drizzle CASCADE; CREATE SCHEMA public;'
dump=$(find "$BACKUP_DIR" -name '*.dump' | sort | tail -1)
scripts/restore.sh "$dump"
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U reviewr -d reviewr_test <<'SQL'
DO $$ BEGIN
  IF (SELECT count(*) FROM drizzle.__drizzle_migrations) < 1 OR
     (SELECT count(*) FROM documents) <> 1 OR
     NOT EXISTS (SELECT 1 FROM documents WHERE revision=2 AND content=E'Bonjour 🌍\nDeuxième ligne\n') OR
     (SELECT count(*) FROM revisions) <> 2 OR
     NOT EXISTS (SELECT 1 FROM revisions WHERE revision=1 AND content='ancien') OR
     NOT EXISTS (SELECT 1 FROM revisions WHERE revision=2 AND content=E'Bonjour 🌍\nDeuxième ligne\n')
  THEN RAISE EXCEPTION 'Restore verification failed'; END IF;
END $$;
SQL
