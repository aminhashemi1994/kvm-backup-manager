#!/bin/bash

###############################################################################
# Cleanup_Backup.sh - Cleanup partial/failed backup files without starting backup
#
# This script iterates through all schedule types (daily, weekly, monthly, once, custom)
# to find and cleanup partial files. For each schedule type with partial files:
# 1. Checks if tmux session exists for that schedule
# 2. Checks if lock file exists for that schedule  
# 3. If both checks pass, removes partial files and latest checkpoint
# 4. Skips cleanup if backup is currently running for that schedule
#
# Usage:
#   bash Cleanup_Backup.sh --domain vm1 --backup-path /path/to/backup
###############################################################################

# Source temporary directory configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/tmp_dirs.sh"

# ─── Defaults ────────────────────────────────────────────────────────────────
vm_name=""
backup_path=""
vm_base_dir=""
lock_dir=""

# ─── Argument parsing ────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
    --domain)
        vm_name="$2"
        shift 2
        ;;
    --backup-path)
        backup_path="$2"
        shift 2
        ;;
    *)
        echo "Unknown parameter passed: $1"
        exit 1
        ;;
    esac
done

# ─── Color codes ──────────────────────────────────────────────────────────────
: "${Red:=\033[0;31m}"
: "${Green:=\033[0;32m}"
: "${Yellow:=\033[1;33m}"
: "${Blue:=\033[0;34m}"
: "${Cyan:=\033[0;36m}"
: "${NC:=\033[0m}"
: "${CROSS:=✗}"
: "${CHECK:=✓}"
: "${WARNING:=⚠}"

###############################################################################
# OUTPUT HELPERS
###############################################################################

die() {
    echo -e "${Red}${CROSS} $1${NC}" >&2
    exit 1
}

warn() {
    echo -e "${Yellow}${WARNING} $1${NC}"
}

info() {
    echo -e "${Green}${CHECK} $1${NC}"
}

###############################################################################
# INPUT VALIDATION
###############################################################################

[[ -z "$vm_name" ]] && die "--domain is required."
[[ -z "$backup_path" ]] && die "--backup-path is required."

# Validate backup path exists
if [[ ! -d "$backup_path" ]]; then
    die "Backup path does not exist: $backup_path"
fi

###############################################################################
# DIRECTORY LAYOUT
###############################################################################

vm_base_dir="$backup_path/$vm_name"
lock_dir="$backup_path/in_progress_backups"

# All possible schedule types
ALL_SCHEDULES=("daily" "weekly" "monthly" "once" "custom")

###############################################################################
# CLEANUP FUNCTION FOR A SINGLE SCHEDULE
###############################################################################

