#!/bin/bash

###############################################################################
# Rsync_Manager.sh — offsite replication, as a job of its own
#
# Replicates a VM's backup directory to one or more offsite hosts, and verifies
# that what landed there matches what was sent. This used to be the tail end of
# Backup_Manager.sh; it is a separate script — and a separate job — because the
# two have almost nothing in common:
#
#   - A backup is bounded by the VM and the hypervisor. A transfer is bounded by
#     the link, and routinely runs for hours after the backup that produced the
#     data has finished.
#   - A failed transfer should be retried on its own. Re-running the backup to
#     get another attempt at the copy is expensive and pointless.
#   - A backup that finished should be reported as finished. Holding the job
#     open until replication completes makes every backup look as slow as the
#     slowest link.
#
# The two run concurrently and safely. This script never reads a file a backup
# is still writing: virtnbdbackup writes <name>.<type>.<n>.partial and renames
# it only once complete, and *.partial is excluded from the transfer.
#
# Usage:
#   bash Rsync_Manager.sh --domain vm1 --backup-path /mnt/pool \
#        --offsite-ip 172.50.0.100,172.50.0.200:/mnt/other:85
#
#   # Check only — report what differs, transfer nothing:
#   bash Rsync_Manager.sh --domain vm1 --backup-path /mnt/pool \
#        --offsite-ip 172.50.0.100 --check-only
#
# Offsite target format: "ip", "ip:/custom/base/path", or
# "ip:/custom/base/path:threshold". The colon delimiter is safe because IPv4
# addresses and absolute paths contain no colons.
#
# Exit codes:
#   0   every target is in sync
#   1   at least one target failed
#   2   --check-only: at least one target differs from the source
#  75   another rsync for this VM already holds the lock; nothing was done
###############################################################################

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/tmp_dirs.sh"

# ─── Defaults ────────────────────────────────────────────────────────────────
vm_name=""
backup_path=""
offsite_ips=""
verbose="false"
check_only="false"
# Re-record the source-filesystem baseline instead of refusing when it does not
# match. The escape hatch for a deliberate pool migration — see SOURCE GUARD.
reset_source_guard="false"
# Same escape hatch for the destination guard — see DESTINATION GUARD.
reset_target_guard="false"

# Where the source-filesystem baseline is kept.
#
# Deliberately not under the pool and not under /tmp. A record that lives inside
# the pool disappears the moment the pool is unmounted, and a record under /tmp
# disappears on reboot — this has to outlive both, because "the file that should
# be here is missing" is precisely the signal being looked for.
SOURCE_GUARD_DIR="${BACKUP_MANAGER_STATE_DIR:-/var/lib/backup-manager}/pool-guard"

# Disk-usage guard rail (percent) for an offsite destination: a transfer is
# refused when the destination pool is already used above this level. The
# per-target value from --offsite-ip overrides it.
disk_usage_threshold="80"

declare -A OFFSITE_PATH_BY_IP=()
declare -A OFFSITE_THRESHOLD_BY_IP=()

# Per-target retry: attempts before giving up on that host for this run, and the
# base delay (seconds) for the exponential backoff between them (attempt N waits
# offsite_retry_backoff_base * 2^(N-1) seconds).
offsite_retry_attempts="3"
offsite_retry_backoff_base="15"

# Staging directory (relative, on the offsite side) for partially transferred
# files, enabling a retry to RESUME instead of restarting. Kept relative on
# purpose: rsync then stages the file inside the destination directory and
# renames it into its real place once complete, so incomplete data never appears
# under a real filename, and rsync removes the staging dir itself once the
# partial has served its purpose.
#
# NOTE: the matching --exclude is NOT redundant. rsync auto-adds an exclude for
# a relative partial-dir, but appends it AFTER any rules we supply, and the
# manual warns that "the auto-added rule may be ineffective at the end of your
# other rules". We pass several excludes, so we state our own — that is what
# stops --delete from wiping the resume data between attempts.
OFFSITE_PARTIAL_DIR=".rsync-partial"

# The complete filter set for a transfer, declared once. The verification pass
# re-runs rsync in dry-run mode with this SAME array, so the check can never
# drift from what was actually transferred — a second, hand-maintained exclude
# list would eventually disagree and report differences that are not real (or,
# worse, miss ones that are).
#
#   *.partial            in-flight backup data. virtnbdbackup writes
#                        <name>.full.<n>.partial and renames it only once the
#                        file is complete, so excluding this is what makes it
#                        safe to sync a VM while a backup of it is running.
#   /*/scheduler         the per-schedule ledger an operator reads to see which
#                        backups exist. Held back and copied only after the data
#                        has landed and verified, so a half-finished sync never
#                        advertises backups the offsite host does not have. The
#                        leading / anchors it to the schedule directories —
#                        archived/<chain>/scheduler is historical and still syncs.
#   .offsite_ops.*       the rotation journal and its per-target cursors: local
#                        bookkeeping, and the cursors are per-target state that
#                        must never be mirrored onto a target.
#   .rotation-in-progress
#                        the backup's rotation fence. Local coordination, and
#                        replicating it would leave a fence sitting on the
#                        offsite host forever.
#
# --whole-file turns OFF rsync's delta algorithm, and that is the right trade
# here rather than a shortcut.
#
# The delta algorithm earns its keep on files that are edited in place: send the
# changed blocks instead of the file. Backup data is not edited in place —
# virtnbdbackup writes a file once and never touches it again. So for every file
# that matches, rsync's quick check (size + mtime) already skips it without
# reading anything, and for every file that does NOT match, the delta pass is
# pure cost: the RECEIVER must read the entire existing copy to checksum it
# before one byte crosses the wire.
#
# That cost is what stalls a transfer here. A file left truncated at the
# destination by an earlier interrupted sync — an archived chain of hundreds of
# gigabytes on shared storage — has to be read end to end, at destination disk
# speed, showing no progress at all, before the transfer that repairs it can
# start. Sending the file whole is faster than reading it once, and on this link
# by a wide margin.
#
# The cost of --whole-file is that an interrupted transfer restarts the file it
# was on rather than resuming inside it. --partial-dir still keeps everything
# already completed, so the loss is bounded by one file.
#
# Set to "false" (or pass --offsite-delta-transfer) on a link slow enough that
# re-sending a file costs more than reading it — a metered or long-haul WAN.
#
# --delete-delay rather than plain --delete is a safety choice, not a
# performance one. With the default, rsync removes the destination's extraneous
# files BEFORE it sends anything; if a retention rotation moved a chain from
# daily/ to archived/ since the file list was built, that means deleting the
# offsite copy of the chain and only then starting to upload its replacement —
# hours during which the offsite host holds neither. Deleting at the end means
# the replacement has already landed before anything is removed, so there is no
# window in which the copy is missing.
#
# --delete-delay, not --delete-after, because --delete-after "forces rsync to
# use the old, non-incremental recursion algorithm" (rsync(1)). That is the
# whole reason a transfer to a slow destination sat silent for hours before
# moving a byte: the deletion mode, not the recursion flag, was what made rsync
# scan both trees up front. --delete-delay computes the deletions during the
# transfer and applies them after it — the same "nothing is removed until its
# replacement has landed" guarantee, without the up-front scan.
OFFSITE_RSYNC_FILTERS=(
	-az --delete-delay --sparse --whole-file
	--exclude='.rotation-in-progress'
	--exclude="$OFFSITE_PARTIAL_DIR/"
	--exclude='logs/'
	--exclude='offsite_logs/'
	--exclude='in_progress_backups/'
	--exclude='offsite_locks/'
	--exclude='*.partial'
	--exclude='/*/scheduler'
	--exclude='.offsite_ops.jsonl'
	--exclude='.offsite_ops.jsonl.lock'
	--exclude='.offsite_ops.*.cursor'
)

# rsync I/O-inactivity timeout (seconds) — NOT a cap on total duration. A
# transfer that keeps moving bytes runs as long as it needs; a dead connection
# gives up after this and hands off to the retry loop, which then resumes.
#
# 30 minutes: a link that goes quiet for a few minutes at night is a stall to
# ride out, not a dead connection.
offsite_rsync_timeout="1800"

# Build the file list incrementally (rsync's default) rather than up front.
#
# --no-inc-recursive was used here so the transfer had a total to report a
# percentage against from the first byte. The cost turned out to be far higher
# than the nicer bar: it makes rsync walk the ENTIRE source tree, and the
# receiver stat the entire destination tree, before a single byte moves. On a
# large VM whose target sits on shared/network storage — several VMs pushing to
# it at once — that scan can run for hours. Worse, it cannot time out: rsync
# sends keepalives while the receiver is scanning, so --timeout below never
# fires and the transfer sits at 0% indefinitely.
#
# Note that dropping this flag alone changes nothing: --delete-after forces the
# same non-incremental recursion on its own. Both had to go, which is why the
# deletion mode above is --delete-delay.
#
# Incremental recursion starts transferring almost immediately and keeps the
# connection carrying real data, which is exactly what --timeout is able to
# police. The percentage becomes an estimate that firms up as the list grows —
# a fair trade for a transfer that starts.
#
# Set to "false" (or pass --offsite-no-inc-recursive) to get the old up-front
# file list back. Note that on its own that flag is not what caused the stall —
# --delete-after was — so restoring it is a diagnostic, not a rollback.
offsite_rsync_incremental="true"

# Send whole files rather than running the delta algorithm. See --whole-file in
# the filter block above for why immutable backup data makes the delta pass pure
# cost. "false" (or --offsite-delta-transfer) restores it.
offsite_rsync_whole_file="true"

# How long the file-list phase may produce no progress at all before the
# transfer is treated as stalled and handed to the retry loop. Distinct from
# --timeout above, which rsync's own keepalives defeat during this phase; this
# is the only bound on a receiver that never comes back.
#
# 0 disables the watchdog.
offsite_rsync_scan_timeout="1800"

# Age (days) after which an orphaned staging file is swept. Orphans only arise
# when a source file is never transferred again (e.g. its chain was archived).
offsite_partial_max_age_days="7"

# Post-sync verification. Re-runs rsync in dry-run/itemize mode with the same
# filter rules: anything it still reports is a real difference in file list,
# size or mtime. Content checksums are deliberately NOT part of this — on
# multi-TB chains that reads every byte on both sides, for files virtnbdbackup
# never rewrites once complete.
offsite_verify="true"

# Identity of the job that owns this run, recorded in the lock so a later run
# can tell "still going" from "died and left the lock behind".
rsync_job_id=""
rsync_tmux_session=""

# Resolved at startup.
vm_base_dir=""
offsite_lock_dir=""
rsync_lock_file=""
progress_metadata_dir=""
rsync_progress_file=""
offsite_ops_journal=""
log_dir=""
log_timestamp=""
log_file_path=""
events_file=""
_rsync_lock_held="false"

# Exit code meaning "another rsync for this VM is already running". Distinct
# from a real failure so the controller requeues instead of raising an alert.
readonly EXIT_RSYNC_BUSY=75
# Internal: a transfer the rotation watchdog stopped. Never leaves the script.
readonly EXIT_RSYNC_ROTATED=90
# Internal: a transfer the scan watchdog stopped because the file-list phase
# never produced progress. Never leaves the script.
readonly EXIT_RSYNC_STALLED=91
# --check-only found at least one target out of sync.
readonly EXIT_OUT_OF_SYNC=2

###############################################################################
# ARGUMENTS
###############################################################################

while [[ $# -gt 0 ]]; do
	case $1 in
	--domain)
		vm_name="$2"
		shift 2
		;;
	--backup-path)
		backup_path="$2"
		shift 2
		;;
	--offsite-ip)
		offsite_ips="$2"
		shift 2
		;;
	--offsite-retry-attempts)
		offsite_retry_attempts="$2"
		shift 2
		;;
	--offsite-retry-backoff-base)
		offsite_retry_backoff_base="$2"
		shift 2
		;;
	--offsite-rsync-timeout)
		offsite_rsync_timeout="$2"
		shift 2
		;;
	--offsite-rsync-scan-timeout)
		offsite_rsync_scan_timeout="$2"
		shift 2
		;;
	--reset-target-guard)
		reset_target_guard="true"
		shift
		;;
	--offsite-delta-transfer)
		# Restores rsync's delta algorithm: send changed blocks rather than
		# whole files, at the cost of reading each differing file at the
		# destination first.
		offsite_rsync_whole_file="false"
		shift
		;;
	--offsite-no-inc-recursive)
		# Restores the pre-incremental behaviour: full file list up front.
		offsite_rsync_incremental="false"
		shift
		;;
	--disk-threshold)
		disk_usage_threshold="$2"
		shift 2
		;;
	--rsync-job-id)
		rsync_job_id="$2"
		shift 2
		;;
	--rsync-tmux-session)
		rsync_tmux_session="$2"
		shift 2
		;;
	--check-only)
		check_only="true"
		shift
		;;
	--reset-source-guard)
		reset_source_guard="true"
		shift
		;;
	--no-verify)
		offsite_verify="false"
		shift
		;;
	--verbose)
		verbose="true"
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
		printf '{"timestamp":"%s","event":"fatal_error","status":"error","domain":"%s","job":"offsite","message":"%s"}\n' \
			"$ts" "$vm_name" "$1" >>"$events_file" 2>/dev/null
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
	printf '{"timestamp":"%s","event":"%s","status":"%s","domain":"%s","job":"offsite","message":"%s"%s}\n' \
		"$timestamp" "$event_type" "$status" "$vm_name" "$message" "$extras" \
		>>"$events_file" 2>/dev/null
	return 0
}

