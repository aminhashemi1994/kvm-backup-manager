import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Select } from '@/components/ui/select'
import { useUpdateSchedule } from '@/hooks/useBackups'
import { useOffsiteHostsByBackupHost } from '@/hooks/useOffsiteHosts'
import { Loader2, AlertCircle, CheckCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { toast } from 'sonner'

interface BulkEditScheduleDialogProps {
  schedules: any[]
  onClose: () => void
}

export default function BulkEditScheduleDialog({ schedules, onClose }: BulkEditScheduleDialogProps) {
  const [formData, setFormData] = useState({
    // Flags to indicate which fields to update
    updateTime: false,
    updateRetention: false,
    updateKeepArchive: false,
    updateCompression: false,
    updateVerify: false,
    updateEnabled: false,
    updateOffsite: false,
    updateRetry: false,
    updateOffsiteRetry: false,
    updateOffsiteResync: false,

    // Values
    time: '02:00',
    retention: 7,
    keepArchive: 2,
    noCompression: false,
    compression: 2,
    noVerify: false,
    enabled: true,

    // Retry values
    retryCount: 3,
    retryDelayMinutes: 5,
    offsiteRetryAttempts: 3,
    offsiteRetryBackoffSeconds: 15,
    // '' = clear the per-schedule override so these schedules fall back to
    // their own Retry on Failure settings.
    offsiteResyncAttempts: '' as number | '',
    offsiteResyncDelayMinutes: '' as number | '',

    // Offsite values
    syncToOffsite: false,
    offsiteHostIds: [] as string[],
    // Per-offsite-host destination pool: offsiteHostId -> offsitePoolId
    offsitePoolByHost: {} as Record<string, string>,
  })

  const [offsiteValidationAttempted, setOffsiteValidationAttempted] = useState(false)
  const [isUpdating, setIsUpdating] = useState(false)
  const [updatedCount, setUpdatedCount] = useState(0)
  const [failedCount, setFailedCount] = useState(0)

  const updateSchedule = useUpdateSchedule()

  // Offsite hosts are scoped to a single backup host, so bulk offsite editing
  // is only offered when every selected schedule shares the same backup host.
  const backupHostIds = Array.from(
    new Set(schedules.map(s => s.backupHostId).filter(Boolean))
  )
  const commonBackupHostId = backupHostIds.length === 1 ? (backupHostIds[0] as string) : ''
  const canEditOffsite = !!commonBackupHostId
  const { data: offsiteHosts, isLoading: offsiteLoading } = useOffsiteHostsByBackupHost(commonBackupHostId)

  const handleOffsiteHostToggle = (hostId: string) => {
    setFormData(prev => {
      const isChecked = prev.offsiteHostIds.includes(hostId)
      const nextHostIds = isChecked
        ? prev.offsiteHostIds.filter(id => id !== hostId)
        : [...prev.offsiteHostIds, hostId]
      const nextPools = { ...prev.offsitePoolByHost }
      if (isChecked) delete nextPools[hostId]
      return { ...prev, offsiteHostIds: nextHostIds, offsitePoolByHost: nextPools }
    })
  }

  const handleOffsitePoolChange = (hostId: string, poolId: string) => {
    setFormData(prev => ({
      ...prev,
      offsitePoolByHost: { ...prev.offsitePoolByHost, [hostId]: poolId },
    }))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    // Check if at least one field is selected for update
    const hasUpdates = formData.updateTime ||
                       formData.updateRetention || 
                       formData.updateKeepArchive || 
                       formData.updateCompression || 
                       formData.updateVerify || 
                       formData.updateEnabled ||
                       formData.updateOffsite ||
                       formData.updateRetry ||
                       formData.updateOffsiteRetry ||
                       formData.updateOffsiteResync

    if (!hasUpdates) {
      toast.error('Please select at least one field to update')
      return
    }

    if (formData.updateTime && !/^\d{2}:\d{2}$/.test(formData.time)) {
      toast.error('Please enter a valid start time (HH:MM)')
      return
    }

    // Offsite validation (mirrors server Req 4.3): when enabling offsite sync,
    // require at least one host and a destination pool for each checked host.
    if (formData.updateOffsite && formData.syncToOffsite) {
      if (formData.offsiteHostIds.length === 0) {
        toast.error('Select at least one offsite host or turn off offsite sync')
        return
      }
      const missing = formData.offsiteHostIds.filter(id => !formData.offsitePoolByHost[id])
      if (missing.length > 0) {
        setOffsiteValidationAttempted(true)
        toast.error('Select a destination pool for each offsite host')
        return
      }
    }

    // Build the offsite targets once — all selected schedules share one
    // backup host, so the same targets apply to every schedule.
    const offsiteTargets = formData.offsiteHostIds
      .map(id => ({ offsiteHostId: id, offsitePoolId: formData.offsitePoolByHost[id] }))
      .filter(t => !!t.offsitePoolId)

    setIsUpdating(true)
    setUpdatedCount(0)
    setFailedCount(0)

    // Schedule types where a HH:MM start time is meaningful.
    const TIME_BASED = ['daily', 'weekly', 'monthly', 'once']
    // Chain backups that use retention / keep-archive.
    const CHAIN_TYPES = ['daily', 'weekly', 'interval', 'cron']

    // Use local counters — React state updates are async and the closure
    // would otherwise read stale values when building the final toast.
    let ok = 0
    let failed = 0

    for (const schedule of schedules) {
      try {
        const updates: any = {}

        if (formData.updateTime && TIME_BASED.includes(schedule.scheduleType)) {
          updates.time = formData.time
        }
        if (formData.updateRetention && CHAIN_TYPES.includes(schedule.scheduleType)) {
          updates.retention = formData.retention
        }
        if (formData.updateKeepArchive && CHAIN_TYPES.includes(schedule.scheduleType)) {
          updates.keepArchive = formData.keepArchive
        }
        if (formData.updateCompression) {
          updates.noCompression = formData.noCompression
          // The level, not just the on/off flag. Sending only noCompression
          // left every schedule's level untouched, so "Update Compression
          // Setting" applied half of what it appeared to.
          updates.compression = formData.noCompression ? 0 : formData.compression
        }
        if (formData.updateVerify) {
          updates.noVerify = formData.noVerify
        }
        if (formData.updateEnabled) {
          updates.enabled = formData.enabled
        }
        // Retry applies to every schedule type — any scheduled backup can fail.
        if (formData.updateRetry) {
          updates.retryCount = formData.retryCount
          updates.retryDelayMinutes = formData.retryDelayMinutes
        }
        if (formData.updateOffsiteRetry) {
          updates.offsiteRetryAttempts = formData.offsiteRetryAttempts
          updates.offsiteRetryBackoffSeconds = formData.offsiteRetryBackoffSeconds
        }
        if (formData.updateOffsiteResync) {
          // Explicit null clears the override; the API treats null as "inherit
          // the backup retry settings" rather than as a missing field.
          updates.offsiteResyncAttempts =
            formData.offsiteResyncAttempts === '' ? null : formData.offsiteResyncAttempts
          updates.offsiteResyncDelayMinutes =
            formData.offsiteResyncDelayMinutes === '' ? null : formData.offsiteResyncDelayMinutes
        }
        if (formData.updateOffsite) {
          updates.syncToOffsite = formData.syncToOffsite
          if (formData.syncToOffsite) {
            // Primary field: one { offsiteHostId, offsitePoolId } per checked host.
            updates.offsiteTargets = offsiteTargets
            updates.offsiteHostIds = formData.offsiteHostIds
          } else {
            // Turning offsite off clears any existing targets.
            updates.offsiteTargets = []
            updates.offsiteHostIds = []
          }
        }

        if (Object.keys(updates).length > 0) {
          await updateSchedule.mutateAsync({ id: schedule.id, data: updates })
          ok += 1
          setUpdatedCount(ok)
        }
      } catch (error) {
        console.error(`Failed to update schedule ${schedule.name}:`, error)
        failed += 1
        setFailedCount(failed)
      }
    }

    setIsUpdating(false)

    if (failed === 0) {
      toast.success(`Successfully updated ${ok} schedule(s)`)
      onClose()
    } else {
      toast.warning(`Updated ${ok} schedule(s), ${failed} failed`)
    }
  }

  // Type groupings used to show which selected schedules each option affects.
  const hasChainSchedules = schedules.some(s => ['daily', 'weekly', 'interval', 'cron'].includes(s.scheduleType))
  const allChainSchedules = schedules.every(s => ['daily', 'weekly', 'interval', 'cron'].includes(s.scheduleType))
  const hasTimeBased = schedules.some(s => ['daily', 'weekly', 'monthly', 'once'].includes(s.scheduleType))
  const allTimeBased = schedules.every(s => ['daily', 'weekly', 'monthly', 'once'].includes(s.scheduleType))

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-2xl w-full">
        <DialogHeader>
          <DialogTitle>Bulk Edit Schedules</DialogTitle>
          <p className="text-sm text-gray-600 mt-2">
            Update settings for {schedules.length} selected schedule(s)
          </p>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-4">
            {/* Selected Schedules */}
            <div className="p-4 border rounded-md bg-blue-50">
              <h3 className="font-medium text-sm mb-2">Selected Schedules ({schedules.length})</h3>
              <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto">
                {schedules.map(schedule => (
                  <Badge key={schedule.id} variant="outline" className="bg-white">
                    {schedule.name}
                  </Badge>
                ))}
              </div>
            </div>

            {/* Schedule Timing (time-based schedules) */}
            {hasTimeBased && (
              <div className="space-y-4 p-4 border rounded-md">
                <h3 className="font-medium text-sm">Schedule Timing</h3>

                {!allTimeBased && (
                  <Alert>
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription className="text-xs">
                      Start time applies to daily, weekly, monthly and once schedules. Interval/cron schedules are skipped.
                    </AlertDescription>
                  </Alert>
                )}

                <div className="flex items-start space-x-3">
                  <Checkbox
                    id="updateTime"
                    checked={formData.updateTime}
                    onChange={(e: any) => setFormData({ ...formData, updateTime: e.target.checked })}
                  />
                  <div className="flex-1">
                    <Label htmlFor="updateTime" className="cursor-pointer">
                      Update Start Time
                    </Label>
                    {formData.updateTime && (
                      <div className="mt-2">
                        <Input
                          type="time"
                          value={formData.time}
                          onChange={(e) => setFormData({ ...formData, time: e.target.value })}
                          className="w-40"
                        />
                        <p className="text-xs text-gray-500 mt-1">
                          New daily/weekly/monthly/once start time (HH:MM). The cron schedule is regenerated automatically.
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Retention Settings (chain backups only) */}
            {hasChainSchedules && (
              <div className="space-y-4 p-4 border rounded-md">
                <h3 className="font-medium text-sm">Retention Settings (Chain Backups: daily/weekly/interval/cron)</h3>
                
                {!allChainSchedules && (
                  <Alert>
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription className="text-xs">
                      These settings only apply to chain backups (daily/weekly/interval/cron). Other schedule types are skipped.
                    </AlertDescription>
                  </Alert>
                )}

                <div className="space-y-3">
                  <div className="flex items-start space-x-3">
                    <Checkbox
                      id="updateRetention"
                      checked={formData.updateRetention}
                      onChange={(e: any) => setFormData({ ...formData, updateRetention: e.target.checked })}
                    />
                    <div className="flex-1">
                      <Label htmlFor="updateRetention" className="cursor-pointer">
                        Update Retention
                      </Label>
                      {formData.updateRetention && (
                        <div className="mt-2">
                          <Input
                            type="number"
                            min="1"
                            max="30"
                            value={formData.retention}
                            onChange={(e) => setFormData({ ...formData, retention: parseInt(e.target.value) })}
                            className="w-32"
                          />
                          <p className="text-xs text-gray-500 mt-1">
                            Backups before archiving
                          </p>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-start space-x-3">
                    <Checkbox
                      id="updateKeepArchive"
                      checked={formData.updateKeepArchive}
                      onChange={(e: any) => setFormData({ ...formData, updateKeepArchive: e.target.checked })}
                    />
                    <div className="flex-1">
                      <Label htmlFor="updateKeepArchive" className="cursor-pointer">
                        Update Keep Archives
                      </Label>
                      {formData.updateKeepArchive && (
                        <div className="mt-2">
                          <Input
                            type="number"
                            min="0"
                            max="10"
                            value={formData.keepArchive}
                            onChange={(e) => setFormData({ ...formData, keepArchive: parseInt(e.target.value) })}
                            className="w-32"
                          />
                          <p className="text-xs text-gray-500 mt-1">
                            Number of archived chains to keep
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Backup Options (All schedules) */}
            <div className="space-y-4 p-4 border rounded-md">
              <h3 className="font-medium text-sm">Backup Options (All Schedules)</h3>
              
              <div className="space-y-3">
                <div className="flex items-start space-x-3">
                  <Checkbox
                    id="updateCompression"
                    checked={formData.updateCompression}
                    onChange={(e: any) => setFormData({ ...formData, updateCompression: e.target.checked })}
                  />
                  <div className="flex-1">
                    <Label htmlFor="updateCompression" className="cursor-pointer">
                      Update Compression Setting
                    </Label>
                    {formData.updateCompression && (
                      <div className="mt-2 flex items-center space-x-2">
                        <Checkbox
                          id="noCompression"
                          checked={formData.noCompression}
                          onChange={(e: any) => setFormData({ ...formData, noCompression: e.target.checked })}
                        />
                        <Label htmlFor="noCompression" className="cursor-pointer font-normal">
                          Disable compression
                        </Label>
                      </div>
                    )}
                    {formData.updateCompression && !formData.noCompression && (
                      <div className="mt-2">
                        <Label htmlFor="bulkCompressionLevel" className="text-xs text-gray-500">
                          Compression level
                        </Label>
                        <Select
                          id="bulkCompressionLevel"
                          value={formData.compression.toString()}
                          onChange={(e: any) =>
                            setFormData({ ...formData, compression: parseInt(e.target.value, 10) })
                          }
                          className="mt-1 w-56"
                        >
                          <option value="1">1 - Minimal compression</option>
                          <option value="2">2 - Default</option>
                          <option value="3">3 - Good compression</option>
                          <option value="4">4 - Better compression</option>
                          <option value="5">5 - High compression</option>
                          <option value="6">6 - Very high compression</option>
                          <option value="7">7 - Maximum compression</option>
                          <option value="8">8 - Ultra compression</option>
                          <option value="9">9 - Best compression (slowest)</option>
                        </Select>
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-start space-x-3">
                  <Checkbox
                    id="updateVerify"
                    checked={formData.updateVerify}
                    onChange={(e: any) => setFormData({ ...formData, updateVerify: e.target.checked })}
                  />
                  <div className="flex-1">
                    <Label htmlFor="updateVerify" className="cursor-pointer">
                      Update Verification Setting
                    </Label>
                    {formData.updateVerify && (
                      <div className="mt-2 flex items-center space-x-2">
                        <Checkbox
                          id="noVerify"
                          checked={formData.noVerify}
                          onChange={(e: any) => setFormData({ ...formData, noVerify: e.target.checked })}
                        />
                        <Label htmlFor="noVerify" className="cursor-pointer font-normal">
                          Disable verification
                        </Label>
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-start space-x-3">
                  <Checkbox
                    id="updateEnabled"
                    checked={formData.updateEnabled}
                    onChange={(e: any) => setFormData({ ...formData, updateEnabled: e.target.checked })}
                  />
                  <div className="flex-1">
                    <Label htmlFor="updateEnabled" className="cursor-pointer">
                      Update Enabled Status
                    </Label>
                    {formData.updateEnabled && (
                      <div className="mt-2 flex items-center space-x-2">
                        <Checkbox
                          id="enabled"
                          checked={formData.enabled}
                          onChange={(e: any) => setFormData({ ...formData, enabled: e.target.checked })}
                        />
                        <Label htmlFor="enabled" className="cursor-pointer font-normal">
                          Enable schedules
                        </Label>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Retry Settings (All Schedules) */}
            <div className="space-y-4 p-4 border rounded-md bg-amber-50 dark:bg-amber-900/10 dark:border-amber-900/30">
              <h3 className="font-medium text-sm flex items-center">
                <span className="mr-2">♻️</span>
                Retry on Failure
              </h3>

              <div className="space-y-3">
                <div className="flex items-start space-x-3">
                  <Checkbox
                    id="updateRetry"
                    checked={formData.updateRetry}
                    onChange={(e: any) => setFormData({ ...formData, updateRetry: e.target.checked })}
                  />
                  <div className="flex-1">
                    <Label htmlFor="updateRetry" className="cursor-pointer">
                      Update Backup Retry
                    </Label>
                    {formData.updateRetry && (
                      <div className="mt-2 grid grid-cols-2 gap-4">
                        <div>
                          <Label htmlFor="bulkRetryCount" className="text-xs">Retry attempts</Label>
                          <Input
                            id="bulkRetryCount"
                            type="number"
                            min="0"
                            max="10"
                            value={formData.retryCount}
                            onChange={(e) => setFormData({ ...formData, retryCount: Math.max(0, Math.min(10, parseInt(e.target.value) || 0)) })}
                            className="w-32"
                          />
                          <p className="text-xs text-gray-500 mt-1">
                            Retries after the first failure (0 = never retry)
                          </p>
                        </div>
                        <div>
                          <Label htmlFor="bulkRetryDelay" className="text-xs">Delay between retries (minutes)</Label>
                          <Input
                            id="bulkRetryDelay"
                            type="number"
                            min="0"
                            max="1440"
                            value={formData.retryDelayMinutes}
                            onChange={(e) => setFormData({ ...formData, retryDelayMinutes: Math.max(0, Math.min(1440, parseInt(e.target.value) || 0)) })}
                            className="w-32"
                          />
                          <p className="text-xs text-gray-500 mt-1">
                            Wait before each retry
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-start space-x-3">
                  <Checkbox
                    id="updateOffsiteRetry"
                    checked={formData.updateOffsiteRetry}
                    onChange={(e: any) => setFormData({ ...formData, updateOffsiteRetry: e.target.checked })}
                  />
                  <div className="flex-1">
                    <Label htmlFor="updateOffsiteRetry" className="cursor-pointer">
                      Update Offsite Sync Retry
                    </Label>
                    {formData.updateOffsiteRetry && (
                      <div className="mt-2 grid grid-cols-2 gap-4">
                        <div>
                          <Label htmlFor="bulkOffsiteRetryAttempts" className="text-xs">Rsync attempts per host</Label>
                          <Input
                            id="bulkOffsiteRetryAttempts"
                            type="number"
                            min="1"
                            max="10"
                            value={formData.offsiteRetryAttempts}
                            onChange={(e) => setFormData({ ...formData, offsiteRetryAttempts: Math.max(1, Math.min(10, parseInt(e.target.value) || 1)) })}
                            className="w-32"
                          />
                          <p className="text-xs text-gray-500 mt-1">
                            Retried in place, no re-backup (1 = never retry)
                          </p>
                        </div>
                        <div>
                          <Label htmlFor="bulkOffsiteRetryBackoff" className="text-xs">Backoff base (seconds)</Label>
                          <Input
                            id="bulkOffsiteRetryBackoff"
                            type="number"
                            min="1"
                            max="600"
                            value={formData.offsiteRetryBackoffSeconds}
                            onChange={(e) => setFormData({ ...formData, offsiteRetryBackoffSeconds: Math.max(1, Math.min(600, parseInt(e.target.value) || 15)) })}
                            className="w-32"
                          />
                          <p className="text-xs text-gray-500 mt-1">
                            Doubled each attempt (15s → 15s, 30s)
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-start space-x-3">
                  <Checkbox
                    id="updateOffsiteResync"
                    checked={formData.updateOffsiteResync}
                    onChange={(e: any) => setFormData({ ...formData, updateOffsiteResync: e.target.checked })}
                  />
                  <div className="flex-1">
                    <Label htmlFor="updateOffsiteResync" className="cursor-pointer">
                      Update Controller Resync (offsite only)
                    </Label>
                    <p className="text-xs text-gray-500 mt-1">
                      After the rsync attempts above are exhausted, the controller re-runs just the
                      replication — never the VM backup. The queued time appears on the job in
                      Active Backups and History. Leave a field blank to clear the override on every
                      selected schedule, so each falls back to its own Retry on Failure settings.
                    </p>

                    {formData.updateOffsiteResync && (
                      <div className="mt-2 grid grid-cols-2 gap-4">
                        <div>
                          <Label htmlFor="bulkOffsiteResyncAttempts" className="text-xs">Resync attempts</Label>
                          <Input
                            id="bulkOffsiteResyncAttempts"
                            type="number"
                            min="0"
                            max="20"
                            placeholder="Inherit"
                            value={formData.offsiteResyncAttempts}
                            onChange={(e) => {
                              const raw = e.target.value
                              setFormData({
                                ...formData,
                                offsiteResyncAttempts: raw === '' ? '' : Math.max(0, Math.min(20, parseInt(raw) || 0)),
                              })
                            }}
                            className="w-32"
                          />
                          <p className="text-xs text-gray-500 mt-1">
                            Queued resyncs before giving up (0 = never)
                          </p>
                        </div>
                        <div>
                          <Label htmlFor="bulkOffsiteResyncDelay" className="text-xs">Resync delay (minutes)</Label>
                          <Input
                            id="bulkOffsiteResyncDelay"
                            type="number"
                            min="0"
                            max="1440"
                            placeholder="Inherit"
                            value={formData.offsiteResyncDelayMinutes}
                            onChange={(e) => {
                              const raw = e.target.value
                              setFormData({
                                ...formData,
                                offsiteResyncDelayMinutes: raw === '' ? '' : Math.max(0, Math.min(1440, parseInt(raw) || 0)),
                              })
                            }}
                            className="w-32"
                          />
                          <p className="text-xs text-gray-500 mt-1">
                            Wait before each queued resync
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Offsite Settings (All Schedules) */}
            <div className="space-y-4 p-4 border rounded-md bg-blue-50 dark:bg-blue-900/10">
              <h3 className="font-medium text-sm flex items-center">
                <span className="mr-2">📤</span>
                Offsite Backup Settings
              </h3>

              {!canEditOffsite ? (
                <Alert>
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription className="text-xs">
                    The selected schedules span multiple backup hosts (or have no backup host).
                    Offsite settings can only be bulk-edited when all schedules belong to the same backup host.
                  </AlertDescription>
                </Alert>
              ) : (
                <div className="flex items-start space-x-3">
                  <Checkbox
                    id="updateOffsite"
                    checked={formData.updateOffsite}
                    onChange={(e: any) => setFormData({ ...formData, updateOffsite: e.target.checked })}
                  />
                  <div className="flex-1">
                    <Label htmlFor="updateOffsite" className="cursor-pointer">
                      Update Offsite Settings
                    </Label>
                    {formData.updateOffsite && (
                      <div className="mt-3 space-y-3">
                        <div className="flex items-center space-x-2">
                          <Checkbox
                            id="syncToOffsite"
                            checked={formData.syncToOffsite}
                            onChange={(e: any) => setFormData({ ...formData, syncToOffsite: e.target.checked })}
                          />
                          <Label htmlFor="syncToOffsite" className="cursor-pointer font-normal">
                            Sync backups to offsite location(s)
                          </Label>
                        </div>

                        {formData.syncToOffsite && (
                          <div className="space-y-2">
                            <Label>Offsite Hosts</Label>
                            {offsiteLoading ? (
                              <div className="border rounded-lg p-3 bg-white dark:bg-gray-800 flex items-center space-x-2">
                                <Loader2 className="h-4 w-4 animate-spin text-gray-500" />
                                <p className="text-sm text-gray-500">Loading offsite hosts...</p>
                              </div>
                            ) : !offsiteHosts || offsiteHosts.length === 0 ? (
                              <div className="border rounded-lg p-3 bg-white dark:bg-gray-800">
                                <p className="text-sm text-gray-500">No offsite hosts configured yet</p>
                                <p className="text-xs text-gray-400 mt-1">
                                  Add offsite hosts in the Backup Hosts page to enable offsite backup.
                                </p>
                              </div>
                            ) : (
                              <div className="border rounded-lg p-3 space-y-3 max-h-72 overflow-y-auto bg-white dark:bg-gray-800">
                                {offsiteHosts.map((host: any) => {
                                  const checked = formData.offsiteHostIds.includes(host.id)
                                  const selectedPoolId = formData.offsitePoolByHost[host.id] || ''
                                  const pools: any[] = host.storagePools || []
                                  const selectedPool = pools.find((p: any) => p.id === selectedPoolId)
                                  const missingPool = checked && !selectedPoolId
                                  const poolTooFull = !!selectedPool &&
                                    typeof selectedPool.usagePercent === 'number' &&
                                    selectedPool.usagePercent >= 80
                                  return (
                                    <div key={host.id} className="space-y-2 border-b border-gray-100 dark:border-gray-700 pb-2 last:border-b-0 last:pb-0">
                                      <div className="flex items-center space-x-2">
                                        <Checkbox
                                          id={`bulkedit-offsite-${host.id}`}
                                          checked={checked}
                                          onChange={() => handleOffsiteHostToggle(host.id)}
                                        />
                                        <Label htmlFor={`bulkedit-offsite-${host.id}`} className="font-normal cursor-pointer flex-1">
                                          {host.name} ({host.ip})
                                        </Label>
                                        {host.status === 'connected' ? (
                                          <Badge variant="outline" className="text-xs bg-green-50 text-green-700 border-green-200">
                                            Connected
                                          </Badge>
                                        ) : (
                                          <Badge variant="outline" className="text-xs bg-red-50 text-red-700 border-red-200">
                                            Disconnected
                                          </Badge>
                                        )}
                                      </div>
                                      {checked && (
                                        <div className="ml-6 space-y-1">
                                          <Label htmlFor={`bulkedit-offsite-pool-${host.id}`} className="text-xs">
                                            Destination Pool *
                                          </Label>
                                          <Select
                                            id={`bulkedit-offsite-pool-${host.id}`}
                                            value={selectedPoolId}
                                            onChange={(e) => handleOffsitePoolChange(host.id, e.target.value)}
                                            className={missingPool && offsiteValidationAttempted ? 'border-red-500' : ''}
                                          >
                                            <option value="">Select pool...</option>
                                            {pools.length === 0 ? (
                                              <option disabled>No pools configured</option>
                                            ) : (
                                              pools.map((p: any) => (
                                                <option key={p.id} value={p.id}>
                                                  {p.name}
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
                                          {missingPool && offsiteValidationAttempted && pools.length > 0 && (
                                            <p className="text-xs text-red-600">
                                              Select a destination pool for this offsite host.
                                            </p>
                                          )}
                                          {poolTooFull && (
                                            <p className="text-xs text-amber-600">
                                              Selected pool is {selectedPool.usagePercent}% full (≥80%); the server may reject this target.
                                            </p>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  )
                                })}
                              </div>
                            )}
                            <p className="text-xs text-gray-500">
                              Applies the same offsite hosts and pools to all {schedules.length} selected schedule(s).
                            </p>
                          </div>
                        )}

                        {!formData.syncToOffsite && (
                          <p className="text-xs text-gray-500">
                            Offsite sync will be turned off for all selected schedules.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Progress Indicator */}
            {isUpdating && (
              <Alert>
                <Loader2 className="h-4 w-4 animate-spin" />
                <AlertDescription>
                  Updating schedules... {updatedCount} of {schedules.length} completed
                  {failedCount > 0 && `, ${failedCount} failed`}
                </AlertDescription>
              </Alert>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={isUpdating}
            >
              Cancel
            </Button>
            <Button 
              type="submit" 
              disabled={isUpdating}
            >
              {isUpdating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Updating...
                </>
              ) : (
                <>
                  <CheckCircle className="mr-2 h-4 w-4" />
                  Update {schedules.length} Schedule{schedules.length !== 1 ? 's' : ''}
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
