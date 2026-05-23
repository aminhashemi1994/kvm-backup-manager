#!/bin/bash

###############################################################################
# Restore_Manager.sh — VM Restore with Progress Tracking (Fixed)
# Matches backup_manager.sh progress metadata format.
###############################################################################

set -euo pipefail

# Source temporary directory configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/tmp_dirs.sh"

# ─── Defaults ────────────────────────────────────────────────────────────────
vm_name=""
backup_path=""
restore_path=""
method=""
until_checkpoint=""
disk=""
restore_id=""
progress_file=""
events_file=""
progress_metadata_dir=""
log_file=""
archive_name=""
is_archived_backup=false

# ─── Argument parsing ────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        --domain)         vm_name="$2";          shift 2 ;;
        --method)         method="$2";           shift 2 ;;
        --backup-path)    backup_path="$2";      shift 2 ;;
        --restore-path)   restore_path="$2";     shift 2 ;;
        --until)          until_checkpoint="$2"; shift 2 ;;
        --disk)           disk="$2";             shift 2 ;;
        --restore-id)     restore_id="$2";       shift 2 ;;
        --progress-file)  progress_file="$2";    shift 2 ;;
        --events-file)    events_file="$2";      shift 2 ;;
        --log-file)       log_file="$2";         shift 2 ;;
        *) echo "Unknown parameter: $1"; exit 1 ;;
    esac
done

# ─── Color codes ──────────────────────────────────────────────────────────────
: "${Red:=\033[0;31m}"
: "${Green:=\033[0;32m}"
: "${Yellow:=\033[1;33m}"
: "${Cyan:=\033[0;36m}"
: "${Bold:=\033[1m}"
: "${Dim:=\033[2m}"
: "${NC:=\033[0m}"
: "${CROSS:=✗}"
: "${CHECK:=✓}"
: "${WARNING:=⚠}"

###############################################################################
# JSON HELPER — safely escapes a string for JSON
###############################################################################
json_escape() {
    local s="${1-}"  # default to empty string if unset
    s="${s//\\/\\\\}"   # backslash -> double backslash
    s="${s//\"/\\\"}"   # quote -> backslash quote
    s="${s//$'\n'/\\n}" # newline -> \n
    s="${s//$'\t'/\\t}" # tab -> \t
    echo "$s"
}

###############################################################################
# OUTPUT HELPERS
###############################################################################

# Log to both console and log file
log_output() {
    local msg="$1"
    echo -e "$msg"
    if [[ -n "$log_file" ]]; then
        echo -e "$msg" | sed 's/\x1b\[[0-9;]*m//g' >> "$log_file" 2>/dev/null || true
    fi
}

die() {
    local msg="${Red}${CROSS} $1${NC}"
    log_output "$msg" >&2
    # Emit a fatal event
    if [[ -n "$events_file" ]]; then
        mkdir -p "$(dirname "$events_file")" 2>/dev/null || true
        local ts
        ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
        printf '{"timestamp":"%s","event":"restore_failed","status":"error","domain":"%s","message":"%s"}\n' \
            "$ts" "$vm_name" "$(json_escape "$1")" >>"$events_file" 2>/dev/null || true
    fi
    # Write final progress as error
    write_progress 0 "Restore failed: $1"
    exit 1
}

warn() {
    log_output "${Yellow}${WARNING} $1${NC}"
}

info() {
    log_output "${Green}${CHECK} $1${NC}"
}

# Emit a structured JSON event line (optional but useful)
emit_event() {
    [[ -z "$events_file" ]] && return 0
    mkdir -p "$(dirname "$events_file")" 2>/dev/null || true
    local event="$1" status="$2" message="$3"
    shift 3
    local extra=""
    for kv in "$@"; do
        local key="${kv%%=*}" val="${kv#*=}"
        extra+=", \"${key}\":\"$(json_escape "$val")\""
    done
    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    printf '{"timestamp":"%s","event":"%s","status":"%s","domain":"%s","message":"%s"%s}\n' \
        "$ts" "$event" "$status" "$vm_name" "$(json_escape "$message")" "$extra" \
        >>"$events_file" 2>/dev/null || true
}

