#!/usr/bin/env bash
#
# Rearranging the VM directory while a transfer of it is running.
#
# This is the interleaving that can turn offsite replication from cheap into
# ruinous, and in one case into data loss. rsync builds its file list once, at
# the start. If the backup then moves that chain somewhere else, every path in
# the list is gone; rebuilt naively, the destination's copy looks extraneous, so
# --delete removes the offsite chain and the identical bytes are uploaded again
# to their new home. On a real chain that is terabytes over the WAN.
#
# Three things move a chain, not one:
#
#   retention    daily/ → archived/<stamp>/     (handle_retention)
#   promotion    daily/ → archived/<stamp>/     (promote_chain_to_full, when an
#                                                incremental turns out to be
#                                                impossible — any schedule, any
#                                                time, not just on a rotation day)
#   quarantine   daily/ → .broken/<stamp>/      (quarantine_broken_chain)
#
# Quarantine is the one that can destroy data: it empties the schedule directory
# without deleting anything, and an unrecorded emptying makes the next sync
# delete the offsite copy of a chain that was just found broken locally — at the
# exact moment the offsite copy is the one worth keeping.
#
# All three are journalled and fenced, and these tests drive the real script
# against a real rsync through an ssh stub to prove it.
#
set -uo pipefail
SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/Rsync_Manager.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
export BACKUP_MANAGER_STATE_DIR="$TMP/state"
export OFFSITE_ROTATION_WAIT_SECS=6

PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); echo "  ok  - $1"; }
no(){ FAIL=$((FAIL+1)); echo "  NOT OK - $1"; }
chk(){ if [[ "$2" == "$3" ]]; then ok "$1"; else no "$1 (got '$2' want '$3')"; fi; }

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

POOL="$TMP/pool"; REMOTE="$TMP/remote"
VM=rotvm
VMDIR="$POOL/$VM"
JOURNAL="$VMDIR/.offsite_ops.jsonl"
FENCE="$VMDIR/.rotation-in-progress"
mkdir -p "$VMDIR/daily" "$VMDIR/weekly" "$VMDIR/archived" "$REMOTE"

sync_vm() { bash "$SCRIPT" --domain "$VM" --backup-path "$POOL" \
	--offsite-ip "127.0.0.1:$REMOTE" "$@" 2>&1; }

