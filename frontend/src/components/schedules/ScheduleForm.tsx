import { useState, useEffect, useMemo } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { Calendar } from '@/components/ui/calendar'
import { useCreateSchedule, useUpdateSchedule } from '@/hooks/useBackups'
import { useBackupHosts, useHypervisorsByBackupHost, useVMsByHypervisor } from '@/hooks/useBackupHosts'
import { useOffsiteHostsByBackupHost } from '@/hooks/useOffsiteHosts'
import { Loader2, Trash2, Plus, Search, HardDrive, AlertCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useQuery } from '@tanstack/react-query'
import { storagePoolsApi } from '@/services/api'

interface ScheduleFormProps {
  schedule?: any
  onClose: () => void
}

interface CustomDate {
  date: string
  time: string
  method: 'full' | 'inc'
}

export default function ScheduleForm({ schedule, onClose }: ScheduleFormProps) {
  const [formData, setFormData] = useState({
    vmId: '',
    storagePoolId: '',
    name: '',
    scheduleType: 'daily' as 'daily' | 'weekly' | 'custom-days' | 'interval' | 'cron' | 'once' | 'monthly',
    
    // Daily
    time: '02:00',
    incrementalCount: 6,
    retention: 7,
    keepArchive: 2,
    
    // Weekly
    daysOfWeek: [] as number[],
    fullBackupDay: 1,
    
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
    
    // Missed-run policy (Item 1)
    missedRunPolicy: 'immediate' as 'immediate' | 'most-recent' | 'skip',
    missedRunGracePeriodMinutes: 360,
    
    // Offsite - Changed to support multiple hosts
    syncToOffsite: false,
    offsiteHostIds: [] as string[], // Changed from offsiteHostId to offsiteHostIds array
  })

  // Hierarchical selection state
  const [selectedBackupHostId, setSelectedBackupHostId] = useState('')
  const [selectedHypervisorId, setSelectedHypervisorId] = useState('')
  const [vmSearchQuery, setVmSearchQuery] = useState('')

  const [selectedCalendarDates, setSelectedCalendarDates] = useState<Date[]>([])

  // Load data based on selections
  const { data: backupHosts } = useBackupHosts()
  const { data: hypervisors } = useHypervisorsByBackupHost(selectedBackupHostId)
  const { data: vms } = useVMsByHypervisor(selectedHypervisorId)
  
  // Load storage pools for selected backup host
  const { data: storagePools, isLoading: poolsLoading } = useQuery({
    queryKey: ['storage-pools', selectedBackupHostId],
    queryFn: async () => {
      if (!selectedBackupHostId) return []
      const response = await storagePoolsApi.getByBackupHost(selectedBackupHostId)
      return response.data.data || []
    },
    enabled: !!selectedBackupHostId,
  })
  
  // Load offsite hosts for selected backup host
  const { data: offsiteHosts, isLoading: offsiteLoading, error: offsiteError } = useOffsiteHostsByBackupHost(selectedBackupHostId)
  
  console.log('ScheduleForm offsite hosts:', { selectedBackupHostId, offsiteHosts, offsiteLoading, offsiteError })
  
  const createSchedule = useCreateSchedule()
  const updateSchedule = useUpdateSchedule()

  // Filter VMs based on search query
  const filteredVMs = useMemo(() => {
    if (!vms) return []
    if (!vmSearchQuery.trim()) return vms
    
    const query = vmSearchQuery.toLowerCase()
    return vms.filter(vm => 
      vm.name.toLowerCase().includes(query) ||
      vm.id.toLowerCase().includes(query)
    )
  }, [vms, vmSearchQuery])

  const handleOffsiteHostToggle = (hostId: string) => {
    setFormData(prev => ({
      ...prev,
      offsiteHostIds: prev.offsiteHostIds.includes(hostId)
        ? prev.offsiteHostIds.filter(id => id !== hostId)
        : [...prev.offsiteHostIds, hostId]
    }))
  }

  useEffect(() => {
    if (schedule) {
      setFormData({
        vmId: schedule.vmId,
        storagePoolId: schedule.storagePoolId || '',
        name: schedule.name,
        scheduleType: schedule.scheduleType || 'daily',
        time: schedule.time || '02:00',
        incrementalCount: schedule.incrementalCount || 6,
        retention: schedule.retention || 7,
        keepArchive: schedule.keepArchive || 2,
        daysOfWeek: schedule.daysOfWeek || [],
        fullBackupDay: schedule.fullBackupDay !== undefined ? schedule.fullBackupDay : 1,
        customDates: schedule.customDates || [],
        retentionCount: schedule.retentionCount || 5,
        intervalValue: schedule.intervalValue || 12,
        intervalUnit: schedule.intervalUnit || 'hours',
        cronExpression: schedule.cronExpression || '0 2 * * *',
        compression: schedule.compression || 2,
        noCompression: schedule.noCompression || false,
        noVerify: schedule.noVerify || false,
        enabled: schedule.enabled !== false,
        missedRunPolicy: schedule.missedRunPolicy || 'immediate',
        missedRunGracePeriodMinutes: typeof schedule.missedRunGracePeriodMinutes === 'number'
          ? schedule.missedRunGracePeriodMinutes : 360,
        syncToOffsite: schedule.syncToOffsite || false,
        offsiteHostIds: schedule.offsiteHostIds || (schedule.offsiteHostId ? [schedule.offsiteHostId] : []),
      })
      
      // Load custom dates into calendar
      if (schedule.customDates && schedule.customDates.length > 0) {
        const dates = schedule.customDates.map((cd: CustomDate) => new Date(cd.date))
        setSelectedCalendarDates(dates)
      }
    }
  }, [schedule])

  // Reset hypervisor and VM when backup host changes
  useEffect(() => {
    setSelectedHypervisorId('')
    setFormData(prev => ({ ...prev, vmId: '' }))
    setVmSearchQuery('')
  }, [selectedBackupHostId])

  // Reset VM when hypervisor changes
  useEffect(() => {
    setFormData(prev => ({ ...prev, vmId: '' }))
    setVmSearchQuery('')
  }, [selectedHypervisorId])

  const handleCalendarSelect = (dates: Date[] | undefined) => {
    if (!dates) {
      setSelectedCalendarDates([])
      setFormData({ ...formData, customDates: [] })
      return
    }
    
    setSelectedCalendarDates(dates)
    
    // Create or update customDates based on selected calendar dates
    const newCustomDates: CustomDate[] = dates.map((date, index) => {
      const dateStr = date.toISOString().split('T')[0]
      const existing = formData.customDates.find(cd => cd.date === dateStr)
      
      return existing || {
        date: dateStr,
        time: '02:00',
        method: index === 0 ? 'full' : 'inc' // First one is always full
      }
    })
    
    // Sort by date
    newCustomDates.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    
    // Ensure first is full
    if (newCustomDates.length > 0) {
      newCustomDates[0].method = 'full'
    }
    
    setFormData({ ...formData, customDates: newCustomDates })
  }

  const updateCustomDate = (index: number, field: 'time' | 'method', value: string) => {
    const newCustomDates = [...formData.customDates]
    if (field === 'method' && index === 0) {
      // First one must always be full
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

    const data: any = {
      vmId: formData.vmId,
      storagePoolId: formData.storagePoolId,
      name: formData.name,
      scheduleType: formData.scheduleType,
      compression: formData.noCompression ? 0 : formData.compression,
      noCompression: formData.noCompression,
      noVerify: formData.noVerify,
      enabled: formData.enabled,
      missedRunPolicy: formData.missedRunPolicy,
      missedRunGracePeriodMinutes: formData.missedRunGracePeriodMinutes,
      syncToOffsite: formData.syncToOffsite,
      offsiteHostIds: formData.syncToOffsite && formData.offsiteHostIds.length > 0 ? formData.offsiteHostIds : undefined,
    }

    // Add type-specific fields
    switch (formData.scheduleType) {
      case 'daily':
        data.time = formData.time
        data.incrementalCount = formData.incrementalCount
        break
      
      case 'weekly':
        data.time = formData.time
        data.daysOfWeek = formData.daysOfWeek
        data.fullBackupDay = formData.fullBackupDay
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
      
      case 'once':
        data.time = formData.time
        break
      
      case 'monthly':
        data.time = formData.time
        break
    }

    if (schedule) {
      await updateSchedule.mutateAsync({ id: schedule.id, data })
    } else {
      await createSchedule.mutateAsync(data)
    }
    
    onClose()
  }

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-3xl w-full">
        <DialogHeader>
          <DialogTitle>{schedule ? 'Edit Schedule' : 'Create Backup Schedule'}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-4">
            {/* Hierarchical VM Selection */}
            <div className="space-y-4 p-4 border rounded-md bg-gray-50">
              <h3 className="font-medium text-sm">Select Virtual Machine *</h3>
              
              {/* Step 1: Backup Host */}
              <div className="space-y-2">
                <Label htmlFor="backupHostId">1. Backup Host *</Label>
                <Select
                  id="backupHostId"
                  value={selectedBackupHostId}
                  onChange={(e) => setSelectedBackupHostId(e.target.value)}
                  required
                >
                  <option value="">Select backup host</option>
                  {backupHosts?.map((host) => (
                    <option key={host.id} value={host.id}>
                      {host.name} ({host.url})
                    </option>
                  ))}
                </Select>
              </div>

              {/* Step 2: Hypervisor */}
              {selectedBackupHostId && (
                <div className="space-y-2">
                  <Label htmlFor="hypervisorId">2. Hypervisor *</Label>
                  <Select
                    id="hypervisorId"
                    value={selectedHypervisorId}
                    onChange={(e) => setSelectedHypervisorId(e.target.value)}
                    required
                  >
                    <option value="">Select hypervisor</option>
                    {hypervisors?.map((hypervisor) => (
                      <option key={hypervisor.id} value={hypervisor.id}>
                        {hypervisor.name} ({hypervisor.ip}:{hypervisor.port})
                      </option>
                    ))}
                  </Select>
                  {hypervisors && hypervisors.length === 0 && (
                    <p className="text-xs text-yellow-600">
                      No hypervisors found for this backup host
                    </p>
                  )}
                </div>
              )}

              {/* Step 3: VM with Search */}
              {selectedHypervisorId && (
                <div className="space-y-2">
                  <Label htmlFor="vmId">3. Virtual Machine *</Label>
                  
                  {/* Search Input */}
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                    <Input
                      type="text"
                      placeholder="Search VMs..."
                      value={vmSearchQuery}
                      onChange={(e) => setVmSearchQuery(e.target.value)}
                      className="pl-10"
                    />
                  </div>

                  {/* VM Dropdown */}
                  <Select
                    id="vmId"
                    value={formData.vmId}
                    onChange={(e) => setFormData({ ...formData, vmId: e.target.value })}
                    required
                  >
                    <option value="">Select VM</option>
                    {filteredVMs?.map((vm) => (
                      <option key={vm.id} value={vm.id}>
                        {vm.name} {vm.state ? `(${vm.state})` : ''}
                      </option>
                    ))}
                  </Select>
                  
                  {vms && vms.length === 0 && (
                    <p className="text-xs text-yellow-600">
                      No VMs found on this hypervisor
                    </p>
                  )}
                  
                  {vms && vms.length > 0 && filteredVMs.length === 0 && vmSearchQuery && (
                    <p className="text-xs text-gray-500">
                      No VMs match "{vmSearchQuery}"
                    </p>
                  )}
                  
                  {vms && vms.length > 0 && (
                    <p className="text-xs text-gray-500">
                      {filteredVMs.length} of {vms.length} VMs shown
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Schedule Name */}
            <div className="space-y-2">
              <Label htmlFor="name">Schedule Name *</Label>
              <Input
                id="name"
                placeholder="Daily backup"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                required
              />
            </div>

            {/* Storage Pool Selection - REQUIRED */}
            {selectedBackupHostId && (
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
                    Select where scheduled backups will be stored
                  </p>
                )}
              </div>
            )}

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
                <option value="once">Once (One-time backup)</option>
                <option value="monthly">Monthly</option>
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
                  <Label htmlFor="fullBackupDay">Full Backup Day *</Label>
                  <Select
                    id="fullBackupDay"
                    value={formData.fullBackupDay.toString()}
                    onChange={(e) => setFormData({ ...formData, fullBackupDay: parseInt(e.target.value) })}
                  >
                    {dayNames.map((day, index) => (
                      <option key={index} value={index}>
                        {day}
                      </option>
                    ))}
                  </Select>
                  <p className="text-xs text-gray-500">
                    This day will run full backup, others will run incremental
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

            {/* Once Schedule */}
            {formData.scheduleType === 'once' && (
              <div className="space-y-4 p-4 border rounded-md bg-gray-50">
                <h3 className="font-medium text-sm">One-Time Backup Configuration</h3>
                <div className="space-y-2">
                  <Label htmlFor="time">Scheduled Time *</Label>
                  <Input
                    id="time"
                    type="time"
                    value={formData.time}
                    onChange={(e) => setFormData({ ...formData, time: e.target.value })}
                    required
                  />
                  <p className="text-xs text-gray-500">
                    The backup will run once at this time
                  </p>
                </div>
                <Alert>
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    This backup will run once at the specified time and will not repeat. No conflicts with other schedule types.
                  </AlertDescription>
                </Alert>
              </div>
            )}

            {/* Monthly Schedule */}
            {formData.scheduleType === 'monthly' && (
              <div className="space-y-4 p-4 border rounded-md bg-gray-50">
                <h3 className="font-medium text-sm">Monthly Schedule Configuration</h3>
                <div className="space-y-2">
                  <Label htmlFor="time">Scheduled Time *</Label>
                  <Input
                    id="time"
                    type="time"
                    value={formData.time}
                    onChange={(e) => setFormData({ ...formData, time: e.target.value })}
                    required
                  />
                  <p className="text-xs text-gray-500">
                    Backup will run on the 1st of each month at this time
                  </p>
                </div>
                <Alert>
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    Monthly backups run on the 1st of each month. No conflicts with other schedule types.
                  </AlertDescription>
                </Alert>
              </div>
            )}

            {/* Common Options */}
            <div className="space-y-4 p-4 border rounded-md">
              <h3 className="font-medium text-sm">Backup Options</h3>
              
              <div className="space-y-2">
                <Label htmlFor="compression">Compression Level</Label>
                <Select
                  id="compression"
                  value={formData.compression.toString()}
                  onChange={(e) => setFormData({ ...formData, compression: parseInt(e.target.value), noCompression: false })}
                  disabled={formData.noCompression}
                >
                  <option value="0">0 - No compression (fastest)</option>
                  <option value="1">1 - Minimal compression</option>
                  <option value="2">2 - Balanced (recommended)</option>
                  <option value="3">3 - Good compression</option>
                  <option value="4">4 - Better compression</option>
                  <option value="5">5 - High compression</option>
                  <option value="6">6 - Very high compression</option>
                  <option value="7">7 - Maximum compression</option>
                  <option value="8">8 - Ultra compression</option>
                  <option value="9">9 - Best compression (slowest)</option>
                </Select>
                <p className="text-xs text-gray-500">
                  Higher levels = smaller files but slower backup. Level 2 is recommended for most cases.
                </p>
              </div>
              
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

            {/* Missed-Run Policy (Item 1) */}
            <div className="space-y-4 p-4 border rounded-md bg-amber-50">
              <h3 className="font-medium text-sm flex items-center">
                <span className="mr-2">🔄</span>
                Missed Run Handling
              </h3>
              <p className="text-xs text-gray-600">
                What should happen if the controller is down when this schedule should fire?
              </p>
              
              <div className="space-y-2">
                <Label htmlFor="missedRunPolicy">Policy</Label>
                <Select
                  id="missedRunPolicy"
                  value={formData.missedRunPolicy}
                  onChange={(e) => setFormData({ ...formData, missedRunPolicy: e.target.value as any })}
                >
                  <option value="immediate">Run immediately when back online (default)</option>
                  <option value="most-recent">Run only the most recent missed occurrence</option>
                  <option value="skip">Skip missed runs (log only)</option>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="missedRunGracePeriod">Grace Period (minutes)</Label>
                <Input
                  id="missedRunGracePeriod"
                  type="number"
                  min="0"
                  max="10080"
                  value={formData.missedRunGracePeriodMinutes}
                  onChange={(e) => setFormData({ ...formData, missedRunGracePeriodMinutes: parseInt(e.target.value) || 0 })}
                />
                <p className="text-xs text-gray-500">
                  Missed runs older than this many minutes will not be replayed (0 = no limit, default 360 = 6 hours)
                </p>
              </div>
            </div>

            {/* Offsite Backup Options */}
            <div className="space-y-4 p-4 border rounded-md bg-blue-50">
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
                    <div className="border rounded-lg p-3 bg-white flex items-center space-x-2">
                      <Loader2 className="h-4 w-4 animate-spin text-gray-500" />
                      <p className="text-sm text-gray-500">Loading offsite hosts...</p>
                    </div>
                  ) : offsiteError ? (
                    <div className="border rounded-lg p-3 bg-red-50">
                      <p className="text-sm text-red-600">
                        Error loading offsite hosts. Please try again.
                      </p>
                    </div>
                  ) : !selectedBackupHostId ? (
                    <div className="border rounded-lg p-3 bg-yellow-50">
                      <p className="text-sm text-yellow-700">
                        Please select a backup host first to see available offsite hosts.
                      </p>
                    </div>
                  ) : !offsiteHosts || offsiteHosts.length === 0 ? (
                    <div className="border rounded-lg p-3 bg-white">
                      <p className="text-sm text-gray-500">
                        No offsite hosts configured yet
                      </p>
                      <p className="text-xs text-gray-400 mt-1">
                        Add offsite hosts in the Backup Hosts page to enable offsite backup.
                      </p>
                    </div>
                  ) : (
                    <div className="border rounded-lg p-3 space-y-2 max-h-40 overflow-y-auto bg-white">
                      {offsiteHosts.map((host: any) => (
                        <div key={host.id} className="flex items-center space-x-2">
                          <Checkbox
                            id={`offsite-${host.id}`}
                            checked={formData.offsiteHostIds.includes(host.id)}
                            onChange={() => handleOffsiteHostToggle(host.id)}
                          />
                          <Label htmlFor={`offsite-${host.id}`} className="font-normal cursor-pointer flex-1">
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
                  <p className="text-xs text-gray-600">
                    Select one or more offsite hosts. Backups will be synced after completion.
                  </p>
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={createSchedule.isPending || updateSchedule.isPending}
            >
              Cancel
            </Button>
            <Button 
              type="submit" 
              disabled={createSchedule.isPending || updateSchedule.isPending || !formData.storagePoolId}
            >
              {(createSchedule.isPending || updateSchedule.isPending) && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {schedule ? 'Update' : 'Create'} Schedule
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
