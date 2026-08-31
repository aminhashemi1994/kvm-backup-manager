#!/usr/bin/env bash
#
# End-to-end exercise of Rsync_Manager.sh --check-only.
#
# There is no offsite host here. Instead `ssh` is replaced with a stub that
# drops the options and the hostname and runs the rest locally — which is
# exactly what real ssh does, minus the network — so `root@1.2.3.4:/some/path`
# resolves to /some/path on this machine. rsync is happy with that: it just
# execs its remote shell and talks the protocol over the pipe.
#
# That makes the whole check path real: target parsing, the in-progress guard,
# the verification pass, the JSON line the replication check consumes, and the
# exit codes it keys off.
#
set -uo pipefail
SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/Rsync_Manager.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); echo "  ok  - $1"; }
no(){ FAIL=$((FAIL+1)); echo "  NOT OK - $1"; }
chk(){ if [[ "$2" == "$3" ]]; then ok "$1"; else no "$1 (got '$2' want '$3')"; fi; }

# ── ssh stub ────────────────────────────────────────────────────────────────
mkdir -p "$TMP/bin"
cat >"$TMP/bin/ssh" <<'SSHEOF'
#!/bin/bash
while [[ $# -gt 0 ]]; do
	case "$1" in
	-o | -p | -i | -l | -F) shift 2 ;;
	-*) shift ;;
	*) shift; break ;;          # the host; whatever follows is the command
	esac
