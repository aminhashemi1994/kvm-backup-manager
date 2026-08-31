#!/usr/bin/env bash
#
# Full simulation: the REAL rotation code from Backup_Manager.sh running against
# a REAL transfer from Rsync_Manager.sh, at the same time.
#
# The sibling test (rotation_during_sync) drives a hand-written stand-in for the
# rotation. That proves the sync copes with a directory being rearranged, but it
# cannot prove the two scripts agree — that the fence the backup raises is the
# one the sync waits on, that the journal line the backup writes is the one the
# sync can parse, that the destination field round-trips. A stand-in that drifts
# from the real thing tests nothing.
#
# So the mutators are lifted out of Backup_Manager.sh by name and executed
# unmodified: handle_retention, archive_current_chain, prune_archives,
# quarantine_broken_chain, record_offsite_op and the fence. Extraction asserts on
# a rename, so if any of them moves this suite fails loudly rather than quietly
# testing an empty file.
#
# What cannot run here is virtnbdbackup itself — it needs a hypervisor. Its
# observable behaviour is reproduced instead: data written to <name>.partial and
# renamed to <name> only once complete, which is precisely what makes it safe to
# replicate a VM while a backup of it is running.
#
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BACKUP_SCRIPT="$HERE/../Backup_Manager.sh"
RSYNC_SCRIPT="$HERE/../Rsync_Manager.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
export BACKUP_MANAGER_STATE_DIR="$TMP/state"
export OFFSITE_ROTATION_WAIT_SECS=6

PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); echo "  ok  - $1"; }
no(){ FAIL=$((FAIL+1)); echo "  NOT OK - $1"; }
chk(){ if [[ "$2" == "$3" ]]; then ok "$1"; else no "$1 (got '$2' want '$3')"; fi; }

# ── Lift the real mutators out of Backup_Manager.sh ─────────────────────────
python3 - "$BACKUP_SCRIPT" "$TMP/rotators.sh" <<'PYX'
import io, re, sys
src, out = sys.argv[1], sys.argv[2]
s = io.open(src, encoding="utf-8").read()
want = ["has_any_backup_data", "record_offsite_op",
        "rotation_fence_up", "rotation_fence_down",
        "archive_current_chain", "prune_archives",
        "quarantine_broken_chain", "handle_retention"]
buf = []
for name in want:
    m = re.search(r'^' + re.escape(name) + r'\(\) \{\n(.*?)^\}\n', s, re.M | re.S)
    assert m, "could not extract %s from %s" % (name, src)
    buf.append(m.group(0))
io.open(out, "w", encoding="utf-8").write("\n".join(buf))
PYX

# ── ssh/scp stubs: real rsync, no network ───────────────────────────────────
mkdir -p "$TMP/bin"
cat >"$TMP/bin/ssh" <<'SSHEOF'
#!/bin/bash
while [[ $# -gt 0 ]]; do
	case "$1" in
	-o | -p | -i | -l | -F) shift 2 ;;
	-*) shift ;;
	*) shift; break ;;
	esac
