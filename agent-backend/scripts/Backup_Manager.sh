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

	if [[ "$percentage_usage" -gt 80 ]]; then
		echo -e "${Red}${CROSS} Disk usage ${percentage_usage}% (>80%) on $check_path. Stopping.${NC}"
		emit_event "disk_check" "error" "Disk >80% (${percentage_usage}%)"
		return 1
	elif [[ "$percentage_usage" -gt 60 ]]; then
		warn "Disk usage ${percentage_usage}% (>60%) on $check_path"
		emit_event "disk_check" "warning" "Disk >60% (${percentage_usage}%)"
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

	# Find and remove *.partial files in backup directory
	local partial_files_found=0
	if [[ -d "$backup_dir" ]]; then
		# Use find to locate all .partial files
		local partial_files=$(find "$backup_dir" -type f -name "*.partial" 2>/dev/null)

		if [[ -n "$partial_files" ]]; then
			echo "$partial_files" | while read -r partial_file; do
				if [[ -f "$partial_file" ]]; then
					info "Removing partial file: $(basename "$partial_file")"
					rm -f "$partial_file"
					((partial_files_found++))
				fi
			done
			info "✓ Removed $partial_files_found partial file(s)"
		else
			info "✓ No partial files found in $backup_dir"
		fi
	else
		info "✓ Backup directory does not exist yet: $backup_dir"
	fi

	# Smart checkpoint cleanup: Only remove the latest checkpoint files
	# Find the latest checkpoint by using virtnbdrestore to dump metadata
	if [[ -d "$backup_dir" ]] && command -v virtnbdrestore &>/dev/null; then
		info "Analyzing backup chain to identify latest checkpoint..."

		# Use virtnbdrestore to get backup metadata
		local metadata=$(virtnbdrestore -i "$backup_dir" -o dump 2>/dev/null | grep -A 20 '"checkpointName"' || true)

		if [[ -n "$metadata" ]]; then
			# Extract the latest checkpoint name (highest number)
			# Example: virtnbdbackup.5
			local latest_checkpoint=$(echo "$metadata" | grep -o '"checkpointName": "virtnbdbackup\.[0-9]*"' |
				grep -o 'virtnbdbackup\.[0-9]*' | sort -t. -k2 -n | tail -n1)

			if [[ -n "$latest_checkpoint" ]]; then
				info "Latest checkpoint found: $latest_checkpoint"
				info "Removing only the latest checkpoint files to preserve backup chain..."

				# Remove checkpoint files for ONLY the latest checkpoint
				# This preserves the older checkpoints which are part of the valid backup chain
				local checkpoint_dir="$backup_dir"
				local removed_count=0
				local checkpoint_xml_dir="${backup_dir}/checkpoints"

				rm -f ${checkpoint_xml_dir}/${latest_checkpoint}*

				if [[ -d "$checkpoint_dir" ]]; then
					# Remove files matching the latest checkpoint pattern
					# Example: virtnbdbackup.5.* or any file containing virtnbdbackup.5
					for ckpt_file in "$checkpoint_dir"/*"${latest_checkpoint}"* "$checkpoint_dir"/*.checkpoint; do
						if [[ -f "$ckpt_file" ]] && [[ "$ckpt_file" == *"${latest_checkpoint}"* ]]; then
							info "Removing latest checkpoint file: $(basename "$ckpt_file")"
							rm -f "$ckpt_file"
							((removed_count++))
						fi
					done

					if [[ $removed_count -gt 0 ]]; then
						info "✓ Removed $removed_count checkpoint file(s) for $latest_checkpoint"
						info "✓ Older checkpoints preserved (backup chain intact)"
					else
						info "✓ No checkpoint files found for $latest_checkpoint"
					fi
				fi
			else
				info "✓ No checkpoints found in backup metadata"
			fi
		else
			info "✓ Could not read backup metadata (might be first backup)"
		fi
	else
		if [[ ! -d "$backup_dir" ]]; then
			info "✓ Backup directory does not exist yet"
		else
			info "✓ virtnbdrestore not available, skipping checkpoint cleanup"
		fi
	fi

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
	if [[ -f "$dir/scheduler" ]]; then
		local count=0
		count=$(grep -cEv '^\s*$|^\*|^Day' "$dir/scheduler" 2>/dev/null)
		echo "${count:-0}"
	else
		echo 0
	fi
}

has_full_backup() {
	local dir="$1"
	if compgen -G "$dir"/*.full.* >/dev/null 2>&1; then
		return 0
	fi
	if [[ -f "$dir/scheduler" ]] && grep -qi "full" "$dir/scheduler" 2>/dev/null; then
		return 0
	fi
	return 1
}

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

	local matching_archives=()
	local line=""
	while IFS= read -r line; do
		if [[ -n "$line" ]]; then
			matching_archives+=("$line")
		fi
	done < <(find "$archived_backup_dir" -maxdepth 1 -mindepth 1 -type d -name "*_${vm_name}_${sched}" 2>/dev/null | sort)

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

	# Case 2: Data exists but no full backup → broken state
	if ! has_full_backup "$backup_dir"; then
		warn "Data exists but no full backup found. Cleaning and starting fresh."
		find "$backup_dir" -mindepth 1 -maxdepth 1 ! -name 'logs' -exec rm -rf {} + 2>/dev/null
		method="full"
		info "Cleaned broken chain. Method: full (fresh start)"
		emit_event "method_auto" "warning" "Auto-selected: full (broken chain cleaned)"
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

run_virtnbdbackup() {
	local target_dir="$1"
	local level="$2"

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
	if [[ ! -f "$sched_file" ]] || [[ ! -s "$sched_file" ]]; then
		printf "Day\tDate\tMethod\n" >"$sched_file"
		printf "*******************************\n" >>"$sched_file"
	fi
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

	local oip=""
	for oip in "${OFFSITE_HOSTS[@]}"; do
		oip=$(echo "$oip" | xargs)
		if [[ -n "$oip" ]]; then
			offsite_host_list+=("$oip")
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
			emit_event "offsite_fail" "error" "SSH failed to $oip" "offsite_ip=$oip"
			offsite_skipped+=("$oip")
		fi
	done

	echo ""

	if [[ ${#valid_hosts[@]} -eq 0 ]]; then
		echo -e "${Red}${CROSS} All offsite hosts failed SSH. No sync performed.${NC}"
		emit_event "offsite_complete" "error" "All offsite hosts unreachable"
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

		if [[ "$status" == "SUCCESS" ]]; then
			info "Offsite sync to $oip — ${Green}COMPLETED${NC}"
			emit_event "offsite_host_complete" "success" "Sync to $oip completed" "offsite_ip=$oip"
		else
			echo -e "${Red}${CROSS} Offsite sync to $oip — FAILED${NC}"
			echo -e "${Dim}  Log: $offsite_log${NC}"
			emit_event "offsite_host_fail" "error" "Sync to $oip failed" "offsite_ip=$oip"
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

	while [[ "$all_done" != "true" ]]; do
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
	local remote_vm_dir="$backup_path/$vm_name"

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
			echo "FAILED" >"$status_file"
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
				echo "FAILED" >"$status_file"
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
			"mkdir -p '$backup_path'; df '$backup_path' | awk 'NR>1 {print \$5}' | sed 's/%//g'" 2>/dev/null)

		if [[ -n "$remote_usage" ]] && [[ "$remote_usage" -gt 85 ]]; then
			echo "✗ Remote disk ${remote_usage}% (>85%)."
			write_progress 0 "" "0B" "" "failed"
			offsite_emit "offsite_fail" "error" "Remote disk >85%"
			rm -f "$offsite_lock"
			echo "FAILED" >"$status_file"
			return 1
		elif [[ -n "$remote_usage" ]] && [[ "$remote_usage" -gt 70 ]]; then
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
			echo "FAILED" >"$status_file"
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
	# Prevent recursive cleanup
	if [[ "$CLEANUP_IN_PROGRESS" == "true" ]]; then
		return 0
	fi
	CLEANUP_IN_PROGRESS=true

	local exit_code=$?

	echo -e "${Yellow}Cleaning up backup resources...${NC}"

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
	if [[ -n "$nbd_port" && -n "$remote_ip" ]]; then
		echo "Stopping NBD server on port $nbd_port..."
		ssh "root@$remote_ip" "pkill -f 'qemu-nbd.*\\b$nbd_port\\b'" 2>/dev/null || true
	fi

	# Release our reservation in the allocator registry so other backups
	# can pick this port again.
	if [[ -n "$nbd_port_claim_file" && -f "$nbd_port_claim_file" ]]; then
		rm -f "$nbd_port_claim_file" 2>/dev/null || true
	fi

	# Remove backup lock
	remove_backup_lock

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
		exit 1
	fi

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
