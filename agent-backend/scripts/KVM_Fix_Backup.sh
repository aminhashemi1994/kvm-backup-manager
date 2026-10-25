#!/bin/bash
# ============================================================================
# KVM_Fix_Backup.sh
#
# Resets virtnbdbackup checkpoint metadata for a KVM/QEMU VM.
# Used when an incremental backup chain is broken and the next backup must
# be a full one.
#
# Usage: KVM_Fix_Backup.sh <vm_name_or_id>
# ============================================================================

VM=$1

# Resolve VM identifier to its canonical name. Accepts either the VM name or
# the running ID. Updates the global VM variable. Exits if the VM doesn't exist.
resolve_vm() {
    # Match against the full VM list (column 2 = name)
    if virsh list --all | tail -n +3 | head -n -1 | awk '{print $2}' | grep -qE "(^| )$VM( |$)"; then
        return 0
    fi

    # Match against the running VM list (column 1 = ID), then resolve to name
    local resolved
    resolved=$(virsh list | tail -n +3 | head -n -1 | awk -v q="$VM" '$1 == q {print $2}')
    if [[ -n $resolved ]]; then
        VM=$resolved
        return 0
    fi

    echo "hostname $VM is not valid or not exist!" >&2
    exit 1
}

# Returns 0 if the VM is currently running.
is_running() {
    virsh list | grep " $VM " | awk '{print $3}' | grep -qiw "running"
}

# Delete every libvirt checkpoint (newest first). A checkpoint whose bitmap is
# already gone can't be deleted normally, so fall back to --metadata. Prints
# the deleted checkpoint names so their bitmaps can be removed afterwards.
delete_checkpoints() {
    local checkpoints
    checkpoints=$(virsh checkpoint-list --name --topological "$VM" 2>/dev/null | grep -v '^$' | tac)

    for cp in $checkpoints; do
        virsh checkpoint-delete "$VM" "$cp" &>/dev/null \
            || virsh checkpoint-delete "$VM" "$cp" --metadata &>/dev/null \
            || {
                echo "Failed to delete checkpoint $cp from $VM" Error >&2
                return 1
            }
    done

    echo "$checkpoints"
}

# Returns 0 if the bitmap was created by virtnbdbackup or belongs to a deleted checkpoint.
is_backup_bitmap() {
    local bitmap=$1 checkpoints=$2
    [[ $bitmap == virtnbdbackup* ]] || grep -qxF "$bitmap" <<<"$checkpoints"
}

# Live (running VM) fix path: delete checkpoints, then remove leftover backup
# bitmaps from every block node (format/protocol layers and backing chain)
# through QMP. Works even when no checkpoints exist but bitmaps remain.
fix_running_vm() {
    local checkpoints failed=0
    checkpoints=$(delete_checkpoints) || exit 1

    local node_bitmaps
    node_bitmaps=$(virsh qemu-monitor-command "$VM" --cmd '{"execute":"query-named-block-nodes","arguments":{"flat":true}}' \
        | jq -r '.return[] | select(.["dirty-bitmaps"] != null) | .["node-name"] as $n | .["dirty-bitmaps"][] | "\($n) \(.name)"' \
        | sort -u)

    while read -r node bitmap; do
        [[ -z $node ]] && continue
        is_backup_bitmap "$bitmap" "$checkpoints" || continue
        virsh qemu-monitor-command "$VM" \
            --cmd '{"execute":"block-dirty-bitmap-remove","arguments":{"node":"'"$node"'","name":"'"$bitmap"'"}}' \
            &>/dev/null || {
            echo "Failed to remove bitmap $bitmap from node $node of $VM" Error
            failed=1
        }
    done <<<"$node_bitmaps"

    [[ $failed -eq 1 ]] && exit 1
    echo "vm backup reset successfull, Please Consider create Full backup." Success
}

# Offline (shut off) fix path: delete checkpoints, then remove leftover backup
# bitmaps from each qcow2 disk with qemu-img. The VM is never started.
fix_shutoff_vm() {
    local state
    state=$(virsh dominfo "$VM" | grep -i state | awk '{print $2}')
    if [[ $state != shut ]]; then
        echo "VM must be Shutdown to Fix Backup Errors." Error
        exit 1
    fi

    local checkpoints disks failed=0
    checkpoints=$(delete_checkpoints) || exit 1
    disks=$(virsh domblklist --inactive "$VM" | awk 'NR >2 && $2 != "-" {print $2}')

    for disk in $disks; do
        [[ $(qemu-img info -U --output=json "$disk" 2>/dev/null | jq -r '.format') == qcow2 ]] || continue
        for bitmap in $(qemu-img info -U --output=json "$disk" | jq -r '.["format-specific"].data.bitmaps[]?.name'); do
            is_backup_bitmap "$bitmap" "$checkpoints" || continue
            qemu-img bitmap --remove "$disk" "$bitmap" || {
                echo "Failed to remove bitmap $bitmap from $disk" Error
                failed=1
            }
        done
    done

    [[ $failed -eq 1 ]] && exit 1
    echo "Vm backup Fixed Successfully, Please Consider Taking Full Backup in the next Following Backup. or the Backups will Fail again." Success
}

# ─── Main ───────────────────────────────────────────────────────────────────

resolve_vm

if is_running; then
    fix_running_vm
else
    fix_shutoff_vm
fi
