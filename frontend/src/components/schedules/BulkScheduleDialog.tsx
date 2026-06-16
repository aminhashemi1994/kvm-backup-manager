import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { Calendar } from '@/components/ui/calendar'
import { useCreateSchedule } from '@/hooks/useBackups'
import { useVMsByHypervisor } from '@/hooks/useBackupHosts'
import { useOffsiteHostsByBackupHost } from '@/hooks/useOffsiteHosts'
import { Loader2, AlertCircle, CheckCircle, HardDrive } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useQuery } from '@tanstack/react-query'
import { storagePoolsApi } from '@/services/api'
import { toast } from 'sonner'

interface BulkScheduleDialogProps {
  vmIds: string[]
  backupHostId: string
  hypervisorId: string
  onClose: () => void
}

interface CustomDate {
  date: string
  time: string
  method: 'full' | 'inc'
}

export default function BulkScheduleDialog({ vmIds, backupHostId, hypervisorId, onClose }: BulkScheduleDialogProps) {
  const [formData, setFormData] = useState({
    storagePoolId: '',
    scheduleType: 'daily' as 'daily' | 'weekly' | 'custom-days' | 'interval' | 'cron',
    
    // Daily
    time: '02:00',
    incrementalCount: 6,
    retention: 7,
    keepArchive: 2,
    
    // Weekly
    daysOfWeek: [] as number[],
    
    // Custom Days
    customDates: [] as CustomDate[],
    retentionCount: 5,
    
    // Interval
    intervalValue: 12,
    intervalUnit: 'hours' as 'hours' | 'days',
    
    // Cron
    cronExpression: '0 2 * * *',
    
    // Common
    compression: 2,
    noCompression: false,
    noVerify: false,
    enabled: true,
    
    // Offsite
    syncToOffsite: false,
    offsiteHostIds: [] as string[],
  })

  const [selectedCalendarDates, setSelectedCalendarDates] = useState<Date[]>([])
  const [isCreating, setIsCreating] = useState(false)
  const [createdCount, setCreatedCount] = useState(0)
  const [failedCount, setFailedCount] = useState(0)

  const { data: vms } = useVMsByHypervisor(hypervisorId)
  const createSchedule = useCreateSchedule()

  // Load storage pools for selected backup host
  const { data: storagePools, isLoading: poolsLoading } = useQuery({
    queryKey: ['storage-pools', backupHostId],
    queryFn: async () => {
      if (!backupHostId) return []
      const response = await storagePoolsApi.getByBackupHost(backupHostId)
      return response.data.data || []
    },
    enabled: !!backupHostId,
  })

  // Load offsite hosts for selected backup host
  const { data: offsiteHosts, isLoading: offsiteLoading } = useOffsiteHostsByBackupHost(backupHostId)

  const handleOffsiteHostToggle = (hostId: string) => {
    setFormData(prev => ({
      ...prev,
      offsiteHostIds: prev.offsiteHostIds.includes(hostId)
        ? prev.offsiteHostIds.filter(id => id !== hostId)
        : [...prev.offsiteHostIds, hostId]
    }))
  }

  // Get selected VMs
  const selectedVMs = vms?.filter(vm => vmIds.includes(vm.id)) || []

  const handleCalendarSelect = (dates: Date[] | undefined) => {
    if (!dates) {
      setSelectedCalendarDates([])
      setFormData({ ...formData, customDates: [] })
      return
    }
    
    setSelectedCalendarDates(dates)
    
    const newCustomDates: CustomDate[] = dates.map((date, index) => {
      const dateStr = date.toISOString().split('T')[0]
      const existing = formData.customDates.find(cd => cd.date === dateStr)
      
      return existing || {
        date: dateStr,
        time: '02:00',
        method: index === 0 ? 'full' : 'inc'
      }
    })
    
    newCustomDates.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    
    if (newCustomDates.length > 0) {
      newCustomDates[0].method = 'full'
    }
    
    setFormData({ ...formData, customDates: newCustomDates })
  }

  const updateCustomDate = (index: number, field: 'time' | 'method', value: string) => {
    const newCustomDates = [...formData.customDates]
    if (field === 'method' && index === 0) {
      return
    }
    newCustomDates[index] = { ...newCustomDates[index], [field]: value }
    setFormData({ ...formData, customDates: newCustomDates })
  }

  const toggleDayOfWeek = (day: number) => {
    const newDays = formData.daysOfWeek.includes(day)
      ? formData.daysOfWeek.filter(d => d !== day)
      : [...formData.daysOfWeek, day].sort()
    setFormData({ ...formData, daysOfWeek: newDays })
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    // Validation
    if (formData.scheduleType === 'weekly' && formData.daysOfWeek.length === 0) {
      alert('Please select at least one day of the week')
      return
    }
    
    if (formData.scheduleType === 'custom-days' && formData.customDates.length === 0) {
      alert('Please select at least one date on the calendar')
      return
    }

    if (!formData.storagePoolId) {
      alert('Please select a storage pool')
      return
    }

    setIsCreating(true)
    setCreatedCount(0)
    setFailedCount(0)

    // Create schedule for each VM
    for (const vm of selectedVMs) {
      try {
        const data: any = {
          vmId: vm.id,
          storagePoolId: formData.storagePoolId,
          name: `${vm.name} - ${formData.scheduleType} backup`,
          scheduleType: formData.scheduleType,
          noCompression: formData.noCompression,
          noVerify: formData.noVerify,
          enabled: formData.enabled,
          syncToOffsite: formData.syncToOffsite,
          offsiteHostIds: formData.syncToOffsite ? formData.offsiteHostIds : undefined,
        }

        // Add type-specific fields
        switch (formData.scheduleType) {
          case 'daily':
            data.time = formData.time
            data.incrementalCount = formData.incrementalCount
            data.retention = formData.retention
            data.keepArchive = formData.keepArchive
            break
          
          case 'weekly':
            data.time = formData.time
            data.daysOfWeek = formData.daysOfWeek
            data.incrementalCount = formData.incrementalCount
            break
          
          case 'custom-days':
            data.customDates = formData.customDates
            data.retentionCount = formData.retentionCount
            break
          
          case 'interval':
            data.intervalValue = formData.intervalValue
            data.intervalUnit = formData.intervalUnit
            data.incrementalCount = formData.incrementalCount
            break
          
          case 'cron':
            data.cronExpression = formData.cronExpression
            data.incrementalCount = formData.incrementalCount
            break
        }

        await createSchedule.mutateAsync(data)
        setCreatedCount(prev => prev + 1)
      } catch (error) {
        console.error(`Failed to create schedule for ${vm.name}:`, error)
        setFailedCount(prev => prev + 1)
      }
    }

    setIsCreating(false)
    
    if (failedCount === 0) {
      toast.success(`Successfully created ${createdCount} schedules`)
      onClose()
    } else {
      toast.warning(`Created ${createdCount} schedules, ${failedCount} failed`)
    }
  }

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-3xl w-full">
        <DialogHeader>
          <DialogTitle>Create Bulk Backup Schedule</DialogTitle>
          <p className="text-sm text-gray-600 mt-2">
            Create the same schedule for {selectedVMs.length} selected VMs
          </p>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-4">
            {/* Selected VMs */}
            <div className="p-4 border rounded-md bg-blue-50">
              <h3 className="font-medium text-sm mb-2">Selected VMs ({selectedVMs.length})</h3>
              <div className="flex flex-wrap gap-2">
                {selectedVMs.map(vm => (
                  <Badge key={vm.id} variant="outline" className="bg-white">
                    {vm.name}
                  </Badge>
                ))}
              </div>
            </div>

            {/* Storage Pool Selection */}
            <div className="space-y-2">
              <Label htmlFor="storagePool" className="flex items-center gap-2">
                <HardDrive className="h-4 w-4" />
                Storage Pool *
              </Label>
              <Select
                id="storagePool"
                value={formData.storagePoolId}
                onChange={(e) => setFormData({ ...formData, storagePoolId: e.target.value })}
                required
              >
                <option value="">Select storage pool...</option>
                {poolsLoading ? (
                  <option disabled>Loading storage pools...</option>
                ) : !storagePools || storagePools.length === 0 ? (
                  <option disabled>No storage pools available</option>
                ) : (
                  storagePools.map((pool: any) => (
                    <option key={pool.id} value={pool.id}>
                      {pool.name} ({pool.availableGB}GB available of {pool.totalGB}GB)
                    </option>
                  ))
                )}
              </Select>
              {!storagePools || storagePools.length === 0 ? (
                <Alert>
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    No storage pools configured for this backup host. Please create a storage pool first.
                  </AlertDescription>
                </Alert>
              ) : (
                <p className="text-xs text-gray-500">
                  All VMs will use this storage pool
                </p>
              )}
            </div>

            {/* Schedule Type */}
            <div className="space-y-2">
              <Label htmlFor="scheduleType">Schedule Type *</Label>
              <Select
                id="scheduleType"
                value={formData.scheduleType}
                onChange={(e) => setFormData({ ...formData, scheduleType: e.target.value as any })}
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="custom-days">Custom Days (Calendar)</option>
                <option value="interval">Interval</option>
                <option value="cron">Cron Expression</option>
              </Select>
            </div>

            {/* Daily Schedule */}
            {formData.scheduleType === 'daily' && (
              <div className="space-y-4 p-4 border rounded-md bg-gray-50">
                <h3 className="font-medium text-sm">Daily Schedule Configuration</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="time">Time *</Label>
                    <Input
                      id="time"
                      type="time"
                      value={formData.time}
                      onChange={(e) => setFormData({ ...formData, time: e.target.value })}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="retention">Retention *</Label>
                    <Input
                      id="retention"
                      type="number"
                      min="1"
                      max="30"
                      value={formData.retention}
                      onChange={(e) => setFormData({ ...formData, retention: parseInt(e.target.value) })}
                      required
                    />
                    <p className="text-xs text-gray-500">
                      Backups before archiving
                    </p>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="keepArchive">Keep Archives *</Label>
                  <Input
                    id="keepArchive"
                    type="number"
                    min="0"
                    max="10"
                    value={formData.keepArchive}
                    onChange={(e) => setFormData({ ...formData, keepArchive: parseInt(e.target.value) })}
                    required
                  />
                  <p className="text-xs text-gray-500">
                    Number of archived chains to keep
                  </p>
                </div>
              </div>
            )}

            {/* Weekly Schedule */}
            {formData.scheduleType === 'weekly' && (
              <div className="space-y-4 p-4 border rounded-md bg-gray-50">
                <h3 className="font-medium text-sm">Weekly Schedule Configuration</h3>
                <div className="space-y-2">
                  <Label htmlFor="time">Time *</Label>
                  <Input
                    id="time"
                    type="time"
                    value={formData.time}
                    onChange={(e) => setFormData({ ...formData, time: e.target.value })}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label>Days of Week *</Label>
                  <div className="flex gap-2">
                    {dayNames.map((day, index) => (
                      <Button
                        key={index}
                        type="button"
                        variant={formData.daysOfWeek.includes(index) ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => toggleDayOfWeek(index)}
                      >
                        {day}
                      </Button>
                    ))}
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="incrementalCount">Incremental Count *</Label>
                  <Input
                    id="incrementalCount"
                    type="number"
                    min="1"
                    max="30"
                    value={formData.incrementalCount}
                    onChange={(e) => setFormData({ ...formData, incrementalCount: parseInt(e.target.value) || 1 })}
                    required
                  />
                  <p className="text-xs text-gray-500">
                    Number of incremental backups before a new full backup. After this many incrementals, the chain is archived and a new full backup starts.
                  </p>
                </div>
              </div>
            )}

            {/* Custom Days Schedule */}
            {formData.scheduleType === 'custom-days' && (
              <div className="space-y-4 p-4 border rounded-md bg-gray-50">
                <h3 className="font-medium text-sm">Custom Days Configuration</h3>
                <div className="space-y-2">
                  <Label>Select Dates on Calendar *</Label>
                  <Calendar
                    mode="multiple"
                    selected={selectedCalendarDates}
                    onSelect={handleCalendarSelect}
                    className="rounded-md border bg-white"
                    disabled={(date) => date < new Date(new Date().setHours(0, 0, 0, 0))}
                  />
                  <p className="text-xs text-gray-500">
                    Select multiple dates. First date will always be full backup.
                  </p>
                </div>

                {formData.customDates.length > 0 && (
                  <div className="space-y-2">
                    <Label>Selected Dates Configuration</Label>
                    <div className="space-y-2 max-h-60 overflow-y-auto">
                      {formData.customDates.map((cd, index) => (
                        <div key={index} className="flex items-center gap-2 p-2 bg-white rounded border">
                          <span className="text-sm font-medium w-28">
                            {new Date(cd.date).toLocaleDateString()}
                          </span>
                          <Input
                            type="time"
                            value={cd.time}
                            onChange={(e) => updateCustomDate(index, 'time', e.target.value)}
                            className="w-32"
                          />
                          <Select
                            value={cd.method}
                            onChange={(e) => updateCustomDate(index, 'method', e.target.value)}
                            disabled={index === 0}
                            className="w-32"
                          >
                            <option value="full">Full</option>
                            <option value="inc">Incremental</option>
                          </Select>
                          {index === 0 && (
                            <Badge variant="outline" className="text-xs">First (Full)</Badge>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="retentionCount">Retention Count *</Label>
                  <Input
                    id="retentionCount"
                    type="number"
                    min="1"
                    value={formData.retentionCount}
                    onChange={(e) => setFormData({ ...formData, retentionCount: parseInt(e.target.value) })}
                    required
                  />
                  <p className="text-xs text-gray-500">
                    Number of backup sets to keep before deletion
                  </p>
                </div>
              </div>
            )}

            {/* Interval Schedule */}
            {formData.scheduleType === 'interval' && (
              <div className="space-y-4 p-4 border rounded-md bg-gray-50">
                <h3 className="font-medium text-sm">Interval Schedule Configuration</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="intervalValue">Interval Value *</Label>
                    <Input
                      id="intervalValue"
                      type="number"
                      min="1"
                      value={formData.intervalValue}
                      onChange={(e) => setFormData({ ...formData, intervalValue: parseInt(e.target.value) })}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="intervalUnit">Interval Unit *</Label>
                    <Select
                      id="intervalUnit"
                      value={formData.intervalUnit}
                      onChange={(e) => setFormData({ ...formData, intervalUnit: e.target.value as any })}
                    >
                      <option value="hours">Hours</option>
                      <option value="days">Days</option>
                    </Select>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="incrementalCount">Incremental Count *</Label>
                  <Input
                    id="incrementalCount"
                    type="number"
                    min="1"
                    value={formData.incrementalCount}
                    onChange={(e) => setFormData({ ...formData, incrementalCount: parseInt(e.target.value) })}
                    required
                  />
                  <p className="text-xs text-gray-500">
                    Number of incremental backups before archiving (1 full + N inc)
                  </p>
                </div>
              </div>
            )}

            {/* Cron Schedule */}
            {formData.scheduleType === 'cron' && (
              <div className="space-y-4 p-4 border rounded-md bg-gray-50">
                <h3 className="font-medium text-sm">Cron Schedule Configuration</h3>
                <div className="space-y-2">
                  <Label htmlFor="cronExpression">Cron Expression *</Label>
                  <Input
                    id="cronExpression"
                    placeholder="0 2 * * *"
                    value={formData.cronExpression}
                    onChange={(e) => setFormData({ ...formData, cronExpression: e.target.value })}
                    required
                  />
                  <p className="text-xs text-gray-500">
                    Format: minute hour day month weekday (e.g., "0 2 * * *" = daily at 2 AM)
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="incrementalCount">Incremental Count *</Label>
                  <Input
                    id="incrementalCount"
                    type="number"
                    min="1"
                    value={formData.incrementalCount}
                    onChange={(e) => setFormData({ ...formData, incrementalCount: parseInt(e.target.value) })}
                    required
                  />
                  <p className="text-xs text-gray-500">
                    Number of incremental backups before archiving (1 full + N inc)
                  </p>
                </div>
              </div>
            )}

            {/* Common Options */}
            <div className="space-y-4 p-4 border rounded-md">
              <h3 className="font-medium text-sm">Backup Options</h3>
              
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="noCompression"
                  checked={formData.noCompression}
                  onChange={(e: any) => setFormData({ ...formData, noCompression: e.target.checked })}
                />
                <Label htmlFor="noCompression">Disable compression</Label>
              </div>

              <div className="flex items-center space-x-2">
                <Checkbox
                  id="noVerify"
                  checked={formData.noVerify}
                  onChange={(e: any) => setFormData({ ...formData, noVerify: e.target.checked })}
                />
                <Label htmlFor="noVerify">Disable verification</Label>
              </div>
            </div>

            {/* Offsite Backup Options */}
            <div className="space-y-4 p-4 border rounded-md bg-blue-50 dark:bg-blue-900/10">
              <h3 className="font-medium text-sm flex items-center">
                <span className="mr-2">📤</span>
                Offsite Backup (Optional)
              </h3>
              
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="syncToOffsite"
                  checked={formData.syncToOffsite}
                  onChange={(e: any) => setFormData({ ...formData, syncToOffsite: e.target.checked })}
                />
                <Label htmlFor="syncToOffsite">Sync backups to offsite location(s)</Label>
              </div>

              {formData.syncToOffsite && (
                <div className="space-y-2 pt-2">
                  <Label>Offsite Hosts</Label>
                  {offsiteLoading ? (
                    <div className="border rounded-lg p-3 bg-white dark:bg-gray-800 flex items-center space-x-2">
                      <Loader2 className="h-4 w-4 animate-spin text-gray-500" />
                      <p className="text-sm text-gray-500">Loading offsite hosts...</p>
                    </div>
                  ) : !offsiteHosts || offsiteHosts.length === 0 ? (
                    <div className="border rounded-lg p-3 bg-white dark:bg-gray-800">
                      <p className="text-sm text-gray-500">
                        No offsite hosts configured yet
                      </p>
                      <p className="text-xs text-gray-400 mt-1">
                        Add offsite hosts in the Backup Hosts page to enable offsite backup.
                      </p>
                    </div>
                  ) : (
                    <div className="border rounded-lg p-3 space-y-2 max-h-40 overflow-y-auto bg-white dark:bg-gray-800">
                      {offsiteHosts.map((host: any) => (
                        <div key={host.id} className="flex items-center space-x-2">
                          <Checkbox
                            id={`bulk-offsite-${host.id}`}
                            checked={formData.offsiteHostIds.includes(host.id)}
                            onChange={() => handleOffsiteHostToggle(host.id)}
                          />
                          <Label htmlFor={`bulk-offsite-${host.id}`} className="font-normal cursor-pointer flex-1">
                            {host.name} ({host.ip})
                          </Label>
                          {host.status === 'online' ? (
                            <Badge variant="outline" className="text-xs bg-green-50 text-green-700 border-green-200">
                              Connected
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-xs bg-red-50 text-red-700 border-red-200">
                              Disconnected
                            </Badge>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="text-xs text-gray-600 dark:text-gray-400">
                    Select one or more offsite hosts. Backups for all {selectedVMs.length} VM(s) will be synced after completion.
                  </p>
                </div>
              )}
            </div>

            {/* Progress Indicator */}
            {isCreating && (
              <Alert>
                <Loader2 className="h-4 w-4 animate-spin" />
                <AlertDescription>
                  Creating schedules... {createdCount} of {selectedVMs.length} completed
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
              disabled={isCreating}
            >
              Cancel
            </Button>
            <Button 
              type="submit" 
              disabled={isCreating || !formData.storagePoolId}
            >
              {isCreating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <CheckCircle className="mr-2 h-4 w-4" />
                  Create {selectedVMs.length} Schedules
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
