#!/bin/bash
###############################################################################
# backup_info.sh — Scan ALL VM backups and emit a complete JSON report.
# Usage: bash backup_info.sh --backup-paths "/path1,/path2,/path3"
###############################################################################

# Absolutely no set -e/-u/pipefail — handle everything explicitly
set +e +u +o pipefail 2>/dev/null

# Source temporary directory configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/tmp_dirs.sh"

# ── Debug log ────────────────────────────────────────────────────────────────
DEBUG_LOG="$BACKUP_TMP_LOGS/backup_info_debug_$$.log"
: >"$DEBUG_LOG" 2>/dev/null

_log() { echo "[$(date '+%H:%M:%S')] $*" >>"$DEBUG_LOG" 2>/dev/null; }
_log "START pid=$$"

###############################################################################
# ARGUMENT PARSING
###############################################################################

backup_paths=""

while [[ $# -gt 0 ]]; do
    case "$1" in
    --backup-paths)
        backup_paths="$2"
        shift 2
        ;;
    *)
        echo '{"error":"Unknown parameter: '"$1"'"}'
        exit 1
        ;;
    esac
done

if [[ -z "$backup_paths" ]]; then
    echo '{"error":"--backup-paths is required (comma-separated list)"}'
    exit 1
fi

if ! command -v virtnbdrestore >/dev/null 2>&1; then
    echo '{"error":"virtnbdrestore not installed"}'
    exit 1
fi

_log "backup_paths=$backup_paths"

###############################################################################
# CONSTANTS
###############################################################################

NON_VM_NAMES="in_progress_backups offsite_locks metrics restore logs archived TPM scheduler current Error.log Execution.log backup_scheduler.run backup_scheduler.sh backup_manager.sh backup_info.sh setting.sh old_json"
SCHEDULE_NAMES="daily weekly monthly once custom"

WORK_DIR="$BACKUP_TMP_VMDATA/.bkinfo_$$"
mkdir -p "$WORK_DIR" 2>/dev/null
_log "WORK_DIR=$WORK_DIR"

trap 'rm -rf "$WORK_DIR" 2>/dev/null' EXIT

HAS_JQ="no"
command -v jq >/dev/null 2>&1 && HAS_JQ="yes"
_log "HAS_JQ=$HAS_JQ"

###############################################################################
# MINIMAL SAFE HELPERS
###############################################################################

_is_non_vm() {
    local name="${1:-}"
    local n
    for n in $NON_VM_NAMES; do
        [[ "$name" == "$n" ]] && return 0
    done
    return 1
}

_is_vm_dir() {
    local p="${1:-}"
    [[ -d "$p" ]] || return 1
    local name
    name="$(basename "$p" 2>/dev/null)" || return 1
    _is_non_vm "$name" && return 1
    # Starts with 20YYXXX-
    [[ "$name" =~ ^20[0-9]{2}[0-9]{3,6}[-_] ]] && return 0
    # Has schedule subdirs
    local s
    for s in $SCHEDULE_NAMES; do
        [[ -d "$p/$s" ]] && return 0
    done
    # Has data files
    _has_data "$p" && return 0
    return 1
}

_has_data() {
    local d="${1:-}"
    [[ -d "$d" ]] || return 1
    local r
    # Only check root level, NOT current subdirectory (that's handled separately)
    r=$(find "$d" -maxdepth 1 -type f \( -name "*.data" -o -name "*.full.*" -o -name "*.inc.*" -o -name "*.copy.*" \) -print -quit 2>/dev/null) || true
    [[ -n "${r:-}" ]] && return 0
    return 1
}

_find_data_dir() {
    local d="${1:-}"
    local r
    # Only check root level for legacy backups
    r=$(find "$d" -maxdepth 1 -type f \( -name "*.data" -o -name "*.full.*" -o -name "*.inc.*" -o -name "*.copy.*" \) -print -quit 2>/dev/null) || true
    [[ -n "${r:-}" ]] && { echo "$d"; return 0; }
    echo "$d"
    return 1
}

_dir_bytes() {
    local r
    r=$(du -sb "${1:-/dev/null}" 2>/dev/null | awk '{print $1}') || r="0"
    [[ "${r:-0}" =~ ^[0-9]+$ ]] || r="0"
    echo "$r"
}

_gb() {
    awk -v b="${1:-0}" 'BEGIN{printf "%.3f GB",b/1073741824}' 2>/dev/null || echo "0.000 GB"
}

# JSON string escape — MUST handle any input safely
_js() {
    local s="${1:-}"
    if [[ "$HAS_JQ" == "yes" ]]; then
        printf '%s' "$s" | jq -Rs '.' 2>/dev/null || echo '""'
    else
        s="${s//\\/\\\\}"
        s="${s//\"/\\\"}"
        s="${s//$'\n'/\\n}"
        s="${s//$'\r'/\\r}"
        s="${s//$'\t'/\\t}"
        printf '"%s"' "$s"
    fi
}

###############################################################################
# INFER METHODS → ["full","inc"] etc
###############################################################################

_infer_methods() {
    local dir="${1:-}"
    local hf="n" hi="n" hc="n" bn
    while IFS= read -r -d '' f; do
        bn="$(basename "$f" 2>/dev/null)" || continue
        [[ "$bn" == *.full.* ]] && hf="y"
        [[ "$bn" == *.inc.*  ]] && hi="y"
        [[ "$bn" == *.copy.* ]] && hc="y"
    done < <(find "$dir" -maxdepth 1 -type f \( -name "*.data" -o -name "*.full.*" -o -name "*.inc.*" -o -name "*.copy.*" \) -print0 2>/dev/null)
    local out='['
    local first="y"
    [[ "$hf" == "y" ]] && { [[ "$first" == "n" ]] && out+=','; out+='"full"'; first="n"; }
    [[ "$hi" == "y" ]] && { [[ "$first" == "n" ]] && out+=','; out+='"inc"'; first="n"; }
    [[ "$hc" == "y" ]] && { [[ "$first" == "n" ]] && out+=','; out+='"copy"'; first="n"; }
    [[ "$first" == "y" ]] && out+='"unknown"'
    echo "${out}]"
}

###############################################################################
# READ SCHEDULER → compact JSON array
###############################################################################

