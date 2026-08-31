#!/usr/bin/env bash
#
# Exercises the offsite rotation journal and the VM-level rsync lock.
#
# The journal is what stops a retention rotation from costing a full re-transfer
# of the chain over the WAN, and the lock is what stops two rsync jobs for the
# same VM from running at once. Both are pure local bookkeeping, so they can be
# lifted straight out of Backup_Manager.sh and driven directly.
#
set -uo pipefail
SP="$(mktemp -d)"; trap 'rm -rf "$SP"' EXIT
SRC="$(dirname "$0")/../Rsync_Manager.sh"
BM="$(dirname "$0")/../Backup_Manager.sh"

# Pull the functions under test out of the script by name. Asserting here means
# a rename fails the suite instead of quietly testing an empty file.
# record_offsite_op stays in Backup_Manager.sh — only the backup knows a
# rotation happened. Everything that replays or guards it lives in
# Rsync_Manager.sh. Extracting from both is the point: the two halves have to
# agree on the journal format, and this is what proves they still do.
python3 - "$SRC" "$BM" "$SP/lib_under_test.sh" <<'PYX'
import io, re, sys
rsync_src, backup_src, out = sys.argv[1], sys.argv[2], sys.argv[3]
sources = {
    backup_src: ["record_offsite_op"],
    rsync_src:  ["_journal_max_seq", "apply_offsite_ops", "trim_offsite_ops_journal",
                 "pending_offsite_ops_count",
                 "_rsync_lock_owner_alive", "_rsync_lock_owner_desc",
                 "acquire_rsync_lock", "release_rsync_lock"],
}
buf = []
for src, want in sources.items():
    s = io.open(src, encoding="utf-8").read()
    for name in want:
        m = re.search(r'^' + re.escape(name) + r'\(\) \{\n(.*?)^\}\n', s, re.M | re.S)
        assert m, "could not extract %s from %s" % (name, src)
        buf.append(m.group(0))
io.open(out, "w", encoding="utf-8").write("\n".join(buf))
PYX
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); echo "  ok  - $1"; }
no(){ FAIL=$((FAIL+1)); echo "  NOT OK - $1"; }
chk(){ if [[ "$2" == "$3" ]]; then ok "$1"; else no "$1 (got '$2' want '$3')"; fi; }

# --- stubs / globals the extracted functions expect -------------------------
info(){ :; }
warn(){ echo "    warn: $*" >&2; }
emit_event(){ :; }
schedule="daily"
vm_name="testvm"
offsite_ips="10.0.0.1"
rsync_tmux_session="rs_testvm_abc"
rsync_job_id="job-123"
_rsync_lock_held="false"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP" "$SP"' EXIT
vm_base_dir="$TMP/vm"; mkdir -p "$vm_base_dir"
offsite_ops_journal="$vm_base_dir/.offsite_ops.jsonl"
rsync_lock_file="$TMP/locks/testvm.rsync.lock"

source "$SP/lib_under_test.sh"

echo "== journal: record assigns monotonic sequence =="
record_offsite_op archive "2026-01-01_00-00-00_testvm_daily"
record_offsite_op prune   "2025-01-01_00-00-00_testvm_daily"
record_offsite_op archive "2026-02-02_00-00-00_testvm_daily"
chk "three entries recorded" "$(wc -l <"$offsite_ops_journal")" "3"
# Ids come from the clock, not from a counter over the journal's own contents:
# a counter restarted whenever the trim emptied the file, and a reused id is
# silently skipped by every target already past it.
seqs=$(sed -n 's/.*"seq":\([0-9]*\).*/\1/p' "$offsite_ops_journal")
chk "every id is distinct" "$(echo "$seqs" | sort -u | wc -l)" "3"
chk "and they increase" "$(echo "$seqs" | sort -n | tr '\n' ' ')" "$(echo "$seqs" | tr '\n' ' ')"
chk "ids are clock-scale, not counter-scale" \
	"$(echo "$seqs" | head -1 | awk '{print (length($1)==19)?"y":"n"}')" "y"
