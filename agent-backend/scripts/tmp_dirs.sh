#!/bin/bash

# Centralized temporary directory configuration
# Source this file in all backup/restore scripts

# Base directories
export BACKUP_TMP_BASE="/tmp/backup-manager"
export RESTORE_TMP_BASE="/tmp/restore-manager"

# Backup subdirectories
export BACKUP_TMP_LOGS="$BACKUP_TMP_BASE/logs"
export BACKUP_TMP_QEMU="$BACKUP_TMP_BASE/qemu"
export BACKUP_TMP_VMDATA="$BACKUP_TMP_BASE/vm-data"
export BACKUP_TMP_PROGRESS="$BACKUP_TMP_BASE/progress"
export BACKUP_TMP_FIFOS="$BACKUP_TMP_BASE/fifos"
export BACKUP_TMP_EXIT="$BACKUP_TMP_BASE/exit-codes"

# Restore subdirectories
export RESTORE_TMP_EVENTS="$RESTORE_TMP_BASE/events"
export RESTORE_TMP_LOGS="$RESTORE_TMP_BASE/logs"
export RESTORE_TMP_LOCKS="$RESTORE_TMP_BASE/locks"
export RESTORE_TMP_FIFOS="$RESTORE_TMP_BASE/fifos"
export RESTORE_TMP_EXIT="$RESTORE_TMP_BASE/exit-codes"

# Function to ensure all directories exist
ensure_tmp_dirs() {
    local dirs=(
        "$BACKUP_TMP_LOGS"
        "$BACKUP_TMP_QEMU"
        "$BACKUP_TMP_VMDATA"
        "$BACKUP_TMP_PROGRESS"
        "$BACKUP_TMP_FIFOS"
        "$BACKUP_TMP_EXIT"
        "$RESTORE_TMP_EVENTS"
        "$RESTORE_TMP_LOGS"
        "$RESTORE_TMP_LOCKS"
        "$RESTORE_TMP_FIFOS"
        "$RESTORE_TMP_EXIT"
    )
    
    for dir in "${dirs[@]}"; do
        mkdir -p "$dir" 2>/dev/null || true
    done
}

# Call on source
ensure_tmp_dirs