# Write simple progress metadata (matching backup_manager.sh format):
# {"percentage":42,"text":"…","type":"restore","timestamp":"…"}
write_progress() {
    [[ -z "$progress_file" ]] && return 0
    mkdir -p "$(dirname "$progress_file")" 2>/dev/null || true
    local pct="${1-0}"
    local text="${2-}"
    local type="${3:-restore}"
    local ts
    ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Escape percentage and text
    text=$(json_escape "$text")
    # Note: pct is numeric, no escaping needed
    printf '{"percentage":%d,"text":"%s","type":"%s","timestamp":"%s"}\n' \
        "$pct" "$text" "$type" "$ts" > "$progress_file" 2>/dev/null || true
}

cleanup_progress_file() {
    if [[ -n "$progress_file" && -f "$progress_file" ]]; then
        rm -f "$progress_file" 2>/dev/null || true
    fi
}

###############################################################################
# VALIDATION
###############################################################################

validate_inputs() {
    info "Validating restore parameters..."
    [[ -z "$vm_name" ]]       && die "'--domain' is required"
    [[ -z "$backup_path" ]]   && die "'--backup-path' is required"
    [[ -z "$restore_path" ]]  && die "'--restore-path' is required"
    [[ -z "$method" ]]        && die "'--method' is required"
    [[ -z "$restore_id" ]]    && die "'--restore-id' is required"

    # Detect if this is an archived backup
    # Method can be:
    # 1. "archived_{archive_name}" - e.g., "archived_2026-05-05_09-54-00_vmname_daily"
    # 2. Regular schedule name but backup_path points to archived directory
    if [[ "$method" =~ ^archived_ ]]; then
        is_archived_backup=true
        archive_name="${method#archived_}"
        info "Detected archived backup: $archive_name"
        
        # Extract original schedule from archive name
        # Format: {timestamp}_{vm_name}_{original_schedule}
        # Example: 2026-05-05_09-54-00_20251201-084842204304931-99_test-tartanak-edge2_daily
        local original_schedule
        original_schedule=$(echo "$archive_name" | rev | cut -d'_' -f1 | rev)
        
        if [[ -n "$original_schedule" ]]; then
            info "Original schedule extracted: $original_schedule"
            # Update backup_path to point to the archived directory
            # If backup_path is like: /path/backup/vm_name/archived
            # We need: /path/backup/vm_name/archived/{archive_name}
            if [[ "$backup_path" =~ /archived$ ]]; then
                backup_path="$backup_path/$archive_name"
            elif [[ ! "$backup_path" =~ /archived/ ]]; then
                # If backup_path doesn't contain archived, construct it
                local vm_backup_base
                vm_backup_base=$(dirname "$backup_path")
                backup_path="$vm_backup_base/archived/$archive_name"
            fi
        fi
    elif [[ "$backup_path" =~ /archived/ ]]; then
        # backup_path contains "archived" but method doesn't have prefix
        is_archived_backup=true
        # Extract archive name from path
        archive_name=$(basename "$backup_path")
        info "Detected archived backup from path: $archive_name"
    fi

    [[ -d "$backup_path" ]]   || die "Backup directory not found: $backup_path"
    command -v virtnbdrestore &>/dev/null || die "virtnbdrestore not installed"

    # Setup log file (if not provided)
    if [[ -z "$log_file" ]]; then
        local base
        base=$(dirname "$(dirname "$backup_path")")
        log_file="$base/.progress/${vm_name}_restore_${restore_id}.log"
    fi
    mkdir -p "$(dirname "$log_file")" 2>/dev/null || true
    
    # Setup progress file (if not provided)
    if [[ -z "$progress_file" ]]; then
        # backup_path is like .../backup/vm_name/daily  -> we want .../backup/.progress/{vm_name}_restore.progress
        local base
        base=$(dirname "$(dirname "$backup_path")")    # go up two levels (vm_name and schedule)
        progress_metadata_dir="$base/.progress"
        progress_file="$progress_metadata_dir/${vm_name}_restore.progress"
    else
        # Ensure directory exists
        local pdir
        pdir=$(dirname "$progress_file")
        mkdir -p "$pdir" 2>/dev/null || true
        progress_metadata_dir="$pdir"
    fi
    mkdir -p "$progress_metadata_dir" 2>/dev/null

    info "Backup path: $backup_path"
    if [[ "$is_archived_backup" == "true" ]]; then
        info "Restoring from ARCHIVED backup"
        info "Archive name: $archive_name"
    fi
    info "Progress file: $progress_file"
    info "Log file: $log_file"
    write_progress 0 "Starting restore..." "restore"
    emit_event "restore_validated" "info" "Parameters validated"
}

###############################################################################
# LOCK FILE (re-uses backup locks to prevent concurrent backup+restore)
###############################################################################