chk "schedule captured" "$(sed -n '1s/.*"schedule":"\([^"]*\)".*/\1/p' "$offsite_ops_journal")" "daily"

echo "== journal: record is skipped when no name =="
record_offsite_op archive ""
chk "still three entries" "$(wc -l <"$offsite_ops_journal")" "3"

echo "== journal: apply replays from cursor and advances it =="
# Stand in for ssh so we can record what would run remotely.
SSH_LOG="$TMP/ssh.log"
ssh(){ shift $(( $# - 1 )); echo "$1" >>"$SSH_LOG"; return 0; }
apply_offsite_ops "10.0.0.1" "root" "/remote/testvm" >/dev/null
chk "cursor advanced to the newest id" \
	"$(cat "$vm_base_dir/.offsite_ops.10.0.0.1.cursor")" "$(echo "$seqs" | sort -n | tail -1)"
chk "three remote commands issued" "$(wc -l <"$SSH_LOG")" "3"
chk "archive replayed as a remote move" "$(grep -c "mv -f" "$SSH_LOG")" "2"
chk "prune replayed as a remote delete" "$(grep -c "rm -rf '/remote/testvm/archived/2025-01-01_00-00-00_testvm_daily'" "$SSH_LOG")" "1"

echo "== journal: replay is idempotent — a second pass does nothing =="
: >"$SSH_LOG"
apply_offsite_ops "10.0.0.1" "root" "/remote/testvm" >/dev/null
chk "no remote commands re-issued" "$(wc -l <"$SSH_LOG")" "0"

echo "== journal: a second target replays independently =="
: >"$SSH_LOG"
apply_offsite_ops "10.0.0.2" "root" "/remote/testvm" >/dev/null
chk "second target replayed all three" "$(wc -l <"$SSH_LOG")" "3"
chk "second cursor at the newest id" \
	"$(cat "$vm_base_dir/.offsite_ops.10.0.0.2.cursor")" "$(echo "$seqs" | sort -n | tail -1)"

echo "== journal: an unreachable target keeps its cursor =="
: >"$SSH_LOG"
record_offsite_op archive "2026-03-03_00-00-00_testvm_daily"
ssh(){ return 255; }
apply_offsite_ops "10.0.0.3" "root" "/remote/testvm" >/dev/null; rc=$?
chk "apply reports failure" "$rc" "1"
chk "no cursor written for the failed target" "$([[ -f "$vm_base_dir/.offsite_ops.10.0.0.3.cursor" ]] && echo yes || echo no)" "no"

echo "== journal: trim keeps what the slowest target still owes =="
ssh(){ shift $(( $# - 1 )); echo "$1" >>"$SSH_LOG"; return 0; }
apply_offsite_ops "10.0.0.1" "root" "/remote/testvm" >/dev/null
trim_offsite_ops_journal
chk "the entry 10.0.0.2 still owes is kept" "$(wc -l <"$offsite_ops_journal")" "1"
apply_offsite_ops "10.0.0.2" "root" "/remote/testvm" >/dev/null
trim_offsite_ops_journal
# Emptying it completely is safe now: a clock id cannot collide with an old one,
# which is the only reason a line ever had to be held back.
chk "journal empty once every target has replayed" "$(wc -l <"$offsite_ops_journal")" "0"

echo "== journal: a trimmed journal cannot cause an id to be reused =="
# The bug this replaced: the next id was derived from the journal's contents, so
# an empty journal restarted the count at 1 — and every target whose cursor was
# past 1 skipped the rotation silently, re-uploading the chain instead.
record_offsite_op archive "after-trim-1"
new_seq=$(sed -n 's/.*"seq":\([0-9]*\).*/\1/p' "$offsite_ops_journal" | sort -n | tail -1)
prev_cursor=$(cat "$vm_base_dir/.offsite_ops.10.0.0.1.cursor")
chk "the new id is past every cursor already issued" \
	"$([[ "$new_seq" -gt "$prev_cursor" ]] && echo y || echo n)" "y"
: >"$SSH_LOG"
apply_offsite_ops "10.0.0.1" "root" "/remote/testvm" >/dev/null
chk "so a caught-up target still replays it" "$(wc -l <"$SSH_LOG")" "1"

echo "== journal: a wiped journal does not strand a target =="
rm -f "$offsite_ops_journal"
record_offsite_op archive "fresh-start"
: >"$SSH_LOG"
apply_offsite_ops "10.0.0.1" "root" "/remote/testvm" >/dev/null
chk "the entry is replayed despite the older cursor" "$(wc -l <"$SSH_LOG")" "1"

echo "== journal: replay is safe even with no cursor at all =="
# Correctness must not rest on the cursor. The op says "the chain that was in
# daily/ is now at archived/<name>/"; replayed when daily/ holds a DIFFERENT
# chain, a blind move would bury the live chain inside an old archive. The guard
# is on the remote side, at the moment of the move: a destination that already
# holds something means the rotation was applied, so nothing moves.
rm -f "$vm_base_dir/.offsite_ops.10.0.0.1.cursor"
: >"$SSH_LOG"
ssh(){
	shift $(( $# - 1 ))
	echo "$1" >>"$SSH_LOG"
	# Stand in for a destination that already holds the archived chain.
	[[ "$1" == *"exit 3"* ]] && return 3
	return 0
}
apply_offsite_ops "10.0.0.1" "root" "/remote/testvm" >/dev/null
chk "the replay checks the destination before moving anything" \
	"$(grep -c "exit 3" "$SSH_LOG")" "1"
chk "and reports already-applied rather than moving the live chain" \
	"$(cat "$vm_base_dir/.offsite_ops.10.0.0.1.cursor" | wc -l)" "1"
ssh(){ shift $(( $# - 1 )); echo "$1" >>"$SSH_LOG"; return 0; }

echo "== journal: the destination directory round-trips =="
record_offsite_op archive "quarantined-chain" ".broken"
: >"$SSH_LOG"
apply_offsite_ops "10.0.0.1" "root" "/remote/testvm" >/dev/null
chk "a quarantine replays into .broken, not archived" \
	"$(grep -c "/remote/testvm/.broken/quarantined-chain" "$SSH_LOG")" "1"

echo "== lock: acquire writes owner metadata =="
unset -f ssh
chk "acquire succeeds" "$(acquire_rsync_lock >/dev/null 2>&1; echo $?)" "0"
chk "records our pid" "$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$rsync_lock_file")" "$$"
chk "records the tmux session" "$(sed -n 's/.*"tmux_session":"\([^"]*\)".*/\1/p' "$rsync_lock_file")" "rs_testvm_abc"
chk "records the job id" "$(sed -n 's/.*"job_id":"\([^"]*\)".*/\1/p' "$rsync_lock_file")" "job-123"

echo "== lock: a live owner is refused, not killed =="
tmux(){ return 1; }   # no tmux session; fall back to the PID witness
chk "live pid blocks a second acquire" "$(acquire_rsync_lock >/dev/null 2>&1; echo $?)" "1"
chk "lock still belongs to the original owner" "$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$rsync_lock_file")" "$$"

echo "== lock: a dead owner is reclaimed (power loss / SIGKILL) =="
DEAD=$( (exec bash -c 'exit 0') & echo $! ); wait "$DEAD" 2>/dev/null
printf '{"pid":%d,"tmux_session":"gone_session","job_id":"old","vm":"testvm","started_at":"2026-01-01T00:00:00Z"}\n' \
  "$DEAD" >"$rsync_lock_file"
_rsync_lock_held="false"
chk "stale lock reclaimed" "$(acquire_rsync_lock >/dev/null 2>&1; echo $?)" "0"
chk "lock now ours" "$(sed -n 's/.*"pid":\([0-9]*\).*/\1/p' "$rsync_lock_file")" "$$"

echo "== lock: a live tmux session alone is enough to refuse =="
printf '{"pid":999999999,"tmux_session":"rs_other","job_id":"other","vm":"testvm","started_at":"x"}\n' >"$rsync_lock_file"
tmux(){ [[ "$*" == *"rs_other"* ]] && return 0; return 1; }
_rsync_lock_held="false"
chk "refused on the tmux witness despite a dead pid" "$(acquire_rsync_lock >/dev/null 2>&1; echo $?)" "1"

echo "== lock: legacy bare-pid lock files are still understood =="
tmux(){ return 1; }
echo "$$" >"$rsync_lock_file"
_rsync_lock_held="false"
chk "legacy live pid refused" "$(acquire_rsync_lock >/dev/null 2>&1; echo $?)" "1"

echo "== lock: release only drops our own lock =="
_rsync_lock_held="false"
acquire_rsync_lock >/dev/null 2>&1
printf '{"pid":424242,"tmux_session":"x","job_id":"y","vm":"testvm","started_at":"z"}\n' >"$rsync_lock_file"
release_rsync_lock
chk "someone else's lock left alone" "$([[ -f "$rsync_lock_file" ]] && echo present || echo gone)" "present"
_rsync_lock_held="false"
acquire_rsync_lock >/dev/null 2>&1
release_rsync_lock
chk "our own lock removed" "$([[ -f "$rsync_lock_file" ]] && echo present || echo gone)" "gone"

echo
echo "passed: $PASS   failed: $FAIL"
[[ "$FAIL" -eq 0 ]]
