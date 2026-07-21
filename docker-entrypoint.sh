#!/bin/sh
set -e

echo "⏳ Waiting for PostgreSQL..."
until pg_isready -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" 2>/dev/null; do
  echo "  Waiting for PostgreSQL to be ready..."
  sleep 2
done
echo "✅ PostgreSQL is ready!"

echo "🌱 Seeding database..."
node src/database/seed.js

echo "🚀 Starting backend server..."
node src/index.js