create_lock_file() {
    local lock_dir="$(dirname "$(dirname "$backup_path")")/in_progress_backups"
    mkdir -p "$lock_dir" 2>/dev/null || true
    local lock_file="$lock_dir/${vm_name}_${method}_backup"
    if [[ -f "$lock_file" ]]; then
        die "A backup operation is already in progress for ${vm_name}/${method}. Cannot restore."
    fi
    # Write restore lock
    echo "restore:${restore_id}:$(date -u +"%Y-%m-%dT%H:%M:%SZ")" >"$lock_file"
    info "Created lock file: $lock_file"
    emit_event "lock_created" "info" "Lock created"
    # Store for cleanup in organized directory
    echo "$lock_file" > "$RESTORE_TMP_LOCKS/restore_lock_${restore_id}.txt"
}

remove_lock_file() {
    local lock_path
    if [[ -f "$RESTORE_TMP_LOCKS/restore_lock_${restore_id}.txt" ]]; then
        lock_path=$(cat "$RESTORE_TMP_LOCKS/restore_lock_${restore_id}.txt")
        rm -f "$lock_path" 2>/dev/null || true
        info "Removed lock file: $lock_path"
        rm -f "$RESTORE_TMP_LOCKS/restore_lock_${restore_id}.txt"
    fi
}

###############################################################################
# SPACE CHECK (unchanged)
###############################################################################

check_restore_space() {
    info "Checking disk space..."
    local restore_dir
    restore_dir=$(dirname "$restore_path")
    local avail_gb
    avail_gb=$(df -BG "$restore_dir" | awk 'NR>1 {gsub(/G/,"",$4); print $4}')
    local back_size_bytes back_size_gb
    back_size_bytes=$(du -sb "$backup_path" | awk '{print $1}')
    back_size_gb=$(( back_size_bytes / 1073741824 + 1 ))
    local required_gb=$(( back_size_gb * 2 ))   # rough estimate with buffer
    info "Available: ${avail_gb} GB, Required: ${required_gb} GB"
    if [[ $avail_gb -lt $required_gb ]]; then
        die "Insufficient space: have ${avail_gb}G, need ~${required_gb}G"
    fi
}

###############################################################################
# PROGRESS BAR & PARSING (aggregate across disks)
###############################################################################

get_terminal_width() { tput cols 2>/dev/null || echo 80; }

human_to_bytes() {
    local val="$1" num unit
    num=$(echo "$val" | sed 's/[^0-9.]//g')
    unit=$(echo "$val" | sed 's/[0-9.]//g; s/iB$//; s/B$//' | tr '[:lower:]' '[:upper:]')
    case "$unit" in
        K) echo "$num * 1024" | bc | cut -d. -f1 ;;
        M) echo "$num * 1048576" | bc | cut -d. -f1 ;;
        G) echo "$num * 1073741824" | bc | cut -d. -f1 ;;
        T) echo "$num * 1099511627776" | bc | cut -d. -f1 ;;
        *) echo "${num%.*}" ;;
    esac
}

bytes_to_human() {
    local b="$1"
    if [[ $b -ge 1099511627776 ]]; then echo "$(echo "scale=2; $b/1099511627776" | bc)T"
    elif [[ $b -ge 1073741824 ]]; then echo "$(echo "scale=2; $b/1073741824" | bc)G"
    elif [[ $b -ge 1048576 ]]; then echo "$(echo "scale=2; $b/1048576" | bc)M"
    elif [[ $b -ge 1024 ]]; then echo "$(echo "scale=2; $b/1024" | bc)K"
    else echo "${b}B"
    fi
}

# Parse a virtnbdrestore progress line, sets global vars: _disk, _pct, _xferred, _total, _speed, _eta
parse_progress_line() {
    local line="$1"
    _disk="" _pct="" _xferred="" _total="" _speed="" _eta=""
    if [[ "$line" =~ restoring\ disk\ \[([a-zA-Z0-9_-]+)\]:\ *([0-9]+)%\|[^|]*\|\ *([0-9.]+[KMGTP]i?B?)/([0-9.]+[KMGTP]i?B?)\ *\[([0-9:]+)\<([0-9:]+),\ *([0-9.]+[KMGTP]i?B?/s)\] ]]; then
        _disk="${BASH_REMATCH[1]}"
        _pct="${BASH_REMATCH[2]}"
        _xferred="${BASH_REMATCH[3]}"
        _total="${BASH_REMATCH[4]}"
        _speed="${BASH_REMATCH[7]}"
        _eta="${BASH_REMATCH[6]}"
        return 0
    elif [[ "$line" =~ restoring\ disk\ \[([a-zA-Z0-9_-]+)\]:\ *([0-9]+)% ]]; then
        _disk="${BASH_REMATCH[1]}"
        _pct="${BASH_REMATCH[2]}"
        return 0
    fi
    return 1
}