done
[[ $# -eq 0 ]] && exit 0        # bare `ssh host` / `ssh host exit`
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
# Keep the source-guard baseline inside the sandbox rather than /var/lib.
export BACKUP_MANAGER_STATE_DIR="$TMP/state"

# ── a VM backup tree and an "offsite" destination ───────────────────────────
POOL="$TMP/pool"; REMOTE="$TMP/remote"
mkdir -p "$POOL/testvm/daily" "$POOL/testvm/archived" "$REMOTE"
echo "full-backup-data" >"$POOL/testvm/daily/testvm.full.data"
printf 'Day\tDate\tMethod\n' >"$POOL/testvm/daily/scheduler"

run_check() { bash "$SCRIPT" --domain testvm --backup-path "$POOL" \
	--offsite-ip "127.0.0.1:$REMOTE" --check-only 2>/dev/null; }
json_of()  { run_check | grep '^{' | tail -1; }
state_of() { sed -n 's/.*"state":"\([a-z_]*\)".*/\1/p' <<<"$1"; }

echo "== a destination that has never been synced reports out of sync =="
out=$(json_of); rc_out=$(run_check >/dev/null 2>&1; echo $?)
chk "exit code is EXIT_OUT_OF_SYNC" "$rc_out" "2"
chk "state is out_of_sync" "$(state_of "$out")" "out_of_sync"
chk "the missing file is counted" "$(grep -c '"differences":1' <<<"$out")" "1"

echo "== after a real sync the same check reports in sync =="
bash "$SCRIPT" --domain testvm --backup-path "$POOL" \
	--offsite-ip "127.0.0.1:$REMOTE" >/dev/null 2>&1
rc_sync=$?
chk "the sync itself succeeded" "$rc_sync" "0"
chk "backup data landed" "$([[ -f "$REMOTE/testvm/daily/testvm.full.data" ]] && echo y || echo n)" "y"
chk "scheduler ledger published after the data" "$([[ -f "$REMOTE/testvm/daily/scheduler" ]] && echo y || echo n)" "y"
rc_out=$(run_check >/dev/null 2>&1; echo $?)
chk "check now exits 0" "$rc_out" "0"
chk "state is in_sync" "$(state_of "$(json_of)")" "in_sync"

echo "== a backup running right now does not make the check fail =="
echo "being-written" >"$POOL/testvm/daily/testvm.inc.2.partial"
rc_out=$(run_check >/dev/null 2>&1; echo $?)
chk "in-flight data is invisible to the check" "$rc_out" "0"
rm -f "$POOL/testvm/daily/testvm.inc.2.partial"

echo "== damage at the destination is detected =="
echo -n "x" >"$REMOTE/testvm/daily/testvm.full.data"
rc_out=$(run_check >/dev/null 2>&1; echo $?)
chk "truncated file reported" "$rc_out" "2"

echo "== a sync repairs it and the check agrees =="
bash "$SCRIPT" --domain testvm --backup-path "$POOL" \
	--offsite-ip "127.0.0.1:$REMOTE" >/dev/null 2>&1
rc_out=$(run_check >/dev/null 2>&1; echo $?)
chk "back in sync after re-sync" "$rc_out" "0"

echo "== a VM with a sync in progress is skipped, not judged =="
LOCK="$POOL/offsite_locks/testvm.rsync.lock"
mkdir -p "$(dirname "$LOCK")"
printf '{"pid":%d,"tmux_session":"rs_testvm_live","job_id":"j1","vm":"testvm","started_at":"x"}\n' "$$" >"$LOCK"
rc_out=$(run_check >/dev/null 2>&1; echo $?)
chk "exit code is EXIT_RSYNC_BUSY" "$rc_out" "75"
chk "reports checked:false" "$(grep -c '"checked":false' <<<"$(json_of)")" "1"
chk "names the reason" "$(grep -c 'sync_in_progress' <<<"$(json_of)")" "1"
rm -f "$LOCK"

echo "== a stale lock from a dead process does not block anything =="
printf '{"pid":999999999,"tmux_session":"rs_gone","job_id":"j0","vm":"testvm","started_at":"x"}\n' >"$LOCK"
rc_out=$(run_check >/dev/null 2>&1; echo $?)
chk "check runs anyway" "$rc_out" "0"
rm -f "$LOCK"

echo "== a rotation the destination has not replayed is reported as pending =="
printf '{"seq":1,"op":"archive","name":"2026-01-01_00-00-00_testvm_daily","schedule":"daily","ts":"x"}\n' \
	>"$POOL/testvm/.offsite_ops.jsonl"
out=$(json_of)
chk "pending rotation flagged" "$(grep -c 'pending_rotations' <<<"$out")" "1"
chk "counted as needing a sync" "$(run_check >/dev/null 2>&1; echo $?)" "2"

echo "== the sync replays it and the cursor advances =="
bash "$SCRIPT" --domain testvm --backup-path "$POOL" \
	--offsite-ip "127.0.0.1:$REMOTE" >/dev/null 2>&1
chk "cursor recorded for the target" "$(cat "$POOL/testvm/.offsite_ops.127.0.0.1.cursor" 2>/dev/null)" "1"
chk "check is clean again" "$(run_check >/dev/null 2>&1; echo $?)" "0"

echo "== an empty source is refused instead of wiping the destination =="
# The catastrophic case: the pool did not mount, or a cleanup went too far, and
# --delete would faithfully mirror "nothing" onto every offsite host.
SAFE="$TMP/pool2"; SAFEREMOTE="$TMP/remote2"
mkdir -p "$SAFE/lostvm/daily" "$SAFEREMOTE/lostvm/daily"
echo "the only remaining copy" >"$SAFEREMOTE/lostvm/daily/lostvm.full.data"
rc_out=$(bash "$SCRIPT" --domain lostvm --backup-path "$SAFE" \
	--offsite-ip "127.0.0.1:$SAFEREMOTE" >/dev/null 2>&1; echo $?)
chk "the sync refuses" "$rc_out" "1"
chk "the offsite copy is untouched" \
	"$([[ -f "$SAFEREMOTE/lostvm/daily/lostvm.full.data" ]] && echo y || echo n)" "y"

echo "== a source holding only in-flight data is also refused =="
echo "half-written" >"$SAFE/lostvm/daily/lostvm.full.1.partial"
rc_out=$(bash "$SCRIPT" --domain lostvm --backup-path "$SAFE" \
	--offsite-ip "127.0.0.1:$SAFEREMOTE" >/dev/null 2>&1; echo $?)
chk "still refuses" "$rc_out" "1"
chk "offsite copy still there" \
	"$([[ -f "$SAFEREMOTE/lostvm/daily/lostvm.full.data" ]] && echo y || echo n)" "y"

echo "== once a backup completes, the sync proceeds =="
mv "$SAFE/lostvm/daily/lostvm.full.1.partial" "$SAFE/lostvm/daily/lostvm.full.data"
rc_out=$(bash "$SCRIPT" --domain lostvm --backup-path "$SAFE" \
	--offsite-ip "127.0.0.1:$SAFEREMOTE" >/dev/null 2>&1; echo $?)
chk "sync runs" "$rc_out" "0"
chk "destination now matches the source" \
	"$(cat "$SAFEREMOTE/lostvm/daily/lostvm.full.data")" "half-written"

echo "== the source guard records a baseline on the first run =="
GUARD="$TMP/pool3"; GUARDREMOTE="$TMP/remote3"
mkdir -p "$GUARD/gvm/daily" "$GUARDREMOTE"
echo "real-backup-data" >"$GUARD/gvm/daily/gvm.full.data"
sync_guard() { bash "$SCRIPT" --domain gvm --backup-path "$GUARD" \
	--offsite-ip "127.0.0.1:$GUARDREMOTE" "$@" >/dev/null 2>&1; }
chk "first sync succeeds" "$(sync_guard; echo $?)" "0"
chk "in-pool marker written" "$([[ -f "$GUARD/.offsite_source_fsid" ]] && echo y || echo n)" "y"
chk "baseline written outside the pool" \
	"$(grep -rl "^path=$GUARD\$" "$BACKUP_MANAGER_STATE_DIR/pool-guard" 2>/dev/null | wc -l)" "1"
chk "data reached the destination" \
	"$([[ -f "$GUARDREMOTE/gvm/daily/gvm.full.data" ]] && echo y || echo n)" "y"

echo "== an unmounted pool is refused and the remote is left alone =="
# Unmounting hides everything that was written INTO the filesystem — the marker
# included. Removing it reproduces exactly what the script would see.
rm -f "$GUARD/.offsite_source_fsid"
chk "sync refuses" "$(sync_guard; echo $?)" "1"
chk "offsite data untouched" \
	"$([[ -f "$GUARDREMOTE/gvm/daily/gvm.full.data" ]] && echo y || echo n)" "y"
chk "refusal is recorded as an event" \
	"$(grep -l offsite_source_unmounted "$GUARD/gvm/offsite_logs/"*.events.jsonl 2>/dev/null | wc -l | awk '{print ($1>0)?"y":"n"}')" "y"

echo "== an unmounted pool with stale data behind it is still refused =="
# The case the emptiness check cannot see: something is at the mount point, so
# the source looks populated, and --delete would prune the remote down to it.
rm -rf "$GUARD/gvm/daily"; mkdir -p "$GUARD/gvm/daily"
echo "stale leftover" >"$GUARD/gvm/daily/leftover.full.data"
chk "sync still refuses" "$(sync_guard; echo $?)" "1"
chk "the real offsite backup survives" \
	"$([[ -f "$GUARDREMOTE/gvm/daily/gvm.full.data" ]] && echo y || echo n)" "y"
chk "the stale file was NOT pushed" \
	"$([[ -f "$GUARDREMOTE/gvm/daily/leftover.full.data" ]] && echo y || echo n)" "n"

echo "== the check reports the real cause, not 'out of sync' =="
out=$(bash "$SCRIPT" --domain gvm --backup-path "$GUARD" \
	--offsite-ip "127.0.0.1:$GUARDREMOTE" --check-only 2>/dev/null | grep '^{' | tail -1)
chk "check declines to answer" "$(grep -c '"checked":false' <<<"$out")" "1"
chk "and names the source as the cause" "$(grep -c 'source_unavailable' <<<"$out")" "1"

echo "== a copy of the pool mounted in its place is refused =="
# A different filesystem normally carries no marker at all and is caught by the
# check above. It carries one when the filesystem is a COPY of this pool — a
# restored snapshot, a cloned disk. Then the marker exists but disagrees with
# the baseline held outside the pool, which is what this reproduces.
printf 'target=/elsewhere;uuid=00000000-dead-beef-0000-000000000000;source=/dev/zzz\n' \
	>"$GUARD/.offsite_source_fsid"
chk "sync refuses" "$(sync_guard; echo $?)" "1"
chk "offsite data untouched" \
	"$([[ -f "$GUARDREMOTE/gvm/daily/gvm.full.data" ]] && echo y || echo n)" "y"

echo "== --reset-source-guard is the way back for a genuine migration =="
chk "reset run succeeds" "$(sync_guard --reset-source-guard; echo $?)" "0"
chk "subsequent runs work again" "$(sync_guard; echo $?)" "0"
chk "and the new content is now mirrored" \
	"$([[ -f "$GUARDREMOTE/gvm/daily/leftover.full.data" ]] && echo y || echo n)" "y"

echo
echo "passed: $PASS   failed: $FAIL"
[[ "$FAIL" -eq 0 ]]
