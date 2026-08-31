#!/usr/bin/env bash
#
# Exercises the rsync filter rules and the post-sync verification pass against a
# real local rsync — no SSH, no offsite host.
#
# These rules carry most of the safety of the design: *.partial is what makes it
# safe to sync a VM while a backup of it is running, and the anchored
# /*/scheduler rule is what holds back the live ledger without also stripping
# the historical copies inside archived chains.
#
set -uo pipefail
SP="$(mktemp -d)"; trap 'rm -rf "$SP"' EXIT
SRC="$(dirname "$0")/../Rsync_Manager.sh"

python3 - "$SRC" "$SP/filters.sh" <<'PYX'
import io, re, sys
src, out = sys.argv[1], sys.argv[2]
s = io.open(src, encoding="utf-8").read()
m = re.search(r'^OFFSITE_PARTIAL_DIR=.*?\n^OFFSITE_RSYNC_FILTERS=\(\n.*?^\)\n', s, re.M | re.S)
assert m, "could not extract OFFSITE_RSYNC_FILTERS from %s" % src
io.open(out, "w", encoding="utf-8").write(m.group(0))
PYX
source "$SP/filters.sh"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); echo "  ok  - $1"; }
no(){ FAIL=$((FAIL+1)); echo "  NOT OK - $1"; }
chk(){ if [[ "$2" == "$3" ]]; then ok "$1"; else no "$1 (got '$2' want '$3')"; fi; }

TMP=$(mktemp -d); trap 'rm -rf "$TMP" "$SP"' EXIT
SRC="$TMP/src"; DST="$TMP/dst"; mkdir -p "$SRC" "$DST"

# A realistic VM backup tree.
mkdir -p "$SRC/daily/logs" "$SRC/weekly" "$SRC/archived/2026-01-01_00-00-00_vm_daily" \
         "$SRC/logs" "$SRC/in_progress_backups" "$SRC/offsite_locks"
echo "complete-full"      >"$SRC/daily/vm.full.data"
echo "in-flight-data"     >"$SRC/daily/vm.inc.2.partial"     # a backup writing RIGHT NOW
printf 'Day\tDate\tMethod\n' >"$SRC/daily/scheduler"          # live ledger, held back
echo "weekly-full"        >"$SRC/weekly/vm.full.data"
printf 'Day\tDate\tMethod\n' >"$SRC/weekly/scheduler"
echo "archived-full"      >"$SRC/archived/2026-01-01_00-00-00_vm_daily/vm.full.data"
printf 'Day\tDate\tMethod\n' >"$SRC/archived/2026-01-01_00-00-00_vm_daily/scheduler"  # historical, must sync
echo "joblog"             >"$SRC/daily/logs/run.log"
echo "bookkeeping"        >"$SRC/.offsite_ops.jsonl"
echo "7"                  >"$SRC/.offsite_ops.10.0.0.1.cursor"
echo "lockdata"           >"$SRC/offsite_locks/vm_offsite_10.0.0.1"

rsync "${OFFSITE_RSYNC_FILTERS[@]}" "$SRC/" "$DST/" >/dev/null 2>&1

echo "== what the transfer carries =="
chk "completed backup data synced"        "$([[ -f "$DST/daily/vm.full.data" ]] && echo y || echo n)" "y"
chk "in-flight .partial NOT synced"       "$([[ -e "$DST/daily/vm.inc.2.partial" ]] && echo y || echo n)" "n"
chk "live scheduler ledger held back"     "$([[ -e "$DST/daily/scheduler" ]] && echo y || echo n)" "n"
chk "weekly ledger held back too"         "$([[ -e "$DST/weekly/scheduler" ]] && echo y || echo n)" "n"
chk "ARCHIVED ledger still synced"        "$([[ -f "$DST/archived/2026-01-01_00-00-00_vm_daily/scheduler" ]] && echo y || echo n)" "y"
chk "archived chain data synced"          "$([[ -f "$DST/archived/2026-01-01_00-00-00_vm_daily/vm.full.data" ]] && echo y || echo n)" "y"
chk "logs excluded"                       "$([[ -e "$DST/daily/logs" ]] && echo y || echo n)" "n"
chk "in_progress_backups excluded"        "$([[ -e "$DST/in_progress_backups" ]] && echo y || echo n)" "n"
chk "offsite_locks excluded"              "$([[ -e "$DST/offsite_locks" ]] && echo y || echo n)" "n"
chk "rotation journal excluded"           "$([[ -e "$DST/.offsite_ops.jsonl" ]] && echo y || echo n)" "n"
chk "per-target cursor NOT mirrored"      "$([[ -e "$DST/.offsite_ops.10.0.0.1.cursor" ]] && echo y || echo n)" "n"

echo "== verification: a matching destination reports clean =="
verify(){ rsync -n -i "${OFFSITE_RSYNC_FILTERS[@]}" "$SRC/" "$DST/" 2>/dev/null | grep -E '^(>f|<f|\*deleting)' || true; }
chk "no differences after a good sync" "$(verify | wc -l)" "0"

echo "== verification: a truncated file at the destination is caught =="
echo -n "trunc" >"$DST/daily/vm.full.data"
out=$(verify)
chk "one difference reported" "$(printf '%s\n' "$out" | grep -c .)" "1"
chk "it names the damaged file" "$(printf '%s\n' "$out" | grep -c 'daily/vm.full.data')" "1"

echo "== verification: a missing file is caught =="
rsync "${OFFSITE_RSYNC_FILTERS[@]}" "$SRC/" "$DST/" >/dev/null 2>&1
rm -f "$DST/archived/2026-01-01_00-00-00_vm_daily/vm.full.data"
chk "missing archived file reported" "$(verify | grep -c 'archived/.*vm.full.data')" "1"

echo "== verification: an extra file at the destination is caught =="
rsync "${OFFSITE_RSYNC_FILTERS[@]}" "$SRC/" "$DST/" >/dev/null 2>&1
echo "stray" >"$DST/daily/orphan.data"
chk "extraneous file reported as a deletion" "$(verify | grep -c '^\*deleting.*orphan.data')" "1"

echo "== verification ignores what the transfer ignores =="
rsync "${OFFSITE_RSYNC_FILTERS[@]}" "$SRC/" "$DST/" >/dev/null 2>&1
echo "new in-flight write" >"$SRC/daily/vm.inc.3.partial"
printf 'Day\tDate\tMethod\nMon\t01/01/2026\tinc\n' >"$SRC/daily/scheduler"
chk "a running backup does not fail verification" "$(verify | wc -l)" "0"

echo
echo "passed: $PASS   failed: $FAIL"
[[ "$FAIL" -eq 0 ]]
