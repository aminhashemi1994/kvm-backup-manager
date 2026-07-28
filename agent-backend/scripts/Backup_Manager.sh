#!/bin/bash

###############################################################################
# backup_manager.sh — Remote VM backup manager with offsite sync
#
# Usage:
#   # Daily (auto-detects full/inc):
#   bash backup_manager.sh --domain vm1 --ip 10.0.0.1 --schedule daily \
#        --retention 7 --keep-archive 2
#
#   # Monthly (always copy):
#   bash backup_manager.sh --domain vm1 --ip 10.0.0.1 --schedule monthly
#
#   # Once (always copy):
#   bash backup_manager.sh --domain vm1 --ip 10.0.0.1 --schedule once
#
#   # Weekly copy (no retention, overwrites):
#   bash backup_manager.sh --domain vm1 --ip 10.0.0.1 --schedule weekly \
#        --method copy
#
#   # Weekly full/inc chain (auto-detects):
#   bash backup_manager.sh --domain vm1 --ip 10.0.0.1 --schedule weekly \
#        --retention 4 --keep-archive 1
#
#   # Custom:
#   bash backup_manager.sh --domain vm1 --ip 10.0.0.1 --schedule custom \
#        --retention 5 --keep-archive 3
#
#   # With offsite sync:
#   bash backup_manager.sh --domain vm1 --ip 10.0.0.1 --schedule daily \
#        --retention 7 --keep-archive 2 --offsite-ip 172.50.0.100,172.50.0.200
#
#   # With compression:
#   bash backup_manager.sh --domain vm1 --ip 10.0.0.1 --schedule daily \
#        --retention 7 --keep-archive 2 --compress 4
#
#   # Verbose output:
#   bash backup_manager.sh --domain vm1 --ip 10.0.0.1 --schedule daily \
#        --retention 7 --keep-archive 2 --verbose
###############################################################################

# Source temporary directory configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/tmp_dirs.sh"

# ─── Defaults ────────────────────────────────────────────────────────────────
vm_name=""
remote_ip=""
schedule=""
method=""
retention=""
compression_level=""
skip_skip_backup_verification="false"
backup_compression="true"
archives_to_keep=""
compress_backup=""
verbose="false"
offsite_ips=""
# Disk-usage guard rail (percent). A backup is refused when the target pool
# — or an offsite destination — is already used above this level. Configurable
# per storage pool from the controller; defaults to 80 when not supplied.
disk_usage_threshold="80"
# Maps an offsite IP → its custom destination base path (empty = mirror the
# source pool path). Populated from the "ip:path" entries in --offsite-ip
# (colon delimiter — IPv4-safe since IPv4 addresses contain no colons).
declare -A OFFSITE_PATH_BY_IP=()
# Maps an offsite IP → its per-pool disk-usage threshold (percent). Empty when
# the controller didn't supply one; the global disk_usage_threshold is used then.
declare -A OFFSITE_THRESHOLD_BY_IP=()
backup_path=""
events_file=""
log_file_path=""
log_dir=""
log_timestamp=""
lock_file=""
backup_dir=""
scheduler_file=""
destination_ip=""
hostName=""
vm_base_dir=""
archived_backup_dir=""
offsite_lock_dir=""
lock_dir=""
nbd_port=""
vm_shutdown_status=""
_archived_this_run=""
_pruned_archives=()
is_retry="false" # NEW: Flag to indicate this is a retry attempt
# Marker written by the fix-backup endpoint after KVM_Fix_Backup.sh has reset a
# VM's checkpoint metadata. Its presence means the next backup MUST be full.
# Resolved once vm_base_dir is known (see DIRECTORY LAYOUT).
needs_full_marker=""

# ─── Argument parsing ────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
	case "$1" in
	--domain)
		vm_name="$2"
		shift 2
		;;
	--ip)
		remote_ip="$2"
		shift 2
		;;
	--schedule | --schedual)
		schedule="$2"
		shift 2
		;;
	--method)
		method="$2"
		shift 2
		;;
	--retention)
		retention="$2"
		shift 2
		;;
	--compress)
		compression_level="$2"
		shift 2
		;;
	--no-verify)
		skip_backup_verification="true"
		shift
		;;
	--no-compression)
		backup_compression="false"
		shift
		;;
	--keep-archive)
		archives_to_keep="$2"
		shift 2
		;;
	--verbose)
		verbose="true"
		shift
		;;
	--offsite-ip)
		offsite_ips="$2"
		shift 2
		;;
	--backup-path)
		backup_path="$2"
		shift 2
		;;
	--disk-threshold)
		disk_usage_threshold="$2"
		shift 2
		;;
	--retry)
		is_retry="true"
		shift
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
: "${Bold:=\033[1m}"
: "${Dim:=\033[2m}"
: "${NC:=\033[0m}"
: "${CROSS:=✗}"
: "${CHECK:=✓}"
: "${WARNING:=⚠}"

###############################################################################
# OUTPUT HELPERS
###############################################################################

die() {
	echo -e "${Red}${CROSS} $1${NC}" >&2
	if [[ -n "$events_file" && -f "$events_file" ]]; then
		local ts=""
		ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
		printf '{"timestamp":"%s","event":"fatal_error","status":"error","domain":"%s","schedule":"%s","method":"%s","message":"%s"}\n' \
			"$ts" "$vm_name" "$schedule" "$method" "$1" >>"$events_file" 2>/dev/null
	fi
	exit 1
}

warn() {
	echo -e "${Yellow}${WARNING} $1${NC}"
}

info() {
	echo -e "${Green}${CHECK} $1${NC}"
}

emit_event() {
	if [[ -z "$events_file" ]]; then return 0; fi
	if [[ ! -f "$events_file" ]]; then return 0; fi
	local event_type="$1"
	local status="$2"
	local message="$3"
	shift 3
	local extras=""
	local kv=""
	for kv in "$@"; do
		local key="${kv%%=*}"
		local val="${kv#*=}"
		extras+=", \"${key}\": \"${val}\""
	done
	local timestamp=""
	timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
	printf '{"timestamp":"%s","event":"%s","status":"%s","domain":"%s","schedule":"%s","method":"%s","message":"%s"%s}\n' \
		"$timestamp" "$event_type" "$status" "$vm_name" "$schedule" "$method" "$message" "$extras" \
		>>"$events_file" 2>/dev/null
	return 0
}

###############################################################################
# INPUT VALIDATION
###############################################################################

[[ -z "$vm_name" ]] && die "--domain is required."
[[ -z "$remote_ip" ]] && die "--ip is required."
[[ -z "$schedule" ]] && die "--schedule is required."
[[ -z "$backup_path" ]] && die "--backup-path is required."

# Normalize the disk-usage threshold: must be an integer 1–100, else fall
# back to the historical default of 80 so a bad value never disables the guard.
if ! [[ "$disk_usage_threshold" =~ ^[0-9]+$ ]] || \
	[[ "$disk_usage_threshold" -lt 1 ]] || [[ "$disk_usage_threshold" -gt 100 ]]; then
	disk_usage_threshold="80"
fi
# Warning level is always a fixed 60% "getting full" notice; the hard stop uses
# the configurable disk_usage_threshold. The stop check runs first, so this fixed
# warn stays correct even if a pool's threshold is set below 60.
disk_usage_warn_threshold=60

# Validate backup path exists
if [[ ! -d "$backup_path" ]]; then
	die "Backup path does not exist: $backup_path"
fi

case "$schedule" in
once | monthly | daily | weekly | custom) ;;
*) die "Invalid --schedule '$schedule'. Must be: once, monthly, daily, weekly, custom." ;;
esac

if [[ -n "$method" ]]; then
	case "$method" in
	full | inc | copy) ;;
	*) die "Invalid --method '$method'. Must be: full, inc, copy." ;;
	esac
fi

###############################################################################
# SCHEDULE / METHOD CONSTRAINT ENFORCEMENT
###############################################################################

case "$schedule" in
once | monthly)
	if [[ -n "$method" && "$method" != "copy" ]]; then
		die "Schedule '$schedule' requires --method copy (or omit --method)."
	fi
	method="copy"
	if [[ -n "$retention" ]]; then
		warn "Schedule '$schedule' ignores --retention."
		retention=""
	fi
	if [[ -n "$archives_to_keep" ]]; then
		warn "Schedule '$schedule' ignores --keep-archive."
		archives_to_keep=""
	fi
	;;
daily)
	if [[ -n "$method" && "$method" == "copy" ]]; then
		die "Schedule 'daily' does not support --method copy. Use full/inc or omit --method for auto-detection."
	fi
	if [[ -z "$method" ]]; then
		method="auto"
	fi
	if [[ -z "$retention" ]]; then
		die "Schedule 'daily' requires --retention."
	fi
	if [[ -z "$archives_to_keep" ]]; then
		die "Schedule 'daily' requires --keep-archive."
	fi
	;;
weekly)
	if [[ -n "$method" && "$method" == "copy" ]]; then
		if [[ -n "$retention" ]]; then
			warn "Weekly copy ignores --retention."
			retention=""
		fi
		if [[ -n "$archives_to_keep" ]]; then
			warn "Weekly copy ignores --keep-archive."
			archives_to_keep=""
		fi
	else
		if [[ -z "$method" ]]; then
			method="auto"
		fi
		if [[ "$method" != "copy" ]]; then
			if [[ -z "$retention" ]]; then
				die "Weekly with full/inc requires --retention."
			fi
			if [[ -z "$archives_to_keep" ]]; then
				die "Weekly with full/inc requires --keep-archive."
			fi
		fi
	fi
	;;
custom)
	if [[ -z "$method" ]]; then
		method="auto"
	fi
	if [[ "$method" == "auto" || "$method" == "full" || "$method" == "inc" ]]; then
		if [[ -z "$retention" ]]; then
			warn "Custom: defaulting --retention to 7."
			retention=7
		fi
		if [[ -z "$archives_to_keep" ]]; then
			warn "Custom: defaulting --keep-archive to 2."
			archives_to_keep=2
		fi
	fi
	;;
esac

###############################################################################
# FURTHER VALIDATION
###############################################################################

if [[ "$backup_compression" == "false" && -n "$compression_level" ]]; then
	die "Cannot use --compress and --no-compression together."
fi
if [[ -n "$compression_level" ]]; then
	if ! [[ "$compression_level" =~ ^[0-9]+$ ]] || [[ "$compression_level" -lt 2 || "$compression_level" -gt 16 ]]; then
		die "--compress must be between 2 and 16."
	fi
fi
if [[ -n "$retention" ]]; then
	if ! [[ "$retention" =~ ^[0-9]+$ ]] || [[ "$retention" -lt 1 ]]; then
		die "--retention must be a positive integer."
	fi
fi
if [[ -n "$archives_to_keep" ]]; then
	if ! [[ "$archives_to_keep" =~ ^[0-9]+$ ]] || [[ "$archives_to_keep" -lt 1 ]]; then
		die "--keep-archive must be a positive integer."
	fi
fi

###############################################################################
# BUILD COMPRESSION FLAG
###############################################################################

if [[ "$backup_compression" == "false" ]]; then
	compress_backup=""
elif [[ -n "$compression_level" ]]; then
	compress_backup="--compress=$compression_level"
else
	compress_backup="--compress=2"
fi

if ! command -v virtnbdbackup &>/dev/null; then
	die "virtnbdbackup is not installed."
fi

###############################################################################
# DIRECTORY LAYOUT
###############################################################################

if [[ -z "${backup_path:-}" ]]; then
	die "backup_path variable is empty in setting.sh."
fi

vm_base_dir="$backup_path/$vm_name"
daily_backup_dir="$vm_base_dir/daily"
weekly_backup_dir="$vm_base_dir/weekly"
monthly_backup_dir="$vm_base_dir/monthly"
once_backup_dir="$vm_base_dir/once"
custom_backup_dir="$vm_base_dir/custom"
archived_backup_dir="$vm_base_dir/archived"
lock_dir="$backup_path/in_progress_backups"
offsite_lock_dir="$backup_path/offsite_locks"

# Progress metadata file
progress_metadata_dir="$backup_path/.progress"
mkdir -p "$progress_metadata_dir" 2>/dev/null
progress_file="$progress_metadata_dir/${vm_name}_${schedule}.progress"

for d in "$daily_backup_dir" "$weekly_backup_dir" "$monthly_backup_dir" \
	"$once_backup_dir" "$custom_backup_dir" "$archived_backup_dir" \
	"$lock_dir" "$offsite_lock_dir"; do
	mkdir -p "$d" 2>/dev/null
done

backup_dir=""
case "$schedule" in
daily) backup_dir="$daily_backup_dir" ;;
weekly) backup_dir="$weekly_backup_dir" ;;
monthly) backup_dir="$monthly_backup_dir" ;;
once) backup_dir="$once_backup_dir" ;;
custom) backup_dir="$custom_backup_dir" ;;
esac

scheduler_file="$backup_dir/scheduler"
lock_file="$lock_dir/${vm_name}_${schedule}_backup"

# Per VM, not per schedule: libvirt checkpoints are VM-global, so a backup fix
# invalidates the daily, weekly and custom chains simultaneously.
needs_full_marker="$vm_base_dir/.needs-full"

destination_ip="$remote_ip"
hostName="$vm_name"

###############################################################################
# LOGGING SETUP
###############################################################################

log_dir="$backup_dir/logs"
mkdir -p "$log_dir" 2>/dev/null

log_timestamp=$(date +"%Y-%m-%d_%H-%M-%S")
log_filename="${log_timestamp}_${schedule}_${method}.log"
log_file_path="$log_dir/$log_filename"
events_file="$log_dir/${log_timestamp}_${schedule}_${method}.events.jsonl"

touch "$events_file" 2>/dev/null
touch "$log_file_path" 2>/dev/null

exec > >(tee -a "$log_file_path") 2>&1
sleep 0.1

###############################################################################
# CORE FUNCTIONS
###############################################################################

check_ssh_connection() {
	local target_ip="$1"
	local remote_server="root@$target_ip"
	local timeout=5

	mkdir -p /root/.ssh 2>/dev/null
	chmod 700 /root/.ssh 2>/dev/null
	if [[ ! -f /root/.ssh/known_hosts ]]; then
		touch /root/.ssh/known_hosts
		chmod 600 /root/.ssh/known_hosts
	fi

	if ! ssh-keygen -F "$target_ip" &>/dev/null; then
		ssh-keyscan -H "$target_ip" >>/root/.ssh/known_hosts 2>/dev/null
	fi

	if ! ssh -o BatchMode=yes -o ConnectTimeout=$timeout "$remote_server" exit &>/dev/null; then
		echo -e "${Red}${CROSS} Cannot SSH to $target_ip${NC}"
		return 1
	fi

	local rhost=""
	rhost=$(ssh -o ConnectTimeout=$timeout "$remote_server" 'hostname' 2>/dev/null)
	if [[ -z "$rhost" ]]; then
		echo -e "${Red}${CROSS} Failed to get hostname from $target_ip${NC}"
		return 1
	fi

	if ! ssh-keygen -F "$rhost" &>/dev/null; then
		timeout 5s ssh-keyscan -4 -H "$rhost" >>~/.ssh/known_hosts 2>/dev/null
	fi

	local existing_entry=""
	existing_entry=$(grep -Ev '^\s*#' /etc/hosts 2>/dev/null | grep -w "$rhost" 2>/dev/null | awk '{print $1}' | head -1)

	if [[ -z "$existing_entry" ]]; then
		echo "$target_ip $rhost" | sudo tee -a /etc/hosts >/dev/null 2>&1
	elif [[ "$existing_entry" != "$target_ip" ]]; then
		warn "Hostname $rhost in /etc/hosts → $existing_entry, expected $target_ip"
	fi

	info "SSH to $target_ip ($rhost) — OK"
	return 0
}

get_remote_hostname() {
	local vm_list=""
	vm_list=$(virsh -c "qemu+ssh://root@$remote_ip/system" list --all 2>/dev/null | tail -n +3 | head -n -1)

	if echo "$vm_list" | awk '{print $2}' | grep -qxF "$hostName" 2>/dev/null; then
		return 0
	fi
	if echo "$vm_list" | awk '{print $1}' | grep -qxF "$hostName" 2>/dev/null; then
		hostName=$(echo "$vm_list" | awk -v id="$hostName" '$1 == id {print $2}')
		return 0
	fi
	return 1
}