cleanup_schedule() {
    local schedule="$1"
    local backup_dir="$vm_base_dir/$schedule"
    
    # Skip if directory doesn't exist
    if [[ ! -d "$backup_dir" ]]; then
        return 0
    fi
    
    # Check if there are any partial files
    local partial_files=$(find "$backup_dir" -type f -name "*.partial" 2>/dev/null)
    
    if [[ -z "$partial_files" ]]; then
        # No partial files, nothing to cleanup for this schedule
        return 0
    fi
    
    echo ""
    echo -e "${Cyan}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${Cyan}  Found partial files in: ${Yellow}${schedule}${NC}"
    echo -e "${Cyan}═══════════════════════════════════════════════════════════════${NC}"
    echo ""
    
    # Safety check 1: Verify no tmux session exists for this schedule
    local sanitized_vm=$(echo "$vm_name" | sed 's/[^a-zA-Z0-9-]/_/g')
    local tmux_session="${sanitized_vm}_${schedule}_backup"
    
    if tmux has-session -t "$tmux_session" 2>/dev/null; then
        warn "Skipping ${schedule}: Active tmux session '${tmux_session}' exists"
        warn "A backup is currently running for this schedule"
        return 1
    fi
    info "✓ No tmux session found for ${schedule}"
    
    # Safety check 2: Verify no lock file exists for this schedule
    local lock_file="$lock_dir/${vm_name}_${schedule}_backup"
    if [[ -f "$lock_file" ]]; then
        warn "Skipping ${schedule}: Lock file exists at ${lock_file}"
        warn "A backup process has the lock for this schedule"
        return 1
    fi
    info "✓ No lock file found for ${schedule}"
    
    # All safety checks passed - proceed with cleanup
    echo ""
    info "Safety checks passed for ${schedule}. Cleaning up..."
    echo ""
    
    # Count and remove partial files
    local partial_count=0
    echo "$partial_files" | while read -r partial_file; do
        if [[ -f "$partial_file" ]]; then
            info "  Removing: $(basename "$partial_file")"
            rm -f "$partial_file"
            ((partial_count++))
        fi
    done
    
    local actual_count=$(echo "$partial_files" | wc -l)
    info "✓ Removed ${actual_count} partial file(s) from ${schedule}"
    echo ""
    
    # Smart checkpoint cleanup: Only remove the latest checkpoint files
    if command -v virtnbdrestore &>/dev/null; then
        info "Analyzing backup chain for ${schedule}..."
        
        # Use virtnbdrestore to get backup metadata
        local metadata=$(virtnbdrestore -i "$backup_dir" -o dump 2>/dev/null | grep -A 20 '"checkpointName"' || true)
        
        if [[ -n "$metadata" ]]; then
            # Extract the latest checkpoint name (highest number)
            local latest_checkpoint=$(echo "$metadata" | grep -o '"checkpointName": "virtnbdbackup\.[0-9]*"' | \
                grep -o 'virtnbdbackup\.[0-9]*' | sort -t. -k2 -n | tail -n1)
            
            if [[ -n "$latest_checkpoint" ]]; then
                info "Latest checkpoint: ${Blue}${latest_checkpoint}${NC}"
                info "Removing only the latest checkpoint files..."
                echo ""
                
                local removed_count=0
                for ckpt_file in "$backup_dir"/*"${latest_checkpoint}"*; do
                    if [[ -f "$ckpt_file" ]]; then
                        info "  Removing: $(basename "$ckpt_file")"
                        rm -f "$ckpt_file"
                        ((removed_count++))
                    fi
                done
                
                if [[ $removed_count -gt 0 ]]; then
                    echo ""
                    info "✓ Removed ${removed_count} checkpoint file(s) for ${latest_checkpoint}"
                    info "✓ Older checkpoints preserved (backup chain intact)"
                else
                    info "✓ No checkpoint files found for ${latest_checkpoint}"
                fi
            else
                info "✓ No checkpoints found in backup metadata"
            fi
        else
            info "✓ Could not read backup metadata (might be first backup)"
        fi
    else
        info "✓ virtnbdrestore not available, skipping checkpoint cleanup"
    fi
    
    echo ""
    echo -e "${Green}✓ Cleanup completed for ${schedule}${NC}"
    
    return 0
}

###############################################################################
# MAIN EXECUTION
###############################################################################

echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║         Backup Cleanup Tool - All Schedules Scanner           ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
echo "VM Name:       $vm_name"
echo "Backup Path:   $backup_path"
echo "VM Base Dir:   $vm_base_dir"
echo ""

# Check if VM base directory exists
if [[ ! -d "$vm_base_dir" ]]; then
    echo ""
    echo -e "${Yellow}${WARNING} No backup directory found for VM '${vm_name}'${NC}"
    echo ""
    echo "Expected directory: $vm_base_dir"
    echo ""
    echo -e "${Blue}This VM has no backups in this storage pool.${NC}"
    echo ""
    exit 10  # Special exit code: no backups found
fi

echo "Scanning all schedule types for partial files..."
echo ""

# Track statistics
total_cleaned=0
total_skipped=0
total_empty=0

# Iterate through all schedule types
for schedule in "${ALL_SCHEDULES[@]}"; do
    backup_dir="$vm_base_dir/$schedule"
    
    # Check if directory exists
    if [[ ! -d "$backup_dir" ]]; then
        ((total_empty++))
        continue
    fi
    
    # Check if there are partial files
    partial_files=$(find "$backup_dir" -type f -name "*.partial" 2>/dev/null)
    
    if [[ -z "$partial_files" ]]; then
        ((total_empty++))
        continue
    fi
    
    # Cleanup this schedule
    if cleanup_schedule "$schedule"; then
        ((total_cleaned++))
    else
        ((total_skipped++))
    fi
done

# Print summary
echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║                      CLEANUP SUMMARY                           ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

if [[ $total_cleaned -gt 0 ]]; then
    echo -e "${Green}✓ Cleaned up: ${total_cleaned} schedule(s)${NC}"
fi

if [[ $total_skipped -gt 0 ]]; then
    echo -e "${Yellow}⚠ Skipped: ${total_skipped} schedule(s) (backup running)${NC}"
fi

if [[ $total_empty -gt 0 ]]; then
    echo -e "${Cyan}ℹ No partial files: ${total_empty} schedule(s)${NC}"
fi

echo ""

if [[ $total_cleaned -eq 0 && $total_skipped -eq 0 ]]; then
    echo -e "${Blue}No cleanup needed. No partial files found in any schedule type.${NC}"
    echo -e "${Green}✓ Backup is healthy - no issues detected.${NC}"
    exit 11  # Special exit code: no cleanup needed (healthy backup)
elif [[ $total_cleaned -gt 0 ]]; then
    echo -e "${Green}Cleanup completed successfully!${NC}"
    echo -e "${Yellow}Note: This cleanup did NOT start any backups.${NC}"
    echo -e "${Yellow}You must manually trigger new backups or wait for scheduled backups.${NC}"
    exit 0  # Success - cleaned something
elif [[ $total_skipped -gt 0 ]]; then
    echo -e "${Yellow}All schedules with partial files are currently running.${NC}"
    echo -e "${Yellow}Please wait for backups to complete before retrying cleanup.${NC}"
    exit 2  # Warning - skipped some due to running backups
fi

echo ""