# A remote `mv` keeps the inode; a re-upload creates a new file with a new one.
# So an unchanged inode across a rotation is proof the data never crossed the
# wire a second time. This is the measurement the whole design turns on.
inode_of() { stat -c %i "$1" 2>/dev/null || echo missing; }
inodes_in() { for f in "$1"/*.data; do inode_of "$f"; done 2>/dev/null | sort | tr '\n' ' '; }

# Per-target workers log to their own files, not to the script's stdout.
target_events() { cat "$VMDIR/offsite_logs/"*_offsite_*.events.jsonl 2>/dev/null; }

# The journal entry each mover writes, in the same shape Backup_Manager.sh uses.
journal_append() {
	local op="$1" name="$2" dest="$3" sched="$4"
	# Mirrors record_offsite_op: the id is the clock, so it survives the journal
	# being trimmed, wiped, or restored from an older copy — none of which a
	# counter derived from the journal's own contents does.
	local seq=""
	seq=$(date +%s%N 2>/dev/null)
	[[ "$seq" =~ ^[0-9]{19}$ ]] || seq="$(date +%s)000000000"
	printf '{"seq":%s,"op":"%s","name":"%s","dest":"%s","schedule":"%s","ts":"x"}\n' \
		"$seq" "$op" "$name" "$dest" "$sched" >>"$JOURNAL"
}

# What archive_current_chain does, for any schedule.
rotate() {
	local sched="$1" name="$2" dest="${3:-archived}"
	: >"$FENCE"
	mkdir -p "$VMDIR/$dest/$name"
	find "$VMDIR/$sched" -mindepth 1 -maxdepth 1 ! -name logs \
		-exec mv {} "$VMDIR/$dest/$name/" \; 2>/dev/null
	journal_append archive "$name" "$dest" "$sched"
	rm -f "$FENCE"
}

make_chain() {
	local sched="$1" n="$2" size="${3:-300000}"
	mkdir -p "$VMDIR/$sched"
	head -c "$size" /dev/urandom >"$VMDIR/$sched/$VM.full.data"
	local i=0
	for ((i = 1; i < n; i++)); do
		head -c "$size" /dev/urandom >"$VMDIR/$sched/$VM.inc.$i.data"
	done
	printf 'Day\tDate\tMethod\n' >"$VMDIR/$sched/scheduler"
}

echo "== baseline: a daily chain is replicated =="
make_chain daily 8
chk "sync succeeds" "$(sync_vm >/dev/null 2>&1; echo $?)" "0"
chk "all eight files landed" "$(find "$REMOTE/$VM/daily" -name "$VM.*.data" | wc -l)" "8"

echo "== retention rotates daily: replayed as a rename, not re-sent =="
before=$(inodes_in "$REMOTE/$VM/daily")
rotate daily "2026-01-01_daily" archived
make_chain daily 1
chk "sync succeeds" "$(sync_vm >/dev/null 2>&1; echo $?)" "0"
after=$(inodes_in "$REMOTE/$VM/archived/2026-01-01_daily")
carried=0; for i in $before; do [[ " $after " == *" $i "* ]] || carried=$((carried+1)); done
chk "every archived file is the same file, moved" "$carried" "0"
chk "daily/ holds only the new chain" \
	"$(find "$REMOTE/$VM/daily" -name "$VM.*.data" | wc -l)" "1"

echo "== the same holds for weekly — this is not a daily-only path =="
make_chain weekly 5
sync_vm >/dev/null 2>&1
before=$(inodes_in "$REMOTE/$VM/weekly")
chk "the weekly chain replicated" "$(echo $before | wc -w)" "5"
rotate weekly "2026-01-08_weekly" archived
chk "sync succeeds" "$(sync_vm >/dev/null 2>&1; echo $?)" "0"
after=$(inodes_in "$REMOTE/$VM/archived/2026-01-08_weekly")
carried=0; for i in $before; do [[ " $after " == *" $i "* ]] || carried=$((carried+1)); done
chk "every archived weekly file is the same file, moved" "$carried" "0"
chk "weekly/ is empty on the target" \
	"$(find "$REMOTE/$VM/weekly" -name "$VM.*.data" 2>/dev/null | wc -l)" "0"

echo "== a quarantined chain is MOVED offsite, never deleted =="
# quarantine_broken_chain empties the schedule directory without deleting
# anything. Unjournalled, the next sync would mirror that emptiness and destroy
# the offsite copy of a chain that was just found broken locally.
make_chain daily 4
sync_vm >/dev/null 2>&1
before=$(inodes_in "$REMOTE/$VM/daily")
chk "the chain to be quarantined is replicated" "$(echo $before | wc -w)" "4"
rotate daily "daily_2026-01-09_03-00-00" .broken
chk "sync succeeds" "$(sync_vm >/dev/null 2>&1; echo $?)" "0"
after=$(inodes_in "$REMOTE/$VM/.broken/daily_2026-01-09_03-00-00")
chk "all four files are still on the offsite host" "$(echo $after | wc -w)" "4"
carried=0; for i in $before; do [[ " $after " == *" $i "* ]] || carried=$((carried+1)); done
chk "and they are the same files, moved rather than re-sent" "$carried" "0"

echo "== pruning an archive removes it from the target too =="
journal_append prune "2026-01-01_daily" archived daily
rm -rf "$VMDIR/archived/2026-01-01_daily"
chk "sync succeeds" "$(sync_vm >/dev/null 2>&1; echo $?)" "0"
chk "the pruned archive is gone from the target" \
	"$([[ -d "$REMOTE/$VM/archived/2026-01-01_daily" ]] && echo present || echo gone)" "gone"

echo "== a rotation DURING the transfer is caught mid-flight =="
# Timed off the sync's own progress rather than a fixed delay, so the rotation
# is guaranteed to land after rsync has built its file list — the window the
# watchdog exists for — rather than before or after the transfer.
make_chain daily 6
sync_vm >/dev/null 2>&1
before=$(inodes_in "$REMOTE/$VM/daily")
head -c 200000000 /dev/urandom >"$VMDIR/daily/$VM.inc.9.data"
rm -f "$VMDIR/offsite_logs/"*_offsite_* 2>/dev/null

PROG="$POOL/.progress/${VM}_offsite_127.0.0.1.progress"
rm -f "$PROG"
(
	# Wait for rsync to report bytes actually moving, then rotate under it.
	for _ in $(seq 1 600); do
		[[ -f "$PROG" ]] && grep -q '@' "$PROG" 2>/dev/null && break
		sleep 0.05
	done
	rotate daily "2026-02-02_daily" archived
) &
ROTPID=$!
rc=$(sync_vm >/dev/null 2>&1; echo $?)
wait "$ROTPID" 2>/dev/null

chk "the sync still succeeds" "$rc" "0"
chk "it detected the rotation mid-transfer" \
	"$(target_events | grep -c offsite_rotation_restart | awk '{print ($1>0)?"y":"n"}')" "y"
after=$(inodes_in "$REMOTE/$VM/archived/2026-02-02_daily")
chk "the whole chain is under the new archive" "$(echo $after | wc -w)" "7"
chk "nothing was stranded in daily/" \
	"$(find "$REMOTE/$VM/daily" -name "$VM.*.data" 2>/dev/null | wc -l)" "0"
carried=0; for i in $before; do [[ " $after " == *" $i "* ]] || carried=$((carried+1)); done
chk "not one already-replicated file was re-uploaded" "$carried" "0"
[[ "$carried" -ne 0 ]] && { echo "     before: $before"; echo "     after:  $after"; }

echo "== the offsite copy is never absent while a rotation is applied =="
missing=0
while IFS= read -r f; do
	rel="${f#"$VMDIR/"}"
	[[ -f "$REMOTE/$VM/$rel" ]] || missing=$((missing + 1))
done < <(find "$VMDIR" -type f -name "$VM.*.data")
chk "every source file has a counterpart on the target" "$missing" "0"

echo "== a stale rotation fence does not block replication forever =="
: >"$FENCE"
start=$(date +%s)
out=$(sync_vm); rc=$?
elapsed=$(( $(date +%s) - start ))
rm -f "$FENCE"
chk "the sync still completes" "$rc" "0"
chk "it reported the fence as stale" \
	"$(grep -c 'stale' <<<"$out" | awk '{print ($1>0)?"y":"n"}')" "y"
chk "and it waited rather than hanging" \
	"$([[ "$elapsed" -ge "$OFFSITE_ROTATION_WAIT_SECS" ]] && echo y || echo n)" "y"

echo
echo "passed: $PASS   failed: $FAIL"
[[ "$FAIL" -eq 0 ]]