abort_stale_domain_job() {
	if [[ ! -f "$lock_file" ]]; then
		virsh -c "qemu+ssh://root@$remote_ip/system" domjobabort "$hostName" >/dev/null 2>&1
	fi
	return 0
}

check_available_disk() {
	local check_path="${1:-$backup_path}"
	if [[ -z "$check_path" ]]; then
		return 1
	fi

	local percentage_usage=""
	percentage_usage=$(df "$check_path" 2>/dev/null | awk 'NR>1 {print $5}' | sed 's/%//g')

	if [[ -z "$percentage_usage" ]]; then
		warn "Could not determine disk usage for $check_path"
		return 0
	fi

	if [[ "$percentage_usage" -gt "$disk_usage_threshold" ]]; then
		echo -e "${Red}${CROSS} Disk usage ${percentage_usage}% (>${disk_usage_threshold}%) on $check_path. Stopping.${NC}"
		emit_event "disk_check" "error" "Disk >${disk_usage_threshold}% (${percentage_usage}%)"
		return 1
	elif [[ "$percentage_usage" -gt "$disk_usage_warn_threshold" ]]; then
		warn "Disk usage ${percentage_usage}% (>${disk_usage_warn_threshold}%) on $check_path"
		emit_event "disk_check" "warning" "Disk >${disk_usage_warn_threshold}% (${percentage_usage}%)"
	fi
	return 0
}

remote_backup_TPM() {
	local current_date=""
	current_date=$(date +"%Y-%m-%d")
	local VM_UUID=""
	VM_UUID=$(virsh -c "qemu+ssh://root@$remote_ip/system" domuuid "$vm_name" 2>/dev/null | awk 'NF')
	if [[ -z "$VM_UUID" ]]; then
		return 0
	fi

	local VM_TPM_directory="/var/lib/libvirt/swtpm/$VM_UUID"
	local TPM_Backup_Directory="${vm_base_dir}/TPM/TPM_${current_date}"

	local has_tpm="no"
	if virsh -c "qemu+ssh://root@$remote_ip/system" dumpxml --inactive "$vm_name" 2>/dev/null | grep -qi tpm; then
		has_tpm="yes"
	fi

	if [[ "$has_tpm" == "yes" ]]; then
		mkdir -p "$TPM_Backup_Directory" 2>/dev/null
		if rsync -az "root@$remote_ip:$VM_TPM_directory" "$TPM_Backup_Directory" >/dev/null 2>&1; then
			info "TPM Backup Succeeded"
		else
			warn "TPM Backup Failed"
			return 1
		fi
	fi
	return 0
}

generate_random_nbd_port() {
	# Allocate a free NBD port atomically. Without this, multiple parallel
	# backups on the same hypervisor (which is normal under
	# maxConcurrentBackups > 1) can pick the same port via a check-then-use
	# race: each script's `ss` snapshot doesn't see the port as bound yet,
	# then both qemu-nbd processes try to bind it. The losing one ends up
	# racing the cleanup `pkill -f qemu-nbd.*$nbd_port` of the other,
	# causing the live backup's NBD socket to be ripped out partway through
	# — which surfaces inside virtnbdbackup as a chunk-write exception
	# whose error class lookup then fails (the AttributeError seen in the
	# logs). The fix is two-pronged:
	#
	#   1. Serialize the pick-and-claim with `flock` against a shared lock
	#      file so two concurrent allocators can't both walk away believing
	#      they own the same port.
	#   2. Track our claimed ports in a registry directory so a port that's
	#      reserved but not yet bound is still considered taken by the next
	#      caller. Stale entries (older than 24h) are pruned automatically.
	#
	# Using a wider port range further reduces collision probability.
	local attempt=0
	local p=0
	local lock_dir="${TMP_DIR:-/tmp}/backup-manager-nbd"
	local lock_file="$lock_dir/allocator.lock"
	local registry="$lock_dir/in-use"
	mkdir -p "$registry"
	: >"$lock_file" 2>/dev/null || true

	# Prune stale port reservations (>24h old). A backup either finishes
	# cleanly (which removes its claim) or crashes — either way 24h is a
	# safe upper bound.
	find "$registry" -type f -mmin +1440 -delete 2>/dev/null || true

	# Take an exclusive lock for the entire pick-and-claim sequence.
	exec 9>"$lock_file"
	flock -x 9 || die "Could not acquire NBD port allocator lock."

	for attempt in $(seq 1 500); do
		# Wider range: 60000..63999 → 4000 candidates, lowering collision
		# probability for high concurrency.
		p=$(((RANDOM * RANDOM) % 4000 + 60000))

		# Skip if another concurrent backup has already reserved this port
		# (claim file present in our registry).
		if [[ -e "$registry/$p" ]]; then
			continue
		fi

		# Skip if anyone is bound on either side right now.
		if ss -tulpn 2>/dev/null | grep -qw "$p"; then
			continue
		fi
		if ssh -o ConnectTimeout=5 "root@$destination_ip" "ss -tulpn 2>/dev/null | grep -qw $p" 2>/dev/null; then
			continue
		fi

		# Reserve it. Write the claim file with our PID + VM context so we
		# can identify and clean it up later. mkfifo would be more atomic
		# but `set -C` (noclobber) on a regular file gives us the same
		# effect: if another process beat us to this exact filename, the
		# write fails and we loop.
		if (
			set -C
			echo "$$ $vm_name $schedule $(date -u +%FT%TZ)" >"$registry/$p"
		) 2>/dev/null; then
			nbd_port=$p
			# Stash the registry path so cleanup can release the claim.
			nbd_port_claim_file="$registry/$p"
			flock -u 9
			exec 9>&-
			return 0
		fi
	done

	flock -u 9
	exec 9>&-
	die "Could not find a free NBD port after 500 attempts."
}

###############################################################################
# RETRY CLEANUP - Clean up partial files from previous failed attempts
#
# This function is called when --retry flag is set. It performs the following
# safety checks and cleanup:
# 1. Verify no tmux session exists for this VM/schedule
# 2. Verify no lock file exists
# 3. If safe, remove all *.partial files in the backup directory
# 4. Find the latest checkpoint and only remove that checkpoint's files
#
# This ensures we start with a clean slate on retry attempts, avoiding issues
# with leftover partial files from the previous failed backup, while preserving
# the valid backup chain history.
###############################################################################
cleanup_retry_partial_files() {
	local vm_name="$1"
	local schedule="$2"
	local backup_dir="$3"

	info "Retry mode: Performing safety checks and cleanup..."

	# Safety check 1: Verify no tmux session exists
	local sanitized_vm=$(echo "$vm_name" | sed 's/[^a-zA-Z0-9-]/_/g')
	local tmux_session="${sanitized_vm}_${schedule}_backup"

	if tmux has-session -t "$tmux_session" 2>/dev/null; then
		die "SAFETY CHECK FAILED: Active tmux session '$tmux_session' exists. Cannot proceed with retry cleanup. Please ensure no backup is currently running."
	fi
	info "✓ No tmux session found for $tmux_session"

	# Safety check 2: Verify no lock file exists
	local lock_file="$lock_dir/${vm_name}_${schedule}_backup"
	if [[ -f "$lock_file" ]]; then
		die "SAFETY CHECK FAILED: Lock file exists at $lock_file. Cannot proceed with retry cleanup. Please ensure no backup is currently running."
	fi
	info "✓ No lock file found at $lock_file"

	# All safety checks passed - proceed with cleanup
	info "Safety checks passed. Cleaning up partial files..."

	# Remove *.partial files — and ONLY those.
	#
	# This deliberately does NOT delete checkpoints. The previous version removed
	# the newest checkpoint's data files whenever it found a .partial, assuming the
	# newest checkpoint belonged to the failed run. It usually doesn't: a run that
	# dies mid-transfer leaves .partial debris WITHOUT having registered its own
	# checkpoint, so the newest checkpoint is the last GOOD backup. Retrying then
	# deleted that backup — while logging "Older checkpoints preserved (backup
	# chain intact)", which made the loss invisible.
	#
	# Cleaning up after a failed attempt means removing that attempt's debris.
	# Deleting real backup data belongs to retention/archive, never to the retry
	# path. A stale checkpoint left behind is recoverable (method resolution
	# detects and cleans a broken chain); a deleted backup is not.
	local partial_count=0
	if [[ -d "$backup_dir" ]]; then
		# Process substitution rather than a pipe: piping into `while` runs the loop
		# in a subshell, so the counter was always lost and this reported "Removed 0
		# partial file(s)" no matter how many it actually deleted.
		while IFS= read -r partial_file; do
			[[ -f "$partial_file" ]] || continue
			info "Removing partial file: $(basename "$partial_file")"
			rm -f "$partial_file"
			partial_count=$((partial_count + 1))
		done < <(find "$backup_dir" -type f -name "*.partial" 2>/dev/null)

		if [[ $partial_count -gt 0 ]]; then
			info "✓ Removed $partial_count partial file(s)"
		else
			info "✓ No partial files found in $backup_dir"
		fi
	else
		info "✓ Backup directory does not exist yet: $backup_dir"
	fi

	info "✓ Checkpoints left untouched (only the failed attempt's debris is removed)"

	info "✓ Retry cleanup completed successfully"
	return 0
}

create_backup_lock() {
	if [[ -f "$lock_file" ]]; then
		die "Another backup in progress for $vm_name ($schedule). Remove $lock_file if safe."
	fi
	touch "$lock_file"
	return 0
}

remove_backup_lock() {
	if [[ -n "$lock_file" && -f "$lock_file" ]]; then
		rm -f "$lock_file"
	fi
	cleanup_progress_metadata
	return 0
}

get_remote_vm_shutdown_status() {
	vm_shutdown_status=""
	vm_shutdown_status=$(virsh -c "qemu+ssh://root@$remote_ip/system" domstate "$vm_name" 2>/dev/null | awk 'NF' | awk '{print $1}')
	return 0
}

check_incremental_support() {
	if ! virsh -c "qemu+ssh://root@$destination_ip/system" dumpxml "$vm_name" 2>/dev/null | grep -qi "incremental-backup"; then
		if [[ "$method" == "inc" || "$method" == "auto" ]]; then
			warn "VM XML lacks 'incremental-backup' flag. Incremental may fail."
		fi
	fi
	return 0
}

verify_created_backups() {
	local target_dir="$1"
	if [[ "$skip_backup_verification" == "true" ]]; then
		info "Backup verification skipped (--no-verify)."
		return 0
	fi
	if command -v virtnbdrestore &>/dev/null; then
		info "Verifying backup integrity ..."
		if virtnbdrestore -i "$target_dir" -o verify >/dev/null 2>&1; then
			info "Backup verification passed."
			return 0
		else
			echo -e "${Red}${CROSS} Backup verification FAILED${NC}"
			return 1
		fi
	else
		warn "virtnbdrestore not found; skipping verification."
		return 0
	fi
}

###############################################################################
# BACKUP STATE HELPERS
###############################################################################

has_any_backup_data() {
	local dir="$1"
	if [[ ! -d "$dir" ]]; then
		return 1
	fi
	local content=""
	content=$(find "$dir" -mindepth 1 -maxdepth 1 ! -name 'logs' 2>/dev/null | head -1)
	if [[ -n "$content" ]]; then
		return 0
	fi
	return 1
}

###############################################################################
# VALIDATE AND REPAIR SCHEDULER FILE
# Validates scheduler file against actual backup files and repairs if needed
# Only runs once per script execution (cached)
###############################################################################
validate_scheduler() {
	local backup_dir="$1"
	local sched_file="$backup_dir/scheduler"
	
	# Use a flag file to track if validation was done in this script run
	local validation_flag="/tmp/.backup_manager_scheduler_validated_$$"
	
	# If already validated in this script execution, skip
	if [[ -f "$validation_flag" ]]; then
		return 0
	fi
	
	# Mark as validated for this script execution
	touch "$validation_flag" 2>/dev/null || true
	
	# If scheduler doesn't exist, nothing to validate (silently skip)
	[[ ! -f "$sched_file" ]] && return 0
	
	# Only validate if virtnbdrestore is available (silently skip if not)
	command -v virtnbdrestore &>/dev/null || return 0
	
	# Check if backup directory has actual backup data (silently skip if not)
	if ! has_any_backup_data "$backup_dir"; then
		return 0
	fi
	
	# Try to get actual backup state from virtnbdrestore (wrap in error handling)
	local json_output=""
	json_output=$(cd "$backup_dir" && virtnbdrestore -i . -o dump 2>/dev/null | sed -n '/^ *\[/,$p') || return 0
	
	# If virtnbdrestore failed or returned no data, skip validation silently
	if [[ -z "$json_output" ]] || ! echo "$json_output" | jq empty 2>/dev/null; then
		return 0
	fi
	
	# Count actual full and inc backups from virtnbdrestore (with error handling)
	local actual_full_count
	local actual_inc_count
	
	actual_full_count=$(echo "$json_output" | jq '[.[] | select(.incremental == false)] | unique_by(.checkpointName) | length' 2>/dev/null) || return 0
	actual_inc_count=$(echo "$json_output" | jq '[.[] | select(.incremental == true)] | unique_by(.checkpointName) | length' 2>/dev/null) || return 0
	
	# Ensure we got valid numbers
	[[ -z "$actual_full_count" ]] && return 0
	[[ -z "$actual_inc_count" ]] && return 0
	
	# Count entries in scheduler file (excluding headers and comments)
	local sched_full_count
	local sched_inc_count
	sched_full_count=$(grep -ciE '\tfull$' "$sched_file" 2>/dev/null) || return 0
	sched_inc_count=$(grep -ciE '\tinc$' "$sched_file" 2>/dev/null) || return 0
	
	# Convert all counts to decimal integers using awk to avoid octal interpretation
	actual_full_count=$(echo "$actual_full_count" | awk '{print $1+0}' 2>/dev/null) || return 0
	actual_inc_count=$(echo "$actual_inc_count" | awk '{print $1+0}' 2>/dev/null) || return 0
	sched_full_count=$(echo "$sched_full_count" | awk '{print $1+0}' 2>/dev/null) || return 0
	sched_inc_count=$(echo "$sched_inc_count" | awk '{print $1+0}' 2>/dev/null) || return 0
	
	# Check if counts match (allow full count difference since we may have 0 or 1 full)
	if [[ "$sched_inc_count" -ne "$actual_inc_count" ]] || [[ "$sched_full_count" -gt 1 ]]; then
		warn "Scheduler file inconsistent with actual backups"
		info "Scheduler shows: ${sched_full_count} full, ${sched_inc_count} inc"
		info "Actual backups: ${actual_full_count} full, ${actual_inc_count} inc"
		info "Rebuilding scheduler file from actual backup data..."
		
		# Rebuild scheduler file (with error handling)
		local temp_sched="${sched_file}.rebuilding"
		if ! printf "Day\tDate\tMethod\n" >"$temp_sched" 2>/dev/null; then
			return 0  # Can't write, skip silently
		fi
		printf "*******************************\n" >>"$temp_sched"
		printf "# Rebuilt on $(date '+%Y-%m-%d %H:%M:%S')\n" >>"$temp_sched"
		
		# Add full backup entry (use current date if exists)
		if [[ "$actual_full_count" -gt 0 ]]; then
			printf "N/A\tN/A\tfull\n" >>"$temp_sched"
		fi
		
		# Add inc backup entries
		for ((i=1; i<=actual_inc_count; i++)); do
			printf "N/A\tN/A\tinc\n" >>"$temp_sched"
		done
		
		# Replace old scheduler with rebuilt one (with error handling)
		if mv "$temp_sched" "$sched_file" 2>/dev/null; then
			info "Scheduler file rebuilt successfully"
		else
			rm -f "$temp_sched" 2>/dev/null || true
		fi
	fi
	
	return 0
}

