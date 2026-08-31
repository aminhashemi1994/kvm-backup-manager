#!/usr/bin/env bash
#
# The file-list phase, and what bounds it.
#
# rsync reports nothing while it builds its file list and the receiver stats the
# destination. On a slow or contended destination that phase can run for hours,
# and rsync's own --timeout cannot end it: rsync sends keepalives while the far
# side scans, so the connection never looks idle. A transfer in that state sits
# at 0% forever, holds the VM's offsite lock, and never reaches the retry loop.
#
# So the scan phase gets its own deadline. These tests drive the real script
# against an rsync stub that behaves like a receiver which never comes back.
#
set -uo pipefail
SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/Rsync_Manager.sh"
TMP=$(mktemp -d)
# A test that leaves a transfer running would poison the next run's assertions.
trap 'pkill -f "Rsync_Manager.sh --domain stallvm --backup-path $TMP/pool" 2>/dev/null; \
      [[ -s "$TMP/hung.pids" ]] && xargs -r kill -9 <"$TMP/hung.pids" 2>/dev/null; \
      rm -rf "$TMP"' EXIT
export BACKUP_MANAGER_STATE_DIR="$TMP/state"

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

REAL_RSYNC="$(command -v rsync)"

# A receiver that never finishes scanning: no output, no exit, for far longer
# than any deadline under test.
cat >"$TMP/bin/rsync" <<RSYNCEOF
#!/bin/bash
printf '%s\n' "\$*" >>"$TMP/rsync.args"
if [[ -f "$TMP/rsync.hang" ]]; then
	# Records its own pid so a test can assert on THIS transfer rather than on
	# a pattern that any leftover process could match.
	echo \$\$ >>"$TMP/hung.pids"
	sleep 600
	exit 0
fi
exec "$REAL_RSYNC" "\$@"
RSYNCEOF
chmod +x "$TMP/bin/ssh" "$TMP/bin/scp" "$TMP/bin/rsync"
export PATH="$TMP/bin:$PATH"

POOL="$TMP/pool"; REMOTE="$TMP/remote"
VM=stallvm
VMDIR="$POOL/$VM"
mkdir -p "$VMDIR/daily" "$REMOTE"
head -c 200000 /dev/urandom >"$VMDIR/daily/$VM.full.data"
printf 'Day\tDate\tMethod\n' >"$VMDIR/daily/scheduler"

sync_vm() { bash "$SCRIPT" --domain "$VM" --backup-path "$POOL" \
	--offsite-ip "127.0.0.1:$REMOTE" "$@" 2>&1; }

target_events() { cat "$VMDIR/offsite_logs/"*_offsite_*.events.jsonl 2>/dev/null; }

echo "== a receiver that never reports is given up on, not waited on forever =="
: >"$TMP/rsync.hang"
started=$(date +%s)
timeout 120 bash -c "$(declare -f sync_vm); SCRIPT='$SCRIPT'; VM='$VM'; POOL='$POOL'; REMOTE='$REMOTE'; \
	sync_vm --offsite-rsync-scan-timeout 5 --offsite-retry-attempts 1 \
	        --offsite-retry-backoff-base 1 >/dev/null 2>&1"
rc=$?
elapsed=$(( $(date +%s) - started ))
chk "the script returns instead of hanging"      "$([[ $rc -ne 124 ]] && echo y || echo n)" "y"
chk "and reports the host as failed"             "$([[ $rc -ne 0 ]] && echo y || echo n)" "y"
chk "it gave up near the deadline, not later"    "$([[ $elapsed -lt 60 ]] && echo y || echo n)" "y"
chk "the stall is named as its own event"        "$(target_events | grep -c '"event":"offsite_rsync_stalled"')" "1"
chk "not misreported as a plain rsync failure"   "$(target_events | grep -c '"event":"offsite_rsync_attempt_fail"')" "0"

echo "== nothing was deleted on the way out =="
chk "the destination is left alone"              "$([[ -d "$REMOTE" ]] && echo y || echo n)" "y"

echo "== a transfer that reports progress is never touched by the watchdog =="
rm -f "$TMP/rsync.hang" "$TMP/rsync.args"
rm -rf "$VMDIR/offsite_logs"
chk "sync succeeds"                              "$(sync_vm --offsite-rsync-scan-timeout 5 >/dev/null 2>&1; echo $?)" "0"
chk "data landed"                                "$([[ -f "$REMOTE/$VM/daily/$VM.full.data" ]] && echo y || echo n)" "y"
chk "no stall reported"                          "$(target_events | grep -c '"event":"offsite_rsync_stalled"')" "0"

echo "== the transfer builds its file list incrementally by default =="
# Both halves matter: --delete-after forces the old non-incremental recursion on
# its own, so dropping --no-inc-recursive without changing the deletion mode
# would leave the up-front scan — and the stall — exactly where it was.
chk "no --no-inc-recursive in the transfer"      "$(grep -c -- '--no-inc-recursive' "$TMP/rsync.args")" "0"
chk "deletion deferred without forcing a full scan" "$(grep -q -- '--delete-delay' "$TMP/rsync.args" && echo y || echo n)" "y"
chk "and --delete-after is gone"                 "$(grep -c -- '--delete-after' "$TMP/rsync.args")" "0"

echo "== extraneous files at the destination are still removed =="
echo stale >"$REMOTE/$VM/daily/orphan.data"
sync_vm >/dev/null 2>&1
chk "orphan deleted at the end of the transfer"  "$([[ -e "$REMOTE/$VM/daily/orphan.data" ]] && echo y || echo n)" "n"
chk "real data still there"                      "$([[ -f "$REMOTE/$VM/daily/$VM.full.data" ]] && echo y || echo n)" "y"

