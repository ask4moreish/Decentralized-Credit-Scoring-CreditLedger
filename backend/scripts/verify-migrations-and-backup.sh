#!/usr/bin/env bash
set -euo pipefail

# Verifies reversible Knex migrations (up -> rollback -> up) and tests pg_dump backup & clean restore.
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-postgres}"
DB_NAME="${DB_NAME:-credit_ledger}"
BACKUP_DB="${BACKUP_VERIFY_DB:-credit_ledger_restore_check}"
DUMP_FILE="$(mktemp /tmp/creditledger_backup_XXXXXX.sql)"
trap 'rm -f "$DUMP_FILE"' EXIT

echo "1/4 Applying latest migrations..."
npx knex migrate:latest

echo "2/4 Testing rollback of latest hardened migration..."
npx knex migrate:rollback

echo "3/4 Re-applying latest migrations..."
npx knex migrate:latest

if command -v pg_dump >/dev/null 2>&1 && command -v psql >/dev/null 2>&1; then
  echo "4/4 Verifying pg_dump backup and clean restore into $BACKUP_DB..."
  PGPASSWORD="${DB_PASSWORD:-}" pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" --no-owner --no-acl > "$DUMP_FILE"
  PGPASSWORD="${DB_PASSWORD:-}" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres -c "DROP DATABASE IF EXISTS \"$BACKUP_DB\";"
  PGPASSWORD="${DB_PASSWORD:-}" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres -c "CREATE DATABASE \"$BACKUP_DB\";"
  PGPASSWORD="${DB_PASSWORD:-}" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$BACKUP_DB" -f "$DUMP_FILE" >/dev/null
  PGPASSWORD="${DB_PASSWORD:-}" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$BACKUP_DB" -c "\dt"
  PGPASSWORD="${DB_PASSWORD:-}" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d postgres -c "DROP DATABASE IF EXISTS \"$BACKUP_DB\";"
  echo "Backup and restore verification passed!"
else
  echo "pg_dump/psql not installed in current shell; skipped restore verification step."
fi
