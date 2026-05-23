#!/bin/bash

# Cleanup stale lock files in in_progress_backups directories
# Lock files should never persist for more than a few hours
# This script is more aggressive than cleanup_restore_files.sh

set -e

# Configuration
HOURS_OLD=${1:-6}  # Default: clean locks older than 6 hours
DRY_RUN=${2:-false}  # Set to "true" for dry run

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== Stale Lock Files Cleanup ===${NC}"
echo "Cleaning lock files older than ${HOURS_OLD} hours"
if [ "$DRY_RUN" = "true" ]; then
    echo -e "${YELLOW}DRY RUN MODE - No files will be deleted${NC}"
fi
echo ""

# Find all storage pools by looking for in_progress_backups directories
LOCK_DIRS=$(find /opt/kvm_pool -type d -name "in_progress_backups" 2>/dev/null || true)

if [ -z "$LOCK_DIRS" ]; then
    echo -e "${YELLOW}No in_progress_backups directories found${NC}"
    exit 0
fi

TOTAL_FILES=0
MINUTES=$((HOURS_OLD * 60))

for LOCK_DIR in $LOCK_DIRS; do
    POOL=$(dirname "$LOCK_DIR")
    echo -e "${GREEN}Checking: ${LOCK_DIR}${NC}"
    
    # Find stale lock files
    STALE_LOCKS=$(find "$LOCK_DIR" -type f -mmin +${MINUTES} 2>/dev/null || true)
    
    if [ -n "$STALE_LOCKS" ]; then
        COUNT=$(echo "$STALE_LOCKS" | wc -l)
        echo -e "  ${RED}WARNING:${NC} Found ${YELLOW}${COUNT}${NC} stale lock files (>${HOURS_OLD} hours old)"
        echo -e "  ${YELLOW}These indicate interrupted backups/restores${NC}"
        echo ""
        
        if [ "$DRY_RUN" = "true" ]; then
            echo "  Lock files that would be deleted:"
            for lock in $STALE_LOCKS; do
                LOCK_NAME=$(basename "$lock")
                LOCK_AGE=$(stat -c %y "$lock" 2>/dev/null | cut -d. -f1)
                LOCK_CONTENT=$(head -1 "$lock" 2>/dev/null || echo "unknown")
                echo -e "    ${YELLOW}${LOCK_NAME}${NC}"
                echo "      Created: ${LOCK_AGE}"
                echo "      Content: ${LOCK_CONTENT}"
                echo ""
            done
        else
            echo "  Deleting stale locks:"
            for lock in $STALE_LOCKS; do
                LOCK_NAME=$(basename "$lock")
                echo "    - ${LOCK_NAME}"
                rm -f "$lock" 2>/dev/null || true
            done
            echo -e "  ${GREEN}✓ Deleted ${COUNT} stale locks${NC}"
        fi
        
        TOTAL_FILES=$((TOTAL_FILES + COUNT))
        echo ""
    else
        echo -e "  ${GREEN}✓ No stale locks found${NC}"
        echo ""
    fi
done

echo ""
echo -e "${GREEN}=== Summary ===${NC}"
if [ "$DRY_RUN" = "true" ]; then
    echo -e "Would delete ${YELLOW}${TOTAL_FILES}${NC} stale lock files"
    echo ""
    echo "To actually delete files, run:"
    echo "  bash $0 ${HOURS_OLD} false"
else
    echo -e "Deleted ${GREEN}${TOTAL_FILES}${NC} stale lock files"
fi

if [ $TOTAL_FILES -gt 0 ]; then
    echo ""
    echo -e "${YELLOW}Note:${NC} If you see many stale locks, this may indicate:"
    echo "  1. Backups/restores being killed without proper cleanup"
    echo "  2. System crashes or power failures"
    echo "  3. Signal handling not working correctly"
    echo ""
    echo "Consider investigating the root cause."
fi
