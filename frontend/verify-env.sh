#!/bin/bash

echo "🔍 Verifying Frontend .env Configuration"
echo "=========================================="
echo ""

# Check if .env exists
if [ ! -f .env ]; then
    echo "❌ ERROR: .env file not found!"
    exit 1
fi

echo "📄 Current .env contents:"
cat .env
echo ""
echo "=========================================="
echo ""

# Check VITE_BACKEND_IP
BACKEND_IP=$(grep "^VITE_BACKEND_IP=" .env | cut -d'=' -f2)
if [ -z "$BACKEND_IP" ]; then
    echo "✅ VITE_BACKEND_IP is empty (correct for production)"
else
    echo "❌ ERROR: VITE_BACKEND_IP='$BACKEND_IP' (should be empty)"
    echo "   Fix: VITE_BACKEND_IP="
    exit 1
fi

# Check VITE_BACKEND_PORT
BACKEND_PORT=$(grep "^VITE_BACKEND_PORT=" .env | cut -d'=' -f2)
if [ -z "$BACKEND_PORT" ]; then
    echo "✅ VITE_BACKEND_PORT is empty (correct for production)"
else
    echo "❌ ERROR: VITE_BACKEND_PORT='$BACKEND_PORT' (should be empty)"
    echo "   Fix: VITE_BACKEND_PORT="
    exit 1
fi

# Check VITE_API_BASE_PATH
API_BASE_PATH=$(grep "^VITE_API_BASE_PATH=" .env | cut -d'=' -f2)
if [ "$API_BASE_PATH" = "/api-backup" ]; then
    echo "✅ VITE_API_BASE_PATH=/api-backup (correct)"
elif [ -z "$API_BASE_PATH" ]; then
    echo "⚠️  WARNING: VITE_API_BASE_PATH is empty (will default to /api)"
else
    echo "⚠️  WARNING: VITE_API_BASE_PATH='$API_BASE_PATH' (expected /api-backup)"
fi

echo ""
echo "=========================================="
echo "✅ Configuration is correct for production!"
echo ""
echo "Next steps:"
echo "1. npm run build"
echo "2. sudo cp -r dist/* /var/www/html/backup-manager-panel/dist/"
echo "3. sudo systemctl reload nginx"
