#!/bin/bash

# Pastikan script dijalankan di direktori backend (be)
cd "$(dirname "$0")" || exit

echo "🔄 Pulling latest changes from git..."
git pull

echo "🚀 Building and starting backend containers..."
docker compose up -d --build

# echo "🌱 Seeding database..."
# docker exec eclaim_api npm run seed

# Ambil informasi port dari .env
PORT=$(grep -E "^PORT=" .env | cut -d '=' -f 2)

# Jika tidak ditemukan di .env, gunakan default 5000
if [ -z "$PORT" ]; then
  PORT=5000
fi

echo ""
echo "======================================================"
echo "✅ Backend successfully deployed and running on PORT: $PORT"
echo "======================================================"
echo ""
