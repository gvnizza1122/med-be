#!/bin/bash
# ============================================
# E-Claim DB Backup Script
# Schedule: daily via cron or Windows Task Scheduler
# Usage:   ./be/scripts/backup.sh
# Output:  ./backups/eclaim_YYYYMMDD_HHMMSS.sql.gz
# ============================================
set -euo pipefail

BACKUP_DIR="$(cd "$(dirname "$0")/.." && pwd)/backups"
mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
FILENAME="eclaim_${TIMESTAMP}.sql.gz"
FILEPATH="${BACKUP_DIR}/${FILENAME}"

# Use docker-compose pg credentials
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5433}"
DB_USER="${DB_USER:-postgres}"
DB_PASSWORD="${DB_PASSWORD:-postgres}"
DB_NAME="${DB_NAME:-eclaim}"

export PGPASSWORD="$DB_PASSWORD"
pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
  --no-owner --no-acl \
  | gzip > "$FILEPATH"

echo "✅ Backup saved: $FILEPATH ($(du -h "$FILEPATH" | cut -f1))"

# Keep last 30 days, remove older
find "$BACKUP_DIR" -name 'eclaim_*.sql.gz' -mtime +30 -delete