done
[[ $# -eq 0 ]] && exit 0
exec bash -c "$*"
SSHEOF
cat >"$TMP/bin/scp" <<'SCPEOF'
#!/bin/bash
args=()
while [[ $# -gt 0 ]]; do
	case "$1" in
	-o | -P | -i) shift 2 ;;
	-*) shift ;;
	*) args+=("$1"); shift ;;
	esac
done
dst="${args[-1]}"; unset 'args[-1]'
exec cp "${args[@]}" "${dst#*:}"
SCPEOF
chmod +x "$TMP/bin/ssh" "$TMP/bin/scp"
export PATH="$TMP/bin:$PATH"

# ── The globals Backup_Manager.sh's mutators read ───────────────────────────
POOL="$TMP/pool"; REMOTE="$TMP/remote"
vm_name=simvm
vm_base_dir="$POOL/$vm_name"
archived_backup_dir="$vm_base_dir/archived"
rotation_marker="$vm_base_dir/.rotation-in-progress"
offsite_ops_journal="$vm_base_dir/.offsite_ops.jsonl"
schedule=daily
backup_dir="$vm_base_dir/daily"
log_dir="$backup_dir/logs"
retention=7
archives_to_keep=2
method=inc
_archived_this_run=""
_pruned_archives=()
_rotation_fence_depth=0

# Backup_Manager.sh sets these at the top with `: "${Dim:=...}"`; the extracted
# functions print with them, and under `set -u` an undefined one kills the shell
# mid-rotation — which is exactly how this was found.
: "${Red:=}" "${Green:=}" "${Yellow:=}" "${Blue:=}" "${Cyan:=}"
: "${Bold:=}" "${Dim:=}" "${NC:=}" "${CROSS:=x}" "${CHECK:=+}" "${WARNING:=!}"

info(){ :; }
warn(){ :; }
emit_event(){ :; }
# handle_retention asks how many backups the chain holds; the real counter walks
# a scheduler ledger this simulation has no reason to maintain.
_forced_count=0
count_existing_backups(){ echo "$_forced_count"; }

mkdir -p "$backup_dir" "$log_dir" "$archived_backup_dir" "$vm_base_dir/weekly" "$REMOTE"
source "$TMP/rotators.sh"

sync_vm() { bash "$RSYNC_SCRIPT" --domain "$vm_name" --backup-path "$POOL" \
	--offsite-ip "127.0.0.1:$REMOTE" 2>&1; }

inode_of(){ stat -c %i "$1" 2>/dev/null || echo missing; }
inodes_in(){ for f in "$1"/*.data; do inode_of "$f"; done 2>/dev/null | sort | tr '\n' ' '; }
target_events(){ cat "$vm_base_dir/offsite_logs/"*_offsite_*.events.jsonl 2>/dev/null; }

PROG="$POOL/.progress/${vm_name}_offsite_127.0.0.1.progress"
# Block until the sync reports bytes actually moving, so whatever happens next
# is guaranteed to land after rsync has built its file list — the window that
# matters — rather than before or after the transfer.
await_transfer() {
	local i
	for i in $(seq 1 900); do
		[[ -f "$PROG" ]] && grep -q '@' "$PROG" 2>/dev/null && return 0
		sleep 0.05
	done
	return 1
}

make_chain(){
	local dir="$1" n="$2" size="${3:-300000}"
	mkdir -p "$dir"
	head -c "$size" /dev/urandom >"$dir/$vm_name.full.data"
	local i
	for ((i = 1; i < n; i++)); do head -c "$size" /dev/urandom >"$dir/$vm_name.inc.$i.data"; done
	printf 'Day\tDate\tMethod\n' >"$dir/scheduler"
}

echo "== the extracted code is the real thing =="
chk "handle_retention came from Backup_Manager.sh" \
	"$(type -t handle_retention)" "function"
chk "so did archive_current_chain" "$(type -t archive_current_chain)" "function"
chk "and the fence" "$(type -t rotation_fence_up)" "function"

echo "== baseline: a seven-backup chain is replicated =="
make_chain "$backup_dir" 7
chk "sync succeeds" "$(sync_vm >/dev/null 2>&1; echo $?)" "0"
chk "the whole chain landed" \
	"$(find "$REMOTE/$vm_name/daily" -name "$vm_name.*.data" | wc -l)" "7"

echo "== retention fires DURING a live transfer =="
before=$(inodes_in "$REMOTE/$vm_name/daily")
# Enough new data that the transfer is unmistakably in flight.
head -c 200000000 /dev/urandom >"$backup_dir/$vm_name.inc.8.data"
rm -f "$vm_base_dir/offsite_logs/"*_offsite_* "$PROG" 2>/dev/null

_forced_count=7   # retention reached — the real handle_retention will rotate
rm -f "$TMP/archived_name"
( await_transfer && handle_retention && echo "$_archived_this_run" >"$TMP/archived_name" ) &
ROT=$!
rc=$(sync_vm >/dev/null 2>&1; echo $?)
wait "$ROT" 2>/dev/null
archived_name=$(cat "$TMP/archived_name" 2>/dev/null)

chk "the sync still succeeds" "$rc" "0"
chk "retention actually rotated" \
	"$([[ -n "$archived_name" ]] && echo y || echo n)" "y"
chk "the fence was lowered again" \
	"$([[ -f "$rotation_marker" ]] && echo up || echo down)" "down"
chk "the sync noticed the rotation" \
	"$(target_events | grep -c offsite_rotation_restart | awk '{print ($1>0)?"y":"n"}')" "y"

ARCH="$REMOTE/$vm_name/archived/$archived_name"
after=$(inodes_in "$ARCH")
chk "the whole chain is under the new archive offsite" "$(echo $after | wc -w)" "8"
chk "daily/ is empty offsite, matching the source" \
	"$(find "$REMOTE/$vm_name/daily" -name "$vm_name.*.data" 2>/dev/null | wc -l)" "0"
carried=0; for i in $before; do [[ " $after " == *" $i "* ]] || carried=$((carried+1)); done
chk "not one already-replicated file was re-uploaded" "$carried" "0"

echo "== a backup writing into the chain during a transfer =="
# virtnbdbackup writes <name>.partial and renames it only when the file is
# complete. That rename is what makes concurrent replication safe, so it is
# reproduced exactly: written mid-transfer, finalised mid-transfer.
make_chain "$backup_dir" 3
sync_vm >/dev/null 2>&1
head -c 150000000 /dev/urandom >"$backup_dir/$vm_name.inc.9.data"
rm -f "$vm_base_dir/offsite_logs/"*_offsite_* "$PROG" 2>/dev/null
(
	await_transfer || exit 0
	head -c 400000 /dev/urandom >"$backup_dir/$vm_name.inc.10.data.partial"
	sleep 0.3
	mv "$backup_dir/$vm_name.inc.10.data.partial" "$backup_dir/$vm_name.inc.10.data"
) &
WR=$!
rc=$(sync_vm >/dev/null 2>&1; echo $?)
wait "$WR" 2>/dev/null

chk "the sync succeeds alongside a running backup" "$rc" "0"
chk "no .partial ever reached the offsite host" \
	"$(find "$REMOTE/$vm_name" -name '*.partial' 2>/dev/null | wc -l)" "0"
chk "the finished backup is intact locally" \
	"$([[ -f "$backup_dir/$vm_name.inc.10.data" ]] && echo y || echo n)" "y"
# It either arrived in this pass or is picked up by the next; both are correct,
# and the next pass must settle it.
sync_vm >/dev/null 2>&1
chk "and the next sync has it offsite" \
	"$([[ -f "$REMOTE/$vm_name/daily/$vm_name.inc.10.data" ]] && echo y || echo n)" "y"
chk "source and destination agree" \
	"$(bash "$RSYNC_SCRIPT" --domain "$vm_name" --backup-path "$POOL" \
		--offsite-ip "127.0.0.1:$REMOTE" --check-only >/dev/null 2>&1; echo $?)" "0"

echo "== a quarantine DURING a live transfer =="
# quarantine_broken_chain empties the schedule directory without deleting
# anything. Unjournalled that would make the next sync delete the offsite copy
# of a chain just found broken — when the offsite copy is the one worth keeping.
make_chain "$backup_dir" 4
sync_vm >/dev/null 2>&1
before=$(inodes_in "$REMOTE/$vm_name/daily")
head -c 150000000 /dev/urandom >"$backup_dir/$vm_name.inc.11.data"
sync_vm >/dev/null 2>&1
before=$(inodes_in "$REMOTE/$vm_name/daily")
head -c 150000000 /dev/urandom >"$backup_dir/$vm_name.inc.12.data"
rm -f "$vm_base_dir/offsite_logs/"*_offsite_* "$PROG" 2>/dev/null

( await_transfer && quarantine_broken_chain "$backup_dir" ) &
Q=$!
rc=$(sync_vm >/dev/null 2>&1; echo $?)
wait "$Q" 2>/dev/null

chk "the sync succeeds" "$rc" "0"
QDIR=$(find "$REMOTE/$vm_name/.broken" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | head -1)
chk "the quarantined chain exists offsite" "$([[ -n "$QDIR" ]] && echo y || echo n)" "y"
qafter=$(inodes_in "$QDIR")
carried=0; for i in $before; do [[ " $qafter " == *" $i "* ]] || carried=$((carried+1)); done
chk "and it was moved there, not deleted and re-sent" "$carried" "0"
chk "nothing was lost: every source file has a counterpart" \
	"$(missing=0; while IFS= read -r f; do rel="${f#"$vm_base_dir/"}"; \
	   [[ -f "$REMOTE/$vm_name/$rel" ]] || missing=$((missing+1)); done \
	   < <(find "$vm_base_dir" -type f -name "$vm_name.*.data"); echo $missing)" "0"

echo "== pruning old archives, driven by the real prune_archives =="
for _round in 1 2 3; do
	make_chain "$backup_dir" 2
	_forced_count=7
	handle_retention >/dev/null 2>&1
	# Archive names are stamped to the second; real rotations are a retention
	# cycle apart, so give each one its own second rather than having three
	# land in the same directory.
	sleep 1
done
chk "prune_archives dropped the oldest" \
	"$([[ ${#_pruned_archives[@]} -gt 0 ]] && echo y || echo n)" "y"
chk "sync succeeds" "$(sync_vm >/dev/null 2>&1; echo $?)" "0"
pruned="${_pruned_archives[0]:-}"
chk "the pruned archive is gone offsite too" \
	"$([[ -d "$REMOTE/$vm_name/archived/$pruned" ]] && echo present || echo gone)" "gone"
chk "local and offsite archive counts match" \
	"$(find "$REMOTE/$vm_name/archived" -mindepth 1 -maxdepth 1 -type d | wc -l)" \
	"$(find "$archived_backup_dir" -mindepth 1 -maxdepth 1 -type d | wc -l)"

echo "== the final word: the check agrees everything is in sync =="
chk "replication check reports in sync" \
	"$(bash "$RSYNC_SCRIPT" --domain "$vm_name" --backup-path "$POOL" \
		--offsite-ip "127.0.0.1:$REMOTE" --check-only >/dev/null 2>&1; echo $?)" "0"

echo
echo "passed: $PASS   failed: $FAIL"
[[ "$FAIL" -eq 0 ]]