###############################################################################
# VALIDATION
###############################################################################

[[ -n "$vm_name" ]] || die "--domain is required."
[[ -n "$backup_path" ]] || die "--backup-path is required."
[[ -n "$offsite_ips" ]] || die "--offsite-ip is required — there is nothing to replicate to without it."
[[ -d "$backup_path" ]] || die "Backup path does not exist: $backup_path"

if ! command -v rsync &>/dev/null; then
	die "rsync is not installed on this backup host."
fi

[[ "$offsite_retry_attempts" =~ ^[0-9]+$ ]] || offsite_retry_attempts=3
[[ "$offsite_retry_attempts" -ge 1 ]] || offsite_retry_attempts=3
[[ "$offsite_retry_backoff_base" =~ ^[0-9]+$ ]] || offsite_retry_backoff_base=15
[[ "$offsite_rsync_timeout" =~ ^[0-9]+$ ]] || offsite_rsync_timeout=1800
[[ "$offsite_rsync_scan_timeout" =~ ^[0-9]+$ ]] || offsite_rsync_scan_timeout=1800

# Assembled once, here, so the transfer call site stays a single list.
#
# Recursion only — the deletion mode stays --delete-delay in every case. rsync
# refuses more than one --delete-WHEN option ("You may not combine multiple
# --delete-WHEN options"), and there is nothing to gain: --delete-delay already
# defers every deletion to the end of the transfer, which is the guarantee
# --delete-after was chosen for.
OFFSITE_RSYNC_RECURSION=()
[[ "$offsite_rsync_incremental" == "true" ]] || OFFSITE_RSYNC_RECURSION+=(--no-inc-recursive)
[[ "$offsite_rsync_whole_file" == "true" ]] || OFFSITE_RSYNC_RECURSION+=(--no-whole-file)
[[ "$disk_usage_threshold" =~ ^[0-9]+$ ]] || disk_usage_threshold=80

###############################################################################
# DIRECTORY LAYOUT
#
# Everything here is per VM, not per schedule. The transfer covers the whole VM
# directory — every schedule plus the archives — in one pass, so a per-schedule
# lock, log or progress file would describe only part of what is happening.
###############################################################################

vm_base_dir="$backup_path/$vm_name"
[[ -d "$vm_base_dir" ]] || die "No backup directory for $vm_name at $vm_base_dir — nothing to replicate."

offsite_lock_dir="$backup_path/offsite_locks"
rsync_lock_file="$offsite_lock_dir/${vm_name}.rsync.lock"
progress_metadata_dir="$backup_path/.progress"
rsync_progress_file="$progress_metadata_dir/${vm_name}_offsite.progress"
offsite_ops_journal="$vm_base_dir/.offsite_ops.jsonl"

mkdir -p "$offsite_lock_dir" "$progress_metadata_dir" 2>/dev/null

###############################################################################
# LOGGING SETUP
#
# The sync's own log directory, alongside the schedule directories rather than
# inside one of them — it belongs to no single schedule. It is excluded from the
# transfer, so it never travels to the offsite host.
###############################################################################

log_dir="$vm_base_dir/offsite_logs"
mkdir -p "$log_dir" 2>/dev/null

log_timestamp=$(date +"%Y-%m-%d_%H-%M-%S")
log_file_path="$log_dir/${log_timestamp}_offsite.log"
events_file="$log_dir/${log_timestamp}_offsite.events.jsonl"

touch "$events_file" 2>/dev/null
touch "$log_file_path" 2>/dev/null

exec > >(tee -a "$log_file_path") 2>&1
sleep 0.1

###############################################################################
# PROGRESS
###############################################################################

# The job's own progress file — the one the panel reads. Written from the
# aggregate across all targets, never per target, so the figure means "how far
# is this VM's replication", not "how far is one host". Never the backup's
# progress file: a backup for this VM may be running right now.
write_rsync_progress() {
	local pct="$1"
	local text="$2"

	[[ -n "$rsync_progress_file" ]] || return 0
	printf '{"percentage":%d,"text":"%s","type":"rsync","timestamp":"%s"}\n' \
		"$pct" "$text" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
		>"$rsync_progress_file" 2>/dev/null
	return 0
}

cleanup_rsync_progress() {
	[[ -n "$rsync_progress_file" && -f "$rsync_progress_file" ]] || return 0
	rm -f "$rsync_progress_file" 2>/dev/null
	return 0
}