count_existing_backups() {
	local dir="$1"
	if [[ ! -d "$dir" ]]; then
		echo 0
		return
	fi
	local content=""
	content=$(ls -A "$dir" 2>/dev/null)
	if [[ -z "$content" ]]; then
		echo 0
		return
	fi
	
	# Validate and repair scheduler file before reading it
	validate_scheduler "$dir"
	
	if [[ -f "$dir/scheduler" ]]; then
		local count=0
		count=$(grep -cEv '^\s*$|^\*|^Day|^#' "$dir/scheduler" 2>/dev/null)
		# Convert to decimal to avoid octal interpretation
		count=$(echo "$count" | awk '{print $1+0}')
		echo "${count:-0}"
	else
		echo 0
	fi
}

# Cache: virtnbdrestore costs a subprocess and has_full_backup is consulted from
# both resolve_method and validate_method_state within a single run.
_HAS_FULL_CACHE_DIR=""
_HAS_FULL_CACHE_RC=""

has_full_backup() {
	local dir="$1"

	if [[ -n "$_HAS_FULL_CACHE_RC" && "$dir" == "$_HAS_FULL_CACHE_DIR" ]]; then
		return "$_HAS_FULL_CACHE_RC"
	fi

	_has_full_backup_uncached "$dir"
	local rc=$?
	_HAS_FULL_CACHE_DIR="$dir"
	_HAS_FULL_CACHE_RC="$rc"
	return "$rc"
}

# Does this directory hold a real full backup?
#
# Answered from evidence, in order of authority. It used to be a filename glob
# (`*.full.*`), which also matched virtnbdbackup's OWN log file
# "backup.full.<ts>.log". So a full backup that FAILED and produced nothing but
# a log still looked like a successful full: every later run picked inc, and
# virtnbdbackup died with "No full backup found in target directory" — forever,
# because each failure dropped another log that kept the directory looking
# populated. The script even printed the contradiction it was ignoring:
# "Full backup exists (0/7 backups)".
_has_full_backup_uncached() {
	local dir="$1"
	[[ -d "$dir" ]] || return 1

	# 1. virtnbdrestore is authoritative: it reads the actual data files instead
	#    of inferring from names. "No data files found" + non-zero exit is proof
	#    that not one backup data file exists here, whatever the logs suggest.
	if command -v virtnbdrestore &>/dev/null; then
		local out="" rc=0
		out=$(virtnbdrestore -o dump -i "$dir" 2>&1)
		rc=$?

		if [[ $rc -eq 0 ]]; then
			# A readable chain exists. virtnbdbackup cannot write an inc without a
			# full, so readable data implies a full.
			return 0
		fi
		if grep -qi "No data files found" <<<"$out"; then
			return 1
		fi
		# Non-zero for some other reason (corrupt chain, tool error): inconclusive,
		# so fall through rather than act on a result we do not understand.
	fi

	# 2. The scheduler ledger. record_scheduler only writes after a backup has
	#    actually succeeded, so a "full" entry is a record of a real full.
	if [[ -f "$dir/scheduler" ]] && grep -qiw "full" "$dir/scheduler" 2>/dev/null; then
		return 0
	fi

	# 3. Nothing evidences a full. Safe because the broken-chain path quarantines
	#    rather than deletes — see quarantine_broken_chain.
	return 1
}

# Move a broken chain's contents aside instead of deleting them.
#
# This path is reached when a directory has content but no provable full backup.
# It used to run `rm -rf` over everything but logs/, which is unacceptable when
# the decision rests on inference: one wrong call and real backups are gone with
# no way back. Quarantining is equally effective at unblocking a fresh full, and
# a human can inspect (and delete) the leftovers at their leisure.
#
# Quarantine lives OUTSIDE the schedule directory so it cannot be mistaken for
# backup content by later runs.
quarantine_broken_chain() {
	local dir="$1"
	local sched_name=""
	sched_name=$(basename "$dir")

	# Gather first: only create the quarantine directory if there is something
	# to put in it, so repeated failures do not litter empty folders.
	local -a items=()
	local entry="" base=""
	while IFS= read -r -d '' entry; do
		base=$(basename "$entry")
		[[ "$base" == "logs" ]] && continue
		items+=("$entry")
	done < <(find "$dir" -mindepth 1 -maxdepth 1 -print0 2>/dev/null)

	if [[ ${#items[@]} -eq 0 ]]; then
		info "Nothing to quarantine in $dir"
		return 0
	fi

	local stamp=""
	stamp=$(date +"%Y-%m-%d_%H-%M-%S")
	local qdir="$vm_base_dir/.broken/${sched_name}_${stamp}"

	if ! mkdir -p "$qdir" 2>/dev/null; then
		warn "Could not create quarantine directory $qdir"
		warn "Leaving $dir untouched — nothing was deleted. Backup will likely fail; please clear it manually."
		return 1
	fi

	local moved=0
	for entry in "${items[@]}"; do
		if mv "$entry" "$qdir/" 2>/dev/null; then
			moved=$((moved + 1))
		else
			warn "Could not move $(basename "$entry") into quarantine"
		fi
	done

	info "Quarantined $moved item(s) to $qdir"
	info "Nothing was deleted — remove that directory once you have reviewed it."
	return 0
}

###############################################################################
# HYPERVISOR-SIDE CHAIN INTEGRITY
#
# A virtnbdbackup incremental chain lives in two places:
#
#   1. The target directory — data files plus checkpoints/, the on-disk
#      checkpoint definitions.
#   2. The hypervisor — libvirt checkpoints plus the persistent qemu dirty
#      bitmaps they describe.
#
# has_full_backup only ever inspects (1). KVM_Fix_Backup.sh only ever destroys
# (2) — that is its entire job, and its closing message says so. So after a
# backup fix the target directory still looks perfect (virtnbdrestore reads it
# happily), auto_detect_method concluded "full exists, under retention → inc",
# and virtnbdbackup died putting the chain back onto the VM:
#
#   Loaded checkpoint list from: <dir>/checkpoints
#   Redefine missing checkpoint: [virtnbdbackup.0]
#   Redefining checkpoint failed: checkpoint inconsistent: missing or broken
#     bitmap 'virtnbdbackup.0' for disk 'vda'
#
# And it never recovered on its own: a failed inc leaves the directory untouched
# by design, so nothing recorded that the chain was dead and every later run
# reached the same verdict and failed the same way, indefinitely.
#
# These helpers ask the hypervisor the question the target directory cannot
# answer: can this chain still be extended?
###############################################################################

# The checkpoint names this chain expects the VM to still hold.
#
# Primary source is <dir>/checkpoints — the very directory virtnbdbackup reports
# loading its list from. Diffing the same set it diffs reproduces its decision
# instead of approximating it. Deliberately NOT the scheduler ledger: that file
# records Day/Date/Method with no checkpoint names at all, its counts drift by
# design (record_scheduler dedupes per day, validate_scheduler rebuilds it with
# N/A placeholders), and the system already treats it as derived — so it can
# only ever support a count comparison, and an unreliable one.
expected_chain_checkpoints() {
	local dir="$1"
	local cp_dir="$dir/checkpoints"

	if [[ -d "$cp_dir" ]]; then
		local names=""
		names=$(find "$cp_dir" -maxdepth 1 -type f -printf '%f\n' 2>/dev/null |
			sed 's/\.xml$//' | awk 'NF' | sort -u)
		if [[ -n "$names" ]]; then
			printf '%s\n' "$names"
			return 0
		fi
	fi

	# Fallback when checkpoints/ is absent or unreadable: virtnbdrestore reads
	# the data files themselves and reports each checkpointName.
	#
	# The array is located by a line that is *only* an opening bracket (or a
	# bracket immediately opening an object). Anchoring on a bare '[' the way
	# `sed -n '/^ *\[/,$p'` does is too loose: every virtnbdbackup log line
	# begins with "[2026-07-27 12:38:01] INFO ...", so the moment one of them
	# reaches stdout the captured text starts with a log line, jq rejects it,
	# and the chain silently appears to expect nothing — which would wave a
	# broken incremental straight through.
	if command -v virtnbdrestore &>/dev/null && command -v jq &>/dev/null; then
		local dump=""
		dump=$(virtnbdrestore -o dump -i "$dir" 2>/dev/null |
			sed 's/\x1b\[[0-9;]*m//g' |
			sed -n '/^[[:space:]]*\[[[:space:]]*\({\|$\)/,$p')
		if [[ -n "$dump" ]] && jq empty <<<"$dump" 2>/dev/null; then
			jq -r '.[].checkpointName' <<<"$dump" 2>/dev/null | awk 'NF' | sort -u
			return 0
		fi
	fi

	return 0
}

# Checkpoint names the VM actually holds. Non-zero exit means we could not ask,
# which must be treated as inconclusive rather than as "none".
hypervisor_checkpoints() {
	local out=""
	if ! out=$(virsh -c "qemu+ssh://root@$destination_ip/system" \
		checkpoint-list --name "$vm_name" 2>/dev/null); then
		return 1
	fi
	printf '%s\n' "$out" | awk 'NF' | sort -u
	return 0
}

# Dirty bitmaps qemu has flagged inconsistent.
#
# Only `inconsistent` is treated as broken. A bitmap that is merely not
# recording is normal (they are disabled while a backup runs), so testing for
# that would condemn healthy chains.
inconsistent_chain_bitmaps() {
	command -v jq &>/dev/null || return 0

	local qmp=""
	qmp=$(virsh -c "qemu+ssh://root@$destination_ip/system" qemu-monitor-command \
		"$vm_name" --cmd '{"execute":"query-block"}' 2>/dev/null) || return 0
	[[ -n "$qmp" ]] || return 0
	jq empty <<<"$qmp" 2>/dev/null || return 0

	jq -r '
		[ .return[]?
		  | .inserted?
		  | select(. != null)
		  | (.["dirty-bitmaps"]? // [])
		  | .[]
		  | select(.inconsistent == true)
		  | .name
		] | unique | .[]
	' <<<"$qmp" 2>/dev/null | awk 'NF' | sort -u
	return 0
}

# Can this chain be extended? 0 = yes, 1 = no, 2 = could not determine.
# The reason is left in _CHAIN_HEALTH_REASON for logging.
#
# Cached: consulted from both validate_method_state and the full-side stale
# check within a single run, and each call costs an SSH round trip.
_CHAIN_HEALTH_CACHE_DIR=""
_CHAIN_HEALTH_CACHE_RC=""
_CHAIN_HEALTH_REASON=""

hypervisor_chain_intact() {
	local dir="$1"

	if [[ -n "$_CHAIN_HEALTH_CACHE_RC" && "$dir" == "$_CHAIN_HEALTH_CACHE_DIR" ]]; then
		return "$_CHAIN_HEALTH_CACHE_RC"
	fi

	_hypervisor_chain_intact_uncached "$dir"
	local rc=$?
	_CHAIN_HEALTH_CACHE_DIR="$dir"
	_CHAIN_HEALTH_CACHE_RC="$rc"
	return "$rc"
}

_hypervisor_chain_intact_uncached() {
	local dir="$1"
	_CHAIN_HEALTH_REASON=""

	local expected=""
	expected=$(expected_chain_checkpoints "$dir")
	if [[ -z "$expected" ]]; then
		# The chain expects nothing of the VM, so there is nothing to redefine
		# and nothing that can be missing.
		return 0
	fi

	local actual=""
	if ! actual=$(hypervisor_checkpoints); then
		_CHAIN_HEALTH_REASON="could not read the checkpoint list from $destination_ip"
		return 2
	fi

	# expected ⊆ actual. ANY missing member breaks the redefine, not just the
	# base checkpoint: virtnbdbackup redefines every checkpoint the target knows
	# about and the VM does not, and one failure aborts the run.
	local missing=""
	missing=$(comm -23 <(printf '%s\n' "$expected") <(printf '%s\n' "$actual") |
		awk 'NF' | paste -sd, -)
	if [[ -n "$missing" ]]; then
		_CHAIN_HEALTH_REASON="checkpoint(s) missing on the hypervisor: $missing"
		return 1
	fi

	# Names all present is necessary but not sufficient — note the error is
	# "missing OR BROKEN bitmap". A checkpoint can be listed while the bitmap it
	# describes is inconsistent, which fails in exactly the same place.
	local broken=""
	broken=$(inconsistent_chain_bitmaps)
	if [[ -n "$broken" ]]; then
		local overlap=""
		overlap=$(comm -12 <(printf '%s\n' "$expected") <(printf '%s\n' "$broken") |
			awk 'NF' | paste -sd, -)
		if [[ -n "$overlap" ]]; then
			_CHAIN_HEALTH_REASON="inconsistent dirty bitmap(s) on the hypervisor: $overlap"
			return 1
		fi
	fi

	return 0
}

# The mirror drift: checkpoints the VM carries that no local chain accounts for.
#
# These do not break an incremental — they break a FULL. A fresh chain colliding
# with leftover virtnbdbackup.N state is exactly what KVM_Fix_Backup.sh's
# offline path sweeps with `qemu-img bitmap --remove`. Reported, never acted on:
# deleting checkpoints on a live hypervisor is not this script's call to make.
stale_hypervisor_checkpoints() {
	local dir="$1"

	local actual=""
	actual=$(hypervisor_checkpoints) || return 0
	[[ -n "$actual" ]] || return 0

	local expected=""
	expected=$(expected_chain_checkpoints "$dir")

	comm -13 <(printf '%s\n' "$expected" | sort -u) <(printf '%s\n' "$actual") | awk 'NF'
	return 0
}

warn_stale_hypervisor_state() {
	local stale=""
	stale=$(stale_hypervisor_checkpoints "$backup_dir" | paste -sd, -)
	[[ -z "$stale" ]] && return 0

	warn "Hypervisor holds checkpoint(s) no local chain accounts for: $stale"
	warn "A fresh full may collide with them. If this backup fails, run the backup fix for '$vm_name' and retry."
	emit_event "stale_hypervisor_checkpoints" "warning" \
		"Stale checkpoints on hypervisor" "checkpoints=$stale"
	return 0
}

###############################################################################
# "NEXT BACKUP MUST BE FULL" MARKER
#
# KVM_Fix_Backup.sh knows for certain that it has invalidated every chain for a
# VM. Until now that knowledge died with the SSH session, leaving this script to
# rediscover it the hard way (or not at all). The fix endpoint now records it
# beside the VM's backup directories, and this script honours it without needing
# to ask the hypervisor anything.
###############################################################################

needs_full_marker_present() {
	[[ -n "$needs_full_marker" && -f "$needs_full_marker" ]]
}

needs_full_marker_reason() {
	local reason=""
	if needs_full_marker_present && command -v jq &>/dev/null; then
		reason=$(jq -r '.reason // empty' "$needs_full_marker" 2>/dev/null)
	fi
	[[ -z "$reason" ]] && reason="a backup fix reset this VM's checkpoint metadata"
	printf '%s' "$reason"
}

clear_needs_full_marker() {
	needs_full_marker_present || return 0
	if rm -f "$needs_full_marker" 2>/dev/null; then
		info "Cleared the 'next backup must be full' marker."
		emit_event "needs_full_cleared" "info" "Marker cleared after a successful backup"
	else
		warn "Could not remove $needs_full_marker — the next run will force a full again."
	fi
	return 0
}

# Set aside the current chain and switch to full.
#
# ARCHIVE, not quarantine. This chain is still perfectly restorable — it simply
# cannot be extended. .broken/ is for data whose integrity is in doubt; this
# data's integrity is not in doubt, so it belongs in archived/ alongside every
# other rotated chain, visible to restore and subject to --keep-archive pruning.
promote_chain_to_full() {
	local reason="$1"

	warn "Incremental is not possible: $reason"
	info "Archiving the existing chain and starting a new full backup."

	archive_current_chain "$backup_dir" "$schedule"
	prune_archives "$schedule" "$archives_to_keep"
	mkdir -p "$backup_dir" "$log_dir" 2>/dev/null

	method="full"
	emit_event "chain_promoted_full" "warning" "Promoted inc → full: $reason" "reason=$reason"
	return 0
}

# Gate an incremental on the hypervisor half of the chain.
#
# Runs for BOTH an auto-resolved 'inc' and an explicit --method inc (custom-days
# sends one). Refusing an operator's explicit inc guarantees a failed job;
# promoting it produces a working backup, and there is precedent for that right
# next door in validate_method_state ("No existing backup. Switching to full.").
enforce_inc_chain_health() {
	if needs_full_marker_present; then
		promote_chain_to_full "$(needs_full_marker_reason)"
		return 0
	fi

	local rc=0
	hypervisor_chain_intact "$backup_dir"
	rc=$?

	case "$rc" in
	1)
		promote_chain_to_full "$_CHAIN_HEALTH_REASON"
		;;
	2)
		# Inconclusive. Do not act on a result we do not understand: archiving a
		# healthy chain costs a full backup and a restore path. Proceed with the
		# inc and let virtnbdbackup be the authority — the reactive path in
		# main() catches it if it does fail.
		warn "Could not verify hypervisor checkpoint state (${_CHAIN_HEALTH_REASON:-unknown}). Proceeding with inc."
		;;
	*)
		info "Hypervisor still holds this chain's checkpoints. Incremental is safe."
		;;
	esac
	return 0
}

# Guards the reactive recovery in main() to a single attempt, so a chain that is
# broken for a reason archiving cannot fix can never loop.
_chain_recovery_attempted="false"

# Signatures that mean "this chain cannot be extended", taken from
# virtnbdbackup's own output. These are its verdicts, not our inferences.
chain_failure_detected() {
	local log="$1"
	[[ -n "$log" && -f "$log" ]] || return 1
	grep -qiE 'Failed to redefine checkpoints|checkpoint inconsistent|missing or broken bitmap|No full backup found in target directory' \
		"$log" 2>/dev/null
}

check_method_conflicts() {
	if [[ "$method" == "copy" ]]; then
		return 0
	fi
	local sched_dirs=("daily" "weekly" "custom")
	local s=""
	for s in "${sched_dirs[@]}"; do
		if [[ "$s" == "$schedule" ]]; then
			continue
		fi
		local other_dir="$vm_base_dir/$s"
		if [[ -d "$other_dir" ]] && has_any_backup_data "$other_dir"; then
			if [[ -f "$other_dir/scheduler" ]] && grep -qiE "full|inc" "$other_dir/scheduler" 2>/dev/null; then
				die "Conflict: Active full/inc chain under '$s'. Only one allowed per VM."
			fi
		fi
	done
	return 0
}

validate_method_state() {
	case "$method" in
	full)
		if has_full_backup "$backup_dir"; then
			die "Full backup already exists in $backup_dir. Archive or remove first."
		fi
		;;
	inc)
		if ! has_full_backup "$backup_dir"; then
			if ! has_any_backup_data "$backup_dir"; then
				info "No existing backup. Switching to full."
				method="full"
			else
				die "No full backup but data exists in $backup_dir. Broken chain. Remove contents."
			fi
		fi

		# A readable full on disk is only half the requirement. The hypervisor
		# must still hold the checkpoints this chain expects, or virtnbdbackup
		# fails redefining them — a non-empty directory containing a perfectly
		# good full is exactly the state that used to slip through here.
		if [[ "$method" == "inc" ]]; then
			enforce_inc_chain_health
		fi
		;;
	auto)
		die "Method auto-detection should have resolved before validation. This is a bug."
		;;
	esac
	return 0
}

