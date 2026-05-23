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

# Recreate a persistent dirty bitmap on every live block node, then delete the
# matching libvirt checkpoint.
create_live_dirty_bitmap() {
    local bitmap=$1

    local nodes
    nodes=$(virsh qemu-monitor-command "$VM" --cmd '{"execute":"query-block"}' \
        | jq | grep -i node-name | grep -v "pflash" | awk '{print $2}' | sed 's/,//g')

    for node in $nodes; do
        virsh qemu-monitor-command "$VM" \
            --cmd '{"execute":"block-dirty-bitmap-add","arguments":{"node":'"$node"' ,"name":"'"$bitmap"'","persistent":true}}' \
            &>/dev/null
    done

    virsh checkpoint-delete "$VM" "$bitmap" || {
        echo "Failed to delete checkpoint $bitmap, manual override required." Error
        exit 1
    }
}

# Live (running VM) fix path: walk checkpoints in reverse topological order
# and delete each. If delete fails, recreate the dirty bitmap and try again.
fix_running_vm() {
    local checkpoints
    checkpoints=$(virsh checkpoint-list --name --topological "$VM" | grep -v '^$' | tac)

    for cp in $checkpoints; do
        (virsh checkpoint-delete "$VM" "$cp" \
            || create_live_dirty_bitmap "$cp") &>/dev/null
    done

    echo "vm backup reset successfull, Please Consider create Full backup." Success
}

# Offline (shut off) fix path:
#   - If checkpoints are recorded: add bitmaps for each on each disk, start
#     the VM, then delete all the checkpoints.
#   - Otherwise: remove any orphan virtnbdbackup.N bitmaps from each disk.
fix_shutoff_vm() {
    local state
    state=$(virsh dominfo "$VM" | grep -i state | awk '{print $2}')
    if [[ $state != shut ]]; then
        echo "VM must be Shutdown to Fix Backup Errors." Error
        exit 1
    fi

    echo "****************************************************************************************************************************************************************"
    echo "Please note, for Fixing Backup Errors, vm might start in some situations during this process, you can cancell this process using ^C in 10 Seconds From now."
    echo "****************************************************************************************************************************************************************"
    sleep 10

    local checkpoints disks
    checkpoints=$(virsh checkpoint-list "$VM" --name)
    disks=$(virsh domblklist --inactive "$VM" | awk 'NR >2 {print $2}')

    if [[ -n $checkpoints ]]; then
        for disk in $disks; do
            for cp in $checkpoints; do
                qemu-img bitmap "$disk" "$cp" --add
            done
        done

        virsh start "$VM" || exit 1

        for cp in $checkpoints; do
            virsh checkpoint-delete "$VM" "$cp" || {
                echo "Failed to Delete Checkpoint $cp from $VM" Error
                exit 1
            }
        done
    else
        for disk in $disks; do
            for i in $(seq 0 100); do
                qemu-img bitmap "$disk" "virtnbdbackup.$i" --remove &>/dev/null
            done
        done

        echo "Vm backup Fixed Successfully, Please Consider Taking Full Backup in the next Following Backup. or the Backups will Fail again." Success
    fi
}

# ─── Main ───────────────────────────────────────────────────────────────────

resolve_vm

if is_running; then
    fix_running_vm
else
    fix_shutoff_vm
fi
