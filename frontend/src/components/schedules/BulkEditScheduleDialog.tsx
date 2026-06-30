import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { useUpdateSchedule } from '@/hooks/useBackups'
import { Loader2, AlertCircle, CheckCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { toast } from 'sonner'

interface BulkEditScheduleDialogProps {
  scheduleIds: string[]
  schedules: any[]
  onClose: () => void
}

export default function BulkEditScheduleDialog({ scheduleIds, schedules, onClose }: BulkEditScheduleDialogProps) {
  const [formData, setFormData] = useState({
    // Flags to indicate which fields to update
    updateTime: false,
    updateRetention: false,
    updateKeepArchive: false,
    updateCompression: false,
    updateVerify: false,
    updateEnabled: false,
    
    // Values
    time: '02:00',
    retention: 7,
    keepArchive: 2,
    noCompression: false,
    noVerify: false,
    enabled: true,
  })

  const [isUpdating, setIsUpdating] = useState(false)
  const [updatedCount, setUpdatedCount] = useState(0)
  const [failedCount, setFailedCount] = useState(0)

  const updateSchedule = useUpdateSchedule()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    // Check if at least one field is selected for update
    const hasUpdates = formData.updateTime ||
                       formData.updateRetention || 
                       formData.updateKeepArchive || 
                       formData.updateCompression || 
                       formData.updateVerify || 
                       formData.updateEnabled

    if (!hasUpdates) {
      toast.error('Please select at least one field to update')
      return
    }

    if (formData.updateTime && !/^\d{2}:\d{2}$/.test(formData.time)) {
      toast.error('Please enter a valid start time (HH:MM)')
      return
    }

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
        }
        if (formData.updateVerify) {
          updates.noVerify = formData.noVerify
        }
        if (formData.updateEnabled) {
          updates.enabled = formData.enabled
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