echo "== a file left truncated at the destination is repaired, not checksummed =="
# This is the shape that stalled a real transfer: an earlier interrupted sync
# left a huge archived file short at the destination. With the delta algorithm
# the receiver must read that whole file before anything moves; --whole-file
# just sends it. Here we only assert the outcome and the flag.
mkdir -p "$REMOTE/$VM/archived/chain"
mkdir -p "$VMDIR/archived/chain"
head -c 400000 /dev/urandom >"$VMDIR/archived/chain/big.data"
head -c 120000 "$VMDIR/archived/chain/big.data" >"$REMOTE/$VM/archived/chain/big.data"
rm -f "$TMP/rsync.args"
chk "sync succeeds"                              "$(sync_vm >/dev/null 2>&1; echo $?)" "0"
chk "the truncated copy now matches the source"  "$(cmp -s "$VMDIR/archived/chain/big.data" "$REMOTE/$VM/archived/chain/big.data" && echo y || echo n)" "y"
chk "sent whole, not delta-checksummed"          "$(grep -q -- '--whole-file' "$TMP/rsync.args" && echo y || echo n)" "y"

echo "== and the old behaviour is still reachable =="
rm -f "$TMP/rsync.args"
sync_vm --offsite-no-inc-recursive >/dev/null 2>&1
chk "--offsite-no-inc-recursive restores it"     "$(grep -c -- '--no-inc-recursive' "$TMP/rsync.args")" "1"
# rsync refuses more than one --delete-WHEN option, so the escape hatch must not
# bring --delete-after back with it.
chk "and the run is still accepted by rsync"     "$(sync_vm --offsite-no-inc-recursive >/dev/null 2>&1; echo $?)" "0"
rm -f "$TMP/rsync.args"
chk "--offsite-delta-transfer restores the delta algorithm" \
	"$(sync_vm --offsite-delta-transfer >/dev/null 2>&1; grep -q -- '--no-whole-file' "$TMP/rsync.args" && echo y || echo n)" "y"

echo "== the destination volume is checked before anything is written =="
# The incident this guards: an offsite host's network volume dropped, the mount
# point stayed a writable directory on the root filesystem, and the transfer
# filled / . Here the volume "vanishing" is the marker going with it.
chk "a first sync records the baseline"          "$(sync_vm >/dev/null 2>&1; echo $?)" "0"
chk "and leaves a marker in the remote base"     "$([[ -f "$REMOTE/.offsite_target_fsid" ]] && echo y || echo n)" "y"
chk "the marker sits ABOVE the transfer root"    "$([[ -f "$REMOTE/$VM/.offsite_target_fsid" ]] && echo y || echo n)" "n"

# The volume goes away; the path remains, empty and writable.
rm -rf "$REMOTE"; mkdir -p "$REMOTE"
# Per-target workers log to their own files, so the refusal is there, not on
# the script's stdout.
sync_rc=0; sync_vm >/dev/null 2>&1 || sync_rc=$?
chk "the sync fails rather than proceeding"      "$([[ $sync_rc -ne 0 ]] && echo y || echo n)" "y"
chk "and says why, in the target's log"          "$(cat "$VMDIR/offsite_logs/"*_offsite_127.0.0.1.log 2>/dev/null | grep -c 'REFUSING TO SYNC')" "1"
chk "and nothing was written to the bare path"   "$([[ -e "$REMOTE/$VM" ]] && echo y || echo n)" "n"
chk "the refusal is recorded as an event"        "$(target_events | grep -c 'offsite_target_marker_missing')" "1"

echo "== a genuine move to new storage has a way through =="
chk "--reset-target-guard re-records"            "$(sync_vm --reset-target-guard >/dev/null 2>&1; echo $?)" "0"
chk "and data flows again"                       "$([[ -f "$REMOTE/$VM/daily/$VM.full.data" ]] && echo y || echo n)" "y"

echo "== stopping the job stops the transfers, not just the script =="
# The shape that left rsync running with no tmux session and no monitor: each
# target is synced by a background subshell, which a SIGTERM to the script does
# not reach. An agent restart tearing down the process tree hit exactly this.
: >"$TMP/rsync.hang"
rm -rf "$VMDIR/offsite_locks"
# Started directly, not through sync_vm(): a backgrounded function call is a
# subshell, and signalling that would not reach the script itself — which is the
# very thing under test.
bash "$SCRIPT" --domain "$VM" --backup-path "$POOL" --offsite-ip "127.0.0.1:$REMOTE" \
	--offsite-rsync-scan-timeout 0 >/dev/null 2>&1 &
job_pid=$!
# Wait for the transfer to actually be running before stopping it.
rm -f "$TMP/hung.pids"
for _ in $(seq 1 40); do
	[[ -s "$TMP/hung.pids" ]] && break
	sleep 0.5
done
hung_pid=$(head -1 "$TMP/hung.pids" 2>/dev/null)
chk "a transfer is running"                      "$([[ -n "$hung_pid" ]] && kill -0 "$hung_pid" 2>/dev/null && echo y || echo n)" "y"
kill -TERM "$job_pid" 2>/dev/null
wait "$job_pid" 2>/dev/null
sleep 3
chk "no rsync left behind"                       "$(kill -0 "$hung_pid" 2>/dev/null && echo y || echo n)" "n"
chk "no worker subshell left behind"             "$(pgrep -f "Rsync_Manager.sh --domain $VM --backup-path $POOL" >/dev/null 2>&1 && echo y || echo n)" "n"
chk "the VM lock was released"                   "$(ls "$VMDIR/offsite_locks/"*.rsync.lock 2>/dev/null | wc -l)" "0"
rm -f "$TMP/rsync.hang"

echo ""
echo "passed: $PASS   failed: $FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
