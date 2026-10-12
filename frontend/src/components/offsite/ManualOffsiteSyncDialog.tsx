import { useMemo, useState } from 'react'
import { Loader2, UploadCloud } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { useBackupHistory, useSchedules } from '@/hooks/useBackups'
import { useOffsiteHostsByBackupHost } from '@/hooks/useOffsiteHosts'
import { useTriggerOffsiteSync } from '@/hooks/useOffsiteJobs'
import type { BackupJob, BackupSchedule } from '@/types'

/**
 * Send a finished backup offsite by hand.
 *
 * For backups no schedule replicates — a one-off "Backup now", or a VM whose
 * schedules have offsite switched off. The sync transfers the VM's whole
 * backup directory on that pool (it always does), so picking a backup really
 * picks the VM, its source pool and the host the offsite targets hang off.
 */

// Same test as the controller's replicationEnabled(): offsite on AND somewhere to send.
function replicates(s: BackupSchedule): boolean {
  const any = s as any
  if (any.offsiteEnabled === false || any.syncToOffsite === false) return false
  return (any.offsiteTargets?.length ?? 0) > 0 || (any.offsiteHostIds?.length ?? 0) > 0
}

export default function ManualOffsiteSyncDialog({ open, onOpenChange }: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { data: history, isLoading: historyLoading } = useBackupHistory({ status: 'completed', limit: 500 }, { enabled: open })
  const { data: schedules } = useSchedules()
  const trigger = useTriggerOffsiteSync()

  const [showAll, setShowAll] = useState(false)
  const [jobId, setJobId] = useState('')
  // Same shape as the schedule form: which offsite hosts are ticked, and the
  // destination pool chosen on each.
  const [hostIds, setHostIds] = useState<string[]>([])
  const [poolByHost, setPoolByHost] = useState<Record<string, string>>({})
  const [attempted, setAttempted] = useState(false)

  const toggleHost = (hostId: string) => {
    setHostIds(prev => prev.includes(hostId) ? prev.filter(id => id !== hostId) : [...prev, hostId])
    setPoolByHost(prev => {
      const next = { ...prev }
      delete next[hostId]
      return next
    })
  }

  const replicatedVmIds = useMemo(
    () => new Set((schedules || []).filter(replicates).map(s => s.vmId)),
    [schedules],
  )

  const backups = useMemo(() => {
    const list = (history || []).filter(
      (j: BackupJob) => j.jobType !== 'restore' && j.status === 'completed' && j.vmId,
    )
    return showAll ? list : list.filter(j => !replicatedVmIds.has(j.vmId))
  }, [history, showAll, replicatedVmIds])

  const selected = backups.find(j => j.id === jobId) || null
  const { data: offsiteHosts, isLoading: hostsLoading } = useOffsiteHostsByBackupHost(selected?.backupHostId || '')

  const targets = hostIds
    .filter(id => !!poolByHost[id])
    .map(id => ({ offsiteHostId: id, offsitePoolId: poolByHost[id] }))
  const missingPool = hostIds.some(id => !poolByHost[id])

  const reset = () => {
    setJobId('')
    setHostIds([])
    setPoolByHost({})
    setAttempted(false)
  }

  const submit = () => {
    setAttempted(true)
    if (!selected || targets.length === 0 || missingPool) return
    trigger.mutate(
      {
        vmId: selected.vmId,
        vmName: selected.vmName,
        offsiteTargets: targets,
        storagePoolId: selected.storagePoolId ?? null,
        triggeredByJobId: selected.id,
      },
      {
        onSuccess: () => {
          reset()
          onOpenChange(false)
        },
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o) }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Sync a backup offsite</DialogTitle>
          <DialogDescription>
            Choose a successful backup and where to send it. The whole VM backup directory is
            transferred, so earlier backups of the same VM go along with it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="manual-sync-backup">Backup</Label>
            <Select
              id="manual-sync-backup"
              value={jobId}
              onChange={(e) => { setJobId(e.target.value); setHostIds([]); setPoolByHost({}); setAttempted(false) }}
              disabled={historyLoading}
            >
              <option value="">
                {historyLoading ? 'Loading backups…' : backups.length === 0 ? 'No matching backups' : 'Select a backup'}
              </option>
              {backups.map(j => (
                <option key={j.id} value={j.id}>
                  {j.vmName} · {j.scheduleType || 'once'} · {new Date(j.endTime || j.startTime).toLocaleString()}
                  {j.storagePoolName ? ` · ${j.storagePoolName}` : ''}
                </option>
              ))}
            </Select>
            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
              <Checkbox checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
              Also show VMs that already replicate on a schedule
            </label>
          </div>

          {selected && (
            <div className="space-y-2">
              <Label>Offsite destinations on {selected.backupHostName}</Label>
              {hostsLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading offsite hosts…
                </div>
              ) : !offsiteHosts || offsiteHosts.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No offsite hosts are configured for this backup host.
                </p>
              ) : (
                <div className="border rounded-lg p-3 space-y-3 max-h-72 overflow-y-auto">
                  {offsiteHosts.map(host => {
                    const checked = hostIds.includes(host.id)
                    const selectedPoolId = poolByHost[host.id] || ''
                    const pools = host.storagePools || []
                    const selectedPool = pools.find(p => p.id === selectedPoolId)
                    const poolMissing = checked && !selectedPoolId
                    const poolTooFull = !!selectedPool &&
                      typeof selectedPool.usagePercent === 'number' &&
                      selectedPool.usagePercent >= (selectedPool.diskUsageThreshold ?? 80)
                    return (
                      <div key={host.id} className="space-y-2 border-b border-border pb-2 last:border-b-0 last:pb-0">
                        <div className="flex items-center space-x-2">
                          <Checkbox
                            id={`manual-offsite-${host.id}`}
                            checked={checked}
                            onChange={() => toggleHost(host.id)}
                          />
                          <Label htmlFor={`manual-offsite-${host.id}`} className="font-normal cursor-pointer flex-1">
                            {host.name} ({host.ip})
                          </Label>
                          {host.status === 'connected' ? (
                            <Badge variant="outline" className="text-xs bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-300 dark:border-green-800">
                              Connected
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-xs bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800">
                              Disconnected
                            </Badge>
                          )}
                        </div>
                        {checked && (
                          <div className="ml-6 space-y-1">
                            <Label htmlFor={`manual-offsite-pool-${host.id}`} className="text-xs">
                              Destination Pool *
                            </Label>
                            <Select
                              id={`manual-offsite-pool-${host.id}`}
                              value={selectedPoolId}
                              onChange={(e) => setPoolByHost(prev => ({ ...prev, [host.id]: e.target.value }))}
                              className={poolMissing && attempted ? 'border-red-500' : ''}
                            >
                              <option value="">Select pool...</option>
                              {pools.length === 0 ? (
                                <option disabled>No pools configured</option>
                              ) : (
                                pools.map(p => (
                                  <option key={p.id} value={p.id}>
                                    {p.name || p.path}
                                    {typeof p.usagePercent === 'number' ? ` (${p.usagePercent}% used)` : ''}
                                  </option>
                                ))
                              )}
                            </Select>
                            {pools.length === 0 && (
                              <p className="text-xs text-red-600">
                                This offsite host has no storage pools. Add one before selecting it.
                              </p>
                            )}
                            {poolMissing && attempted && pools.length > 0 && (
                              <p className="text-xs text-red-600">
                                Select a destination pool for this offsite host.
                              </p>
                            )}
                            {poolTooFull && selectedPool && (
                              <p className="text-xs text-amber-600">
                                Selected pool is {selectedPool.usagePercent}% full; the sync may be refused.
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={!selected || hostIds.length === 0 || trigger.isPending}>
            {trigger.isPending
              ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              : <UploadCloud className="h-4 w-4 mr-2" />}
            Start sync
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
