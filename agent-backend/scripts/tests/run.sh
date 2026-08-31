#!/usr/bin/env bash
#
# Tests for the offsite sync logic in Backup_Manager.sh.
#
# The script is not sourceable — it parses arguments and calls main() at the
# bottom — so each test extracts the functions (or the filter array) it needs
# straight out of the source file and exercises them in isolation. Extraction
# is by exact function name and asserts on failure, so a rename breaks the test
# loudly instead of silently testing nothing.
#
# No hypervisor, no offsite host and no SSH: the remote calls are stubbed, and
# the rsync tests run a real local rsync, which is enough to pin down the filter
# semantics that matter (what a running backup exposes, what the verification
# pass considers a difference).
#
#   ./run.sh
#
set -uo pipefail
cd "$(dirname "$0")"

echo "Syntax check ..."
for src in ../Backup_Manager.sh ../Rsync_Manager.sh; do
	[[ -f "$src" ]] || { echo "cannot find $src"; exit 1; }
	bash -n "$src" || exit 1
	echo "  ok  - $(basename "$src")"
done
echo

rc=0
for t in ./*.test.sh; do
	echo "── $(basename "$t") ────────────────────────────────────────────"
	bash "$t" || rc=1
	echo
done

if [[ "$rc" -eq 0 ]]; then
	echo "ALL TESTS PASSED"
else
	echo "TESTS FAILED"
fi
exit "$rc"