_read_sched() {
    local f="${1:-}"
    [[ -f "$f" ]] || { echo "[]"; return; }
    local out="[" first="y" line day dt meth
    while IFS= read -r line; do
        [[ "$line" =~ ^Day ]] && continue
        [[ "$line" =~ ^\*  ]] && continue
        [[ -z "${line//[[:space:]]/}" ]] && continue
        read -r day dt meth <<<"$line" 2>/dev/null || continue
        [[ -n "${day:-}" && -n "${dt:-}" && -n "${meth:-}" ]] || continue
        [[ "$first" == "n" ]] && out+=","
        out+="{\"day\":$(_js "$day"),\"date\":$(_js "$dt"),\"method\":$(_js "$meth")}"
        first="n"
    done <"$f" 2>/dev/null
    echo "${out}]"
}

###############################################################################
# EXTRACT JSON FROM virtnbdrestore OUTPUT
###############################################################################

_extract_json() {
    local raw="${1:-}"
    local started="n" line s
    local out=""
    while IFS= read -r line; do
        if [[ "$started" == "n" ]]; then
            s="${line#"${line%%[![:space:]]*}"}"
            if [[ "$s" == "[" ]] || [[ "$s" =~ ^\[\{ ]]; then
                started="y"
                out+="$s"$'\n'
            fi
        else
            out+="$line"$'\n'
        fi
    done <<<"$raw"
    [[ "$started" == "y" ]] || return 1
    printf '%s' "$out"
}

###############################################################################
# ANALYZE DUMP JSON — always compact single line
###############################################################################

_analyze() {
    local json="${1:-}"
    [[ -z "$json" ]] && { echo "null"; return 1; }

    if [[ "$HAS_JQ" == "yes" ]]; then
        local r
        r=$(printf '%s' "$json" | jq -c '
            def g(b): ((b/1073741824*1000|round)/1000)|tostring+" GB";
            group_by(.diskName) as $bd |
            ($bd|map({key:.[0].diskName,value:{
                disk_name:.[0].diskName,disk_format:.[0].diskFormat,
                virtual_size_bytes:.[0].virtualSize,virtual_size_gb:g(.[0].virtualSize),
                total_data_bytes:(map(.dataSize)|add),total_data_gb:g(map(.dataSize)|add),
                full_checkpoint_count:(map(select(.incremental==false))|length),
                inc_checkpoint_count:(map(select(.incremental==true))|length),
                compression_methods:(map(.compressionMethod)|unique),
                first_backup_date:(map(.date)|sort|first),
                last_backup_date:(map(.date)|sort|last),
                checkpoints:(sort_by(.checkpointName)|map({
                    checkpoint:.checkpointName,parent_checkpoint:.parentCheckpoint,
                    date:.date,incremental:.incremental,data_bytes:.dataSize,
                    data_gb:g(.dataSize),compressed:.compressed,
                    compression_method:.compressionMethod}))
            }})|from_entries) as $dm |
            ($bd|map(.[0].virtualSize)|add) as $tv |
            (map(.dataSize)|add) as $td |
            {disks:$dm,disk_count:($dm|length),
             total_virtual_bytes:$tv,total_virtual_gb:g($tv),
             total_data_bytes:$td,total_data_gb:g($td),
             compression_methods:(map(.compressionMethod)|unique),
             chain_depth:(map(.checkpointName)|unique|length),
             has_incremental:(map(.incremental)|any),
             first_backup_date:(map(.date)|sort|first),
             last_backup_date:(map(.date)|sort|last),
             unique_checkpoints:(map(.checkpointName)|unique|sort)}
        ' 2>/dev/null) || r=""
        [[ -n "$r" ]] && echo "$r" || { echo "null"; return 1; }
    else
        echo "null"
        return 1
    fi
}

###############################################################################
# RUN DUMP — always produces one compact JSON line
###############################################################################

_run_dump() {
    local dir="${1:-}"
    [[ -d "$dir" ]] || { echo '{"analysis":null,"corrupted":true,"error":"dir missing","exit_code":-1,"raw_stderr":null}'; return; }

    local sf
    sf="$BACKUP_TMP_VMDATA/.vnd_$$"
    : >"$sf" 2>/dev/null

    local raw="" ec=0
    raw=$(virtnbdrestore -i "$dir" -o dump 2>"$sf") || ec=$?

    local se=""
    [[ -f "$sf" ]] && { se=$(tail -5 "$sf" 2>/dev/null | tr '\n' '|' | sed 's/|$//') || se=""; rm -f "$sf" 2>/dev/null; }

    if [[ "$ec" -ne 0 ]]; then
        local msg="exit $ec"
        [[ -n "$se" ]] && msg="$msg — $se"
        printf '{"analysis":null,"corrupted":true,"error":%s,"exit_code":%d,"raw_stderr":%s}' \
            "$(_js "$msg")" "$ec" "$(_js "$se")"
        return
    fi

    local cj=""
    cj=$(_extract_json "$raw") || cj=""
    if [[ -z "$cj" ]]; then
        printf '{"analysis":null,"corrupted":true,"error":"no JSON output","exit_code":0,"raw_stderr":%s}' "$(_js "$se")"
        return
    fi

    local an=""
    an=$(_analyze "$cj") || an=""
    if [[ -z "$an" || "$an" == "null" ]]; then
        printf '{"analysis":null,"corrupted":true,"error":"parse failed","exit_code":0,"raw_stderr":%s}' "$(_js "$se")"
        return
    fi

    # Check entry count
    local cnt=0
    if [[ "$HAS_JQ" == "yes" ]]; then
        cnt=$(printf '%s' "$cj" | jq 'length' 2>/dev/null) || cnt=0
    fi
    [[ "${cnt:-0}" =~ ^[0-9]+$ ]] || cnt=0
    if [[ "$cnt" -eq 0 ]]; then
        printf '{"analysis":null,"corrupted":true,"error":"no checkpoints","exit_code":0,"raw_stderr":%s}' "$(_js "$se")"
        return
    fi

    printf '{"analysis":%s,"corrupted":false,"error":null,"exit_code":0,"raw_stderr":null}' "$an"
}

###############################################################################
# PARSE DUMP RESULT — sets _A _C _E _EC _S in caller scope
###############################################################################

_parse_dump() {
    local dr="${1:-}"
    _A="null"; _C="false"; _E="null"; _EC="0"; _S="null"
    [[ -z "$dr" ]] && { _C="true"; _E='"empty"'; return; }
    if [[ "$HAS_JQ" == "yes" ]]; then
        _A=$(printf '%s' "$dr"  | jq -c '.analysis'   2>/dev/null) || _A="null"
        _C=$(printf '%s' "$dr"  | jq -r '.corrupted'  2>/dev/null) || _C="false"
        _E=$(printf '%s' "$dr"  | jq -c '.error'      2>/dev/null) || _E="null"
        _EC=$(printf '%s' "$dr" | jq -r '.exit_code'  2>/dev/null) || _EC="0"
        _S=$(printf '%s' "$dr"  | jq -c '.raw_stderr' 2>/dev/null) || _S="null"
    else
        printf '%s' "$dr" | grep -q '"corrupted":true' 2>/dev/null && _C="true" || true
    fi
    [[ -z "${_A:-}" ]]  && _A="null"
    [[ -z "${_C:-}" ]]  && _C="false"
    [[ -z "${_E:-}" ]]  && _E="null"
    [[ -z "${_EC:-}" ]] && _EC="0"
    [[ -z "${_S:-}" ]]  && _S="null"
}

###############################################################################
# CHECK FOR PARTIAL/INTERRUPTED BACKUPS
###############################################################################

_check_partial_backups() {
    local dir="${1:-}"
    local vmname="${2:-}"
    local schedule="${3:-}"
    
    _log "_check_partial: START - dir=$dir, vmname=$vmname, schedule=$schedule"
    
    # Check if backup is currently running by looking for in_progress file
    local in_progress_dir=""
    local parent_dir=$(dirname "$dir")
    
    # Try to find in_progress_backups directory
    # It could be at storage pool root or backup path root
    while [[ "$parent_dir" != "/" && "$parent_dir" != "." ]]; do
        if [[ -d "$parent_dir/in_progress_backups" ]]; then
            in_progress_dir="$parent_dir/in_progress_backups"
            _log "_check_partial: found in_progress_dir=$in_progress_dir"
            break
        fi
        parent_dir=$(dirname "$parent_dir")
    done
    
    local backup_running="false"
    if [[ -n "$in_progress_dir" ]]; then
        # Check for in-progress file with pattern: ${vmname}_${schedule}_backup
        # Also check for just vmname for backward compatibility
        local lock_file=""
        local expected_lock="${vmname}_${schedule}_backup"
        _log "_check_partial: looking for lock file: $expected_lock"
        
        if [[ -f "$in_progress_dir/${vmname}_${schedule}_backup" ]]; then
            lock_file="$in_progress_dir/${vmname}_${schedule}_backup"
            _log "_check_partial: found exact match lock file"
        elif [[ -f "$in_progress_dir/$vmname" ]]; then
            lock_file="$in_progress_dir/$vmname"
            _log "_check_partial: found legacy lock file"
        else
            # Try to find any lock file for this VM
            lock_file=$(ls "$in_progress_dir/${vmname}_"* 2>/dev/null | head -n1) || lock_file=""
            if [[ -n "$lock_file" ]]; then
                _log "_check_partial: found wildcard match lock file: $lock_file"
            else
                _log "_check_partial: no lock file found for $vmname"
            fi
        fi
        
        if [[ -n "$lock_file" && -f "$lock_file" ]]; then
            # Verify the backup is actually running by checking tmux session
            # Lock file format: backup:{job_id}:{timestamp} or restore:{restore_id}:{timestamp}
            local lock_content
            lock_content=$(cat "$lock_file" 2>/dev/null) || lock_content=""
            
            # Sanitize VM name to match backupExecutor format
            # Replace all non-alphanumeric chars (except dash) with underscore
            local sanitized_vmname=$(echo "$vmname" | sed 's/[^a-zA-Z0-9-]/_/g')
            
            if [[ -n "$lock_content" ]]; then
                # Extract job ID from lock content
                local job_type job_id
                job_type=$(echo "$lock_content" | cut -d':' -f1)
                job_id=$(echo "$lock_content" | cut -d':' -f2)
                
                # Check if tmux session exists for this job
                if [[ "$job_type" == "backup" && -n "$job_id" ]]; then
                    local tmux_session="${sanitized_vmname}_${schedule}_${job_id}"
                    _log "_check_partial: checking tmux session: $tmux_session"
                    if tmux has-session -t "$tmux_session" 2>/dev/null; then
                        backup_running="true"
                        _log "_check_partial: backup is running for $vmname/$schedule (tmux session active)"
                    else
                        # Tmux session doesn't exist - lock file is stale
                        _log "_check_partial: stale lock file detected for $vmname/$schedule - removing"
                        rm -f "$lock_file" 2>/dev/null || true
                    fi
                elif [[ "$job_type" == "restore" ]]; then
                    # This is a restore lock, not a backup
                    _log "_check_partial: restore lock found for $vmname/$schedule - not a backup"
                else
                    # Old format or empty lock file - search for tmux session by pattern
                    _log "_check_partial: lock file has no job ID, searching for tmux session by pattern"
                    local tmux_pattern="${sanitized_vmname}_${schedule}_"
                    local found_session=""
                    found_session=$(tmux list-sessions -F "#{session_name}" 2>/dev/null | grep "^${tmux_pattern}" | head -n1) || found_session=""
                    
                    if [[ -n "$found_session" ]]; then
                        backup_running="true"
                        _log "_check_partial: found running tmux session: $found_session"
                    else
                        # No tmux session found - check if lock file is recent
                        local lock_age
                        lock_age=$(( $(date +%s) - $(stat -c %Y "$lock_file" 2>/dev/null || echo 0) ))
                        if [[ $lock_age -lt 3600 ]]; then
                            # Lock file is recent, assume backup is running
                            backup_running="true"
                            _log "_check_partial: backup is running for $vmname/$schedule (recent lock file, age: ${lock_age}s)"
                        else
                            # Lock file is old - likely stale
                            _log "_check_partial: stale lock file detected for $vmname/$schedule (age: ${lock_age}s) - removing"
                            rm -f "$lock_file" 2>/dev/null || true
                        fi
                    fi
                fi
            else
                # Empty lock file - search for tmux session by pattern
                _log "_check_partial: empty lock file, searching for tmux session by pattern"
                local tmux_pattern="${sanitized_vmname}_${schedule}_"
                local found_session=""
                found_session=$(tmux list-sessions -F "#{session_name}" 2>/dev/null | grep "^${tmux_pattern}" | head -n1) || found_session=""
                
                if [[ -n "$found_session" ]]; then
                    backup_running="true"
                    _log "_check_partial: found running tmux session: $found_session"
                else
                    # No tmux session found - check if lock file is recent
                    local lock_age
                    lock_age=$(( $(date +%s) - $(stat -c %Y "$lock_file" 2>/dev/null || echo 0) ))
                    if [[ $lock_age -lt 3600 ]]; then
                        # Lock file is recent, assume backup is running
                        backup_running="true"
                        _log "_check_partial: backup is running for $vmname/$schedule (recent lock file, age: ${lock_age}s)"
                    else
                        # Lock file is old - likely stale
                        _log "_check_partial: stale lock file detected for $vmname/$schedule (age: ${lock_age}s) - removing"
                        rm -f "$lock_file" 2>/dev/null || true
                    fi
                fi
            fi
        fi
    fi
    
    # Look for *.partial files in the directory
    local partial_files=()
    local partial_count=0
    while IFS= read -r -d '' pf; do
        partial_files+=("$(basename "$pf")")
        partial_count=$((partial_count + 1))
    done < <(find "$dir" -maxdepth 1 -type f -name "*.partial" -print0 2>/dev/null)
    
    # If we have partial files and backup is NOT running, it's interrupted
    if [[ "$partial_count" -gt 0 && "$backup_running" == "false" ]]; then
        _log "_check_partial: INTERRUPTED backup detected for $vmname/$schedule - $partial_count partial files"
        local partial_list=""
        local pf
        for pf in "${partial_files[@]}"; do
            [[ -n "$partial_list" ]] && partial_list+=", "
            partial_list+="$pf"
        done
        echo "{\"has_partial\":true,\"partial_count\":$partial_count,\"partial_files\":$(_js "$partial_list"),\"backup_running\":false,\"interrupted\":true,\"in_progress\":false}"
        return 0
    elif [[ "$partial_count" -gt 0 && "$backup_running" == "true" ]]; then
        _log "_check_partial: backup in progress for $vmname/$schedule - $partial_count partial files"
        echo "{\"has_partial\":true,\"partial_count\":$partial_count,\"partial_files\":null,\"backup_running\":true,\"interrupted\":false,\"in_progress\":true}"
        return 0
    elif [[ "$backup_running" == "true" ]]; then
        # Backup is running but no partial files yet (just started)
        _log "_check_partial: backup just started for $vmname/$schedule - no partial files yet"
        echo "{\"has_partial\":false,\"partial_count\":0,\"partial_files\":null,\"backup_running\":true,\"interrupted\":false,\"in_progress\":true}"
        return 0
    else
        echo "{\"has_partial\":false,\"partial_count\":0,\"partial_files\":null,\"backup_running\":false,\"interrupted\":false,\"in_progress\":false}"
        return 0
    fi
}

###############################################################################
# BUILD ENTRY — writes ONE compact JSON line to a file. NEVER to stdout.
###############################################################################

_write_entry() {
    local outf="${1:-/dev/null}"
    local sched="${2:-unknown}" path="${3:-}" dbytes="${4:-0}"
    local methods="${5:-[\"unknown\"]}" rcount="${6:-0}" slog="${7:-[]}"
    local corr="${8:-false}" anal="${9:-null}" err="${10:-null}" ec="${11:-0}" se="${12:-null}"
    shift 12
    # remaining: extra key=value pairs

    [[ "${dbytes:-0}" =~ ^[0-9]+$ ]] || dbytes=0
    [[ "${rcount:-0}" =~ ^[0-9]+$ ]] || rcount=0
    [[ "${ec:-0}"     =~ ^[0-9]+$ ]] || ec=0

    local dgb
    dgb=$(_gb "$dbytes")

    # Build extras string for archive fields and partial info
    local extras=""
    local kv
    for kv in "$@"; do
        local k="${kv%%=*}"
        local v="${kv#*=}"
        extras+=",\"$k\":$v"
    done

    printf '{"schedule":%s,"available":true,"path":%s,"disk_usage_bytes":%d,"disk_usage_gb":%s,"inferred_methods":%s,"recorded_run_count":%d,"scheduler_log":%s,"corrupted":%s,"dump_analysis":%s,"dump_error":%s,"dump_exit_code":%s,"dump_stderr":%s%s}' \
        "$(_js "$sched")" "$(_js "$path")" \
        "$dbytes" "$(_js "$dgb")" \
        "$methods" "$rcount" "$slog" \
        "$corr" "$anal" "$err" "$ec" "$se" \
        "$extras" >"$outf"
}

_write_absent() {
    local outf="${1:-/dev/null}" sched="${2:-}" reason="${3:-}"
    printf '{"schedule":%s,"available":false,"reason":%s,"corrupted":false}' \
        "$(_js "$sched")" "$(_js "$reason")" >"$outf"
}

###############################################################################
# PROCESS SCHEDULE DIR → file
###############################################################################

_proc_sched() {
    local vmdir="${1:-}" sn="${2:-}" outf="${3:-/dev/null}"
    local sd="$vmdir/$sn"
    local vmname
    vmname="$(basename "$vmdir" 2>/dev/null)" || vmname="unknown"
    
    _log "_proc_sched: $sn in $vmname"

    if [[ ! -d "$sd" ]]; then
        _write_absent "$outf" "$sn" "directory_absent"
        return
    fi

    local hc
    hc=$(find "$sd" -mindepth 1 -maxdepth 1 ! -name 'logs' ! -name 'scheduler' -print -quit 2>/dev/null) || hc=""
    if [[ -z "${hc:-}" ]]; then
        _write_absent "$outf" "$sn" "directory_empty"
        return
    fi

    local db meth sl rc dr _A _C _E _EC _S partial_info
    db=$(_dir_bytes "$sd")
    meth=$(_infer_methods "$sd")
    sl=$(_read_sched "$sd/scheduler")
    rc=0
    [[ -f "$sd/scheduler" ]] && { rc=$(grep -cEv '^\s*$|^\*|^Day' "$sd/scheduler" 2>/dev/null) || rc=0; }
    [[ "${rc:-0}" =~ ^[0-9]+$ ]] || rc=0

    # Check for partial/interrupted backups
    partial_info=$(_check_partial_backups "$sd" "$vmname" "$sn")
    
    # Check if backup is interrupted (has partial files but not running)
    local is_interrupted="false"
    local is_in_progress="false"
    if [[ "$HAS_JQ" == "yes" ]]; then
        is_interrupted=$(printf '%s' "$partial_info" | jq -r '.interrupted' 2>/dev/null) || is_interrupted="false"
        is_in_progress=$(printf '%s' "$partial_info" | jq -r '.in_progress' 2>/dev/null) || is_in_progress="false"
    else
        printf '%s' "$partial_info" | grep -q '"interrupted":true' 2>/dev/null && is_interrupted="true" || true
        printf '%s' "$partial_info" | grep -q '"in_progress":true' 2>/dev/null && is_in_progress="true" || true
    fi

    # If backup is in progress, skip virtnbdrestore check and mark as NOT corrupted
    if [[ "$is_in_progress" == "true" ]]; then
        _log "_proc_sched: backup in progress for $vmname/$sn - skipping virtnbdrestore check"
        _A="null"
        _C="false"  # Explicitly NOT corrupted when in progress
        _E="null"
        _EC="0"
        _S="null"
    else
        # Run virtnbdrestore dump check only if NOT in progress
        dr=$(_run_dump "$sd")
        _parse_dump "$dr"
        
        # If interrupted (has partial files but NOT running), mark as corrupted
        if [[ "$is_interrupted" == "true" ]]; then
            _log "_proc_sched: marking $vmname/$sn as corrupted due to interrupted backup"
            _C="true"
            _E='"interrupted_backup"'
        fi
    fi

    _write_entry "$outf" "$sn" "$sd" "$db" "$meth" "$rc" "$sl" "$_C" "$_A" "$_E" "$_EC" "$_S" \
        "partial_backup_info=$partial_info" \
        "in_progress=$is_in_progress"
}

###############################################################################
# PROCESS LEGACY DIR → file
###############################################################################

_proc_legacy() {
    local vmdir="${1:-}" outf="${2:-/dev/null}"
    local vmname
    vmname="$(basename "$vmdir" 2>/dev/null)" || vmname="unknown"
    
    _log "_proc_legacy: $vmname"

    local dd db meth sf sl rc dr _A _C _E _EC _S partial_info
    dd=$(_find_data_dir "$vmdir") || dd="$vmdir"
    db=$(_dir_bytes "$vmdir")
    meth=$(_infer_methods "$dd")
    sf=""
    [[ -f "$dd/scheduler" ]]    && sf="$dd/scheduler"
    [[ -z "$sf" && -f "$vmdir/scheduler" ]] && sf="$vmdir/scheduler"
    sl=$(_read_sched "${sf:-}")
    rc=0
    [[ -n "${sf:-}" && -f "$sf" ]] && { rc=$(grep -cEv '^\s*$|^\*|^Day' "$sf" 2>/dev/null) || rc=0; }
    [[ "${rc:-0}" =~ ^[0-9]+$ ]] || rc=0

    # Check for partial/interrupted backups
    partial_info=$(_check_partial_backups "$dd" "$vmname" "legacy")
    
    # Check if backup is interrupted
    local is_interrupted="false"
    local is_in_progress="false"
    if [[ "$HAS_JQ" == "yes" ]]; then
        is_interrupted=$(printf '%s' "$partial_info" | jq -r '.interrupted' 2>/dev/null) || is_interrupted="false"
        is_in_progress=$(printf '%s' "$partial_info" | jq -r '.in_progress' 2>/dev/null) || is_in_progress="false"
    else
        printf '%s' "$partial_info" | grep -q '"interrupted":true' 2>/dev/null && is_interrupted="true" || true
        printf '%s' "$partial_info" | grep -q '"in_progress":true' 2>/dev/null && is_in_progress="true" || true
    fi

    # If backup is in progress, skip virtnbdrestore check and mark as NOT corrupted
    if [[ "$is_in_progress" == "true" ]]; then
        _log "_proc_legacy: backup in progress for $vmname/legacy - skipping virtnbdrestore check"
        _A="null"
        _C="false"  # Explicitly NOT corrupted when in progress
        _E="null"
        _EC="0"
        _S="null"
    else
        # Run virtnbdrestore dump check only if NOT in progress
        dr=$(_run_dump "$dd")
        _parse_dump "$dr"
        
        # If interrupted (has partial files but NOT running), mark as corrupted
        if [[ "$is_interrupted" == "true" ]]; then
            _log "_proc_legacy: marking $vmname/legacy as corrupted due to interrupted backup"
            _C="true"
            _E='"interrupted_backup"'
        fi
    fi

    _write_entry "$outf" "legacy" "$dd" "$db" "$meth" "$rc" "$sl" "$_C" "$_A" "$_E" "$_EC" "$_S" \
        "partial_backup_info=$partial_info" \
        "in_progress=$is_in_progress"
}

###############################################################################
# PROCESS ARCHIVES → files in entries_dir starting at idx
###############################################################################

_proc_archives() {
    local vmdir="${1:-}" edir="${2:-}" idx="${3:-0}"
    local adir="$vmdir/archived"
    [[ -d "$adir" ]] || { echo "$idx"; return; }

    _log "_proc_archives: $(basename "$vmdir")"

    local vmname
    vmname="$(basename "$vmdir" 2>/dev/null)" || vmname="unknown"

    local entry aname
    while IFS= read -r -d '' entry; do
        [[ -d "$entry" ]] || continue
        aname="$(basename "$entry" 2>/dev/null)" || continue

        local hs
        hs=$(find "$entry" -mindepth 1 -print -quit 2>/dev/null) || hs=""
        [[ -z "${hs:-}" ]] && continue

        _log "_proc_archives: $aname"

        local ab fc meth sl rc orig dr _A _C _E _EC _S s partial_info
        ab=$(_dir_bytes "$entry")
        fc=$(find "$entry" -type f 2>/dev/null | wc -l) || fc=0
        [[ "${fc:-0}" =~ ^[0-9]+$ ]] || fc=0
        meth=$(_infer_methods "$entry")
        sl=$(_read_sched "$entry/scheduler")
        rc=0
        [[ -f "$entry/scheduler" ]] && { rc=$(grep -cEv '^\s*$|^\*|^Day' "$entry/scheduler" 2>/dev/null) || rc=0; }
        [[ "${rc:-0}" =~ ^[0-9]+$ ]] || rc=0

        orig="unknown"
        for s in $SCHEDULE_NAMES; do
            [[ "$aname" == *"_${s}" ]] && orig="$s" && break
        done

        # Check for partial/interrupted backups in archived backups too
        partial_info=$(_check_partial_backups "$entry" "$vmname" "archived_$aname")
        
        # Check if backup is interrupted
        local is_interrupted="false"
        local is_in_progress="false"
        if [[ "$HAS_JQ" == "yes" ]]; then
            is_interrupted=$(printf '%s' "$partial_info" | jq -r '.interrupted' 2>/dev/null) || is_interrupted="false"
            is_in_progress=$(printf '%s' "$partial_info" | jq -r '.in_progress' 2>/dev/null) || is_in_progress="false"
        else
            printf '%s' "$partial_info" | grep -q '"interrupted":true' 2>/dev/null && is_interrupted="true" || true
            printf '%s' "$partial_info" | grep -q '"in_progress":true' 2>/dev/null && is_in_progress="true" || true
        fi

        # If backup is in progress, skip virtnbdrestore check and mark as NOT corrupted
        if [[ "$is_in_progress" == "true" ]]; then
            _log "_proc_archives: backup in progress for $vmname/$aname - skipping virtnbdrestore check"
            _A="null"
            _C="false"  # Explicitly NOT corrupted when in progress
            _E="null"
            _EC="0"
            _S="null"
        else
            # Run virtnbdrestore dump check only if NOT in progress
            dr=$(_run_dump "$entry")
            _parse_dump "$dr"
            
            # If interrupted (has partial files but NOT running), mark as corrupted
            if [[ "$is_interrupted" == "true" ]]; then
                _log "_proc_archives: marking $vmname/$aname as corrupted due to interrupted backup"
                _C="true"
                _E='"interrupted_backup"'
            fi
        fi

        _write_entry "$edir/$(printf '%05d' $idx).json" \
            "archived" "$entry" "$ab" "$meth" "$rc" "$sl" \
            "$_C" "$_A" "$_E" "$_EC" "$_S" \
            "archive_name=$(_js "$aname")" \
            "original_schedule=$(_js "$orig")" \
            "file_count=$fc" \
            "partial_backup_info=$partial_info" \
            "in_progress=$is_in_progress"

        idx=$((idx + 1))
    done < <(find "$adir" -maxdepth 1 -mindepth 1 -type d -print0 2>/dev/null | sort -z)

    echo "$idx"
}

###############################################################################
# PROCESS CURRENT DIR (legacy-daily) → file
###############################################################################

_proc_current() {
    local vmdir="${1:-}" outf="${2:-/dev/null}"
    local vmname
    vmname="$(basename "$vmdir" 2>/dev/null)" || vmname="unknown"
    
    _log "_proc_current: $vmname"

    local current_dir="$vmdir/current"
    
    if [[ ! -d "$current_dir" ]]; then
        _write_absent "$outf" "daily" "current_directory_absent"
        return
    fi

    local hc
    hc=$(find "$current_dir" -maxdepth 1 -type f \( -name "*.data" -o -name "*.full.*" -o -name "*.inc.*" -o -name "*.copy.*" \) -print -quit 2>/dev/null) || hc=""
    if [[ -z "${hc:-}" ]]; then
        _write_absent "$outf" "daily" "current_directory_empty"
        return
    fi

    local db meth sf sl rc dr _A _C _E _EC _S partial_info
    db=$(_dir_bytes "$current_dir")
    meth=$(_infer_methods "$current_dir")
    sf=""
    [[ -f "$current_dir/scheduler" ]] && sf="$current_dir/scheduler"
    [[ -z "$sf" && -f "$vmdir/scheduler" ]] && sf="$vmdir/scheduler"
    sl=$(_read_sched "${sf:-}")
    rc=0
    [[ -n "${sf:-}" && -f "$sf" ]] && { rc=$(grep -cEv '^\s*$|^\*|^Day' "$sf" 2>/dev/null) || rc=0; }
    [[ "${rc:-0}" =~ ^[0-9]+$ ]] || rc=0

    # Check for partial/interrupted backups
    partial_info=$(_check_partial_backups "$current_dir" "$vmname" "daily")
    
    # Check if backup is interrupted
    local is_interrupted="false"
    local is_in_progress="false"
    if [[ "$HAS_JQ" == "yes" ]]; then
        is_interrupted=$(printf '%s' "$partial_info" | jq -r '.interrupted' 2>/dev/null) || is_interrupted="false"
        is_in_progress=$(printf '%s' "$partial_info" | jq -r '.in_progress' 2>/dev/null) || is_in_progress="false"
    else
        printf '%s' "$partial_info" | grep -q '"interrupted":true' 2>/dev/null && is_interrupted="true" || true
        printf '%s' "$partial_info" | grep -q '"in_progress":true' 2>/dev/null && is_in_progress="true" || true
    fi

    # If backup is in progress, skip virtnbdrestore check and mark as NOT corrupted
    if [[ "$is_in_progress" == "true" ]]; then
        _log "_proc_current: backup in progress for $vmname/daily (current) - skipping virtnbdrestore check"
        _A="null"
        _C="false"  # Explicitly NOT corrupted when in progress
        _E="null"
        _EC="0"
        _S="null"
    else
        # Run virtnbdrestore dump check only if NOT in progress
        dr=$(_run_dump "$current_dir")
        _parse_dump "$dr"
        
        # If interrupted (has partial files but NOT running), mark as corrupted
        if [[ "$is_interrupted" == "true" ]]; then
            _log "_proc_current: marking $vmname/daily (current) as corrupted due to interrupted backup"
            _C="true"
            _E='"interrupted_backup"'
        fi
    fi

    _write_entry "$outf" "daily" "$current_dir" "$db" "$meth" "$rc" "$sl" "$_C" "$_A" "$_E" "$_EC" "$_S" \
        "partial_backup_info=$partial_info" \
        "in_progress=$is_in_progress" \
        "is_legacy_format=true" \
        "backup_location=$(_js "current")"
}

###############################################################################
# PROCESS ONE VM → writes result to out_file
###############################################################################

_proc_vm() {
    local vmdir="${1:-}" outf="${2:-/dev/null}" storage_pool_path="${3:-}"
    local vmname
    vmname="$(basename "$vmdir" 2>/dev/null)" || vmname="unknown"

    _log "_proc_vm: START $vmname (pool: $storage_pool_path)"

    local vb
    vb=$(_dir_bytes "$vmdir")

    # Detect layout
    local has_sched="n" has_legacy="n" s sc
    for s in $SCHEDULE_NAMES; do
        if [[ -d "$vmdir/$s" ]]; then
            sc=$(find "$vmdir/$s" -mindepth 1 -maxdepth 1 ! -name 'logs' ! -name 'scheduler' -print -quit 2>/dev/null) || sc=""
            [[ -n "${sc:-}" ]] && { has_sched="y"; break; }
        fi
    done
    _has_data "$vmdir" && has_legacy="y"

    local edir="$WORK_DIR/e_$$_${vmname}"
    mkdir -p "$edir" 2>/dev/null
    local idx=0

    if [[ "$has_sched" == "y" ]]; then
        for s in $SCHEDULE_NAMES; do
            _proc_sched "$vmdir" "$s" "$edir/$(printf '%05d' $idx).json"
            idx=$((idx + 1))
        done
    fi

    if [[ "$has_legacy" == "y" ]]; then
        _proc_legacy "$vmdir" "$edir/$(printf '%05d' $idx).json"
        idx=$((idx + 1))
    fi
    
    # Check for "current" directory (legacy-daily backup)
    if [[ -d "$vmdir/current" ]]; then
        local current_has_data
        current_has_data=$(find "$vmdir/current" -maxdepth 1 -type f \( -name "*.data" -o -name "*.full.*" -o -name "*.inc.*" -o -name "*.copy.*" \) -print -quit 2>/dev/null) || current_has_data=""
        if [[ -n "${current_has_data:-}" ]]; then
            _proc_current "$vmdir" "$edir/$(printf '%05d' $idx).json"
            idx=$((idx + 1))
        fi
    fi

    local nidx
    nidx=$(_proc_archives "$vmdir" "$edir" "$idx") || nidx="$idx"
    [[ "${nidx:-$idx}" =~ ^[0-9]+$ ]] && idx=$nidx

    if [[ "$idx" -eq 0 ]]; then
        for s in $SCHEDULE_NAMES; do
            _write_absent "$edir/$(printf '%05d' $idx).json" "$s" "directory_absent"
            idx=$((idx + 1))
        done
    fi

    _log "_proc_vm: $vmname entries=$idx"

    # Read entries and build array
    local -a entries=()
    local ef ln
    for ef in "$edir"/*.json; do
        [[ -f "$ef" ]] || continue
        ln=$(cat "$ef" 2>/dev/null) || ln=""
        [[ -n "${ln:-}" ]] && entries+=("$ln")
    done

    # Counters - IMPORTANT: in_progress backups should NOT be counted as corrupted
    local avail=0 corr=0 arch=0 archc=0 inprog=0 healthy_count=0 e
    for e in "${entries[@]}"; do
        local is_avail="false" is_corr="false" is_prog="false" is_arch="false"
        
        printf '%s' "$e" | grep -q '"available":true'    2>/dev/null && is_avail="true" || true
        printf '%s' "$e" | grep -q '"corrupted":true'    2>/dev/null && is_corr="true"  || true
        printf '%s' "$e" | grep -q '"in_progress":true'  2>/dev/null && is_prog="true"  || true
        printf '%s' "$e" | grep -q '"schedule":"archived"' 2>/dev/null && is_arch="true" || true
        
        # Count available
        [[ "$is_avail" == "true" ]] && avail=$((avail+1))
        
        # Count in-progress
        [[ "$is_prog" == "true" ]] && inprog=$((inprog+1))
        
        # Count corrupted ONLY if NOT in progress (in-progress backups are not corrupted)
        [[ "$is_corr" == "true" && "$is_prog" == "false" ]] && corr=$((corr+1))
        
        # Count archived
        if [[ "$is_arch" == "true" ]]; then
            arch=$((arch+1))
            [[ "$is_corr" == "true" && "$is_prog" == "false" ]] && archc=$((archc+1))
        fi
        
        # Count healthy schedules (available, not corrupted, not in progress)
        if [[ "$is_avail" == "true" && "$is_corr" == "false" && "$is_prog" == "false" ]]; then
            healthy_count=$((healthy_count+1))
        fi
    done

    # Determine overall health status
    local health="healthy"
    
    # No backups at all
    [[ "$avail" -eq 0 ]] && health="no_backups"
    
    # All available backups are in progress
    [[ "$avail" -gt 0 && "$inprog" -gt 0 && "$inprog" -eq "$avail" ]] && health="in_progress"
    
    # Some backups in progress, but not all
    [[ "$avail" -gt 0 && "$inprog" -gt 0 && "$inprog" -lt "$avail" ]] && {
        # Check if non-in-progress backups are healthy or corrupted
        local non_inprog=$((avail - inprog))
        if [[ "$healthy_count" -gt 0 ]]; then
            health="healthy"
        elif [[ "$corr" -eq "$non_inprog" ]]; then
            health="partially_corrupted"  # Some in progress, rest corrupted
        fi
    }
    
    # No in-progress backups - check corruption status
    [[ "$inprog" -eq 0 ]] && {
        if [[ "$corr" -eq 0 && "$avail" -gt 0 ]]; then
            health="healthy"
        elif [[ "$corr" -gt 0 && "$corr" -eq "$avail" ]]; then
            health="all_corrupted"
        elif [[ "$corr" -gt 0 && "$corr" -lt "$avail" ]]; then
            health="partially_corrupted"
        fi
    }

    # Build schedules array by joining entries
    local sarr="["
    local j=0
    for j in "${!entries[@]}"; do
        [[ $j -gt 0 ]] && sarr+=","
        sarr+="${entries[$j]}"
    done
    sarr+="]"

    local vgb
    vgb=$(_gb "$vb")

    # Write VM object — all in one printf, never via jq args
    printf '{"vm_name":%s,"vm_path":%s,"storage_pool_path":%s,"total_disk_usage_bytes":%d,"total_disk_usage_gb":%s,"available_schedule_count":%d,"corrupted_schedule_count":%d,"archived_backup_count":%d,"archived_corrupted_count":%d,"health":%s,"schedules":%s}' \
        "$(_js "$vmname")" "$(_js "$vmdir")" "$(_js "$storage_pool_path")" \
        "$vb" "$(_js "$vgb")" \
        "$avail" "$corr" "$arch" "$archc" \
        "$(_js "$health")" "$sarr" >"$outf"

    rm -rf "$edir" 2>/dev/null
    _log "_proc_vm: DONE $vmname health=$health"
}

###############################################################################
# MAIN
###############################################################################

main() {
    _log "main: processing backup_paths=$backup_paths"

    # Split comma-separated paths into array
    IFS=',' read -ra PATH_ARRAY <<< "$backup_paths"
    _log "main: found ${#PATH_ARRAY[@]} paths to scan"

    # Collect VM dirs from ALL paths
    local -a vmdirs=()
    local -a vmdir_pools=()  # Track which pool each VM belongs to
    local backup_path
    for backup_path in "${PATH_ARRAY[@]}"; do
        # Trim whitespace
        backup_path=$(echo "$backup_path" | xargs)
        
        if [[ ! -d "$backup_path" ]]; then
            _log "main: WARNING - path does not exist: $backup_path"
            continue
        fi
        
        _log "main: scanning $backup_path"
        
        local entry
        while IFS= read -r -d '' entry; do
            if _is_vm_dir "$entry"; then
                vmdirs+=("$entry")
                vmdir_pools+=("$backup_path")  # Store the pool path for this VM
            fi
        done < <(find "$backup_path" -maxdepth 1 -mindepth 1 -print0 2>/dev/null | sort -z)
    done

    local vmc=${#vmdirs[@]}
    _log "main: found $vmc VM dirs across all paths"

    if [[ "$vmc" -eq 0 ]]; then
        printf '{"generated_at":"%s","hostname":"%s","backup_path":%s,"vm_count":0,"total_backup_size_bytes":0,"total_backup_size_gb":"0.000 GB","summary":{"healthy":0,"corrupted":0,"no_backups":0,"total_archived":0,"total_archived_corrupted":0},"vms":[]}\n' \
            "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
            "$(hostname 2>/dev/null || echo unknown)" \
            "$(_js "$backup_paths")"
        return
    fi

    # Parallel workers
    local maxj
    maxj=$(nproc 2>/dev/null) || maxj=4
    maxj=$((maxj * 2))
    [[ "$maxj" -lt 4  ]] && maxj=4
    [[ "$maxj" -gt 32 ]] && maxj=32
    _log "main: max_jobs=$maxj"

    local -a outfiles=() pids=()
    local i
    for i in "${!vmdirs[@]}"; do
        local of="$WORK_DIR/vm_${i}.json"
        echo 'null' >"$of"
        outfiles+=("$of")

        _proc_vm "${vmdirs[$i]}" "$of" "${vmdir_pools[$i]}" &
        pids+=($!)

        # Throttle
        if [[ "${#pids[@]}" -ge "$maxj" ]]; then
            local old=$((i - maxj + 1))
            [[ "$old" -ge 0 ]] && wait "${pids[$old]}" 2>/dev/null || true
        fi
    done

    local p
    for p in "${pids[@]}"; do
        wait "$p" 2>/dev/null || true
    done
    _log "main: all workers done"

    # Collect results
    local -a vmobjs=()
    local f c
    for f in "${outfiles[@]}"; do
        c=$(cat "$f" 2>/dev/null) || c="null"
        [[ -z "${c:-}" ]] && c="null"
        vmobjs+=("$c")
    done

    # Total bytes
    local tb=0 v b
    for v in "${vmdirs[@]}"; do
        b=$(_dir_bytes "$v")
        tb=$((tb + b))
    done

    # Summary
    local th=0 tc=0 tn=0 ta=0 tac=0 obj h ac acc
    for obj in "${vmobjs[@]}"; do
        [[ "$obj" == "null" || -z "$obj" ]] && continue
        if [[ "$HAS_JQ" == "yes" ]]; then
            h=$(printf '%s' "$obj"  | jq -r '.health' 2>/dev/null) || h="healthy"
            ac=$(printf '%s' "$obj" | jq -r '.archived_backup_count' 2>/dev/null) || ac=0
            acc=$(printf '%s' "$obj"| jq -r '.archived_corrupted_count' 2>/dev/null) || acc=0
            [[ "${ac:-0}"  =~ ^[0-9]+$ ]] || ac=0
            [[ "${acc:-0}" =~ ^[0-9]+$ ]] || acc=0
        else
            h="healthy"
            printf '%s' "$obj" | grep -q '"health":"all_corrupted"'       2>/dev/null && h="all_corrupted" || true
            printf '%s' "$obj" | grep -q '"health":"partially_corrupted"' 2>/dev/null && h="partially_corrupted" || true
            printf '%s' "$obj" | grep -q '"health":"no_backups"'          2>/dev/null && h="no_backups" || true
            ac=0; acc=0
        fi
        case "${h:-healthy}" in
            all_corrupted|partially_corrupted) tc=$((tc+1)) ;;
            no_backups) tn=$((tn+1)) ;;
            *) th=$((th+1)) ;;
        esac
        ta=$((ta+ac)); tac=$((tac+acc))
    done

    # Build vms array by direct concatenation (NOT via jq --argjson)
    local varr="["
    local j=0
    for j in "${!vmobjs[@]}"; do
        local o="${vmobjs[$j]}"
        [[ "$o" == "null" || -z "$o" ]] && continue
        [[ "$varr" != "[" ]] && varr+=","
        varr+="$o"
    done
    varr+="]"

    local ga hn tgb
    ga=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    hn=$(hostname 2>/dev/null) || hn="unknown"
    tgb=$(_gb "$tb")

    _log "main: assembling report, vms_array_len=${#varr}"

    # Final output — pure printf, NO jq for assembly
    # This avoids the ARG_MAX limit that killed jq --argjson with 200KB+ data
    local report
    report=$(printf '{"generated_at":%s,"hostname":%s,"backup_path":%s,"vm_count":%d,"total_backup_size_bytes":%d,"total_backup_size_gb":%s,"summary":{"healthy":%d,"corrupted":%d,"no_backups":%d,"total_archived":%d,"total_archived_corrupted":%d},"vms":%s}' \
        "$(_js "$ga")" "$(_js "$hn")" "$(_js "$backup_paths")" \
        "$vmc" "$tb" "$(_js "$tgb")" \
        "$th" "$tc" "$tn" "$ta" "$tac" \
        "$varr")

    _log "main: report_len=${#report}"

    # Pretty-print with jq if available, via stdin (not args)
    if [[ "$HAS_JQ" == "yes" ]]; then
        printf '%s' "$report" | jq '.' 2>/dev/null || printf '%s\n' "$report"
    else
        printf '%s\n' "$report"
    fi

    _log "main: DONE"
}

main "$@"