###############################################################################
# RETENTION / ARCHIVE / PRUNE
###############################################################################

archive_current_chain() {
	local source_dir="$1"
	local sched="$2"
	local timestamp=""
	timestamp=$(date +"%Y-%m-%d_%H-%M-%S")
	local archive_name="${timestamp}_${vm_name}_${sched}"
	local archive_target="$archived_backup_dir/$archive_name"

	if ! has_any_backup_data "$source_dir"; then
		return 0
	fi

	info "Archiving backup chain → $archive_target ..."
	mkdir -p "$archive_target"
	find "$source_dir" -mindepth 1 -maxdepth 1 ! -name 'logs' -exec mv {} "$archive_target/" \;
	info "Archived successfully."

	_archived_this_run="$archive_name"
	emit_event "archive" "success" "Archived chain to $archive_name" "archive_name=$archive_name"
	return 0
}

prune_archives() {
	local sched="$1"
	local keep="$2"
	if [[ -z "$keep" ]] || [[ "$keep" -lt 1 ]]; then
		return 0
	fi
	_pruned_archives=()

	# Match both the current naming scheme (<timestamp>_<vm_name>_<sched>)
	# and the legacy scheme (archived-<vm_name>_<timestamp>) used by older
	# versions of this script, so old-style archives are counted and pruned
	# too instead of accumulating forever.
	local matching_archives=()
	local entry=""
	local mtime=""
	local dated=()
	while IFS= read -r -d '' entry; do
		mtime=$(stat -c '%Y' "$entry" 2>/dev/null || stat -f '%m' "$entry" 2>/dev/null)
		[[ -z "$mtime" ]] && mtime=0
		dated+=("${mtime} ${entry}")
	done < <(find "$archived_backup_dir" -maxdepth 1 -mindepth 1 -type d \
		\( -name "*_${vm_name}_${sched}" -o -name "archived-${vm_name}_*" \) \
		-print0 2>/dev/null)

	if [[ ${#dated[@]} -gt 0 ]]; then
		while IFS= read -r line; do
			[[ -n "$line" ]] && matching_archives+=("${line#* }")
		done < <(printf '%s\n' "${dated[@]}" | sort -n)
	fi

	local count=${#matching_archives[@]}
	if [[ "$count" -gt "$keep" ]]; then
		local to_remove=$((count - keep))
		info "Pruning $to_remove old archive(s) (keeping $keep) ..."
		local i=0
		for ((i = 0; i < to_remove; i++)); do
			local pruned_name=""
			pruned_name=$(basename "${matching_archives[$i]}")
			echo -e "  ${Dim}Removing: ${matching_archives[$i]}${NC}"
			rm -rf "${matching_archives[$i]}"
			_pruned_archives+=("$pruned_name")
			emit_event "prune" "success" "Pruned $pruned_name" "pruned=$pruned_name"
		done
	fi
	return 0
}

handle_retention() {
	if [[ -z "$retention" ]]; then
		return 0
	fi
	if [[ "$method" == "copy" ]]; then
		return 0
	fi

	local current_count=0
	current_count=$(count_existing_backups "$backup_dir")

	if [[ "$current_count" -ge "$retention" ]]; then
		info "Retention ($retention) reached ($current_count backups). Archiving ..."
		archive_current_chain "$backup_dir" "$schedule"
		prune_archives "$schedule" "$archives_to_keep"
		mkdir -p "$backup_dir" "$log_dir" 2>/dev/null

		# After archiving, always start fresh with full
		if [[ "$method" != "full" ]]; then
			info "Chain archived. Switching method to 'full' for new chain."
		fi
		method="full"
	fi
	return 0
}

###############################################################################
# AUTO-DETECT METHOD
###############################################################################

auto_detect_method() {
	if [[ "$method" != "auto" ]]; then
		return 0
	fi

	info "Auto-detecting backup method ..."

	# Case 1: No backup data at all → full
	if ! has_any_backup_data "$backup_dir"; then
		method="full"
		info "No existing backup found. Method: full (new chain)"
		emit_event "method_auto" "info" "Auto-selected: full (empty directory)"
		return 0
	fi

	# Case 2: Content exists but no provable full backup → broken state.
	# Quarantine rather than delete: this decision rests on inference, and the
	# cost of being wrong must never be destroyed backups.
	if ! has_full_backup "$backup_dir"; then
		warn "Content exists but no full backup found. Quarantining and starting fresh."
		quarantine_broken_chain "$backup_dir"
		method="full"
		info "Broken chain set aside. Method: full (fresh start)"
		emit_event "method_auto" "warning" "Auto-selected: full (broken chain quarantined)"
		return 0
	fi

	# Case 3: Retention already reached (safety net — handle_retention runs first)
	local current_count=0
	current_count=$(count_existing_backups "$backup_dir")

	if [[ -n "$retention" && "$current_count" -ge "$retention" ]]; then
		method="full"
		info "Retention limit reached. Method: full (new chain after archive)"
		emit_event "method_auto" "info" "Auto-selected: full (retention reached)"
		return 0
	fi

	# Case 4: Full exists, under retention → incremental
	method="inc"
	local retention_display="${retention:-∞}"
	info "Full backup exists ($current_count/$retention_display backups). Method: inc"
	emit_event "method_auto" "info" "Auto-selected: inc ($current_count/$retention_display)"
	return 0
}

###############################################################################
# PROGRESS BAR FUNCTIONS
###############################################################################

write_progress_metadata() {
	local pct="$1"
	local text="$2"
	local type="${3:-backup}"

	if [[ -n "$progress_file" ]]; then
		printf '{"percentage":%d,"text":"%s","type":"%s","timestamp":"%s"}\n' \
			"$pct" "$text" "$type" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" >"$progress_file" 2>/dev/null
	fi
}

cleanup_progress_metadata() {
	if [[ -n "$progress_file" && -f "$progress_file" ]]; then
		rm -f "$progress_file" 2>/dev/null
	fi
}

get_terminal_width() {
	tput cols 2>/dev/null || echo 80
}

draw_aggregate_progress_bar() {
	local overall_pct="$1"
	local overall_xferred="$2"
	local overall_total="$3"
	local disk_status="$4"
	local term_width=""
	term_width=$(get_terminal_width)

	if [[ "$overall_pct" -lt 0 ]]; then overall_pct=0; fi
	if [[ "$overall_pct" -gt 100 ]]; then overall_pct=100; fi

	# Throttle: re-render only when the percentage changes, or at most every
	# 5s otherwise. Every render is captured into the job log by tmux
	# pipe-pane, so unthrottled rendering (one line per virtnbdbackup tick,
	# often byte-identical) bloats job logs by an order of magnitude.
	local _now_ts
	_now_ts=$(date +%s)
	if [[ "$overall_pct" == "${_AGG_LAST_PCT:-}" && $((_now_ts - ${_AGG_LAST_TS:-0})) -lt 5 && "$overall_pct" -lt 100 ]]; then
		return 0
	fi
	_AGG_LAST_PCT="$overall_pct"
	_AGG_LAST_TS="$_now_ts"

	# Write progress metadata
	write_progress_metadata "$overall_pct" "Backup: $overall_xferred/$overall_total" "backup"

	local suffix=""
	suffix=$(printf " %3d%%  %s/%s  [%s]" "$overall_pct" "$overall_xferred" "$overall_total" "$disk_status")
	local suffix_len=${#suffix}
	local bar_prefix="  ▐"
	local bar_suffix="▌"
	local reserved=$((${#bar_prefix} + ${#bar_suffix} + suffix_len + 2))
	local bar_width=$((term_width - reserved))
	if [[ "$bar_width" -lt 10 ]]; then bar_width=10; fi
	if [[ "$bar_width" -gt 60 ]]; then bar_width=60; fi

	local filled=$((bar_width * overall_pct / 100))
	local empty=$((bar_width - filled))
	local bar_filled="" bar_empty=""
	local j=0
	for ((j = 0; j < filled; j++)); do bar_filled+="█"; done
	for ((j = 0; j < empty; j++)); do bar_empty+="░"; done

	local bar_color="$Cyan"
	if [[ "$overall_pct" -ge 100 ]]; then bar_color="$Green"; fi

	printf "\r${bar_color}${bar_prefix}%s%s${bar_suffix}${Bold}%s${NC}" \
		"$bar_filled" "$bar_empty" "$suffix"
}

parse_progress_line() {
	local line="$1"
	if [[ "$line" =~ saving\ disk\ ([a-zA-Z0-9_-]+):\ *([0-9]+)%\|.*\|\ *([0-9.]+[KMGTP]?i?B?)/([0-9.]+[KMGTP]?i?B?) ]]; then
		_pb_disk="${BASH_REMATCH[1]}"
		_pb_pct="${BASH_REMATCH[2]}"
		_pb_xferred="${BASH_REMATCH[3]}"
		_pb_total="${BASH_REMATCH[4]}"
		return 0
	fi
	return 1
}

human_to_bytes() {
	local val="$1"
	val="${val%%iB}"
	val="${val%%B}"
	local number=""
	local unit=""
	number=$(echo "$val" | sed 's/[^0-9.]//g')
	unit=$(echo "$val" | sed 's/[0-9.]//g' | tr '[:lower:]' '[:upper:]')
	if [[ -z "$number" ]]; then
		echo 0
		return
	fi
	case "$unit" in
	K) echo "$number * 1024" | bc 2>/dev/null | cut -d. -f1 ;;
	M) echo "$number * 1024 * 1024" | bc 2>/dev/null | cut -d. -f1 ;;
	G) echo "$number * 1024 * 1024 * 1024" | bc 2>/dev/null | cut -d. -f1 ;;
	T) echo "$number * 1024 * 1024 * 1024 * 1024" | bc 2>/dev/null | cut -d. -f1 ;;
	P) echo "$number * 1024 * 1024 * 1024 * 1024 * 1024" | bc 2>/dev/null | cut -d. -f1 ;;
	*) echo "$number" | cut -d. -f1 ;;
	esac
}

bytes_to_human() {
	local bytes="$1"
	if [[ -z "$bytes" ]] || [[ "$bytes" == "0" ]]; then
		echo "0B"
		return
	fi
	if [[ "$bytes" -ge 1099511627776 ]]; then
		echo "$(echo "scale=2; $bytes / 1099511627776" | bc 2>/dev/null)T"
	elif [[ "$bytes" -ge 1073741824 ]]; then
		echo "$(echo "scale=2; $bytes / 1073741824" | bc 2>/dev/null)G"
	elif [[ "$bytes" -ge 1048576 ]]; then
		echo "$(echo "scale=2; $bytes / 1048576" | bc 2>/dev/null)M"
	elif [[ "$bytes" -ge 1024 ]]; then
		echo "$(echo "scale=2; $bytes / 1024" | bc 2>/dev/null)K"
	else
		echo "${bytes}B"
	fi
}

###############################################################################
# RSYNC PROGRESS BAR  (aggregate style — matches virtnbdbackup bar exactly)
###############################################################################

# parse_rsync_progress: sets _rsync_pct _rsync_speed _rsync_xferred _rsync_eta
# Handles both --info=progress2 single-line format and classic rsync format.
parse_rsync_progress() {
	local line="$1"

	# Reset variables
	_rsync_pct=""
	_rsync_speed=""
	_rsync_xferred=""
	_rsync_eta=""

	# Try format 1: --info=progress2  →  "    1,234,567  42%  12.34MB/s    0:00:08"
	if [[ "$line" =~ ([0-9,]+)[[:space:]]+([0-9]+)%[[:space:]]+([0-9.]+[KMGTP]?B/s)[[:space:]]+([0-9:]+) ]]; then
		_rsync_xferred="${BASH_REMATCH[1]}"
		_rsync_pct="${BASH_REMATCH[2]}"
		_rsync_speed="${BASH_REMATCH[3]}"
		_rsync_eta="${BASH_REMATCH[4]}"
		return 0
	fi

	# Try format 2: without commas  →  "    1234567  42%  12.34MB/s    0:00:08"
	if [[ "$line" =~ ([0-9]+)[[:space:]]+([0-9]+)%[[:space:]]+([0-9.]+[KMGTP]?B/s)[[:space:]]+([0-9:]+) ]]; then
		_rsync_xferred="${BASH_REMATCH[1]}"
		_rsync_pct="${BASH_REMATCH[2]}"
		_rsync_speed="${BASH_REMATCH[3]}"
		_rsync_eta="${BASH_REMATCH[4]}"
		return 0
	fi

	# Try format 3: with units  →  "    1.23M  42%  12.34MB/s    0:00:08"
	if [[ "$line" =~ ([0-9.]+[KMGTP]?)[[:space:]]+([0-9]+)%[[:space:]]+([0-9.]+[KMGTP]?B/s)[[:space:]]+([0-9:]+) ]]; then
		_rsync_xferred="${BASH_REMATCH[1]}"
		_rsync_pct="${BASH_REMATCH[2]}"
		_rsync_speed="${BASH_REMATCH[3]}"
		_rsync_eta="${BASH_REMATCH[4]}"
		return 0
	fi

	# Try format 4: just percentage  →  "42%"
	if [[ "$line" =~ ([0-9]+)% ]]; then
		_rsync_pct="${BASH_REMATCH[1]}"
		_rsync_xferred="0"
		_rsync_speed=""
		_rsync_eta=""
		return 0
	fi

	return 1
}

# draw_rsync_progress_bar: identical visual style to draw_aggregate_progress_bar
# Args: pct  speed  xferred  eta  label
draw_rsync_progress_bar() {
	local pct="$1"
	local speed="$2"
	local xferred="$3"
	local eta="$4"
	local label="$5"
	local term_width=""
	term_width=$(get_terminal_width)

	if [[ "$pct" -lt 0 ]]; then pct=0; fi
	if [[ "$pct" -gt 100 ]]; then pct=100; fi

	# Throttle identically to draw_aggregate_progress_bar: re-render only on
	# a percentage change, or at most every 5s — keeps job logs small.
	local _now_ts
	_now_ts=$(date +%s)
	if [[ "$pct" == "${_RSYNC_LAST_PCT:-}" && $((_now_ts - ${_RSYNC_LAST_TS:-0})) -lt 5 && "$pct" -lt 100 ]]; then
		return 0
	fi
	_RSYNC_LAST_PCT="$pct"
	_RSYNC_LAST_TS="$_now_ts"

	# Write progress metadata
	write_progress_metadata "$pct" "Offsite sync: $xferred @ $speed" "rsync"

	# Build suffix — same layout as aggregate bar: pct  xferred/speed  [label]
	local suffix=""
	suffix=$(printf " %3d%%  %s @ %s  ETA: %s  [%s]" "$pct" "$xferred" "$speed" "$eta" "$label")
	local suffix_len=${#suffix}
	local bar_prefix="  ▐"
	local bar_suffix="▌"
	local reserved=$((${#bar_prefix} + ${#bar_suffix} + suffix_len + 2))
	local bar_width=$((term_width - reserved))
	if [[ "$bar_width" -lt 10 ]]; then bar_width=10; fi
	if [[ "$bar_width" -gt 60 ]]; then bar_width=60; fi

	local filled=$((bar_width * pct / 100))
	local empty=$((bar_width - filled))
	local bar_filled="" bar_empty=""
	local j=0
	for ((j = 0; j < filled; j++)); do bar_filled+="█"; done
	for ((j = 0; j < empty; j++)); do bar_empty+="░"; done

	# Cyan while in progress, Green when done — same as aggregate bar
	local bar_color="$Cyan"
	if [[ "$pct" -ge 100 ]]; then bar_color="$Green"; fi

	printf "\r${bar_color}${bar_prefix}%s%s${bar_suffix}${Bold}%s${NC}" \
		"$bar_filled" "$bar_empty" "$suffix"
}

###############################################################################
# run_rsync_with_progress
#
# Drop-in rsync runner that shows the aggregate-style progress bar.
# Usage:
#   run_rsync_with_progress  \
#       <detail_log>         \   absolute path for the raw rsync output log
#       <label>              \   short label shown inside […] on the bar
#       <emit_prefix>        \   prefix for emit_event calls (e.g. "offsite_rsync")
#       [rsync args …]           all remaining args are passed verbatim to rsync
#
# Returns: exit code of rsync (0 = success, non-zero = failure).
# Side-effects: prints progress bar to stdout; appends raw output to detail_log.
###############################################################################
run_rsync_with_progress() {
	local detail_log="$1"
	local label="$2"
	local emit_prefix="$3"
	shift 3
	# $@ now contains the full rsync command arguments

	info "Starting rsync: $label"
	if [[ "$verbose" == "true" ]]; then
		echo -e "${Dim}  Command: rsync $*${NC}"
	fi

	emit_event "${emit_prefix}_start" "in_progress" "Starting rsync: $label" "label=$label"

	if [[ "$verbose" == "true" ]]; then
		# In verbose mode stream directly — no progress bar, full output visible
		rsync "$@"
		local rc=$?
		if [[ $rc -eq 0 ]]; then
			emit_event "${emit_prefix}_complete" "success" "rsync complete: $label"
		else
			emit_event "${emit_prefix}_fail" "error" "rsync failed: $label" "exit_code=$rc"
		fi
		return $rc
	fi

	# ── Non-verbose: pipe through fifo and draw progress bar ─────────────

	local fifo=""
	fifo="$BACKUP_TMP_FIFOS/.rsync_prog_fifo_$$"
	mkfifo "$fifo"

	local exit_code_file="$BACKUP_TMP_EXIT/.rsync_prog_exit_$$"
	rm -f "$exit_code_file"

	# Run rsync with --info=progress2 injected (idempotent if caller already set it)
	(
		rsync --info=progress2 "$@" >"$fifo" 2>&1
		echo $? >"$exit_code_file"
	) &
	local bg_pid=$!

	local _rsync_pct="" _rsync_speed="" _rsync_xferred="" _rsync_eta=""
	local last_emit_pct=-1
	local progress_shown=false
	local char="" line_buf=""

	# ── Read fifo character-by-character (handles \r progress rewrites) ──
	while IFS= read -r -n1 -d '' char || {
		# Flush remaining buffer on EOF
		if [[ -n "$line_buf" ]]; then
			echo "$line_buf" >>"$detail_log"
			if parse_rsync_progress "$line_buf"; then
				draw_rsync_progress_bar \
					"$_rsync_pct" "$_rsync_speed" "$_rsync_xferred" "$_rsync_eta" "$label"
				progress_shown=true
				if [[ $((_rsync_pct - last_emit_pct)) -ge 5 ]]; then
					last_emit_pct=$_rsync_pct
					emit_event "${emit_prefix}_progress" "in_progress" \
						"rsync ${_rsync_pct}% — $label" \
						"percent=$_rsync_pct" "speed=$_rsync_speed" \
						"transferred=$_rsync_xferred" "eta=$_rsync_eta"
				fi
			fi
			line_buf=""
		fi
		false
	}; do
		case "$char" in
		$'\r' | $'\n')
			if [[ -n "$line_buf" ]]; then
				echo "$line_buf" >>"$detail_log"
				if parse_rsync_progress "$line_buf"; then
					draw_rsync_progress_bar \
						"$_rsync_pct" "$_rsync_speed" "$_rsync_xferred" "$_rsync_eta" "$label"
					progress_shown=true
					if [[ $((_rsync_pct - last_emit_pct)) -ge 5 ]]; then
						last_emit_pct=$_rsync_pct
						emit_event "${emit_prefix}_progress" "in_progress" \
							"rsync ${_rsync_pct}% — $label" \
							"percent=$_rsync_pct" "speed=$_rsync_speed" \
							"transferred=$_rsync_xferred" "eta=$_rsync_eta"
					fi
				fi
			fi
			line_buf=""
			;;
		*)
			line_buf+="$char"
			;;
		esac
	done <"$fifo"

	wait "$bg_pid" 2>/dev/null
	rm -f "$fifo"

	# Move to next line after the progress bar
	if [[ "$progress_shown" == "true" ]]; then
		echo ""
	fi

	local exit_code=1
	if [[ -f "$exit_code_file" ]]; then
		exit_code=$(cat "$exit_code_file")
		rm -f "$exit_code_file"
	fi

	if [[ "$exit_code" -ne 0 ]]; then
		echo -e "${Red}${CROSS} rsync failed (exit code: $exit_code) — $label${NC}"
		echo -e "${Red}${CROSS} Detail log: $detail_log${NC}"
		echo -e "${Dim}--- Last 20 lines ---${NC}"
		tail -20 "$detail_log" 2>/dev/null | while IFS= read -r l; do
			echo -e "  ${Dim}$l${NC}"
		done
		echo -e "${Dim}--- End ---${NC}"
		emit_event "${emit_prefix}_fail" "error" "rsync failed: $label" "exit_code=$exit_code"
		return 1
	fi

	# Ensure bar shows 100% green on completion
	draw_rsync_progress_bar 100 "" "" "" "$label"
	echo ""
	info "rsync complete: $label"
	emit_event "${emit_prefix}_complete" "success" "rsync complete: $label"
	return 0
}

###############################################################################
# VIRTNBDBACKUP RUNNER
###############################################################################

# Detail log of the most recent virtnbdbackup invocation, so the caller can read
# virtnbdbackup's own verdict on a failure. Empty under --verbose, where output
# goes straight to the terminal and there is no file to scan.
_virtnbd_last_detail_log=""

run_virtnbdbackup() {
	local target_dir="$1"
	local level="$2"

	_virtnbd_last_detail_log=""

	local cmd=(
		virtnbdbackup --raw
		-U "qemu+ssh://root@$destination_ip/system"
		--nbd-port "$nbd_port"
		--nbd-ip "$destination_ip"
		--ssh-user root
		-d "$vm_name"
		-l "$level"
		-o "$target_dir"
	)
	if [[ -n "$compress_backup" ]]; then
		cmd+=($compress_backup)
	fi

	info "Starting virtnbdbackup ($level) ..."
	if [[ "$verbose" == "true" ]]; then
		echo -e "${Dim}  Command: ${cmd[*]}${NC}"
	fi

	emit_event "backup_start" "in_progress" "Starting $level backup" "level=$level"

	if [[ "$verbose" == "true" ]]; then
		if "${cmd[@]}"; then
			return 0
		else
			return 1
		fi
	fi

	local virtnbd_detail_log="$log_dir/${log_timestamp}_${schedule}_${level}_virtnbdbackup_detail.log"
	_virtnbd_last_detail_log="$virtnbd_detail_log"
	local exit_code_file="$BACKUP_TMP_EXIT/.virtnbdbackup_exit_$$"
	rm -f "$exit_code_file"

	local fifo=""
	fifo="$BACKUP_TMP_FIFOS/.virtnbd_fifo_$$"
	mkfifo "$fifo"

	(
		"${cmd[@]}" >"$fifo" 2>&1
		echo $? >"$exit_code_file"
	) &
	local bg_pid=$!

	declare -A disk_pct=()
	declare -A disk_xferred_bytes=()
	declare -A disk_total_bytes=()
	declare -a disk_order=()

	local char="" line_buf=""
	local _pb_disk="" _pb_pct="" _pb_xferred="" _pb_total=""
	local progress_shown=false
	local last_emit_pct=-1

	update_aggregate_and_draw() {
		local disk="$_pb_disk"
		local pct="$_pb_pct"
		local xferred="$_pb_xferred"
		local total="$_pb_total"

		if [[ -z "${disk_pct[$disk]+_}" ]]; then
			disk_order+=("$disk")
		fi

		disk_pct[$disk]="$pct"
		disk_xferred_bytes[$disk]=$(human_to_bytes "$xferred")
		disk_total_bytes[$disk]=$(human_to_bytes "$total")

		local total_xferred_bytes=0
		local total_total_bytes=0
		local d=""
		for d in "${disk_order[@]}"; do
			total_xferred_bytes=$((total_xferred_bytes + ${disk_xferred_bytes[$d]:-0}))
			total_total_bytes=$((total_total_bytes + ${disk_total_bytes[$d]:-0}))
		done

		local overall_pct=0
		if [[ "$total_total_bytes" -gt 0 ]]; then
			overall_pct=$((total_xferred_bytes * 100 / total_total_bytes))
		fi
		if [[ "$overall_pct" -gt 100 ]]; then overall_pct=100; fi

		local overall_xferred_human=""
		local overall_total_human=""
		overall_xferred_human=$(bytes_to_human "$total_xferred_bytes")
		overall_total_human=$(bytes_to_human "$total_total_bytes")

		local status_parts=()
		for d in "${disk_order[@]}"; do
			local dpct="${disk_pct[$d]:-0}"
			local icon="◉"
			if [[ "$dpct" -ge 100 ]]; then icon="✓"; fi
			status_parts+=("${d} ${dpct}% ${icon}")
		done

		local disk_status=""
		local IFS_SAVE="$IFS"
		IFS="|"
		disk_status="${status_parts[*]}"
		IFS="$IFS_SAVE"
		disk_status=$(echo "$disk_status" | sed 's/|/ | /g')

		draw_aggregate_progress_bar "$overall_pct" "$overall_xferred_human" "$overall_total_human" "$disk_status"
		progress_shown=true

		if [[ $((overall_pct - last_emit_pct)) -ge 5 ]] || [[ "$overall_pct" -ge 100 && "$last_emit_pct" -lt 100 ]]; then
			last_emit_pct=$overall_pct
			emit_event "backup_progress" "in_progress" "Backup ${overall_pct}% complete" \
				"percent=$overall_pct" "transferred=$overall_xferred_human" "total=$overall_total_human" "disks=$disk_status"
		fi
	}

	while IFS= read -r -n1 -d '' char || {
		if [[ -n "$line_buf" ]]; then
			echo "$line_buf" >>"$virtnbd_detail_log"
			if parse_progress_line "$line_buf"; then
				update_aggregate_and_draw
			fi
			line_buf=""
		fi
		false
	}; do
		case "$char" in
		$'\r' | $'\n')
			if [[ -n "$line_buf" ]]; then
				echo "$line_buf" >>"$virtnbd_detail_log"
				if parse_progress_line "$line_buf"; then
					update_aggregate_and_draw
				fi
			fi
			line_buf=""
			;;
		*)
			line_buf+="$char"
			;;
		esac
	done <"$fifo"

	wait "$bg_pid" 2>/dev/null
	rm -f "$fifo"

	if [[ "$progress_shown" == "true" ]]; then echo ""; fi

	local exit_code=1
	if [[ -f "$exit_code_file" ]]; then
		exit_code=$(cat "$exit_code_file")
		rm -f "$exit_code_file"
	fi

	if [[ "$exit_code" -ne 0 ]]; then
		echo -e "${Red}${CROSS} virtnbdbackup failed (exit code: $exit_code).${NC}"
		echo -e "${Red}${CROSS} Detail log: $virtnbd_detail_log${NC}"
		echo -e "${Dim}--- Last 20 lines ---${NC}"
		tail -20 "$virtnbd_detail_log" 2>/dev/null | while IFS= read -r l; do
			echo -e "  ${Dim}$l${NC}"
		done
		echo -e "${Dim}--- End ---${NC}"
		emit_event "backup_fail" "error" "virtnbdbackup failed" "exit_code=$exit_code"
		return 1
	else
		info "Detail log: $virtnbd_detail_log"
		return 0
	fi
}

###############################################################################
# SCHEDULER / DURATION / LOG CLEANUP
###############################################################################

record_scheduler() {
	local target_dir="$1"
	local level="$2"
	local sched_file="$target_dir/scheduler"
	local weekday="" wd="" wm="" wy=""
	weekday=$(date +%a)
	wd=$(date +%d)
	wm=$(date +%m)
	wy=$(date +%Y)
	
	# Create scheduler file if it doesn't exist
	if [[ ! -f "$sched_file" ]] || [[ ! -s "$sched_file" ]]; then
		printf "Day\tDate\tMethod\n" >"$sched_file"
		printf "*******************************\n" >>"$sched_file"
	fi
	
	# Check if an entry for today already exists (to prevent duplicate entries on retry)
	local today_entry="${weekday}\t${wd}/${wm}/${wy}"
	if grep -qF "${today_entry}" "$sched_file" 2>/dev/null; then
		# Entry already exists for today, update it instead of appending
		# Remove the old entry and add the new one
		local temp_file="${sched_file}.tmp"
		grep -vF "${today_entry}" "$sched_file" > "$temp_file"
		mv "$temp_file" "$sched_file"
		info "Updating existing scheduler entry for today"
	fi
	
	# Append the new entry
	printf "%s\t%s/%s/%s\t%s\n" "$weekday" "$wd" "$wm" "$wy" "$level" >>"$sched_file"
}

format_duration() {
	local s="$1"
	local h=$((s / 3600))
	local m=$(((s % 3600) / 60))
	local sec=$((s % 60))
	if [[ "$h" -gt 0 ]]; then
		printf "%dh %dm %ds" "$h" "$m" "$sec"
	elif [[ "$m" -gt 0 ]]; then
		printf "%dm %ds" "$m" "$sec"
	else
		printf "%ds" "$sec"
	fi
}

cleanup_old_logs() {
	local max_logs=50
	local ext=""
	for ext in "*.log" "*.jsonl"; do
		local file_count=0
		file_count=$(find "$log_dir" -maxdepth 1 -name "$ext" -type f 2>/dev/null | wc -l)
		# Convert to decimal to avoid octal interpretation
		file_count=$(echo "$file_count" | awk '{print $1+0}')
		if [[ "$file_count" -gt "$max_logs" ]]; then
			local to_remove=$((file_count - max_logs))
			find "$log_dir" -maxdepth 1 -name "$ext" -type f -printf '%T@ %p\n' 2>/dev/null |
				sort -n | head -n "$to_remove" | awk '{print $2}' | xargs rm -f 2>/dev/null
		fi
	done
	return 0
}

###############################################################################
# OFFSITE SYNC
###############################################################################

offsite_sync() {
	if [[ -z "$offsite_ips" ]]; then
		return 0
	fi

	echo ""
	echo -e "${Bold}╔══════════════════════════════════════════════════════════════╗${NC}"
	echo -e "${Bold}║              OFFSITE SYNC                                    ║${NC}"
	echo -e "${Bold}╚══════════════════════════════════════════════════════════════╝${NC}"
	echo ""

	emit_event "offsite_start" "in_progress" "Starting offsite sync"

	local OFFSITE_HOSTS=()
	IFS=',' read -ra OFFSITE_HOSTS <<<"$offsite_ips"

	local offsite_pids=()
	local offsite_logs=()
	local offsite_status_files=()
	local offsite_host_list=()
	local offsite_skipped=()
	local offsite_progress_files=()

	local entry=""
	for entry in "${OFFSITE_HOSTS[@]}"; do
		entry=$(echo "$entry" | xargs)
		[[ -z "$entry" ]] && continue
		# Entry format: "ip", "ip:/custom/base/path", or
		# "ip:/custom/base/path:threshold" (colon delimiter — safe because IPv4
		# addresses and absolute paths contain no colons). The optional third
		# field is a per-pool disk-usage threshold (percent).
		local oip="" opath="" othresh=""
		IFS=':' read -r oip opath othresh <<<"$entry"
		oip=$(echo "$oip" | xargs)
		opath=$(echo "$opath" | xargs)
		othresh=$(echo "$othresh" | xargs)
		if [[ -n "$oip" ]]; then
			offsite_host_list+=("$oip")
			OFFSITE_PATH_BY_IP["$oip"]="$opath"
			# Only keep a valid integer 1–100; otherwise leave unset so the
			# global threshold applies.
			if [[ "$othresh" =~ ^[0-9]+$ ]] && [[ "$othresh" -ge 1 ]] && [[ "$othresh" -le 100 ]]; then
				OFFSITE_THRESHOLD_BY_IP["$oip"]="$othresh"
			fi
		fi
	done

	if [[ ${#offsite_host_list[@]} -eq 0 ]]; then
		warn "No valid offsite IPs provided."
		return 0
	fi

	info "Syncing to ${#offsite_host_list[@]} offsite host(s): ${offsite_host_list[*]}"
	echo ""

	# ── Pre-flight SSH check (sequential) ────────────────────────────────
	local valid_hosts=()
	for oip in "${offsite_host_list[@]}"; do
		echo -e "${Dim}  Checking SSH to $oip ...${NC}"
		if check_ssh_connection "$oip"; then
			valid_hosts+=("$oip")
		else
			echo -e "${Red}${CROSS} SSH to $oip — FAILED. Skipping.${NC}"
			# Carry the resolved destination path + reason so the controller can
			# map this skip back to the exact offsite host/pool (Req 6.3, 6.4).
			local _skip_path="${OFFSITE_PATH_BY_IP[$oip]:-}"
			[[ -z "$_skip_path" ]] && _skip_path="$backup_path"
			emit_event "offsite_fail" "error" "SSH failed to $oip" \
				"offsite_ip=$oip" "offsite_path=$_skip_path" "reason=SSH connection failed"
			offsite_skipped+=("$oip")
		fi
	done

	echo ""

	if [[ ${#valid_hosts[@]} -eq 0 ]]; then
		echo -e "${Red}${CROSS} All offsite hosts failed SSH. No sync performed.${NC}"
		emit_event "offsite_complete" "error" "All offsite hosts unreachable" \
			"offsite_ips=${offsite_host_list[*]}"
		return 1
	fi

	if [[ ${#offsite_skipped[@]} -gt 0 ]]; then
		warn "Skipped ${#offsite_skipped[@]} host(s): ${offsite_skipped[*]}"
	fi

	info "Launching parallel sync to ${#valid_hosts[@]} host(s) ..."
	echo ""

	# ── Create progress tracking dir ─────────────────────────────────────
	local progress_dir="$BACKUP_TMP_PROGRESS/offsite_progress_$$"
	mkdir -p "$progress_dir" 2>/dev/null

	for oip in "${valid_hosts[@]}"; do
		local offsite_log="$log_dir/${log_timestamp}_offsite_${oip}.log"
		local offsite_event_log="$log_dir/${log_timestamp}_offsite_${oip}.events.jsonl"
		local status_file="$BACKUP_TMP_PROGRESS/.offsite_status_${vm_name}_${oip}_$$"
		local progress_file="$progress_dir/${oip}"
		rm -f "$status_file"

		echo "0||0B||checking" >"$progress_file"

		offsite_logs+=("$offsite_log")
		offsite_status_files+=("$status_file")
		offsite_progress_files+=("$progress_file")

		(
			offsite_sync_single_host "$oip" "$offsite_log" "$offsite_event_log" "$status_file" "$progress_file"
		) &
		offsite_pids+=($!)
	done

	# ── Live progress monitor ────────────────────────────────────────────
	monitor_offsite_progress valid_hosts offsite_pids offsite_progress_files offsite_status_files

	# ── Collect results ──────────────────────────────────────────────────
	echo ""
	local all_success=true
	local i=0
	for i in "${!valid_hosts[@]}"; do
		local oip="${valid_hosts[$i]}"
		local status_file="${offsite_status_files[$i]}"
		local offsite_log="${offsite_logs[$i]}"

		local status="FAILED"
		if [[ -f "$status_file" ]]; then
			status=$(cat "$status_file")
		fi
		rm -f "$status_file"

		# The per-host worker writes either "SUCCESS" or "FAILED|<reason>" so we
		# can surface the specific cause (SSH/disk/rsync) to the controller,
		# not just a generic failure. Also resolve this host's destination path
		# (custom pool path or legacy mirror) so the controller can map the
		# outcome back to the exact offsite host/pool (Req 6.3, 6.4).
		local ostatus="${status%%|*}"
		local oreason="offsite sync failed"
		if [[ "$status" == *"|"* ]]; then
			oreason="${status#*|}"
		fi
		local opath="${OFFSITE_PATH_BY_IP[$oip]:-}"
		[[ -z "$opath" ]] && opath="$backup_path"

		if [[ "$ostatus" == "SUCCESS" ]]; then
			info "Offsite sync to $oip — ${Green}COMPLETED${NC}"
			emit_event "offsite_host_complete" "success" "Sync to $oip completed" \
				"offsite_ip=$oip" "offsite_path=$opath"
		else
			echo -e "${Red}${CROSS} Offsite sync to $oip — FAILED${NC}"
			echo -e "${Dim}  Log: $offsite_log${NC}"
			emit_event "offsite_host_fail" "error" "Sync to $oip failed: $oreason" \
				"offsite_ip=$oip" "offsite_path=$opath" "reason=$oreason"
			all_success=false
		fi
	done

	rm -rf "$progress_dir" 2>/dev/null

	if [[ ${#offsite_skipped[@]} -gt 0 ]]; then
		all_success=false
	fi

	echo ""
	if [[ "$all_success" == "true" ]]; then
		info "All offsite syncs completed successfully."
		emit_event "offsite_complete" "success" "All offsite syncs completed"
	else
		warn "Some offsite syncs failed or were skipped. Check logs."
		emit_event "offsite_complete" "warning" "Some offsite syncs failed" \
			"skipped=${#offsite_skipped[@]}" "total=${#offsite_host_list[@]}"
	fi
	return 0
}

###############################################################################
# OFFSITE PROGRESS MONITOR
###############################################################################

monitor_offsite_progress() {
	local -n _hosts=$1
	local -n _pids=$2
	local -n _progress_files=$3
	local -n _status_files=$4

	local host_count=${#_hosts[@]}
	local display_lines=$((host_count + 2))

	# Reserve display space
	local init_i=0
	for ((init_i = 0; init_i < display_lines; init_i++)); do
		echo ""
	done

	local all_done=false
	local _mon_last_sig=""
	local _mon_last_ts=0

	while [[ "$all_done" != "true" ]]; do
		# Throttle: build a cheap per-host (pct|status) signature and skip the
		# whole redraw when nothing visible changed — the block is re-rendered
		# every second otherwise, and each render lands in the job log via
		# tmux pipe-pane (the dominant source of log bloat on long syncs).
		# Redraw at most every 10s regardless, to refresh speed/ETA.
		local _sig=""
		local _si=0
		for _si in "${!_hosts[@]}"; do
			local _spf="${_progress_files[$_si]}"
			local _sline=""
			[[ -f "$_spf" ]] && _sline=$(tail -1 "$_spf" 2>/dev/null)
			local _spct="" _sstat=""
			IFS='|' read -r _spct _ _ _ _sstat <<<"$_sline"
			_sig+="${_spct}|${_sstat};"
		done
		local _mon_now
		_mon_now=$(date +%s)
		if [[ "$_sig" == "$_mon_last_sig" && $((_mon_now - _mon_last_ts)) -lt 10 ]]; then
			all_done=true
			for _si in "${!_pids[@]}"; do
				if kill -0 "${_pids[$_si]}" 2>/dev/null; then
					all_done=false
					break
				fi
			done
			if [[ "$all_done" != "true" ]]; then
				sleep 1
				continue
			fi
			# All workers just finished — fall through for one final render.
		fi
		_mon_last_sig="$_sig"
		_mon_last_ts=$_mon_now

		# Move cursor up
		printf "\033[%dA" "$display_lines"

		local total_pct_sum=0
		local hosts_syncing=0
		local hosts_done=0
		local hosts_failed=0

		local i=0
		for i in "${!_hosts[@]}"; do
			local oip="${_hosts[$i]}"
			local pf="${_progress_files[$i]}"
			local term_width=""
			term_width=$(get_terminal_width)

			local pct=0 speed="" xferred="0B" eta="" pstatus="checking"
			if [[ -f "$pf" ]]; then
				local pline=""
				pline=$(tail -1 "$pf" 2>/dev/null)
				if [[ -n "$pline" ]]; then
					IFS='|' read -r pct speed xferred eta pstatus <<<"$pline"
				fi
			fi

			# Sanitise
			if [[ -z "$pct" ]] || ! [[ "$pct" =~ ^[0-9]+$ ]]; then pct=0; fi
			if [[ "$pct" -gt 100 ]]; then pct=100; fi
			if [[ -z "$speed" ]]; then speed=""; fi
			if [[ -z "$xferred" ]]; then xferred="0B"; fi
			if [[ -z "$eta" ]]; then eta=""; fi
			if [[ -z "$pstatus" ]]; then pstatus="checking"; fi

			local host_color="$Cyan"
			local host_icon="◉"
			case "$pstatus" in
			success)
				host_color="$Green"
				host_icon="✓"
				pct=100
				hosts_done=$((hosts_done + 1))
				;;
			failed)
				host_color="$Red"
				host_icon="✗"
				hosts_failed=$((hosts_failed + 1))
				;;
			waiting)
				host_color="$Yellow"
				host_icon="⏳"
				;;
			checking | archiving)
				host_color="$Yellow"
				host_icon="⟳"
				;;
			syncing)
				host_color="$Cyan"
				host_icon="◉"
				hosts_syncing=$((hosts_syncing + 1))
				;;
			*)
				host_color="$Dim"
				host_icon="·"
				;;
			esac

			total_pct_sum=$((total_pct_sum + pct))

			local bar_label=""
			if [[ "$pstatus" == "syncing" && -n "$speed" ]]; then
				bar_label=$(printf "%s  %s  ETA: %s" "$xferred" "$speed" "$eta")
			elif [[ "$pstatus" == "success" ]]; then
				bar_label="done"
			elif [[ "$pstatus" == "failed" ]]; then
				bar_label="FAILED"
			else
				bar_label="$pstatus"
			fi

			local prefix=""
			prefix=$(printf "  %s %-18s " "$host_icon" "$oip")
			local prefix_len=${#prefix}
			local suffix=""
			suffix=$(printf " %3d%%  %s" "$pct" "$bar_label")
			local suffix_len=${#suffix}
			local bar_reserved=$((prefix_len + suffix_len + 4))
			local bar_width=$((term_width - bar_reserved))
			if [[ "$bar_width" -lt 5 ]]; then bar_width=5; fi
			if [[ "$bar_width" -gt 40 ]]; then bar_width=40; fi

			local filled=$((bar_width * pct / 100))
			local empty=$((bar_width - filled))
			local bar_filled="" bar_empty=""
			local j=0
			for ((j = 0; j < filled; j++)); do bar_filled+="█"; done
			for ((j = 0; j < empty; j++)); do bar_empty+="░"; done

			printf "\r\033[K${host_color}%s▐%s%s▌${Bold}%s${NC}\n" \
				"$prefix" "$bar_filled" "$bar_empty" "$suffix"
		done

		# Blank separator
		printf "\r\033[K\n"

		# Aggregate bar
		local overall_pct=0
		if [[ "$host_count" -gt 0 ]]; then
			overall_pct=$((total_pct_sum / host_count))
		fi
		if [[ "$overall_pct" -gt 100 ]]; then overall_pct=100; fi

		local agg_term_width=""
		agg_term_width=$(get_terminal_width)
		local agg_status=""
		agg_status=$(printf "%d syncing, %d done, %d failed" "$hosts_syncing" "$hosts_done" "$hosts_failed")
		local agg_suffix=""
		agg_suffix=$(printf " %3d%%  [%s]" "$overall_pct" "$agg_status")
		local agg_suffix_len=${#agg_suffix}
		local agg_prefix="  ▐"
		local agg_reserved=$((${#agg_prefix} + 1 + agg_suffix_len + 2))
		local agg_bar_width=$((agg_term_width - agg_reserved))
		if [[ "$agg_bar_width" -lt 10 ]]; then agg_bar_width=10; fi
		if [[ "$agg_bar_width" -gt 50 ]]; then agg_bar_width=50; fi

		local agg_filled=$((agg_bar_width * overall_pct / 100))
		local agg_empty=$((agg_bar_width - agg_filled))
		local agg_bar_filled="" agg_bar_empty=""
		local j=0
		for ((j = 0; j < agg_filled; j++)); do agg_bar_filled+="█"; done
		for ((j = 0; j < agg_empty; j++)); do agg_bar_empty+="░"; done

		local agg_color="$Blue"
		if [[ "$overall_pct" -ge 100 ]]; then agg_color="$Green"; fi

		printf "\r\033[K${agg_color}${agg_prefix}%s%s▌${Bold}%s${NC}\n" \
			"$agg_bar_filled" "$agg_bar_empty" "$agg_suffix"

		# Check if all done
		all_done=true
		for i in "${!_pids[@]}"; do
			if kill -0 "${_pids[$i]}" 2>/dev/null; then
				all_done=false
				break
			fi
		done

		if [[ "$all_done" != "true" ]]; then
			sleep 1
		fi
	done

	# Wait for all
	local pid=""
	for pid in "${_pids[@]}"; do
		wait "$pid" 2>/dev/null
	done
	return 0
}

###############################################################################
# OFFSITE SYNC SINGLE HOST
#
# The rsync step now uses run_rsync_with_progress() which renders the same
# aggregate-style bar (▐█░▌) as virtnbdbackup.  All other logic is unchanged.
###############################################################################

offsite_sync_single_host() {
	local oip="$1"
	local offsite_log="$2"
	local offsite_event_log="$3"
	local status_file="$4"
	local progress_file="$5"

	local offsite_lock="$offsite_lock_dir/${vm_name}_${schedule}_offsite_${oip}"
	local remote_user="root"
	# Per-host destination base: use the offsite host's custom path if one was
	# configured, otherwise mirror the source pool path (legacy behavior).
	local remote_base="${OFFSITE_PATH_BY_IP[$oip]:-}"
	[[ -z "$remote_base" ]] && remote_base="$backup_path"
	local remote_vm_dir="$remote_base/$vm_name"

	# Per-pool disk-usage guard for this offsite destination. Falls back to the
	# global threshold when the controller didn't send a per-pool value. The
	# warning level is always a fixed 60% (stop check runs first).
	local remote_threshold="${OFFSITE_THRESHOLD_BY_IP[$oip]:-$disk_usage_threshold}"
	local remote_warn=60

	# ── Progress-file writer (for the per-host monitor bars) ─────────────
	write_progress() {
		local pct="${1:-0}"
		local speed="${2:-}"
		local xferred="${3:-0B}"
		local eta="${4:-}"
		local status="${5:-checking}"

		# Write pipe-delimited format for terminal monitor
		echo "${pct}|${speed}|${xferred}|${eta}|${status}" >"$progress_file" 2>/dev/null

		# Also write JSON format to main progress file (for frontend) if it exists
		if [[ -n "${progress_metadata_dir:-}" ]]; then
			local text=""
			if [[ "$status" == "syncing" && -n "$speed" && -n "$xferred" ]]; then
				text="Offsite sync ($oip): $xferred @ $speed"
			elif [[ "$status" == "success" ]]; then
				text="Offsite sync ($oip): Complete"
			elif [[ "$status" == "failed" ]]; then
				text="Offsite sync ($oip): Failed"
			else
				text="Offsite sync ($oip): $status"
			fi

			local json_output=""
			json_output=$(printf '{"percentage":%d,"text":"%s","type":"rsync","timestamp":"%s"}\n' \
				"$pct" "$text" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")")

			local main_progress_file="$progress_metadata_dir/${vm_name}_${schedule}.progress"
			echo "$json_output" >"$main_progress_file" 2>/dev/null
		fi
	}

	# ── Event emitter scoped to this offsite host ─────────────────────────
	offsite_emit() {
		local etype="$1"
		local estatus="$2"
		local emsg="$3"
		shift 3
		local extras=""
		local kv=""
		for kv in "$@"; do
			local key="${kv%%=*}"
			local val="${kv#*=}"
			extras+=", \"${key}\": \"${val}\""
		done
		local ts=""
		ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
		printf '{"timestamp":"%s","event":"%s","status":"%s","domain":"%s","offsite_ip":"%s","message":"%s"%s}\n' \
			"$ts" "$etype" "$estatus" "$vm_name" "$oip" "$emsg" "$extras" >>"$offsite_event_log" 2>/dev/null
	}

	# ── rsync progress bridge ─────────────────────────────────────────────
	# run_rsync_with_progress writes parsed progress to stdout (the bar) AND
	# calls emit_event.  We additionally need to forward pct/speed/eta into
	# the progress_file so monitor_offsite_progress can update per-host bars.
	# We do this by wrapping the fifo read in a co-process that tees progress
	# data into the progress_file while the bar is drawn on stdout.
	#
	# Because offsite_sync_single_host runs entirely inside a subshell (the
	# background ( … ) & block in offsite_sync), stdout here goes to the log
	# file, NOT the terminal.  The per-host monitor reads progress_file for
	# display; run_rsync_with_progress's bar output goes into the log.
	# That is the correct separation: log gets the bar escape sequences,
	# terminal gets the clean monitor view.

	run_rsync_for_offsite() {
		# Wrapper that also keeps progress_file updated for the monitor.
		local detail_log="$1"
		local label="$2"
		shift 2
		# remaining args → rsync arguments

		local fifo_prog=""
		fifo_prog="$BACKUP_TMP_FIFOS/.rsync_offsite_prog_${oip}_$$"
		mkfifo "$fifo_prog"

		local exit_code_file="$BACKUP_TMP_EXIT/.rsync_offsite_exit_${oip}_$$"
		rm -f "$exit_code_file"

		# rsync → fifo
		(
			rsync --info=progress2 "$@" >"$fifo_prog" 2>&1
			echo $? >"$exit_code_file"
		) &
		local bg_pid=$!

		local _rp_pct="" _rp_speed="" _rp_xferred="" _rp_eta=""
		local char="" line_buf=""
		local last_emit_pct=-1

		while IFS= read -r -n1 -d '' char || {
			if [[ -n "$line_buf" ]]; then
				echo "$line_buf" >>"$detail_log"
				if parse_rsync_progress "$line_buf"; then
					_rp_pct="$_rsync_pct"
					_rp_speed="$_rsync_speed"
					_rp_xferred="$_rsync_xferred"
					_rp_eta="$_rsync_eta"
					# Debug: log parsed progress
					echo "[$(date '+%H:%M:%S')] Parsed progress: ${_rp_pct}% | ${_rp_speed} | ${_rp_xferred} | ${_rp_eta}" >>"$detail_log"
					# Write progress for terminal monitor
					write_progress "$_rp_pct" "$_rp_speed" "$_rp_xferred" "$_rp_eta" "syncing"
					if [[ $((_rp_pct - last_emit_pct)) -ge 5 ]]; then
						last_emit_pct=$_rp_pct
						offsite_emit "offsite_rsync_progress" "in_progress" \
							"rsync ${_rp_pct}%" \
							"percent=$_rp_pct" "speed=$_rp_speed" \
							"transferred=$_rp_xferred" "eta=$_rp_eta"
					fi
				fi
				line_buf=""
			fi
			false
		}; do
			case "$char" in
			$'\r' | $'\n')
				if [[ -n "$line_buf" ]]; then
					echo "$line_buf" >>"$detail_log"
					if parse_rsync_progress "$line_buf"; then
						_rp_pct="$_rsync_pct"
						_rp_speed="$_rsync_speed"
						_rp_xferred="$_rsync_xferred"
						_rp_eta="$_rsync_eta"
						# Debug: log parsed progress
						echo "[$(date '+%H:%M:%S')] Parsed progress: ${_rp_pct}% | ${_rp_speed} | ${_rp_xferred} | ${_rp_eta}" >>"$detail_log"
						# Write progress for terminal monitor
						write_progress "$_rp_pct" "$_rp_speed" "$_rp_xferred" "$_rp_eta" "syncing"
						if [[ $((_rp_pct - last_emit_pct)) -ge 5 ]]; then
							last_emit_pct=$_rp_pct
							offsite_emit "offsite_rsync_progress" "in_progress" \
								"rsync ${_rp_pct}%" \
								"percent=$_rp_pct" "speed=$_rp_speed" \
								"transferred=$_rp_xferred" "eta=$_rp_eta"
						fi
					fi
				fi
				line_buf=""
				;;
			*)
				line_buf+="$char"
				;;
			esac
		done <"$fifo_prog"

		wait "$bg_pid" 2>/dev/null
		rm -f "$fifo_prog"

		local rc=1
		if [[ -f "$exit_code_file" ]]; then
			rc=$(cat "$exit_code_file")
			rm -f "$exit_code_file"
		fi
		return $rc
	}

	# ════════════════════════════════════════════════════════════════════════
	# Main body — all output goes to offsite_log
	# ════════════════════════════════════════════════════════════════════════
	{
		echo "═══════════════════════════════════════════════════════════"
		echo "  OFFSITE SYNC: $vm_name → $oip"
		echo "  Started: $(date '+%Y-%m-%d %H:%M:%S')"
		echo "═══════════════════════════════════════════════════════════"
		echo ""

		write_progress 0 "" "0B" "" "checking"
		offsite_emit "offsite_host_start" "in_progress" "Starting sync to $oip"

		# ── Step 1: Previous rsync check ─────────────────────────────────
		if [[ -f "$offsite_lock" ]]; then
			local lock_pid=""
			lock_pid=$(cat "$offsite_lock" 2>/dev/null)
			if [[ -n "$lock_pid" ]] && kill -0 "$lock_pid" 2>/dev/null; then
				echo "⚠ Previous rsync running (PID: $lock_pid). Waiting ..."
				write_progress 0 "" "0B" "" "waiting"
				offsite_emit "offsite_wait" "in_progress" "Waiting for previous rsync"

				local wait_start=0
				local max_wait=7200
				wait_start=$(date +%s)
				while kill -0 "$lock_pid" 2>/dev/null; do
					local elapsed=$(($(date +%s) - wait_start))
					if [[ "$elapsed" -ge "$max_wait" ]]; then
						echo "✗ Timeout. Killing PID $lock_pid."
						kill -9 "$lock_pid" 2>/dev/null
						sleep 2
						break
					fi
					sleep 10
				done
				echo "✓ Previous rsync finished."
			fi
			rm -f "$offsite_lock"
		fi

		echo $BASHPID >"$offsite_lock"

		# Set trap to clean up lock file on exit or interruption
		trap "rm -f '$offsite_lock' 2>/dev/null" EXIT INT TERM

		# ── Step 2: SSH liveness ─────────────────────────────────────────
		write_progress 0 "" "0B" "" "checking"
		echo "Verifying SSH to $oip ..."
		if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "${remote_user}@${oip}" exit &>/dev/null; then
			echo "✗ SSH failed."
			write_progress 0 "" "0B" "" "failed"
			offsite_emit "offsite_fail" "error" "SSH failed"
			rm -f "$offsite_lock"
			echo "FAILED|SSH connection failed" >"$status_file"
			return 1
		fi
		echo "✓ SSH OK"

		# ── Step 3: rsync check/install ──────────────────────────────────
		echo "Checking rsync on $oip ..."
		if ! ssh "${remote_user}@${oip}" "command -v rsync" &>/dev/null; then
			echo "⚠ Installing rsync ..."
			offsite_emit "offsite_install" "in_progress" "Installing rsync"
			if ! ssh "${remote_user}@${oip}" "apt-get update -qq && apt-get install -y -qq rsync" &>/dev/null; then
				echo "✗ Failed to install rsync."
				write_progress 0 "" "0B" "" "failed"
				offsite_emit "offsite_fail" "error" "rsync install failed"
				rm -f "$offsite_lock"
				echo "FAILED|rsync install failed on offsite host" >"$status_file"
				return 1
			fi
			echo "✓ rsync installed"
		else
			echo "✓ rsync present"
		fi

		# ── Step 4: Remote disk space ────────────────────────────────────
		echo "Checking disk space on $oip ..."
		local remote_usage=""
		remote_usage=$(ssh "${remote_user}@${oip}" \
			"mkdir -p '$remote_base'; df '$remote_base' | awk 'NR>1 {print \$5}' | sed 's/%//g'" 2>/dev/null)

		if [[ -n "$remote_usage" ]] && [[ "$remote_usage" -gt "$remote_threshold" ]]; then
			echo "✗ Remote disk ${remote_usage}% (>${remote_threshold}%)."
			write_progress 0 "" "0B" "" "failed"
			offsite_emit "offsite_fail" "error" "Remote disk >${remote_threshold}%"
			rm -f "$offsite_lock"
			echo "FAILED|Remote disk ${remote_usage}% (>${remote_threshold}%)" >"$status_file"
			return 1
		elif [[ -n "$remote_usage" ]] && [[ "$remote_usage" -gt "$remote_warn" ]]; then
			echo "⚠ Remote disk ${remote_usage}%"
		fi
		echo "✓ Disk OK (${remote_usage:-?}%)"

		# ── Step 5: Replicate archive/prune ──────────────────────────────
		ssh "${remote_user}@${oip}" \
			"mkdir -p '$remote_vm_dir/archived' '$remote_vm_dir/daily' \
             '$remote_vm_dir/weekly' '$remote_vm_dir/monthly' \
             '$remote_vm_dir/once' '$remote_vm_dir/custom'" 2>/dev/null

		if [[ -n "$_archived_this_run" ]]; then
			write_progress 0 "" "0B" "" "archiving"
			echo "Replicating archive on $oip ..."
			local remote_schedule_dir="$remote_vm_dir/$schedule"
			local remote_archive_target="$remote_vm_dir/archived/$_archived_this_run"

			local remote_has_data=""
			remote_has_data=$(ssh "${remote_user}@${oip}" \
				"if [ -d '$remote_schedule_dir' ] && \
                 [ \"\$(ls -A '$remote_schedule_dir' 2>/dev/null)\" ]; \
                 then echo 'yes'; else echo 'no'; fi" 2>/dev/null)

			if [[ "$remote_has_data" == "yes" ]]; then
				ssh "${remote_user}@${oip}" \
					"mkdir -p '$remote_archive_target'; \
                     find '$remote_schedule_dir' -mindepth 1 -maxdepth 1 ! -name 'logs' \
                     -exec mv {} '$remote_archive_target/' \; 2>/dev/null" 2>/dev/null
				echo "✓ Archive replicated"
				offsite_emit "offsite_archive" "success" "Replicated archive" \
					"archive=$_archived_this_run"
			else
				echo "  No data to archive on $oip."
			fi
		fi

		if [[ ${#_pruned_archives[@]} -gt 0 ]]; then
			echo "Replicating pruning on $oip ..."
			local pruned=""
			for pruned in "${_pruned_archives[@]}"; do
				ssh "${remote_user}@${oip}" \
					"rm -rf '$remote_vm_dir/archived/$pruned'" 2>/dev/null
				offsite_emit "offsite_prune" "success" "Pruned $pruned" "pruned=$pruned"
			done
			echo "✓ Pruning replicated"
		fi

		# ── Step 6: rsync with aggregate-style progress bar ──────────────
		echo ""
		echo "Starting rsync to $oip ..."
		write_progress 0 "" "0B" "" "syncing"
		offsite_emit "offsite_rsync_start" "in_progress" "Starting rsync"

		local rsync_detail_log="$log_dir/${log_timestamp}_offsite_${oip}_rsync_detail.log"
		local rsync_start_time=0
		rsync_start_time=$(date +%s)

		local rsync_label="${vm_name} → ${oip}"

		if run_rsync_for_offsite \
			"$rsync_detail_log" \
			"$rsync_label" \
			-az --delete --sparse \
			--no-inc-recursive \
			--exclude='logs/' \
			--exclude='in_progress_backups/' \
			--exclude='offsite_locks/' \
			--exclude='*.partial' \
			"$vm_base_dir/" \
			"${remote_user}@${oip}:${remote_vm_dir}/"; then

			local rsync_end_time=0
			rsync_end_time=$(date +%s)
			local rsync_duration=$((rsync_end_time - rsync_start_time))

			echo "✓ rsync completed in $(format_duration $rsync_duration)"
			# Ensure progress is set to 100% on success
			write_progress 100 "0B/s" "0B" "0:00:00" "success"
			sleep 1 # Give monitor time to read the final progress
			offsite_emit "offsite_rsync_complete" "success" "rsync completed" \
				"duration_seconds=$rsync_duration"
			rm -f "$offsite_lock"
			echo "SUCCESS" >"$status_file"

			echo ""
			echo "═══════════════════════════════════════════════════════════"
			echo "  OFFSITE COMPLETE: $vm_name → $oip ($(format_duration $rsync_duration))"
			echo "═══════════════════════════════════════════════════════════"
		else
			local rsync_end_time=0
			rsync_end_time=$(date +%s)
			local rsync_duration=$((rsync_end_time - rsync_start_time))

			echo "✗ rsync FAILED after $(format_duration $rsync_duration)"
			write_progress 0 "0B/s" "0B" "0:00:00" "failed"
			offsite_emit "offsite_rsync_fail" "error" "rsync failed" \
				"duration_seconds=$rsync_duration"
			rm -f "$offsite_lock"
			echo "FAILED|rsync transfer failed" >"$status_file"
			return 1
		fi

	} >>"$offsite_log" 2>&1
}

###############################################################################
# CLEANUP AND SIGNAL HANDLING
###############################################################################

# Global flag to track if we're in cleanup
CLEANUP_IN_PROGRESS=false

# Comprehensive cleanup function
cleanup_on_exit() {
	# Capture the exit code FIRST — any command (even the recursion guard's
	# [[ ]] test) overwrites $? and would make every exit look successful.
	local exit_code=$?

	# Prevent recursive cleanup
	if [[ "$CLEANUP_IN_PROGRESS" == "true" ]]; then
		return 0
	fi
	CLEANUP_IN_PROGRESS=true

	echo -e "${Yellow}Cleaning up backup resources...${NC}"

	# Remove backup lock FIRST. This only touches local files and must never
	# depend on the network calls below (e.g. ssh to a dead hypervisor after
	# a libvirt EOF error) — otherwise an interrupted cleanup leaves a stale
	# lock that keeps this backup showing "in progress" even though it isn't.
	remove_backup_lock
	
	# Clean up scheduler validation flag file
	rm -f "/tmp/.backup_manager_scheduler_validated_$$" 2>/dev/null || true

	# Kill any running virtnbdbackup processes for this VM
	if [[ -n "$vm_name" && -n "$nbd_port" ]]; then
		local pids
		pids=$(pgrep -f "virtnbdbackup.*$vm_name" 2>/dev/null || true)
		if [[ -n "$pids" ]]; then
			echo "Killing virtnbdbackup processes: $pids"
			kill -TERM $pids 2>/dev/null || true
			sleep 2
			# Force kill if still running
			pids=$(pgrep -f "virtnbdbackup.*$vm_name" 2>/dev/null || true)
			if [[ -n "$pids" ]]; then
				kill -KILL $pids 2>/dev/null || true
			fi
		fi
	fi

	# Stop NBD server if running. The pattern is anchored with `\b` so we
	# don't accidentally match a sibling backup whose port happens to share
	# a digit-prefix (e.g. killing port 6294 must not match port 62943).
	# Bounded with timeouts: if the hypervisor is unreachable (the usual
	# reason we're cleaning up after a failure), this must not hang cleanup.
	if [[ -n "$nbd_port" && -n "$remote_ip" ]]; then
		echo "Stopping NBD server on port $nbd_port..."
		timeout 15 ssh -o BatchMode=yes -o ConnectTimeout=10 "root@$remote_ip" \
			"pkill -f 'qemu-nbd.*\\b$nbd_port\\b'" 2>/dev/null || true
	fi

	# Release our reservation in the allocator registry so other backups
	# can pick this port again.
	if [[ -n "$nbd_port_claim_file" && -f "$nbd_port_claim_file" ]]; then
		rm -f "$nbd_port_claim_file" 2>/dev/null || true
	fi

	# Clean up temporary files from organized directories
	if [[ -n "$vm_name" && -n "$schedule" ]]; then
		rm -f "$BACKUP_TMP_LOGS/backup_${vm_name}_${schedule}_"*.log 2>/dev/null || true
		rm -f "$BACKUP_TMP_EXIT/backup_exit_${vm_name}_${schedule}.code" 2>/dev/null || true
	fi

	# Clean up progress file only if backup failed or was interrupted
	if [[ $exit_code -ne 0 ]]; then
		echo "Backup did not complete successfully (exit code: $exit_code)"
		cleanup_progress_metadata

		# Write final error state to progress
		if [[ -n "$backup_path" ]]; then
			local progress_file="$backup_path/.progress/${vm_name}_${schedule}.progress"
			if [[ -f "$progress_file" ]]; then
				local ts
				ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
				printf '{"percentage":0,"text":"Backup interrupted or failed","type":"backup","timestamp":"%s","status":"failed"}\n' \
					"$ts" >"$progress_file" 2>/dev/null || true
			fi
		fi

		# Emit failure event
		if [[ -n "$events_file" ]]; then
			local ts
			ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
			printf '{"timestamp":"%s","domain":"%s","schedule":"%s","method":"%s","event":"backup_interrupted","status":"error","message":"Backup interrupted or failed","exit_code":%d}\n' \
				"$ts" "$vm_name" "$schedule" "$method" "$exit_code" >>"$events_file" 2>/dev/null || true
		fi
	fi

	echo -e "${Green}Cleanup completed${NC}"
}

# Signal handlers
handle_sigterm() {
	echo -e "${Red}Received SIGTERM - terminating backup...${NC}"
	if [[ -n "$events_file" ]]; then
		local ts
		ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
		printf '{"timestamp":"%s","domain":"%s","schedule":"%s","event":"backup_terminated","status":"error","message":"Received SIGTERM signal"}\n' \
			"$ts" "$vm_name" "$schedule" >>"$events_file" 2>/dev/null || true
	fi
	exit 143 # 128 + 15 (SIGTERM)
}

handle_sigint() {
	echo -e "${Red}Received SIGINT (Ctrl+C) - cancelling backup...${NC}"
	if [[ -n "$events_file" ]]; then
		local ts
		ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
		printf '{"timestamp":"%s","domain":"%s","schedule":"%s","event":"backup_cancelled","status":"error","message":"Received SIGINT signal"}\n' \
			"$ts" "$vm_name" "$schedule" >>"$events_file" 2>/dev/null || true
	fi
	exit 130 # 128 + 2 (SIGINT)
}

handle_sighup() {
	echo -e "${Red}Received SIGHUP - terminal disconnected...${NC}"
	if [[ -n "$events_file" ]]; then
		local ts
		ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
		printf '{"timestamp":"%s","domain":"%s","schedule":"%s","event":"backup_interrupted","status":"error","message":"Received SIGHUP signal"}\n' \
			"$ts" "$vm_name" "$schedule" >>"$events_file" 2>/dev/null || true
	fi
	exit 129 # 128 + 1 (SIGHUP)
}

# Set up traps for all signals
trap cleanup_on_exit EXIT
trap handle_sigterm SIGTERM
trap handle_sigint SIGINT
trap handle_sighup SIGHUP

###############################################################################
# MAIN
###############################################################################

main() {
	cleanup_old_logs

	local start_time=0
	start_time=$(date +%s)

	# Display header
	local display_method="$method"
	if [[ "$display_method" == "auto" ]]; then
		display_method="auto (will detect)"
	fi

	echo ""
	echo -e "${Bold}╔══════════════════════════════════════════════════════════════╗${NC}"
	echo -e "${Bold}║              VM BACKUP — $(date '+%Y-%m-%d %H:%M:%S')               ║${NC}"
	echo -e "${Bold}╠══════════════════════════════════════════════════════════════╣${NC}"
	printf "${Bold}║${NC}  %-14s %s\n" "Domain:" "$vm_name"
	printf "${Bold}║${NC}  %-14s %s\n" "Remote IP:" "$remote_ip"
	printf "${Bold}║${NC}  %-14s %s\n" "Schedule:" "$schedule"
	printf "${Bold}║${NC}  %-14s %s\n" "Method:" "$display_method"
	if [[ -n "$retention" ]]; then printf "${Bold}║${NC}  %-14s %s\n" "Retention:" "$retention"; fi
	if [[ -n "$archives_to_keep" ]]; then printf "${Bold}║${NC}  %-14s %s\n" "Keep Archive:" "$archives_to_keep"; fi
	printf "${Bold}║${NC}  %-14s %s\n" "Compression:" "${compress_backup:-disabled}"
	printf "${Bold}║${NC}  %-14s %s\n" "Verification:" "$(if [[ "$skip_backup_verification" == "true" ]]; then echo "SKIP"; else echo "enabled"; fi)"
	printf "${Bold}║${NC}  %-14s %s\n" "Verbose:" "$verbose"
	printf "${Bold}║${NC}  %-14s %s\n" "Backup Dir:" "$backup_dir"
	printf "${Bold}║${NC}  %-14s %s\n" "Log:" "$log_file_path"
	printf "${Bold}║${NC}  %-14s %s\n" "Events:" "$events_file"
	if [[ -n "$offsite_ips" ]]; then printf "${Bold}║${NC}  %-14s %s\n" "Offsite:" "$offsite_ips"; fi
	echo -e "${Bold}╚══════════════════════════════════════════════════════════════╝${NC}"
	echo ""

	emit_event "job_start" "in_progress" "Backup job started"
	info "Backup started at $(date '+%Y-%m-%d %H:%M:%S')"

	# ── Pre-flight checks ────────────────────────────────────────────────
	if ! check_available_disk; then
		emit_event "job_fail" "error" "Disk space check failed"
		exit 1
	fi

	if ! check_ssh_connection "$remote_ip"; then
		die "Failed to SSH to $destination_ip"
	fi

	if ! get_remote_hostname; then
		die "VM '$hostName' not found on $destination_ip"
	fi

	abort_stale_domain_job

	get_remote_vm_shutdown_status
	if [[ "$vm_shutdown_status" == "shut" ]]; then
		die "VM '$vm_name' is shut off."
	fi

	check_incremental_support
	check_method_conflicts

	# ── Handle retention FIRST (may archive and force method=full) ────
	handle_retention

	# ── Auto-detect method if needed ─────────────────────────────────
	auto_detect_method

	# ── Show resolved method ─────────────────────────────────────────
	info "Resolved method: $method"
	emit_event "method_resolved" "info" "Method: $method" "method=$method"

	# ── Validate / handle overwrites ─────────────────────────────────
	case "$schedule" in
	once | monthly)
		if has_any_backup_data "$backup_dir"; then
			warn "Overwriting existing $schedule backup ..."
			find "$backup_dir" -mindepth 1 -maxdepth 1 ! -name 'logs' -exec rm -rf {} + 2>/dev/null
		fi
		;;
	weekly)
		if [[ "$method" == "copy" ]]; then
			if has_any_backup_data "$backup_dir"; then
				warn "Overwriting existing weekly copy backup ..."
				find "$backup_dir" -mindepth 1 -maxdepth 1 ! -name 'logs' -exec rm -rf {} + 2>/dev/null
			fi
		else
			validate_method_state
		fi
		;;
	daily | custom)
		if [[ "$method" != "copy" ]]; then
			validate_method_state
		else
			if has_any_backup_data "$backup_dir"; then
				warn "Overwriting existing $schedule copy backup ..."
				find "$backup_dir" -mindepth 1 -maxdepth 1 ! -name 'logs' -exec rm -rf {} + 2>/dev/null
			fi
		fi
		;;
	esac

	# ── Warn about the mirror drift before a full ────────────────────
	# Checkpoints left on the VM that no local chain accounts for can collide
	# with a fresh chain. Reported so a failure here has an obvious next step.
	if [[ "$method" == "full" ]]; then
		warn_stale_hypervisor_state
	fi

	# ── Retry cleanup ────────────────────────────────────────────────
	# If this is a retry attempt, perform safety checks and clean up
	# partial files from the previous failed attempt
	if [[ "$is_retry" == "true" ]]; then
		cleanup_retry_partial_files "$vm_name" "$schedule" "$backup_dir"
	fi

	# ── Backup lock ──────────────────────────────────────────────────
	create_backup_lock

	generate_random_nbd_port
	remote_backup_TPM || warn "TPM backup had issues."

	# ── Execute backup ───────────────────────────────────────────────
	local backup_success=false

	if run_virtnbdbackup "$backup_dir" "$method"; then
		backup_success=true
		record_scheduler "$backup_dir" "$method"
		echo ""
		info "${method^} backup succeeded for $vm_name on $destination_ip"
		emit_event "backup_complete" "success" "${method^} backup succeeded"
	else
		echo -e "${Red}${CROSS} ${method^} backup FAILED for $vm_name on $destination_ip${NC}"
		emit_event "backup_fail" "error" "${method^} backup failed"

		# ── Reactive chain recovery ───────────────────────────────────
		# The pre-flight check cannot cover everything: the hypervisor's state
		# can change between detection and execution, and a bitmap can be
		# unusable in a way neither checkpoint-list nor query-block reports.
		# When virtnbdbackup itself says the chain cannot be extended, act on
		# that verdict rather than burning the backup window — and rather than
		# leaving a dead chain that fails identically every day from here on.
		#
		# _chain_recovery_attempted makes this strictly one retry.
		if [[ "$method" == "inc" ]] && [[ "$_chain_recovery_attempted" != "true" ]] &&
			chain_failure_detected "$_virtnbd_last_detail_log"; then
			_chain_recovery_attempted="true"

			echo ""
			warn "virtnbdbackup reports this checkpoint chain cannot be extended."
			promote_chain_to_full "virtnbdbackup could not redefine the chain onto the VM"
			warn_stale_hypervisor_state
			info "Retrying once as a full backup ..."
			echo ""

			if run_virtnbdbackup "$backup_dir" "$method"; then
				backup_success=true
				record_scheduler "$backup_dir" "$method"
				echo ""
				info "${method^} backup succeeded for $vm_name on $destination_ip (after chain recovery)"
				emit_event "backup_complete" "success" "${method^} backup succeeded after chain recovery"
			else
				echo -e "${Red}${CROSS} ${method^} backup FAILED after chain recovery${NC}"
				emit_event "backup_fail" "error" "${method^} backup failed after chain recovery"
			fi
		fi
	fi

	if [[ "$backup_success" != "true" ]]; then
		if [[ "$method" == "full" ]]; then
			warn "Cleaning up failed full backup ..."
			find "$backup_dir" -mindepth 1 -maxdepth 1 ! -name 'logs' -exec rm -rf {} + 2>/dev/null
		fi
		local end_time=$(date +%s)
		local duration=$((end_time - start_time))
		echo -e "${Red}${CROSS} Backup FAILED after $(format_duration $duration)${NC}"
		echo -e "${Red}${CROSS} Log: $log_file_path${NC}"
		emit_event "job_fail" "error" "Failed after $(format_duration $duration)" "duration_seconds=$duration"

		# Even though this run failed, still replicate the VM's existing
		# backup data (previous fulls/incrementals, archives) to the offsite
		# hosts so they don't go stale. Partial files from the failed run are
		# excluded by the rsync filter. Running this here — inside the tmux
		# session, before exit — keeps the sync monitored, so the panel can
		# show its progress and outcome even though the backup itself failed.
		offsite_sync || true

		exit 1
	fi

	# ── Clear the "must be full" marker ──────────────────────────────
	# A backup just succeeded, so whatever the fix invalidated is resolved.
	clear_needs_full_marker

	# ── Verify ───────────────────────────────────────────────────────
	verify_created_backups "$backup_dir" || {
		echo -e "${Red}${CROSS} Verification failed.${NC}"
		emit_event "verify_fail" "warning" "Verification failed"
	}

	# ── Post-backup disk check ───────────────────────────────────────
	check_available_disk || warn "Disk usage high after backup."

	# ── Metrics ──────────────────────────────────────────────────────
	if declare -f backup_job_metrics &>/dev/null; then
		backup_job_metrics "$vm_name" "$destination_ip" "finished" "success" "$method"
	fi

	remove_backup_lock

	# ── Offsite sync ─────────────────────────────────────────────────
	offsite_sync

	# ── Summary ──────────────────────────────────────────────────────
	local end_time=$(date +%s)
	local duration=$((end_time - start_time))

	echo ""
	echo -e "${Green}${Bold}╔══════════════════════════════════════════════════════════════╗${NC}"
	echo -e "${Green}${Bold}║  ${CHECK} JOB COMPLETED SUCCESSFULLY                             ║${NC}"
	echo -e "${Green}${Bold}╠══════════════════════════════════════════════════════════════╣${NC}"
	printf "${Green}${Bold}║${NC}  %-14s %s\n" "Domain:" "$vm_name"
	printf "${Green}${Bold}║${NC}  %-14s %s\n" "Schedule:" "$schedule"
	printf "${Green}${Bold}║${NC}  %-14s %s\n" "Method:" "$method"
	printf "${Green}${Bold}║${NC}  %-14s %s\n" "Duration:" "$(format_duration $duration)"
	printf "${Green}${Bold}║${NC}  %-14s %s\n" "Finished:" "$(date '+%Y-%m-%d %H:%M:%S')"
	printf "${Green}${Bold}║${NC}  %-14s %s\n" "Log:" "$log_file_path"
	printf "${Green}${Bold}║${NC}  %-14s %s\n" "Events:" "$events_file"
	echo -e "${Green}${Bold}╚══════════════════════════════════════════════════════════════╝${NC}"
	echo ""

	emit_event "job_complete" "success" "Completed in $(format_duration $duration)" "duration_seconds=$duration"
}

main "$@"