draw_aggregate_bar() {
    local pct="$1" xferred="$2" total="$3" disk_status="$4" speed="$5" eta="$6"
    local tw=$(get_terminal_width)

    if [[ $pct -lt 0 ]]; then pct=0; fi
    if [[ $pct -gt 100 ]]; then pct=100; fi

    local suffix
    if [[ -n "$speed" && -n "$eta" ]]; then
        suffix=$(printf " %3d%%  %s/%s  %s  ETA:%s  [%s]" "$pct" "$xferred" "$total" "$speed" "$eta" "$disk_status")
    else
        suffix=$(printf " %3d%%  %s/%s  [%s]" "$pct" "$xferred" "$total" "$disk_status")
    fi
    local suffix_len=${#suffix}
    local bar_prefix="  ▐"
    local bar_suffix="▌"
    local reserved=$((${#bar_prefix} + ${#bar_suffix} + suffix_len + 2))
    local bar_width=$((tw - reserved))
    [[ $bar_width -lt 10 ]] && bar_width=10
    [[ $bar_width -gt 60 ]] && bar_width=60

    local filled=$(( bar_width * pct / 100 ))
    local empty=$(( bar_width - filled ))
    local bar_filled bar_empty
    bar_filled=$(printf '█%.0s' $(seq 1 $filled))
    bar_empty=$(printf '░%.0s' $(seq 1 $empty))

    local bar_color="$Cyan"
    [[ $pct -ge 100 ]] && bar_color="$Green"

    printf "\r${bar_color}${bar_prefix}%s%s${bar_suffix}${Bold}%s${NC}" \
        "$bar_filled" "$bar_empty" "$suffix"
}

###############################################################################
# MAIN RESTORE EXECUTION WITH PROGRESS
###############################################################################

track_restore_progress() {
    local start_time=$(date +%s)

    # Aggregate tracking
    declare -A disk_pct disk_xferred_bytes disk_total_bytes disk_speed disk_eta
    declare -a disk_order
    local last_metadata_pct=-1
    local progress_shown=false
    local last_update=0

    # Temporary files in organized directories
    local detail_log="$RESTORE_TMP_LOGS/restore_${restore_id}_detail.log"
    local exit_code_file="$RESTORE_TMP_EXIT/restore_exit_${restore_id}.code"
    rm -f "$exit_code_file"

    info "Starting virtnbdrestore ..."
    write_progress 0 "Starting restore" "restore"
    emit_event "restore_start" "info" "Restore started" "restore_id=$restore_id"

    # Build command array
    local cmd_array=(virtnbdrestore -i "$backup_path" -o "$restore_path")
    [[ -n "$until_checkpoint" ]] && cmd_array+=(--until "$until_checkpoint")
    [[ -n "$disk" ]] && cmd_array+=(-d "$disk")

    local fifo
    fifo="$RESTORE_TMP_FIFOS/.virtnbd_restore_${restore_id}"
    rm -f "$fifo" 2>/dev/null || true
    mkfifo "$fifo"

    # Run virtnbdrestore in background, redirect to FIFO
    ("${cmd_array[@]}" >"$fifo" 2>&1; echo $? >"$exit_code_file") &
    local bg_pid=$!

    # Read FIFO character by character (handle \r rewrites)
    local char line_buf=""
    local _disk _pct _xferred _total _speed _eta

    while IFS= read -r -n1 -d '' char || {
        # process remaining buffer on EOF
        if [[ -n "$line_buf" ]]; then
            echo "$line_buf" >> "$detail_log"
            if parse_progress_line "$line_buf"; then
                _update_aggregate
            fi
            line_buf=""
        fi
        false
    }; do
        case "$char" in
            $'\r'|$'\n')
                if [[ -n "$line_buf" ]]; then
                    echo "$line_buf" >> "$detail_log"
                    if parse_progress_line "$line_buf"; then
                        _update_aggregate
                    fi
                fi
                line_buf=""
                ;;
            *) line_buf+="$char" ;;
        esac
    done <"$fifo"

    wait "$bg_pid" 2>/dev/null || true
    local exit_code=1
    [[ -f "$exit_code_file" ]] && exit_code=$(cat "$exit_code_file") && rm -f "$exit_code_file"
    rm -f "$fifo"

    # Finalize display
    if [[ "$progress_shown" == "true" ]]; then echo ""; fi

    local end_time=$(date +%s)
    local duration=$((end_time - start_time))
    local dur_fmt=$(printf '%02d:%02d:%02d' $((duration/3600)) $((duration%3600/60)) $((duration%60)))

    if [[ $exit_code -eq 0 ]]; then
        # Final 100% update
        local last_disk="${disk_order[-1]}"
        local total_xferred=$(bytes_to_human $( sum_bytes "${disk_xferred_bytes[@]}" ))
        local total_disk=$(bytes_to_human $( sum_bytes "${disk_total_bytes[@]}" ))
        draw_aggregate_bar 100 "$total_xferred" "$total_disk" "$(get_disk_status)" "" ""
        echo ""
        write_progress 100 "Restore completed in ${dur_fmt}" "restore"
        emit_event "restore_completed" "success" "Restore succeeded" "duration=$dur_fmt"
        info "Restore completed in $dur_fmt"
    else
        write_progress 0 "Restore failed (exit code $exit_code)" "restore"
        emit_event "restore_failed" "error" "Restore failed" "exit_code=$exit_code" "duration=$dur_fmt"
        # Retrieve last few lines of log for error message
        local err_msg
        err_msg=$(tail -5 "$detail_log" 2>/dev/null | tr '\n' '; ')
        die "Restore failed (code $exit_code). Last output: $err_msg"
    fi
}

# Internal helper: sum an array of numbers
sum_bytes() { local s=0 b; for b in "$@"; do s=$((s + b)); done; echo $s; }

# Build disk status string for the bar
get_disk_status() {
    local parts=()
    for d in "${disk_order[@]}"; do
        local dpct="${disk_pct[$d]:-0}"
        local icon="◉"
        [[ $dpct -ge 100 ]] && icon="✓"
        parts+=("${d} ${dpct}% ${icon}")
    done
    local IFS='|'; echo "${parts[*]}" | sed 's/|/ | /g'
}

_update_aggregate() {
    # Update per-disk arrays
    local disk="$_disk" pct="$_pct" xferred="$_xferred" total="$_total" speed="$_speed" eta="$_eta"
    if [[ -z "${disk_pct[$disk]+_}" ]]; then
        disk_order+=("$disk")
    fi
    disk_pct["$disk"]="$pct"
    disk_xferred_bytes["$disk"]=$(human_to_bytes "$xferred")
    disk_total_bytes["$disk"]=$(human_to_bytes "$total")
    disk_speed["$disk"]="$speed"
    disk_eta["$disk"]="$eta"

    # Compute aggregate
    local total_xferred=0 total_total=0
    for d in "${disk_order[@]}"; do
        total_xferred=$(( total_xferred + ${disk_xferred_bytes[$d]:-0} ))
        total_total=$(( total_total + ${disk_total_bytes[$d]:-0} ))
    done
    local overall_pct=0
    [[ $total_total -gt 0 ]] && overall_pct=$(( total_xferred * 100 / total_total ))
    [[ $overall_pct -gt 100 ]] && overall_pct=100

    local overall_xferred_h overall_total_h
    overall_xferred_h=$(bytes_to_human $total_xferred)
    overall_total_h=$(bytes_to_human $total_total)

    draw_aggregate_bar "$overall_pct" "$overall_xferred_h" "$overall_total_h" "$(get_disk_status)" "$speed" "$eta"
    progress_shown=true

    # Throttle metadata writes every 2% change (or at 100%)
    if [[ $overall_pct -ge 100 && $last_metadata_pct -lt 100 ]] || (( overall_pct - last_metadata_pct >= 2 )); then
        last_metadata_pct=$overall_pct
        local text
        text="Restoring $vm_name: ${overall_xferred_h}/${overall_total_h} @ ${speed} ETA:${eta}"
        write_progress "$overall_pct" "$text" "restore"
    fi
}

###############################################################################
# CLEANUP AND SIGNAL HANDLING
###############################################################################

# Global flag to track if we're in cleanup
CLEANUP_IN_PROGRESS=false

# Cleanup function - called on exit, interrupt, or termination
cleanup() {
    # Prevent recursive cleanup
    if [[ "$CLEANUP_IN_PROGRESS" == "true" ]]; then
        return 0
    fi
    CLEANUP_IN_PROGRESS=true
    
    local exit_code=$?
    
    log_output "${Yellow}Cleaning up restore resources...${NC}"
    
    # Kill any running virtnbdrestore processes for this restore
    if [[ -n "$restore_id" ]]; then
        local pids
        pids=$(pgrep -f "virtnbdrestore.*$restore_path" 2>/dev/null || true)
        if [[ -n "$pids" ]]; then
            log_output "Killing virtnbdrestore processes: $pids"
            kill -TERM $pids 2>/dev/null || true
            sleep 2
            # Force kill if still running
            pids=$(pgrep -f "virtnbdrestore.*$restore_path" 2>/dev/null || true)
            if [[ -n "$pids" ]]; then
                kill -KILL $pids 2>/dev/null || true
            fi
        fi
    fi
    
    # Remove lock file
    remove_lock_file
    
    # Clean up temporary files from organized directories
    if [[ -n "$restore_id" ]]; then
        rm -f "$RESTORE_TMP_LOGS/restore_${restore_id}_detail.log" 2>/dev/null || true
        rm -f "$RESTORE_TMP_EXIT/restore_exit_${restore_id}.code" 2>/dev/null || true
        rm -f "$RESTORE_TMP_LOCKS/restore_lock_${restore_id}.txt" 2>/dev/null || true
        
        # Remove FIFO if exists
        local fifo="$RESTORE_TMP_FIFOS/.virtnbd_restore_${restore_id}"
        if [[ -p "$fifo" ]]; then
            rm -f "$fifo" 2>/dev/null || true
        fi
    fi
    
    # Clean up progress file only if restore failed or was interrupted
    if [[ $exit_code -ne 0 ]]; then
        log_output "Restore did not complete successfully (exit code: $exit_code)"
        cleanup_progress_file
        
        # Write final error state to progress
        if [[ -n "$progress_file" ]]; then
            write_progress 0 "Restore interrupted or failed" "restore"
        fi
        
        # Emit failure event
        if [[ -n "$events_file" ]]; then
            emit_event "restore_cleanup" "error" "Restore interrupted or failed" "exit_code=$exit_code"
        fi
    fi
    
    log_output "${Green}Cleanup completed${NC}"
}

# Signal handlers
handle_sigterm() {
    log_output "${Red}Received SIGTERM - terminating restore...${NC}"
    write_progress 0 "Restore terminated by SIGTERM" "restore"
    emit_event "restore_terminated" "error" "Received SIGTERM signal"
    exit 143  # 128 + 15 (SIGTERM)
}

handle_sigint() {
    log_output "${Red}Received SIGINT (Ctrl+C) - cancelling restore...${NC}"
    write_progress 0 "Restore cancelled by user" "restore"
    emit_event "restore_cancelled" "error" "Received SIGINT signal"
    exit 130  # 128 + 2 (SIGINT)
}

handle_sighup() {
    log_output "${Red}Received SIGHUP - terminal disconnected...${NC}"
    write_progress 0 "Restore interrupted by SIGHUP" "restore"
    emit_event "restore_interrupted" "error" "Received SIGHUP signal"
    exit 129  # 128 + 1 (SIGHUP)
}

# Set up traps for all signals
trap cleanup EXIT
trap handle_sigterm SIGTERM
trap handle_sigint SIGINT
trap handle_sighup SIGHUP

###############################################################################
# MAIN
###############################################################################

main() {
    local header="${Bold}╔════════════════════════════════════════╗${NC}"
    local title="${Bold}║        VM RESTORE MANAGER             ║${NC}"
    local footer="${Bold}╚════════════════════════════════════════╝${NC}"
    local separator="${Bold}───────────────────────────────────────${NC}"
    
    log_output "$header"
    log_output "$title"
    log_output "$footer"
    log_output "$(printf "${Bold}║${NC} %-12s: %s\n" "VM" "$vm_name")"
    log_output "$(printf "${Bold}║${NC} %-12s: %s\n" "Method" "$method")"
    log_output "$(printf "${Bold}║${NC} %-12s: %s\n" "Backup" "$backup_path")"
    log_output "$(printf "${Bold}║${NC} %-12s: %s\n" "Restore" "$restore_path")"
    log_output "$(printf "${Bold}║${NC} %-12s: %s\n" "ID" "$restore_id")"
    log_output "$separator"

    validate_inputs
    check_restore_space
    create_lock_file
    track_restore_progress
    log_output "${Green}${Bold}Restore finished successfully.${NC}"
}

main "$@"