cleanup_old_logs() {
	local max_logs=50
	local ext=""
	for ext in "*.log" "*.jsonl"; do
		local file_count=0
		file_count=$(find "$log_dir" -maxdepth 1 -name "$ext" -type f 2>/dev/null | wc -l)
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
# SOURCE MOUNT GUARD
#
# The pool being unmounted is the single most dangerous state this script can
# run in. Under --delete, "make the destination match the source" carried out
# against a mount point with nothing behind it means "delete every backup on
# every offsite host", and it takes seconds.
#
# The empty-source check below catches the common shape of that. It does not
# catch the worse one: an unmounted pool whose underlying directory still holds
# something — a stale tree from before the mount existed, a directory another
# tool created at the mount point, a partially restored copy. The source then
# looks populated, passes every content check, and --delete prunes each offsite
# host down to that fragment.
#
# So mountedness is established directly, from two independent facts:
#
#   1. A marker file INSIDE the pool. It was written into the mounted
#      filesystem, so it is visible only while that filesystem is mounted. If
#      the pool is not mounted, the marker is not there — regardless of what
#      else is at the mount point.
#
#   2. A baseline OUTSIDE the pool, under /var/lib, recording which filesystem
#      the pool is supposed to be. It survives the unmount, which is what makes
#      the marker's absence readable as "not mounted" rather than "never set up".
#      It also carries the filesystem's UUID, so a DIFFERENT filesystem mounted
#      at the same path is caught too — a restored pool, a spare disk swapped in,
#      a path that now resolves somewhere else.
#
# The first run for a pool records the baseline and proceeds; there is nothing
# yet to compare against. Every run after that is checked. A deliberate move to
# new storage is a one-line override (--reset-source-guard), named in the
# refusal message so nobody has to go looking for it.
###############################################################################

# Filesystem identity for the path: where it is mounted, which filesystem that
# is, and what backs it. The UUID is the part that matters — it is stable across
# reboots, which a device id is not.
_source_fs_identity() {
	local p="$1"
	local target="" uuid="" src=""

	if command -v findmnt &>/dev/null; then
		target=$(findmnt -n -o TARGET --target "$p" 2>/dev/null | head -1)
		uuid=$(findmnt -n -o UUID --target "$p" 2>/dev/null | head -1)
		src=$(findmnt -n -o SOURCE --target "$p" 2>/dev/null | head -1)
	fi

	if [[ -z "$target" ]]; then
		# No findmnt (a stripped container image, say). Fall back to the mount
		# point stat reports plus the device id. Weaker — device ids can change
		# across a reboot — but an identity that is occasionally over-strict
		# beats none at all, and --reset-source-guard clears a false positive.
		target=$(stat -c %m "$p" 2>/dev/null)
		uuid="dev:$(stat -c %d "$p" 2>/dev/null)"
		src="unknown"
	fi

	printf 'target=%s;uuid=%s;source=%s\n' "${target:-?}" "${uuid:-none}" "${src:-?}"
}

_source_guard_baseline_file() {
	local key=""
	key=$(printf '%s' "$backup_path" | md5sum 2>/dev/null | cut -c1-32)
	[[ -n "$key" ]] || key=$(printf '%s' "$backup_path" | tr -c 'a-zA-Z0-9' '_')
	echo "$SOURCE_GUARD_DIR/${key}.fsid"
}

_source_guard_marker_file() {
	echo "$backup_path/.offsite_source_fsid"
}

# Write both halves of the baseline: the one inside the pool and the one that
# outlives it. Called on the first run for a pool, and by --reset-source-guard.
_record_source_baseline() {
	local identity="$1"
	local baseline="" marker=""
	baseline=$(_source_guard_baseline_file)
	marker=$(_source_guard_marker_file)

	mkdir -p "$SOURCE_GUARD_DIR" 2>/dev/null
	{
		echo "$identity"
		echo "path=$backup_path"
		echo "recorded_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
	} >"$baseline" 2>/dev/null || {
		warn "Could not write the source baseline to $baseline — the mount guard is inactive for this run."
		return 1
	}

	{
		echo "$identity"
		echo "path=$backup_path"
		echo "recorded_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
		echo "# Written inside the pool on purpose. Its absence is how"
		echo "# Rsync_Manager.sh knows the pool is not mounted. Do not move it."
	} >"$marker" 2>/dev/null || {
		warn "Could not write the in-pool marker to $marker — the mount guard is inactive for this run."
		return 1
	}
	return 0
}

# True when the pool is mounted and is the same filesystem it was last time.
###############################################################################
# DESTINATION GUARD
#
# The source guard above asks "is the pool I am reading from really mounted?".
# This asks the same question of the other end, and it exists because the answer
# was once no, in the worst possible way.
#
# An offsite host kept its backups on network storage mounted at
# /opt/kvm_pool/shared/hdd/1. The iSCSI session dropped; the filesystem went
# away. The PATH did not: /opt/kvm_pool/shared/hdd/1/backup was still a
# perfectly writable directory — on the root filesystem. rsync did exactly what
# it was told and wrote the backups there, and kept writing until / was full.
# Nothing in the transfer was wrong. The destination had simply stopped being
# the destination, and no one was checking.
#
# Two facts establish it, the same pair the source guard uses:
#
#   1. A marker file inside the remote base path. It was written into the
#      mounted filesystem, so it is visible only while that filesystem is
#      mounted. It lives ABOVE the transfer root (<base>/, not <base>/<vm>/),
#      so --delete never sees it as extraneous and never removes it.
#
#   2. A baseline recorded on THIS host, next to the source baselines. Kept
#      locally on purpose: a record living on the offsite host would vanish with
#      the same unmount it is supposed to detect.
#
# The identity carries the mount point that CONTAINS the base path, which is
# what changes from /opt/kvm_pool/shared/hdd/1 to / the moment the mount fails —
# so the failure is caught even before the marker is consulted.
#
# A read-only destination is refused too. That is the other half of what an
# iSCSI drop looks like, and a transfer into it fails file by file rather than
# stopping.
###############################################################################

_target_guard_baseline_file() {
	local oip="$1" base="$2"
	local key=""
	key=$(printf '%s|%s' "$oip" "$base" | md5sum 2>/dev/null | cut -c1-32)
	[[ -n "$key" ]] || key=$(printf '%s_%s' "$oip" "$base" | tr -c 'a-zA-Z0-9' '_')
	echo "$SOURCE_GUARD_DIR/${key}.target.fsid"
}

TARGET_GUARD_MARKER=".offsite_target_fsid"

# One round trip: the filesystem identity of the remote base path, whether it is
# read-only, and whatever marker is there. Printed as two lines — identity, then
# marker (empty if absent).
#
# When the base path does not exist yet, the nearest existing parent is measured
# instead. That is the whole point on a broken mount: it reports the filesystem
# the directory WOULD be created on, before anything creates it.
_target_fs_identity() {
	local ruser="$1" oip="$2" base="$3"
	ssh -o BatchMode=yes -o ConnectTimeout=15 "${ruser}@${oip}" "
		p='$base'
		while [ ! -e \"\$p\" ] && [ \"\$p\" != '/' ]; do p=\$(dirname \"\$p\"); done
		if command -v findmnt >/dev/null 2>&1; then
			t=\$(findmnt -n -o TARGET --target \"\$p\" 2>/dev/null | head -1)
			u=\$(findmnt -n -o UUID   --target \"\$p\" 2>/dev/null | head -1)
			s=\$(findmnt -n -o SOURCE --target \"\$p\" 2>/dev/null | head -1)
			o=\$(findmnt -n -o OPTIONS --target \"\$p\" 2>/dev/null | head -1)
		else
			t=\$(stat -c %m \"\$p\" 2>/dev/null)
			u=\"dev:\$(stat -c %d \"\$p\" 2>/dev/null)\"
			s=unknown; o=
		fi
		ro=no
		case \",\$o,\" in *,ro,*) ro=yes ;; esac
		printf 'target=%s;uuid=%s;source=%s;ro=%s\\n' \"\${t:-?}\" \"\${u:-none}\" \"\${s:-?}\" \"\$ro\"
		head -1 '$base/$TARGET_GUARD_MARKER' 2>/dev/null || true
	" 2>/dev/null
}

_record_target_baseline() {
	local ruser="$1" oip="$2" base="$3" identity="$4"
	local baseline=""
	baseline=$(_target_guard_baseline_file "$oip" "$base")

	mkdir -p "$SOURCE_GUARD_DIR" 2>/dev/null
	{
		echo "$identity"
		echo "offsite_ip=$oip"
		echo "path=$base"
		echo "recorded_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
	} >"$baseline" 2>/dev/null || {
		warn "Could not write the destination baseline to $baseline — the mount guard is inactive for $oip."
		return 1
	}

	# The marker goes inside the mounted filesystem, which is the only place its
	# absence means anything.
	ssh -o BatchMode=yes -o ConnectTimeout=15 "${ruser}@${oip}" \
		"mkdir -p '$base' && printf '%s\\npath=%s\\nrecorded_at=%s\\n# Written inside the mounted filesystem on purpose. Its absence is how\\n# Rsync_Manager.sh knows this destination is not mounted. Do not move it.\\n' \
			'$identity' '$base' '$(date -u +"%Y-%m-%dT%H:%M:%SZ")' > '$base/$TARGET_GUARD_MARKER'" \
		2>/dev/null || {
		warn "Could not write the destination marker on $oip — the mount guard is inactive for this target."
		return 1
	}
	return 0
}

# True when the target's base path is on the filesystem it was last time, that
# filesystem is mounted, and it is writable.
verify_target_mounted() {
	local ruser="$1" oip="$2" base="$3"

	local probe="" identity="" marker_identity=""
	probe=$(_target_fs_identity "$ruser" "$oip" "$base")
	identity=$(printf '%s\n' "$probe" | sed -n 1p)
	marker_identity=$(printf '%s\n' "$probe" | sed -n 2p)

	if [[ -z "$identity" ]]; then
		echo "✗ Could not determine what filesystem $base is on at $oip."
		offsite_emit "offsite_target_guard_unknown" "error" \
			"Could not read the destination filesystem identity" "path=$base"
		return 1
	fi

	local baseline=""
	baseline=$(_target_guard_baseline_file "$oip" "$base")

	if [[ "$identity" == *";ro=yes" ]]; then
		echo ""
		echo -e "${Red}${CROSS} REFUSING TO SYNC: $base on $oip is READ-ONLY.${NC}"
		echo -e "${Red}   A filesystem that has gone read-only under a live mount is the${NC}"
		echo -e "${Red}   usual sign of a dropped network volume. Transferring into it now${NC}"
		echo -e "${Red}   would fail file by file and leave the copy half written.${NC}"
		echo -e "${Red}   Found: ${identity}${NC}"
		echo ""
		offsite_emit "offsite_target_readonly" "error" \
			"Refused to sync: the destination filesystem is read-only" \
			"found=$identity" "path=$base"
		return 1
	fi

	if [[ "$reset_target_guard" == "true" ]]; then
		warn "Re-recording the destination baseline for $oip:$base as requested."
		warn "  now: $identity"
		_record_target_baseline "$ruser" "$oip" "$base" "$identity"
		offsite_emit "offsite_target_guard_reset" "warning" \
			"Destination filesystem baseline re-recorded" "identity=$identity"
		return 0
	fi

	if [[ ! -f "$baseline" ]]; then
		echo "Recording the destination filesystem baseline for $oip:$base"
		echo "  $identity"
		_record_target_baseline "$ruser" "$oip" "$base" "$identity"
		offsite_emit "offsite_target_guard_init" "info" \
			"Recorded the destination filesystem baseline" "identity=$identity"
		return 0
	fi

	local recorded=""
	recorded=$(head -1 "$baseline" 2>/dev/null)

	# ── A different filesystem is at the path ─────────────────────────────
	# This is the unmount, caught before anything is written: the mount point
	# that contains the base path is no longer the volume, it is whatever the
	# volume was mounted ON — usually /.
	if [[ "$identity" != "$recorded" ]]; then
		echo ""
		echo -e "${Red}${CROSS} REFUSING TO SYNC: $base on $oip is not on the filesystem it should be.${NC}"
		echo -e "${Red}   The backup volume is not mounted there. The path still exists and is${NC}"
		echo -e "${Red}   still writable — it is a directory on the filesystem underneath —${NC}"
		echo -e "${Red}   so a transfer would succeed and quietly fill that disk instead.${NC}"
		echo -e "${Red}${NC}"
		echo -e "${Red}   Expected: ${recorded}${NC}"
		echo -e "${Red}   Found:    ${identity}${NC}"
		echo -e "${Red}${NC}"
		echo -e "${Red}   Mount the volume on $oip and run this again. If this host has genuinely${NC}"
		echo -e "${Red}   moved to new storage, re-record the baseline with --reset-target-guard.${NC}"
		echo ""
		offsite_emit "offsite_target_unmounted" "error" \
			"Refused to sync: the destination volume is not mounted" \
			"expected=$recorded" "found=$identity" "path=$base"
		return 1
	fi

	# ── The marker is gone, or is not ours ────────────────────────────────
	# The identity can match while the volume is still the wrong one: a restored
	# snapshot or a clone reuses the mount point and, on the fallback path, even
	# the device id. The marker is the second, independent fact.
	if [[ -z "$marker_identity" ]]; then
		echo ""
		echo -e "${Red}${CROSS} REFUSING TO SYNC: the marker inside $base on $oip is missing.${NC}"
		echo -e "${Red}   It was written into the mounted filesystem, so its absence means that${NC}"
		echo -e "${Red}   filesystem is not what is at this path now.${NC}"
		echo -e "${Red}   Expected: ${recorded}${NC}"
		echo ""
		offsite_emit "offsite_target_marker_missing" "error" \
			"Refused to sync: the destination marker is missing" \
			"expected=$recorded" "found=$identity" "path=$base"
		return 1
	fi

	if [[ "$marker_identity" != "$recorded" ]]; then
		echo ""
		echo -e "${Red}${CROSS} REFUSING TO SYNC: the marker in $base on $oip is not this destination's.${NC}"
		echo -e "${Red}   Expected: ${recorded}${NC}"
		echo -e "${Red}   Marker:   ${marker_identity}${NC}"
		echo ""
		offsite_emit "offsite_target_changed" "error" \
			"Refused to sync: the destination marker does not match the baseline" \
			"expected=$recorded" "found=$marker_identity" "path=$base"
		return 1
	fi

	return 0
}

verify_source_mounted() {
	local identity=""
	identity=$(_source_fs_identity "$backup_path")

	local baseline="" marker=""
	baseline=$(_source_guard_baseline_file)
	marker=$(_source_guard_marker_file)

	if [[ "$reset_source_guard" == "true" ]]; then
		warn "Re-recording the source baseline for $backup_path as requested."
		warn "  now: $identity"
		_record_source_baseline "$identity"
		emit_event "offsite_source_guard_reset" "warning" \
			"Source filesystem baseline re-recorded" "identity=$identity"
		return 0
	fi

	# ── First run for this pool ───────────────────────────────────────────
	if [[ ! -f "$baseline" ]]; then
		info "Recording the source filesystem baseline for $backup_path"
		info "  $identity"
		_record_source_baseline "$identity"
		emit_event "offsite_source_guard_init" "info" \
			"Recorded the source filesystem baseline" "identity=$identity"
		return 0
	fi

	local recorded=""
	recorded=$(head -1 "$baseline" 2>/dev/null)

	# ── The in-pool marker is gone ────────────────────────────────────────
	# It was written into the mounted filesystem. If it is not visible, that
	# filesystem is not mounted — whatever else is sitting at the path.
	if [[ ! -f "$marker" ]]; then
		echo ""
		echo -e "${Red}${CROSS} REFUSING TO SYNC: $backup_path does not look mounted.${NC}"
		echo -e "${Red}   The marker this pool should contain is missing, which means the${NC}"
		echo -e "${Red}   filesystem it lives on is not mounted. Anything currently at that${NC}"
		echo -e "${Red}   path is not this pool.${NC}"
		echo -e "${Red}${NC}"
		echo -e "${Red}   Syncing now would delete this VM's backups from every offsite host.${NC}"
		echo -e "${Red}${NC}"
		echo -e "${Red}   Expected: ${recorded}${NC}"
		echo -e "${Red}   Found:    ${identity}${NC}"
		echo -e "${Red}${NC}"
		echo -e "${Red}   Mount the pool and run this again. If the pool has genuinely moved${NC}"
		echo -e "${Red}   to new storage, re-record the baseline with --reset-source-guard.${NC}"
		echo ""
		emit_event "offsite_source_unmounted" "error" \
			"Refused to sync: the source pool is not mounted" \
			"expected=$recorded" "found=$identity" "path=$backup_path"
		return 1
	fi

	# ── The marker is there, but it is not this pool's ────────────────────
	# Normally a different filesystem mounted here carries no marker at all and
	# is caught above. It carries one when the filesystem itself is a copy: a
	# pool restored from a snapshot, a cloned disk, a spare that was once this
	# pool. Then the marker exists and says something — just not the same thing
	# the baseline outside the pool says. Trusting existence alone would accept
	# that copy as the live pool and prune every offsite host to match it.
	local marker_identity="" marker_path=""
	marker_identity=$(head -1 "$marker" 2>/dev/null)
	marker_path=$(sed -n 's/^path=//p' "$marker" 2>/dev/null | head -1)

	if [[ "$marker_identity" != "$recorded" ]] || [[ "$marker_path" != "$backup_path" ]]; then
		echo ""
		echo -e "${Red}${CROSS} REFUSING TO SYNC: the marker in $backup_path is not this pool's.${NC}"
		echo -e "${Red}   Something is mounted here that carries a marker of its own — a pool${NC}"
		echo -e "${Red}   restored from a snapshot, a cloned disk, or a spare that used to be${NC}"
		echo -e "${Red}   this pool. It is not the filesystem this pool was last synced from.${NC}"
		echo -e "${Red}${NC}"
		echo -e "${Red}   Expected: ${recorded} (path=$backup_path)${NC}"
		echo -e "${Red}   Marker:   ${marker_identity} (path=${marker_path:-unset})${NC}"
		echo -e "${Red}${NC}"
		echo -e "${Red}   If this storage is now the pool, re-record the baseline with${NC}"
		echo -e "${Red}   --reset-source-guard.${NC}"
		echo ""
		emit_event "offsite_source_changed" "error" \
			"Refused to sync: the in-pool marker does not match the recorded baseline" \
			"expected=$recorded" "found=$marker_identity" "path=$backup_path"
		return 1
	fi

	# ── A different filesystem is mounted here ────────────────────────────
	if [[ "$identity" != "$recorded" ]]; then
		echo ""
		echo -e "${Red}${CROSS} REFUSING TO SYNC: $backup_path is a different filesystem than before.${NC}"
		echo -e "${Red}   The path resolves to storage this pool has not used before — a spare${NC}"
		echo -e "${Red}   disk mounted in its place, a restored copy, or a path that now points${NC}"
		echo -e "${Red}   somewhere else.${NC}"
		echo -e "${Red}${NC}"
		echo -e "${Red}   Expected: ${recorded}${NC}"
		echo -e "${Red}   Found:    ${identity}${NC}"
		echo -e "${Red}${NC}"
		echo -e "${Red}   If this is the intended storage, re-record the baseline with${NC}"
		echo -e "${Red}   --reset-source-guard.${NC}"
		echo ""
		emit_event "offsite_source_changed" "error" \
			"Refused to sync: the source filesystem changed" \
			"expected=$recorded" "found=$identity" "path=$backup_path"
		return 1
	fi

	return 0
}

###############################################################################
# SOURCE CONTENT GUARD
#
# --delete makes the destination match the source. That is what keeps offsite
# retention in step with local retention, and it is also the one way this script
# could destroy data: if the source directory is empty or unreadable when the
# transfer runs, "make the destination match" means "delete every backup on the
# offsite host", and it would do it in seconds.
#
# An empty source is never legitimate here. A VM with no backup data has nothing
# to replicate, so refusing costs nothing; and the situations that produce one —
# a pool that failed to mount, a path typo, a cleanup that went too far, a full
# backup whose failure wiped its own directory — are exactly the ones where the
# offsite copy is the last copy.
#
# Deliberately narrow. It does NOT try to judge whether the source has "enough"
# data: pruning an archive or ageing out a chain legitimately removes a lot at
# once, and second-guessing that would block normal retention. It only refuses
# the case that cannot be right.
###############################################################################

source_has_backup_data() {
	# Any regular file at all under the VM directory that the transfer would
	# actually carry. Excludes logs and in-flight writes for the same reason
	# the filters do: neither is backup data, and a directory holding only a
	# half-written .partial has nothing to replicate yet.
	local hit=""
	hit=$(find "$vm_base_dir" -type f \
		! -name '*.partial' \
		! -name 'scheduler' \
		! -path "$vm_base_dir/logs/*" \
		! -path "$vm_base_dir/offsite_logs/*" \
		! -path '*/logs/*' \
		! -name '.offsite_ops.jsonl' \
		! -name '.offsite_ops.jsonl.lock' \
		! -name '.offsite_ops.*.cursor' \
		-print -quit 2>/dev/null)
	[[ -n "$hit" ]]
}

###############################################################################
# TARGET PARSING
###############################################################################

# Fill the named array with the target IPs from --offsite-ip, and record each
# one's destination path and disk threshold in the lookup maps. Shared by the
# sync and the check so the two can never disagree about what the targets are.
#
# Entry format: "ip", "ip:/custom/base/path", or "ip:/custom/base/path:threshold".
# The colon delimiter is safe because IPv4 addresses and absolute paths contain
# no colons. An empty path means "mirror the source pool path" (legacy).
parse_offsite_targets() {
	local -n _out=$1
	_out=()

	local raw=()
	IFS=',' read -ra raw <<<"$offsite_ips"

	local entry=""
	for entry in "${raw[@]}"; do
		entry=$(echo "$entry" | xargs)
		[[ -z "$entry" ]] && continue

		local oip="" opath="" othresh=""
		IFS=':' read -r oip opath othresh <<<"$entry"
		oip=$(echo "$oip" | xargs)
		opath=$(echo "$opath" | xargs)
		othresh=$(echo "$othresh" | xargs)

		[[ -n "$oip" ]] || continue
		_out+=("$oip")
		OFFSITE_PATH_BY_IP["$oip"]="$opath"
		# Only keep a valid integer 1–100; otherwise leave unset so the global
		# threshold applies.
		if [[ "$othresh" =~ ^[0-9]+$ ]] && [[ "$othresh" -ge 1 ]] && [[ "$othresh" -le 100 ]]; then
			OFFSITE_THRESHOLD_BY_IP["$oip"]="$othresh"
		fi
	done
	return 0
}

# The journal's highest sequence number, or 0. Cheap, and it is the one fact
# that says whether the source layout changed while a transfer was running.
_journal_max_seq() {
	[[ -n "$offsite_ops_journal" && -f "$offsite_ops_journal" ]] || { echo 0; return 0; }
	local m=""
	m=$(sed -n 's/.*"seq":\([0-9]*\).*/\1/p' "$offsite_ops_journal" 2>/dev/null | sort -n | tail -1)
	[[ "$m" =~ ^[0-9]+$ ]] || m=0
	echo "$m"
}

# Hold at the door while a rotation is physically moving directories about.
#
# Bounded, and it fails open: a rotation is a handful of renames on one
# filesystem, so seconds. If the marker is still there after the wait it is
# stale — a backup that was killed between the first rename and the journal
# write — and blocking replication indefinitely on a leftover file would be a
# worse failure than proceeding. Proceeding is safe because the journal check
# inside the transfer loop catches a layout change either way; the wait just
# turns the common case into a clean start instead of a restart.
wait_for_rotation() {
	local marker="$vm_base_dir/.rotation-in-progress"
	[[ -f "$marker" ]] || return 0

	local waited=0
	# Overridable so the test suite does not have to sit through the real wait
	# to prove the stale-fence path works.
	local max_wait="${OFFSITE_ROTATION_WAIT_SECS:-120}"
	info "A retention rotation is in progress for $vm_name — waiting for it to finish."
	write_rsync_progress 0 "Waiting for the backup's retention rotation"
	emit_event "offsite_rotation_wait" "in_progress" "Waiting for a retention rotation"

	while [[ -f "$marker" ]] && [[ "$waited" -lt "$max_wait" ]]; do
		sleep 2
		waited=$((waited + 2))
	done

	if [[ -f "$marker" ]]; then
		warn "The rotation fence is still up after ${max_wait}s; treating it as stale and continuing."
		emit_event "offsite_rotation_stale" "warning" \
			"Rotation fence looked stale after ${max_wait}s" "waited=$waited"
	else
		info "Rotation finished after ${waited}s; starting the sync."
	fi
	return 0
}

# How many rotations this target still owes. Used by the check to tell "the
# files match and we are done" from "the files match but a rename is still
# pending", which are different states even though the data is identical.
pending_offsite_ops_count() {
	local oip="$1"
	[[ -n "$offsite_ops_journal" && -f "$offsite_ops_journal" ]] || { echo 0; return 0; }

	local cursor=0
	local cursor_file="$vm_base_dir/.offsite_ops.${oip}.cursor"
	if [[ -f "$cursor_file" ]]; then
		cursor=$(cat "$cursor_file" 2>/dev/null)
		[[ "$cursor" =~ ^[0-9]+$ ]] || cursor=0
	fi

	local count=0
	count=$(sed -n 's/.*"seq":\([0-9]*\).*/\1/p' "$offsite_ops_journal" 2>/dev/null |
		awk -v c="$cursor" '$1+0 > c {n++} END {print n+0}')
	[[ "$count" =~ ^[0-9]+$ ]] || count=0
	echo "$count"
	return 0
}
get_terminal_width() {
	tput cols 2>/dev/null || echo 80
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



_rsync_lock_owner_alive() {
	local lock="$1"
	[[ -f "$lock" ]] || return 1

	local lpid="" lsess=""
	lpid=$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$lock" 2>/dev/null)
	lsess=$(sed -n 's/.*"tmux_session":"\([^"]*\)".*/\1/p' "$lock" 2>/dev/null)

	# Legacy lock files held nothing but a bare PID.
	if [[ -z "$lpid" ]]; then
		local raw=""
		raw=$(head -1 "$lock" 2>/dev/null | tr -d '[:space:]')
		[[ "$raw" =~ ^[0-9]+$ ]] && lpid="$raw"
	fi

	if [[ -n "$lsess" ]] && tmux has-session -t "$lsess" 2>/dev/null; then
		return 0
	fi
	if [[ -n "$lpid" ]] && kill -0 "$lpid" 2>/dev/null; then
		return 0
	fi
	return 1
}

_rsync_lock_owner_desc() {
	local lock="$1"
	local lpid="" ljob="" lstart=""
	lpid=$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$lock" 2>/dev/null)
	ljob=$(sed -n 's/.*"job_id":"\([^"]*\)".*/\1/p' "$lock" 2>/dev/null)
	lstart=$(sed -n 's/.*"started_at":"\([^"]*\)".*/\1/p' "$lock" 2>/dev/null)
	echo "pid=${lpid:-?} job=${ljob:-?} started=${lstart:-?}"
}

# Stop a transfer and everything it spawned.
#
# `pkill -P` reaches only the direct children. rsync's own children — the ssh it
# talks through, and anything a stub or wrapper starts — inherit the pipe the
# progress reader is blocked on, so killing the parent alone leaves that pipe
# open and the reader waiting forever: exactly the hang the watchdogs exist to
# end. Depth-first, so a child is signalled before the parent that could
# otherwise be reaped and lose the link to it.
_kill_process_tree() {
	local pid="${1:-}" sig="${2:-TERM}" child=""
	[[ -n "$pid" ]] || return 0
	for child in $(pgrep -P "$pid" 2>/dev/null); do
		_kill_process_tree "$child" "$sig"
	done
	kill -"$sig" "$pid" 2>/dev/null
	return 0
}

acquire_rsync_lock() {
	[[ -n "$rsync_lock_file" ]] || return 0
	mkdir -p "$(dirname "$rsync_lock_file")" 2>/dev/null

	if [[ -f "$rsync_lock_file" ]]; then
		if _rsync_lock_owner_alive "$rsync_lock_file"; then
			local desc=""
			desc=$(_rsync_lock_owner_desc "$rsync_lock_file")
			warn "An offsite sync for $vm_name is already running ($desc). Not starting a second one."
			emit_event "offsite_busy" "info" \
				"Another offsite sync for this VM is already running" "owner=$desc"
			return 1
		fi
		local desc=""
		desc=$(_rsync_lock_owner_desc "$rsync_lock_file")
		warn "Reclaiming stale offsite lock for $vm_name — its owner is gone ($desc)."
		emit_event "offsite_lock_reclaimed" "warning" \
			"Reclaimed a stale offsite lock" "owner=$desc"
		rm -f "$rsync_lock_file" 2>/dev/null
	fi

	printf '{"pid":%d,"tmux_session":"%s","job_id":"%s","vm":"%s","started_at":"%s"}\n' \
		"$$" "$rsync_tmux_session" "$rsync_job_id" "$vm_name" \
		"$(date -u +"%Y-%m-%dT%H:%M:%SZ")" >"$rsync_lock_file" 2>/dev/null

	_rsync_lock_held="true"
	return 0
}

release_rsync_lock() {
	[[ "${_rsync_lock_held:-false}" == "true" ]] || return 0
	[[ -n "$rsync_lock_file" && -f "$rsync_lock_file" ]] || return 0

	# Only ever drop OUR lock. A reclaim by another run would have rewritten it,
	# and deleting that would hand a third run the right to start alongside it.
	local lpid=""
	lpid=$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$rsync_lock_file" 2>/dev/null)
	if [[ "$lpid" == "$$" ]]; then
		rm -f "$rsync_lock_file" 2>/dev/null
	fi
	_rsync_lock_held="false"
	return 0
}

apply_offsite_ops() {
	local oip="$1"
	local ruser="$2"
	local rvmdir="$3"

	[[ -n "$offsite_ops_journal" && -f "$offsite_ops_journal" ]] || return 0

	local cursor_file="$vm_base_dir/.offsite_ops.${oip}.cursor"
	local cursor=0
	if [[ -f "$cursor_file" ]]; then
		cursor=$(cat "$cursor_file" 2>/dev/null)
		[[ "$cursor" =~ ^[0-9]+$ ]] || cursor=0
	fi

	local applied=0
	local line=""
	while IFS= read -r line || [[ -n "$line" ]]; do
		[[ -z "$line" ]] && continue

		local seq="" op="" name="" sched="" dest=""
		seq=$(sed -n 's/.*"seq":\([0-9]*\).*/\1/p' <<<"$line")
		op=$(sed -n 's/.*"op":"\([^"]*\)".*/\1/p' <<<"$line")
		name=$(sed -n 's/.*"name":"\([^"]*\)".*/\1/p' <<<"$line")
		sched=$(sed -n 's/.*"schedule":"\([^"]*\)".*/\1/p' <<<"$line")
		# Where the chain was moved to. "archived" for a retention rotation,
		# ".broken" for a quarantined chain. Absent on entries written before
		# the field existed, which were all archives.
		dest=$(sed -n 's/.*"dest":"\([^"]*\)".*/\1/p' <<<"$line")
		[[ -n "$dest" ]] || dest="archived"

		[[ "$seq" =~ ^[0-9]+$ ]] || continue
		[[ "$seq" -le "$cursor" ]] && continue
		[[ -z "$op" || -z "$name" ]] && continue

		case "$op" in
		archive)
			[[ -n "$sched" ]] || continue
			echo "  Replaying rotation ${seq}: ${sched} → ${dest}/${name}"
			# The destination is checked on the remote side before anything
			# moves, and that check — not the cursor — is what makes this safe.
			#
			# The op says "the chain that was in <sched>/ is now at
			# <dest>/<name>/". Replayed later, when <sched>/ holds a DIFFERENT
			# chain, a blind move would take the live chain and bury it inside
			# an old archive directory. The cursor is supposed to stop that, but
			# a cursor is bookkeeping: it can be lost, rolled back with a
			# restored pool, or skipped by a bug like the one that produced this
			# comment. So the guard lives where the damage would happen — if
			# <dest>/<name>/ already holds anything, this rotation has already
			# been applied and the op is a no-op.
			#
			# Correctness therefore no longer depends on the cursor at all. The
			# cursor is now purely an optimisation that saves SSH round-trips,
			# and being wrong about it costs time, never data.
			local rc_replay=0
			ssh -o BatchMode=yes -o ConnectTimeout=15 "${ruser}@${oip}" \
				"if [ -d '$rvmdir/$dest/$name' ] && [ -n \"\$(ls -A '$rvmdir/$dest/$name' 2>/dev/null)\" ]; then exit 3; fi; if [ -d '$rvmdir/$sched' ]; then mkdir -p '$rvmdir/$dest/$name'; find '$rvmdir/$sched' -mindepth 1 -maxdepth 1 ! -name 'logs' -exec mv -f {} '$rvmdir/$dest/$name/' \; 2>/dev/null; fi" \
				2>/dev/null || rc_replay=$?

			if [[ "$rc_replay" -eq 3 ]]; then
				echo "    already applied on $oip — nothing to move"
			elif [[ "$rc_replay" -ne 0 ]]; then
				echo "  ✗ Could not replay rotation ${seq} on $oip"
				return 1
			fi
			;;
		prune)
			# Naturally idempotent: removing something already gone is a no-op,
			# and archive names carry a timestamp so one is never reused.
			echo "  Replaying rotation ${seq}: prune ${dest}/${name}"
			ssh -o BatchMode=yes -o ConnectTimeout=15 "${ruser}@${oip}" \
				"rm -rf '$rvmdir/$dest/$name'" 2>/dev/null || {
				echo "  ✗ Could not replay rotation #${seq} on $oip"
				return 1
			}
			;;
		*)
			# Unknown op from a newer script version: skip it but still move the
			# cursor, otherwise this target would stall on it forever.
			echo "  Skipping unknown rotation ${seq} (op=${op})"
			;;
		esac

		echo "$seq" >"$cursor_file" 2>/dev/null
		cursor="$seq"
		applied=$((applied + 1))
	done <"$offsite_ops_journal"

	if [[ "$applied" -gt 0 ]]; then
		echo "✓ Replayed $applied rotation(s) on $oip — no data re-transferred"
	fi
	return 0
}

trim_offsite_ops_journal() {
	[[ -n "$offsite_ops_journal" && -f "$offsite_ops_journal" ]] || return 0

	local min_cursor=""
	local cf=""
	while IFS= read -r cf; do
		[[ -f "$cf" ]] || continue
		local c=""
		c=$(cat "$cf" 2>/dev/null)
		[[ "$c" =~ ^[0-9]+$ ]] || c=0
		if [[ -z "$min_cursor" ]] || [[ "$c" -lt "$min_cursor" ]]; then
			min_cursor="$c"
		fi
	done < <(find "$vm_base_dir" -maxdepth 1 -type f -name '.offsite_ops.*.cursor' 2>/dev/null)

	[[ -z "$min_cursor" || "$min_cursor" -le 0 ]] && return 0

	local jlock="${offsite_ops_journal}.lock"
	: >>"$jlock" 2>/dev/null || true
	exec 8>>"$jlock" 2>/dev/null || true
	flock -x 8 2>/dev/null || true

	# Trimming everything every target has replayed is safe now that ids come
	# from the clock: emptying the journal cannot make the next id collide with
	# an old one, which is the only reason this once had to keep a line back.
	local tmp="${offsite_ops_journal}.tmp.$$"
	if awk -v m="$min_cursor" '
		{
			seq = 0
			if (match($0, /"seq":[0-9]+/)) {
				seq = substr($0, RSTART + 6, RLENGTH - 6) + 0
			}
			if (seq > m) print
		}' "$offsite_ops_journal" >"$tmp" 2>/dev/null; then
		mv -f "$tmp" "$offsite_ops_journal" 2>/dev/null || rm -f "$tmp" 2>/dev/null
	else
		rm -f "$tmp" 2>/dev/null
	fi

	flock -u 8 2>/dev/null || true
	exec 8>&- 2>/dev/null || true
	return 0
}

verify_offsite_target() {
	local oip="$1"
	local ruser="$2"
	local rvmdir="$3"
	local detail_log="$4"

	_offsite_verify_diff=""
	_offsite_verify_count=0

	[[ "$offsite_verify" == "true" ]] || return 0

	local out=""
	out=$(rsync -n -i "${OFFSITE_RSYNC_FILTERS[@]}" \
		--timeout="$offsite_rsync_timeout" \
		"$vm_base_dir/" "${ruser}@${oip}:${rvmdir}/" 2>>"$detail_log" |
		grep -E '^(>f|<f|\*deleting)' || true)

	if [[ -n "$out" ]]; then
		_offsite_verify_diff="$out"
		_offsite_verify_count=$(printf '%s\n' "$out" | grep -c . || true)
		[[ "$_offsite_verify_count" =~ ^[0-9]+$ ]] || _offsite_verify_count=0
	fi

	[[ "$_offsite_verify_count" -eq 0 ]]
}

offsite_sync_single_host() {
	local oip="$1"
	local offsite_log="$2"
	local offsite_event_log="$3"
	local status_file="$4"
	local progress_file="$5"

	# Per-target lock. VM-wide, not per-schedule: the transfer below covers the
	# whole VM directory (every schedule plus the archives) in one pass, so two
	# schedules of the same VM must never sync to the same target at once.
	local offsite_lock="$offsite_lock_dir/${vm_name}_offsite_${oip}"
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

			# Per-target file. Never the backup's progress file: a backup for
			# this VM may be running right now, and writing there would show
			# rsync's percentage on the backup job. offsite_sync aggregates
			# these into $rsync_progress_file for the panel.
			local host_progress_file="$progress_metadata_dir/${vm_name}_offsite_${oip}.progress"
			echo "$json_output" >"$host_progress_file" 2>/dev/null
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
	# The reader below parses rsync's progress lines and emits events. We
	# additionally need to forward pct/speed/eta into
	# the progress_file so monitor_offsite_progress can update per-host bars.
	# We do this by wrapping the fifo read in a co-process that tees progress
	# data into the progress_file while the bar is drawn on stdout.
	#
	# Because offsite_sync_single_host runs entirely inside a subshell (the
	# background ( … ) & block in offsite_sync), stdout here goes to the log
	# file, NOT the terminal.  The per-host monitor reads progress_file for
	# display; the reader's own output goes into the log.
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

		# rsync builds a file list before it reports progress. With incremental
		# recursion that is short; with --no-inc-recursive it is the whole tree
		# on both ends. Either way it is total silence, during which a bar
		# pinned at 0% is indistinguishable from a hung transfer. Report it as
		# its own phase with the clock running, until the first real progress
		# line arrives.
		#
		# The same loop is the only bound on that phase. A receiver on slow
		# shared storage — or several transfers scanning it at once — can sit
		# there for hours, and rsync's own --timeout cannot catch it: rsync
		# sends keepalives while the far side scans, so the connection never
		# looks idle. Past offsite_rsync_scan_timeout with nothing to show for
		# it, the transfer is stopped and handed to the retry loop, which backs
		# off and tries again rather than leaving the job at 0% forever.
		#
		# Stopping rsync here is safe for the same reason the rotation watchdog
		# is: partial files live in .rsync-partial under a staging name, and
		# nothing has been deleted — --delete-delay applies its deletions only
		# once the transfer completes, and this transfer never got there.
		local scan_flag="$BACKUP_TMP_PROGRESS/.rsync_scan_${oip}_$$"
		local stall_flag="$BACKUP_TMP_PROGRESS/.rsync_stalled_${oip}_$$"
		rm -f "$stall_flag"
		: >"$scan_flag"
		(
			_scan_started_at=$(date +%s)
			while [[ -f "$scan_flag" ]]; do
				_scan_elapsed=$(($(date +%s) - _scan_started_at))
				if [[ "$offsite_rsync_scan_timeout" -gt 0 &&
					"$_scan_elapsed" -ge "$offsite_rsync_scan_timeout" ]]; then
					: >"$stall_flag"
					# rsync and everything under it, so the progress
					# reader sees the pipe close.
					_kill_process_tree "$bg_pid" TERM
					sleep 1
					_kill_process_tree "$bg_pid" KILL
					break
				fi
				write_progress 0 "" "0B" "${_scan_elapsed}s" "scanning"
				sleep 3
			done
		) &
		local scan_pid=$!

		# ── Rotation watchdog ────────────────────────────────────────────
		# Noticing a rotation only after rsync returns is too late. rsync builds
		# its file list once, up front, and on a large chain that takes minutes;
		# a rotation landing anywhere in that window leaves rsync working from a
		# layout that no longer exists. It then uploads the archived chain in
		# full — the same bytes already sitting on the target under daily/ — and
		# with deletion enabled it removes the originals afterwards. The data
		# survives (that is what deferred deletion is for) but terabytes crossed the
		# WAN to achieve nothing.
		#
		# So the transfer is stopped as soon as the journal moves. The restart
		# replays the rotation on the target as the rename it was, and the pass
		# that follows finds the chain already where it belongs.
		#
		# Killing rsync mid-flight is safe by construction: partial files live in
		# .rsync-partial and never under a real name, and deletion has not run —
		# it is the last thing rsync does, and it never gets there.
		local rotation_flag="$BACKUP_TMP_PROGRESS/.rsync_rotated_${oip}_$$"
		rm -f "$rotation_flag"
		(
			while kill -0 "$bg_pid" 2>/dev/null; do
				if [[ "$(_journal_max_seq)" != "$journal_seq" ]]; then
					: >"$rotation_flag"
					# rsync and everything under it, so the progress
					# reader sees the pipe close.
					_kill_process_tree "$bg_pid" TERM
					sleep 1
					_kill_process_tree "$bg_pid" KILL
					break
				fi
				sleep 2
			done
		) &
		local rotation_pid=$!

		local _rp_pct="" _rp_speed="" _rp_xferred="" _rp_eta=""
		local last_emit_pct=-1
		# A large sync crosses whole percent points minutes apart, so a
		# percent-only gate leaves the panel frozen. Emit on 5% OR every
		# OFFSITE_EMIT_MIN_SECS, whichever comes first.
		local last_emit_ts=0
		local OFFSITE_EMIT_MIN_SECS=5

		# rsync separates its progress updates with \r, not \n, so a plain
		# line-at-a-time read would sit blocked until the transfer ended. This
		# used to be solved by reading the stream a BYTE at a time in bash —
		# one loop iteration, one string append and one case statement per byte
		# of a progress line that rsync rewrites many times a second. That cost
		# more CPU than the transfer it was reporting on, and it multiplied by
		# every target syncing at once. `tr` does the same splitting in C for
		# nothing, and the loop below then reads whole lines.
		#
		# `|| [[ -n "$line" ]]` catches a final update with no terminator, which
		# is what the byte loop's fallback block existed for.
		local line=""
		local last_write_ts=0
		while IFS= read -r line || [[ -n "$line" ]]; do
			[[ -n "$line" ]] || continue
			echo "$line" >>"$detail_log"

			if ! parse_rsync_progress "$line"; then
				line=""
				continue
			fi

			_rp_pct="$_rsync_pct"
			_rp_speed="$_rsync_speed"
			_rp_xferred="$_rsync_xferred"
			_rp_eta="$_rsync_eta"
			# First real progress line — the file list is built.
			rm -f "$scan_flag" 2>/dev/null

			# Built-in, so no `date` fork per progress line.
			printf -v _rp_now '%(%s)T' -1

			# The agent polls the progress file every couple of seconds. Writing
			# it several times a second is two file writes and a `date` fork
			# each time, for a value nobody reads before it is overwritten.
			if [[ "$_rp_now" != "$last_write_ts" ]]; then
				last_write_ts="$_rp_now"
				write_progress "$_rp_pct" "$_rp_speed" "$_rp_xferred" "$_rp_eta" "syncing"
			fi

			if [[ $((_rp_pct - last_emit_pct)) -ge 5 ]] ||
				[[ $((_rp_now - last_emit_ts)) -ge $OFFSITE_EMIT_MIN_SECS ]]; then
				last_emit_pct=$_rp_pct
				last_emit_ts=$_rp_now
				# Logged with the emit rather than per line: at full speed the
				# per-line copy doubled the detail log for no extra detail. The
				# raw rsync line above is still recorded in full.
				printf '[%(%H:%M:%S)T] Parsed progress: %s%% | %s | %s | %s\n' -1 \
					"$_rp_pct" "$_rp_speed" "$_rp_xferred" "$_rp_eta" >>"$detail_log"
				offsite_emit "offsite_rsync_progress" "in_progress" \
					"rsync ${_rp_pct}%" \
					"percent=$_rp_pct" "speed=$_rp_speed" \
					"transferred=$_rp_xferred" "eta=$_rp_eta"
			fi
			line=""
		done < <(tr '\r' '\n' <"$fifo_prog")

		# The per-second gate above can swallow the last update, which is the
		# one the panel is left showing. Write it unconditionally.
		if [[ -n "$_rp_pct" ]]; then
			write_progress "$_rp_pct" "$_rp_speed" "$_rp_xferred" "$_rp_eta" "syncing"
		fi

		rm -f "$scan_flag" 2>/dev/null
		wait "$scan_pid" 2>/dev/null
		wait "$bg_pid" 2>/dev/null
		kill "$rotation_pid" 2>/dev/null
		wait "$rotation_pid" 2>/dev/null
		rm -f "$fifo_prog"

		local rc=1
		if [[ -f "$exit_code_file" ]]; then
			rc=$(cat "$exit_code_file")
			rm -f "$exit_code_file"
		fi

		# A transfer the watchdog stopped is not a failed transfer, and its exit
		# code — whatever signal handling produced — says nothing useful. Report
		# it as its own outcome so the caller restarts instead of counting it
		# against the network-retry budget.
		if [[ -f "$rotation_flag" ]]; then
			rm -f "$rotation_flag"
			return "$EXIT_RSYNC_ROTATED"
		fi

		# Same reasoning for a transfer the scan watchdog stopped: the exit code
		# describes the signal, not the transfer. Name the outcome so the caller
		# can say what happened instead of reporting a generic rsync failure.
		if [[ -f "$stall_flag" ]]; then
			rm -f "$stall_flag"
			return "$EXIT_RSYNC_STALLED"
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
		# A live holder wins and we stand down cleanly — this used to wait two
		# hours and then SIGKILL the holder, which with independent rsync jobs
		# means one job killing another job's transfer and reporting a failure
		# that never happened. A holder that is gone (cancelled job, killed
		# backup, power loss) leaves a lock whose PID is dead and whose tmux
		# session no longer exists; that one we reclaim.
		if [[ -f "$offsite_lock" ]]; then
			if _rsync_lock_owner_alive "$offsite_lock"; then
				local _owner=""
				_owner=$(_rsync_lock_owner_desc "$offsite_lock")
				echo "⚠ An rsync to $oip for this VM is already running ($_owner). Standing down."
				write_progress 0 "" "0B" "" "busy"
				offsite_emit "offsite_busy" "info" \
					"Another rsync to this target is already running" "owner=$_owner"
				echo "BUSY|another rsync to this target is already running" >"$status_file"
				return 0
			fi
			local _stale=""
			_stale=$(_rsync_lock_owner_desc "$offsite_lock")
			echo "Reclaiming stale rsync lock for $oip — its owner is gone ($_stale)."
			offsite_emit "offsite_lock_reclaimed" "warning" \
				"Reclaimed a stale rsync lock" "owner=$_stale"
			rm -f "$offsite_lock"
		fi

		printf '{"pid":%d,"tmux_session":"%s","job_id":"%s","vm":"%s","target":"%s","started_at":"%s"}\n' \
			"$BASHPID" "$rsync_tmux_session" "$rsync_job_id" "$vm_name" "$oip" \
			"$(date -u +"%Y-%m-%dT%H:%M:%SZ")" >"$offsite_lock"

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

		# ── Step 4: Destination mount guard ──────────────────────────────
		# Before the mkdir below, deliberately. `mkdir -p` on a path whose
		# volume is not mounted does not fail — it creates the directory on
		# whatever filesystem is underneath, and that is precisely how a
		# dropped iSCSI mount turned into a full root disk.
		echo "Checking the destination volume on $oip ..."
		if ! verify_target_mounted "$remote_user" "$oip" "$remote_base"; then
			write_progress 0 "" "0B" "" "failed"
			offsite_emit "offsite_fail" "error" "Destination volume check failed"
			rm -f "$offsite_lock"
			echo "FAILED|the destination volume is not mounted or not writable" >"$status_file"
			return 1
		fi
		echo "✓ Destination volume OK"

		# ── Step 5: Remote disk space ────────────────────────────────────
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

		# ── Step 6: Replicate archive/prune ──────────────────────────────
		ssh "${remote_user}@${oip}" \
			"mkdir -p '$remote_vm_dir/archived' '$remote_vm_dir/daily' \
             '$remote_vm_dir/weekly' '$remote_vm_dir/monthly' \
             '$remote_vm_dir/once' '$remote_vm_dir/custom'" 2>/dev/null

		# Rotations are replayed at the top of every attempt, not once before
		# the loop, because the source can rotate WHILE a transfer is running.
		# See the rotation handling in the loop below — this is the other half
		# of it. Replaying is a no-op when the target's cursor is already
		# current, so the repetition costs nothing.
		replay_rotations() {
			write_progress 0 "" "0B" "" "archiving"
			if apply_offsite_ops "$oip" "$remote_user" "$remote_vm_dir"; then
				return 0
			fi
			echo "✗ Could not replay pending rotations on $oip — refusing to sync against a stale layout."
			write_progress 0 "" "0B" "" "failed"
			offsite_emit "offsite_fail" "error" "Rotation replay failed"
			rm -f "$offsite_lock"
			echo "FAILED|could not replay pending archive/prune rotations" >"$status_file"
			return 1
		}

		# ── Step 7: rsync with aggregate-style progress bar ──────────────
		# Retried in-place (attempt N waits offsite_retry_backoff_base * 2^(N-1)
		# seconds before the next try) so a brief network blip doesn't fail the
		# whole offsite sync for this host — only after every attempt fails is
		# the host marked FAILED. This is cheap: it just re-runs rsync, not the
		# VM backup.
		local rsync_max_attempts="${offsite_retry_attempts:-3}"
		[[ "$rsync_max_attempts" =~ ^[0-9]+$ ]] || rsync_max_attempts=3
		[[ "$rsync_max_attempts" -lt 1 ]] && rsync_max_attempts=1
		local rsync_backoff_base="${offsite_retry_backoff_base:-15}"
		[[ "$rsync_backoff_base" =~ ^[0-9]+$ ]] || rsync_backoff_base=15

		local rsync_attempt=1
		local rsync_ok="false"
		local rsync_duration=0
		# Set when the transfer completed but the destination still did not
		# match, so the status handed back names the real cause.
		local verify_reason=""

		# ── Rotation restarts ────────────────────────────────────────────
		# A retention rotation during a transfer is the one interleaving that
		# can turn this job from cheap into ruinous. rsync builds its file list
		# once, at the start. If retention then archives the chain — daily/*
		# moved to archived/<name>/ — every path in that list is gone, and a
		# naive restart would rebuild the list from the new layout and see the
		# destination's daily/ copy as extraneous: delete the offsite chain,
		# then re-upload the identical bytes to archived/. Terabytes over the
		# WAN, and (before deletion was deferred) hours with no offsite copy at all.
		#
		# The journal is what makes this recoverable. The backup recorded the
		# rotation as it happened, so a restart replays it on the target as the
		# same rename, and rsync then finds the chain already sitting where it
		# expects — nothing to send.
		#
		# So a rotation restart is not a retry: the attempt did not fail, the
		# ground moved. It gets its own budget and does not spend the retry
		# attempts, which exist for network trouble. Bounded, because a VM
		# rotating faster than it can replicate must eventually be reported
		# rather than looped on forever.
		local rotation_restarts=0
		local max_rotation_restarts=3
		local journal_seq=0

		while [[ "$rsync_attempt" -le "$rsync_max_attempts" ]]; do
			# Apply anything the source rotated since the last pass, then note
			# where the journal stands. Everything below compares against this.
			replay_rotations || return 1
			journal_seq=$(_journal_max_seq)

			echo ""
			if [[ "$rsync_attempt" -gt 1 ]]; then
				echo "Retrying rsync to $oip (attempt $rsync_attempt/$rsync_max_attempts) ..."
				write_progress 0 "" "0B" "" "syncing"
				offsite_emit "offsite_rsync_retry" "in_progress" \
					"Retrying rsync (attempt $rsync_attempt/$rsync_max_attempts)" \
					"attempt=$rsync_attempt" "max_attempts=$rsync_max_attempts"
			else
				echo "Starting rsync to $oip ..."
				write_progress 0 "" "0B" "" "syncing"
				offsite_emit "offsite_rsync_start" "in_progress" "Starting rsync"
			fi

			local rsync_detail_log="$log_dir/${log_timestamp}_offsite_${oip}_rsync_detail.log"
			local rsync_start_time=0
			rsync_start_time=$(date +%s)

			local rsync_label="${vm_name} → ${oip}"

			# Kept as an explicit status rather than `if run_rsync_for_offsite`:
			# the failure path needs to tell a stall from an ordinary rsync
			# failure, and after `fi` $? no longer holds the command's code.
			local rsync_rc=0
			run_rsync_for_offsite \
				"$rsync_detail_log" \
				"$rsync_label" \
				"${OFFSITE_RSYNC_FILTERS[@]}" \
				${OFFSITE_RSYNC_RECURSION[@]+"${OFFSITE_RSYNC_RECURSION[@]}"} \
				--partial-dir="$OFFSITE_PARTIAL_DIR" \
				--timeout="$offsite_rsync_timeout" \
				"$vm_base_dir/" \
				"${remote_user}@${oip}:${remote_vm_dir}/" || rsync_rc=$?

			if [[ "$rsync_rc" -eq 0 ]]; then

				local rsync_end_time=0
				rsync_end_time=$(date +%s)
				rsync_duration=$((rsync_end_time - rsync_start_time))

				# Did the source rotate while that ran? If so the transfer was
				# working from a layout that no longer exists, and verifying it
				# would only report the rotation as thousands of differences.
				# Go round again: the replay at the top of the loop moves the
				# chain on the target to where it now belongs, and the next pass
				# has almost nothing left to send.
				if [[ "$(_journal_max_seq)" != "$journal_seq" ]]; then
					rotation_restarts=$((rotation_restarts + 1))
					if [[ "$rotation_restarts" -gt "$max_rotation_restarts" ]]; then
						verify_reason="the source kept rotating during the transfer"
						echo "✗ $verify_reason — giving up after $max_rotation_restarts restart(s)."
						offsite_emit "offsite_rotation_thrash" "error" \
							"Source rotated repeatedly during the transfer" \
							"restarts=$rotation_restarts"
						break
					fi
					echo "⟳ The source rotated during this transfer (retention archived the chain)."
					echo "  Replaying the rotation on $oip and syncing again — the data is already"
					echo "  there, it just moved, so this costs a rename rather than a re-upload."
					offsite_emit "offsite_rotation_restart" "in_progress" \
						"Source rotated mid-transfer; replaying and re-syncing" \
						"restart=$rotation_restarts" "attempt=$rsync_attempt"
					wait_for_rotation
					continue
				fi

				# rsync exiting 0 means it finished, not that the destination
				# matches. Confirm that before calling this host done: a file
				# that arrived truncated, or that a backup completed while the
				# transfer was already past its directory, still needs sending.
				# A failed check is treated exactly like a failed attempt, so
				# the retry loop re-syncs just the offending files.
				write_progress 99 "" "0B" "" "verifying"
				echo "Verifying $oip holds the same files at the same sizes ..."
				if verify_offsite_target "$oip" "$remote_user" "$remote_vm_dir" \
					"$rsync_detail_log"; then
					echo "✓ Verified — source and destination match"
					offsite_emit "offsite_verify_ok" "success" \
						"Destination matches source"
					rsync_ok="true"
					break
				fi

				verify_reason="verification: ${_offsite_verify_count} file(s) still differ"
				echo "⚠ ${verify_reason} (attempt $rsync_attempt/$rsync_max_attempts)"
				printf '%s\n' "$_offsite_verify_diff" | head -20
				offsite_emit "offsite_verify_fail" "warning" \
					"$_offsite_verify_count file(s) still differ" \
					"differences=$_offsite_verify_count" "attempt=$rsync_attempt"

				if [[ "$rsync_attempt" -lt "$rsync_max_attempts" ]]; then
					local verify_backoff=$((rsync_backoff_base * (1 << (rsync_attempt - 1))))
					echo "  Re-syncing the difference in ${verify_backoff}s ..."
					sleep "$verify_backoff"
				fi
				rsync_attempt=$((rsync_attempt + 1))
				continue
			fi

			local rsync_end_time=0
			rsync_end_time=$(date +%s)
			rsync_duration=$((rsync_end_time - rsync_start_time))

			# A rotation under a running transfer usually shows up here rather
			# than as a clean success: rsync exits non-zero because the files in
			# its list vanished mid-flight. That is not a failure worth spending
			# a retry attempt on — the files did not disappear, they moved, and
			# the journal says exactly where to.
			if [[ "$(_journal_max_seq)" != "$journal_seq" ]]; then
				rotation_restarts=$((rotation_restarts + 1))
				if [[ "$rotation_restarts" -gt "$max_rotation_restarts" ]]; then
					verify_reason="the source kept rotating during the transfer"
					echo "✗ $verify_reason — giving up after $max_rotation_restarts restart(s)."
					offsite_emit "offsite_rotation_thrash" "error" \
						"Source rotated repeatedly during the transfer" \
						"restarts=$rotation_restarts"
					break
				fi
				echo "⟳ rsync stopped because the source rotated under it (retention archived the chain)."
				echo "  Replaying the rotation on $oip and syncing again."
				offsite_emit "offsite_rotation_restart" "in_progress" \
					"Source rotated mid-transfer; replaying and re-syncing" \
					"restart=$rotation_restarts" "attempt=$rsync_attempt"
				wait_for_rotation
				continue
			fi

			# A stall is a failed attempt — it spends a retry and backs off like
			# any other — but it is worth naming, because "rsync failed" sends
			# an operator looking at the network when the answer is a receiver
			# that never finished scanning.
			if [[ "$rsync_rc" -eq "$EXIT_RSYNC_STALLED" ]]; then
				verify_reason="the offsite host never finished building its file list"
				echo "✗ rsync STALLED: no progress in $(format_duration "$offsite_rsync_scan_timeout") while $oip built its file list"
				echo "  (attempt $rsync_attempt/$rsync_max_attempts) — the transfer was stopped; nothing was deleted."
				echo "  Usually a slow or contended destination filesystem rather than the link."
				offsite_emit "offsite_rsync_stalled" "error" \
					"rsync stalled during the file-list phase (attempt $rsync_attempt/$rsync_max_attempts)" \
					"scan_timeout_seconds=$offsite_rsync_scan_timeout" \
					"duration_seconds=$rsync_duration" "attempt=$rsync_attempt"
			else
			echo "✗ rsync FAILED after $(format_duration $rsync_duration) (attempt $rsync_attempt/$rsync_max_attempts)"
			offsite_emit "offsite_rsync_attempt_fail" "error" \
				"rsync failed (attempt $rsync_attempt/$rsync_max_attempts)" \
				"duration_seconds=$rsync_duration" "attempt=$rsync_attempt"
			fi

			if [[ "$rsync_attempt" -lt "$rsync_max_attempts" ]]; then
				local rsync_backoff=$((rsync_backoff_base * (1 << (rsync_attempt - 1))))
				echo "  Waiting ${rsync_backoff}s before retrying ..."
				write_progress 0 "" "0B" "" "checking"
				sleep "$rsync_backoff"
			fi

			rsync_attempt=$((rsync_attempt + 1))
		done

		if [[ "$rsync_ok" == "true" ]]; then
			echo "✓ rsync completed in $(format_duration $rsync_duration)"

			# Sweep orphaned resume data. rsync removes a staging file as soon
			# as it has served its purpose, so anything still here is debris
			# from a transfer whose source no longer exists (an archived
			# chain, say) and would otherwise sit on the offsite host forever.
			# Scoped to THIS VM's remote directory so a concurrent sync of
			# another VM can never have its in-flight resume data deleted.
			ssh "${remote_user}@${oip}" \
				"find '$remote_vm_dir' -type d -name '$OFFSITE_PARTIAL_DIR' \
                 -exec find {} -type f -mtime +$offsite_partial_max_age_days -delete \; 2>/dev/null" \
				2>/dev/null || true

			# The scheduler ledger is the file an operator reads to know which
			# backups exist. It was held back from the transfer on purpose, so
			# it goes over only now — after the data has landed AND verified.
			# Copying it with the rest would let a sync that died halfway leave
			# the offsite host advertising backups that never arrived.
			local _sched_name=""
			local _sched_pushed=0
			for _sched_name in daily weekly monthly once custom; do
				local _local_sched="$vm_base_dir/$_sched_name/scheduler"
				[[ -f "$_local_sched" ]] || continue
				if scp -q -o BatchMode=yes -o ConnectTimeout=15 "$_local_sched" \
					"${remote_user}@${oip}:${remote_vm_dir}/${_sched_name}/scheduler" \
					2>/dev/null; then
					_sched_pushed=$((_sched_pushed + 1))
				else
					echo "⚠ Could not copy the $_sched_name scheduler ledger to $oip"
				fi
			done
			if [[ "$_sched_pushed" -gt 0 ]]; then
				echo "✓ Published $_sched_pushed scheduler ledger(s) to $oip"
				offsite_emit "offsite_scheduler_published" "success" \
					"Published $_sched_pushed scheduler ledger(s)" "count=$_sched_pushed"
			fi

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
			local _fail_reason="rsync transfer failed after $rsync_max_attempts attempt(s)"
			[[ -n "$verify_reason" ]] && _fail_reason="$verify_reason after $rsync_max_attempts attempt(s)"

			write_progress 0 "0B/s" "0B" "0:00:00" "failed"
			offsite_emit "offsite_rsync_fail" "error" \
				"$_fail_reason" \
				"duration_seconds=$rsync_duration" "attempts=$rsync_max_attempts"
			rm -f "$offsite_lock"
			echo "FAILED|$_fail_reason" >"$status_file"
			return 1
		fi

	} >>"$offsite_log" 2>&1
}

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
			scanning)
				host_color="$Yellow"
				host_icon="⋯"
				;;
			verifying)
				host_color="$Cyan"
				host_icon="⌕"
				hosts_syncing=$((hosts_syncing + 1))
				;;
			busy)
				host_color="$Dim"
				host_icon="⏸"
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
			elif [[ "$pstatus" == "scanning" ]]; then
				# rsync reports nothing while the file list is built.
				# Say so, with the clock running, instead of showing a
				# bar stuck at 0% that reads as a hung transfer.
				bar_label=$(printf "building file list%s" "${eta:+ (${eta})}")
			elif [[ "$pstatus" == "verifying" ]]; then
				bar_label="verifying destination"
			elif [[ "$pstatus" == "busy" ]]; then
				bar_label="already syncing elsewhere"
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

		# This is what the panel shows for the rsync job.
		write_rsync_progress "$overall_pct" \
			"Offsite sync: $hosts_syncing syncing, $hosts_done done, $hosts_failed failed"

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

offsite_sync() {
	# Both guards run before anything else, because everything after this point
	# tells each target to make itself match the source, and --delete carries
	# that out literally.
	#
	# Mountedness first: an unmounted pool usually also looks empty, and "the
	# pool is not mounted" is the answer that tells the operator what to do.
	if ! verify_source_mounted; then
		return 1
	fi

	# If retention is mid-rotation, wait it out before doing anything else. The
	# emptiness check below would otherwise read a directory that is halfway
	# between two layouts, and every target would start from a file list of a
	# tree that never existed.
	wait_for_rotation

	if ! source_has_backup_data; then
		echo ""
		echo -e "${Red}${CROSS} REFUSING TO SYNC: $vm_base_dir holds no backup data.${NC}"
		echo -e "${Red}   Replicating an empty source would delete this VM's backups from every${NC}"
		echo -e "${Red}   offsite host. If the pool is unmounted or the path is wrong, fix that${NC}"
		echo -e "${Red}   first; if the VM genuinely has no backups, there is nothing to sync.${NC}"
		echo ""
		emit_event "offsite_source_empty" "error" \
			"Refused to sync: source directory holds no backup data" \
			"source=$vm_base_dir"
		return 1
	fi

	echo ""
	echo -e "${Bold}╔══════════════════════════════════════════════════════════════╗${NC}"
	echo -e "${Bold}║              OFFSITE SYNC                                    ║${NC}"
	echo -e "${Bold}╚══════════════════════════════════════════════════════════════╝${NC}"
	echo ""

	# One offsite run per VM at a time, across every target. Taken before any
	# work so a second rsync job stands down immediately rather than racing the
	# first one target by target. Released in cleanup_on_exit.
	if ! acquire_rsync_lock; then
		return "$EXIT_RSYNC_BUSY"
	fi

	emit_event "offsite_start" "in_progress" "Starting offsite sync"

	local offsite_pids=()
	local offsite_logs=()
	local offsite_status_files=()
	local offsite_host_list=()
	local offsite_skipped=()
	local offsite_progress_files=()

	parse_offsite_targets offsite_host_list

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
		# Also recorded outside this function: the signal handler has to be able
		# to reach these, and it does not run in this scope.
		OFFSITE_WORKER_PIDS+=($!)
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
		elif [[ "$ostatus" == "BUSY" ]]; then
			# Someone else is already replicating this VM to this target. That
			# is the lock doing its job, not an incident: no warning, no
			# notification, and no retry budget spent. Whoever holds the lock
			# reports the outcome.
			info "Offsite sync to $oip — already in progress elsewhere, skipped"
			emit_event "offsite_host_busy" "info" \
				"Sync to $oip skipped: already running" \
				"offsite_ip=$oip" "offsite_path=$opath" "reason=$oreason"
		else
			echo -e "${Red}${CROSS} Offsite sync to $oip — FAILED${NC}"
			echo -e "${Dim}  Log: $offsite_log${NC}"
			emit_event "offsite_host_fail" "error" "Sync to $oip failed: $oreason" \
				"offsite_ip=$oip" "offsite_path=$opath" "reason=$oreason"
			all_success=false
		fi
	done

	rm -rf "$progress_dir" 2>/dev/null

	# Drop the per-target panel files; the aggregate below is the last word.
	local _cleanup_ip=""
	for _cleanup_ip in "${offsite_host_list[@]}"; do
		rm -f "$progress_metadata_dir/${vm_name}_offsite_${_cleanup_ip}.progress" 2>/dev/null
	done

	# Every target that reached this point has replayed the rotations it owed,
	# so entries all of them have passed can go.
	trim_offsite_ops_journal

	if [[ ${#offsite_skipped[@]} -gt 0 ]]; then
		all_success=false
	fi

	echo ""
	if [[ "$all_success" == "true" ]]; then
		write_rsync_progress 100 "Offsite sync complete"
		info "All offsite syncs completed successfully."
		emit_event "offsite_complete" "success" "All offsite syncs completed"
		return 0
	else
		write_rsync_progress 100 "Offsite sync finished with failures"
		warn "Some offsite syncs failed or were skipped. Check logs."
		emit_event "offsite_complete" "warning" "Some offsite syncs failed" \
			"skipped=${#offsite_skipped[@]}" "total=${#offsite_host_list[@]}"
		# Non-zero so --offsite-only callers can tell the resync wasn't fully
		# successful. Existing callers (post-backup sync) never check this
		# return value — one calls it bare, the other with `|| true` — so this
		# is safe to change without touching the normal backup flow.
		return 1
	fi
}

###############################################################################
# CHECK-ONLY MODE
#
# Answers "is every offsite target holding exactly what this VM's backup
# directory holds?" without moving a byte. This is what the replication check
# runs on a schedule: it flags VMs whose replication has fallen behind, so a
# sync can be started for them, and it is safe to run at any time because it
# only reads.
#
# A VM with a sync already in progress is skipped rather than reported. Its
# destination is mid-update by definition, so any answer would be about a moving
# target — and whoever holds the lock will report the real outcome.
###############################################################################

run_check_only() {
	local hosts=()
	parse_offsite_targets hosts
	[[ ${#hosts[@]} -gt 0 ]] || die "No valid offsite target in --offsite-ip."

	# A check against an unmounted pool would report every target as wildly out
	# of sync — and with auto-sync on, that verdict is what would queue the
	# transfers. Report the real cause instead, as its own state, so the panel
	# says "the pool is not mounted" rather than "replication has fallen behind".
	if ! verify_source_mounted; then
		printf '{"vm":"%s","checked":false,"reason":"source_unavailable","targets":[]}\n' "$vm_name"
		exit 1
	fi

	# Comparing against a half-rotated source would report the whole chain as
	# differing and — with auto-sync on — that verdict is what queues transfers.
	# A rotation takes seconds; wait for it and answer about a real layout.
	wait_for_rotation

	# A rotation the target has not replayed yet is reported by the check as
	# pending work rather than as a difference, so a source that rotated between
	# the wait and here still reads correctly.

	if [[ -f "$rsync_lock_file" ]] && _rsync_lock_owner_alive "$rsync_lock_file"; then
		local owner=""
		owner=$(_rsync_lock_owner_desc "$rsync_lock_file")
		info "A sync for $vm_name is in progress ($owner) — skipping the check."
		emit_event "offsite_check_skipped" "info" \
			"Sync in progress; check skipped" "owner=$owner"
		printf '{"vm":"%s","checked":false,"reason":"sync_in_progress","targets":[]}\n' "$vm_name"
		exit "$EXIT_RSYNC_BUSY"
	fi

	echo ""
	echo -e "${Bold}╔══════════════════════════════════════════════════════════════╗${NC}"
	echo -e "${Bold}║              OFFSITE REPLICATION CHECK                       ║${NC}"
	echo -e "${Bold}╚══════════════════════════════════════════════════════════════╝${NC}"
	echo ""
	emit_event "offsite_check_start" "in_progress" "Checking ${#hosts[@]} target(s)"

	local out_of_sync=0
	local unreachable=0
	local json_targets=""
	local oip=""

	for oip in "${hosts[@]}"; do
		local remote_base="${OFFSITE_PATH_BY_IP[$oip]:-}"
		[[ -z "$remote_base" ]] && remote_base="$backup_path"
		local remote_vm_dir="$remote_base/$vm_name"

		echo -e "${Dim}  Checking $oip ...${NC}"

		if ! ssh -o BatchMode=yes -o ConnectTimeout=10 "root@$oip" exit &>/dev/null; then
			echo -e "${Red}${CROSS} $oip — unreachable${NC}"
			emit_event "offsite_check_target" "error" "Unreachable" \
				"offsite_ip=$oip" "offsite_path=$remote_base" "state=unreachable"
			json_targets+="${json_targets:+,}$(printf '{"ip":"%s","path":"%s","state":"unreachable","differences":null}' "$oip" "$remote_base")"
			unreachable=$((unreachable + 1))
			continue
		fi

		local pending=0
		pending=$(pending_offsite_ops_count "$oip")

		if verify_offsite_target "$oip" "root" "$remote_vm_dir" "$log_file_path"; then
			if [[ "$pending" -gt 0 ]]; then
				# The data matches, but rotations this target has not replayed
				# are still owed. Left alone, the next sync would replay them
				# against an already-correct tree; harmless, but the target is
				# not finished with, so do not call it in sync.
				echo -e "${Yellow}${WARNING} $oip — in sync, $pending rotation(s) still to replay${NC}"
				emit_event "offsite_check_target" "warning" "$pending rotation(s) pending" \
					"offsite_ip=$oip" "offsite_path=$remote_base" "state=pending_rotations" \
					"pending=$pending"
				json_targets+="${json_targets:+,}$(printf '{"ip":"%s","path":"%s","state":"pending_rotations","differences":0,"pendingRotations":%d}' "$oip" "$remote_base" "$pending")"
				out_of_sync=$((out_of_sync + 1))
			else
				info "$oip — in sync"
				emit_event "offsite_check_target" "success" "In sync" \
					"offsite_ip=$oip" "offsite_path=$remote_base" "state=in_sync"
				json_targets+="${json_targets:+,}$(printf '{"ip":"%s","path":"%s","state":"in_sync","differences":0,"pendingRotations":0}' "$oip" "$remote_base")"
			fi
			continue
		fi

		echo -e "${Yellow}${WARNING} $oip — ${_offsite_verify_count} file(s) differ${NC}"
		printf '%s\n' "$_offsite_verify_diff" | head -20
		emit_event "offsite_check_target" "warning" "${_offsite_verify_count} file(s) differ" \
			"offsite_ip=$oip" "offsite_path=$remote_base" "state=out_of_sync" \
			"differences=$_offsite_verify_count" "pending=$pending"
		json_targets+="${json_targets:+,}$(printf '{"ip":"%s","path":"%s","state":"out_of_sync","differences":%d,"pendingRotations":%d}' "$oip" "$remote_base" "$_offsite_verify_count" "$pending")"
		out_of_sync=$((out_of_sync + 1))
	done

	echo ""
	local overall="in_sync"
	if [[ "$out_of_sync" -gt 0 ]]; then
		overall="out_of_sync"
	elif [[ "$unreachable" -gt 0 ]]; then
		overall="unreachable"
	fi

	emit_event "offsite_check_complete" \
		"$(if [[ "$overall" == "in_sync" ]]; then echo success; else echo warning; fi)" \
		"Check complete: $overall" \
		"out_of_sync=$out_of_sync" "unreachable=$unreachable" "targets=${#hosts[@]}"

	# One machine-readable line on stdout for the caller. Printed last so it is
	# the final line of output regardless of how much the check logged.
	printf '{"vm":"%s","checked":true,"state":"%s","outOfSync":%d,"unreachable":%d,"targets":[%s]}\n' \
		"$vm_name" "$overall" "$out_of_sync" "$unreachable" "$json_targets"

	if [[ "$out_of_sync" -gt 0 ]]; then
		exit "$EXIT_OUT_OF_SYNC"
	fi
	if [[ "$unreachable" -gt 0 ]]; then
		exit 1
	fi
	exit 0
}

###############################################################################
# CLEANUP AND SIGNAL HANDLING
###############################################################################

CLEANUP_IN_PROGRESS=false

# Per-target transfer workers, so the exit and signal paths can stop them.
#
# Each target is synced by a background subshell, and a background subshell does
# NOT die with the script: it is not in the foreground process group, so the
# SIGHUP that ends a closing terminal never reaches it, and a SIGTERM delivered
# to the script alone leaves it running. Without this, stopping the job — an
# agent restart tearing down the process tree, an operator's Ctrl-C, the tmux
# pane closing — left rsync transferring on, orphaned and invisible: no tmux
# session to attach to, no monitor reporting it, and, because the exit path
# released the VM lock on the way out, nothing to stop a second job from
# starting a competing transfer to the same target.
OFFSITE_WORKER_PIDS=()

_stop_offsite_workers() {
	[[ "${#OFFSITE_WORKER_PIDS[@]}" -gt 0 ]] || return 0
	local pid=""
	local alive="false"
	for pid in "${OFFSITE_WORKER_PIDS[@]}"; do
		kill -0 "$pid" 2>/dev/null || continue
		alive="true"
		_kill_process_tree "$pid" TERM
	done
	[[ "$alive" == "true" ]] || return 0

	# rsync closes its partial file and gets out on SIGTERM; give it that
	# chance before insisting, so the staging file it leaves behind is one a
	# later run can resume from.
	sleep 2
	for pid in "${OFFSITE_WORKER_PIDS[@]}"; do
		kill -0 "$pid" 2>/dev/null || continue
		_kill_process_tree "$pid" KILL
	done
	OFFSITE_WORKER_PIDS=()
	return 0
}

cleanup_on_exit() {
	local exit_code=$?
	if [[ "$CLEANUP_IN_PROGRESS" == "true" ]]; then
		return 0
	fi
	CLEANUP_IN_PROGRESS=true

	# Before the lock, always: releasing it while a worker is still transferring
	# advertises the VM as free and invites a second, competing rsync to the
	# same destination.
	_stop_offsite_workers

	# Release the VM-level lock. If the process dies hard enough that this never
	# runs (SIGKILL, power loss), the next run finds a dead PID and a missing
	# tmux session and reclaims it — which is why the lock records both.
	release_rsync_lock

	# Nothing else needs undoing. A killed transfer leaves its partially copied
	# file staged inside .rsync-partial, never under its real name, so the
	# destination is never left holding a truncated file that looks complete,
	# and the next run resumes from exactly there.
	if [[ "$exit_code" -ne 0 && "$exit_code" -ne "$EXIT_RSYNC_BUSY" ]]; then
		write_rsync_progress 100 "Offsite sync ended (exit $exit_code)"
	fi
	return 0
}

handle_signal() {
	local sig="$1"
	echo ""
	warn "Received $sig — stopping the offsite sync."
	emit_event "job_cancelled" "warning" "Interrupted by $sig"
	write_rsync_progress 0 "Offsite sync cancelled"
	# The transfers first. "Stopping the offsite sync" has to mean the rsyncs
	# stop too, not just the script that was watching them.
	_stop_offsite_workers
	release_rsync_lock
	exit 130
}

trap cleanup_on_exit EXIT
trap 'handle_signal SIGTERM' TERM
trap 'handle_signal SIGINT' INT
trap 'handle_signal SIGHUP' HUP

###############################################################################
# MAIN
###############################################################################

main() {
	cleanup_old_logs

	local start_time=0
	start_time=$(date +%s)

	echo ""
	echo -e "${Bold}╔══════════════════════════════════════════════════════════════╗${NC}"
	echo -e "${Bold}║           OFFSITE SYNC — $(date '+%Y-%m-%d %H:%M:%S')                ║${NC}"
	echo -e "${Bold}╠══════════════════════════════════════════════════════════════╣${NC}"
	printf "${Bold}║${NC}  %-14s %s\n" "Domain:" "$vm_name"
	printf "${Bold}║${NC}  %-14s %s\n" "Source:" "$vm_base_dir"
	printf "${Bold}║${NC}  %-14s %s\n" "Targets:" "$offsite_ips"
	printf "${Bold}║${NC}  %-14s %s\n" "Verify:" "$(if [[ "$offsite_verify" == "true" ]]; then echo "enabled"; else echo "SKIP"; fi)"
	printf "${Bold}║${NC}  %-14s %s\n" "Job:" "${rsync_job_id:-<none>}"
	printf "${Bold}║${NC}  %-14s %s\n" "Log:" "$log_file_path"
	printf "${Bold}║${NC}  %-14s %s\n" "Events:" "$events_file"
	echo -e "${Bold}╚══════════════════════════════════════════════════════════════╝${NC}"
	echo ""

	if [[ "$check_only" == "true" ]]; then
		run_check_only
		# run_check_only always exits.
	fi

	emit_event "job_start" "in_progress" "Offsite sync started"
	write_rsync_progress 0 "Offsite sync starting"

	local rc=0
	offsite_sync || rc=$?

	local end_time=0
	end_time=$(date +%s)
	local duration=$((end_time - start_time))

	if [[ "$rc" -eq 0 ]]; then
		echo ""
		echo -e "${Green}${Bold}╔══════════════════════════════════════════════════════════════╗${NC}"
		echo -e "${Green}${Bold}║  ${CHECK} OFFSITE SYNC COMPLETED                                 ║${NC}"
		echo -e "${Green}${Bold}╠══════════════════════════════════════════════════════════════╣${NC}"
		printf "${Green}${Bold}║${NC}  %-14s %s\n" "Domain:" "$vm_name"
		printf "${Green}${Bold}║${NC}  %-14s %s\n" "Duration:" "$(format_duration $duration)"
		printf "${Green}${Bold}║${NC}  %-14s %s\n" "Finished:" "$(date '+%Y-%m-%d %H:%M:%S')"
		echo -e "${Green}${Bold}╚══════════════════════════════════════════════════════════════╝${NC}"
		echo ""
		emit_event "job_complete" "success" "Offsite sync completed in $(format_duration $duration)" \
			"duration_seconds=$duration"
		cleanup_rsync_progress
	elif [[ "$rc" -eq "$EXIT_RSYNC_BUSY" ]]; then
		echo ""
		warn "Another offsite sync for $vm_name is already running — nothing to do."
		emit_event "job_busy" "info" "Another offsite sync for this VM is already running" \
			"duration_seconds=$duration"
	else
		echo ""
		echo -e "${Red}${CROSS} Offsite sync FAILED after $(format_duration $duration)${NC}"
		echo -e "${Red}${CROSS} Log: $log_file_path${NC}"
		emit_event "job_fail" "error" "Offsite sync failed after $(format_duration $duration)" \
			"duration_seconds=$duration"
	fi

	exit "$rc"
}

main "$@"
