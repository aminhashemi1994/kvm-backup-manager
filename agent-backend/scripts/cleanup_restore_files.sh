#!/bin/bash

# Cleanup old restore progress and log files
# This script removes restore-related temporary files older than specified days

set -e

# Configuration
DAYS_OLD=${1:-7}  # Default: clean files older than 7 days
DRY_RUN=${2:-false}  # Set to "true" for dry run

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== Restore Files Cleanup ===${NC}"
echo "Cleaning files older than ${DAYS_OLD} days"
if [ "$DRY_RUN" = "true" ]; then
    echo -e "${YELLOW}DRY RUN MODE - No files will be deleted${NC}"
fi
echo ""

# Find all storage pools by looking for .progress directories
STORAGE_POOLS=$(find /opt/kvm_pool -type d -name ".progress" 2>/dev/null | sed 's/\/.progress$//' || true)

if [ -z "$STORAGE_POOLS" ]; then
    echo -e "${YELLOW}No storage pools found${NC}"
    exit 0
fi

TOTAL_FILES=0
TOTAL_SIZE=0

for POOL in $STORAGE_POOLS; do
    echo -e "${GREEN}Checking storage pool: ${POOL}${NC}"
    
    # Clean up .progress directory
    PROGRESS_DIR="${POOL}/.progress"
    if [ -d "$PROGRESS_DIR" ]; then
        echo "  Scanning ${PROGRESS_DIR}..."
        
        # Find old restore progress files
        PROGRESS_FILES=$(find "$PROGRESS_DIR" -name "restore_*.progress" -type f -mtime +${DAYS_OLD} 2>/dev/null || true)
        if [ -n "$PROGRESS_FILES" ]; then
            COUNT=$(echo "$PROGRESS_FILES" | wc -l)
            SIZE=$(echo "$PROGRESS_FILES" | xargs du -ch 2>/dev/null | tail -1 | cut -f1 || echo "0")
            echo -e "  Found ${YELLOW}${COUNT}${NC} old progress files (${SIZE})"
            
            if [ "$DRY_RUN" = "true" ]; then
                echo "$PROGRESS_FILES" | head -5
                if [ $COUNT -gt 5 ]; then
                    echo "  ... and $((COUNT - 5)) more"
                fi
            else
                echo "$PROGRESS_FILES" | xargs rm -f
                echo -e "  ${GREEN}✓ Deleted${NC}"
            fi
            
            TOTAL_FILES=$((TOTAL_FILES + COUNT))
        fi
    fi
    
    # Clean up .logs directory
    LOGS_DIR="${POOL}/.logs"
    if [ -d "$LOGS_DIR" ]; then
        echo "  Scanning ${LOGS_DIR}..."
        
        # Find old restore log files
        LOG_FILES=$(find "$LOGS_DIR" -name "restore_*.log" -type f -mtime +${DAYS_OLD} 2>/dev/null || true)
        if [ -n "$LOG_FILES" ]; then
            COUNT=$(echo "$LOG_FILES" | wc -l)
            SIZE=$(echo "$LOG_FILES" | xargs du -ch 2>/dev/null | tail -1 | cut -f1 || echo "0")
            echo -e "  Found ${YELLOW}${COUNT}${NC} old log files (${SIZE})"
            
            if [ "$DRY_RUN" = "true" ]; then
                echo "$LOG_FILES" | head -5
                if [ $COUNT -gt 5 ]; then
                    echo "  ... and $((COUNT - 5)) more"
                fi
            else
                echo "$LOG_FILES" | xargs rm -f
                echo -e "  ${GREEN}✓ Deleted${NC}"
            fi
            
            TOTAL_FILES=$((TOTAL_FILES + COUNT))
        fi
    fi
    
    # Clean up in_progress_backups directory (lock files)
    LOCK_DIR="${POOL}/in_progress_backups"
    if [ -d "$LOCK_DIR" ]; then
        echo "  Scanning ${LOCK_DIR}..."
        
        # Find old lock files (both backup and restore locks)
        # Lock files older than specified days
        LOCK_FILES=$(find "$LOCK_DIR" -type f -mtime +${DAYS_OLD} 2>/dev/null || true)
        if [ -n "$LOCK_FILES" ]; then
            COUNT=$(echo "$LOCK_FILES" | wc -l)
            echo -e "  Found ${YELLOW}${COUNT}${NC} old lock files (>${DAYS_OLD} days)"
            
            if [ "$DRY_RUN" = "true" ]; then
                echo "$LOCK_FILES" | head -10
                if [ $COUNT -gt 10 ]; then
                    echo "  ... and $((COUNT - 10)) more"
                fi
            else
                echo "$LOCK_FILES" | xargs rm -f
                echo -e "  ${GREEN}✓ Deleted${NC}"
            fi
            
            TOTAL_FILES=$((TOTAL_FILES + COUNT))
        fi
        
        # Also find stale lock files (older than 6 hours - likely orphaned)
        STALE_LOCKS=$(find "$LOCK_DIR" -type f -mmin +360 2>/dev/null || true)
        if [ -n "$STALE_LOCKS" ]; then
            # Filter out files already counted in LOCK_FILES
            STALE_COUNT=0
            for lock in $STALE_LOCKS; do
                if ! echo "$LOCK_FILES" | grep -q "$lock"; then
                    STALE_COUNT=$((STALE_COUNT + 1))
                fi
            done
            
            if [ $STALE_COUNT -gt 0 ]; then
                echo -e "  ${RED}WARNING:${NC} Found ${YELLOW}${STALE_COUNT}${NC} stale lock files (>6 hours old)"
                echo -e "  ${YELLOW}These may indicate interrupted backups/restores${NC}"
                
                if [ "$DRY_RUN" = "true" ]; then
                    for lock in $STALE_LOCKS; do
                        if ! echo "$LOCK_FILES" | grep -q "$lock"; then
                            echo "    $(basename $lock) - $(stat -c %y "$lock" 2>/dev/null | cut -d. -f1)"
                        fi
                    done | head -10
                else
                    for lock in $STALE_LOCKS; do
                        if ! echo "$LOCK_FILES" | grep -q "$lock"; then
                            rm -f "$lock" 2>/dev/null || true
                        fi
                    done
                    echo -e "  ${GREEN}✓ Deleted stale locks${NC}"
                fi
                
                TOTAL_FILES=$((TOTAL_FILES + STALE_COUNT))
            fi
        fi
    fi
    
    echo ""
done

# Clean up /tmp restore event files
echo -e "${GREEN}Checking /tmp for restore event files...${NC}"
TMP_FILES=$(find /tmp -name "restore_events_*.jsonl" -type f -mtime +${DAYS_OLD} 2>/dev/null || true)
if [ -n "$TMP_FILES" ]; then
    COUNT=$(echo "$TMP_FILES" | wc -l)
    SIZE=$(echo "$TMP_FILES" | xargs du -ch 2>/dev/null | tail -1 | cut -f1 || echo "0")
    echo -e "Found ${YELLOW}${COUNT}${NC} old event files (${SIZE})"
    
    if [ "$DRY_RUN" = "true" ]; then
        echo "$TMP_FILES" | head -5
        if [ $COUNT -gt 5 ]; then
            echo "  ... and $((COUNT - 5)) more"
        fi
    else
        echo "$TMP_FILES" | xargs rm -f
        echo -e "${GREEN}✓ Deleted${NC}"
    fi
    
    TOTAL_FILES=$((TOTAL_FILES + COUNT))
fi

echo ""
echo -e "${GREEN}=== Summary ===${NC}"
if [ "$DRY_RUN" = "true" ]; then
    echo -e "Would delete ${YELLOW}${TOTAL_FILES}${NC} files"
    echo ""
    echo "To actually delete files, run:"
    echo "  bash $0 ${DAYS_OLD} false"
else
    echo -e "Deleted ${GREEN}${TOTAL_FILES}${NC} files"
fi
