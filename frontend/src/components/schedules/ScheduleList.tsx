import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Plus, Trash2, Edit, Power, Loader2, CheckSquare, Search, XCircle } from 'lucide-react'
import ScheduleForm from './ScheduleForm'
import BulkEditScheduleDialog from './BulkEditScheduleDialog'
import { useSchedules, useDeleteSchedule, useToggleSchedule } from '@/hooks/useBackups'
import { getStatusColor } from '@/lib/utils'
import { toast } from 'sonner'

export default function ScheduleList() {
  const [showForm, setShowForm] = useState(false)
  const [editingSchedule, setEditingSchedule] = useState<any>(null)
  const [selectedScheduleIds, setSelectedScheduleIds] = useState<Set<string>>(new Set())
  const [showBulkEditDialog, setShowBulkEditDialog] = useState(false)
  const [searchQuery, setSearchQuery] = useState<string>('')
  
  const { data: schedules, isLoading } = useSchedules()
  const deleteSchedule = useDeleteSchedule()
  const toggleSchedule = useToggleSchedule()

  // Filter schedules by search query
  const filteredSchedules = schedules?.filter(schedule => {
    if (!searchQuery.trim()) return true
    const query = searchQuery.toLowerCase().trim()
    return (
      schedule.name.toLowerCase().includes(query) ||
      schedule.vmName?.toLowerCase().includes(query)
    )
  }) || []

  const handleDelete = async (id: string, name: string) => {
    if (confirm(`Are you sure you want to delete schedule "${name}"?`)) {
      await deleteSchedule.mutateAsync(id)
    }
  }

  const handleToggle = async (id: string) => {
    await toggleSchedule.mutateAsync(id)
  }

  const handleEdit = (schedule: any) => {
    setEditingSchedule(schedule)
    setShowForm(true)
  }

  const handleCloseForm = () => {
    setShowForm(false)
    setEditingSchedule(null)
  }

  const handleToggleScheduleSelection = (scheduleId: string) => {
    setSelectedScheduleIds(prev => {
      const newSet = new Set(prev)
      if (newSet.has(scheduleId)) {
        newSet.delete(scheduleId)
      } else {
        newSet.add(scheduleId)
      }
      return newSet
    })
  }

  const handleSelectAll = () => {
    if (selectedScheduleIds.size === filteredSchedules.length) {
      setSelectedScheduleIds(new Set())
    } else {
      setSelectedScheduleIds(new Set(filteredSchedules.map(s => s.id)))
    }
  }

  const handleBulkDelete = async () => {
    if (selectedScheduleIds.size === 0) return
    
    if (confirm(`Are you sure you want to delete ${selectedScheduleIds.size} schedule(s)?`)) {
      let successCount = 0
      let failCount = 0
      
      for (const id of selectedScheduleIds) {
        try {
          await deleteSchedule.mutateAsync(id)
          successCount++
        } catch (error) {
          failCount++
        }
      }
      
      setSelectedScheduleIds(new Set())
      
      if (failCount === 0) {
        toast.success(`Successfully deleted ${successCount} schedule(s)`)
      } else {
        toast.warning(`Deleted ${successCount} schedule(s), ${failCount} failed`)
      }
    }
  }

  const handleBulkEdit = () => {
    if (selectedScheduleIds.size === 0) return
    setShowBulkEditDialog(true)
  }

  const handleBulkToggle = async (enable: boolean) => {
    if (selectedScheduleIds.size === 0) return
    
    let successCount = 0
    let failCount = 0
    
    for (const id of selectedScheduleIds) {
      try {
        await toggleSchedule.mutateAsync(id)
        successCount++
      } catch (error) {
        failCount++
      }
    }
    
    setSelectedScheduleIds(new Set())
    
    if (failCount === 0) {
      toast.success(`Successfully ${enable ? 'enabled' : 'disabled'} ${successCount} schedule(s)`)
    } else {
      toast.warning(`Updated ${successCount} schedule(s), ${failCount} failed`)
    }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Backup Schedules</CardTitle>
            <div className="flex items-center gap-2">
              {selectedScheduleIds.size > 0 && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleBulkEdit}
                  >
                    <Edit className="h-4 w-4 mr-2" />
                    Edit ({selectedScheduleIds.size})
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleBulkDelete}
                  >
                    <Trash2 className="h-4 w-4 mr-2 text-red-600" />
                    Delete ({selectedScheduleIds.size})
                  </Button>
                </>
              )}
              <Button onClick={() => setShowForm(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Create Schedule
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
            </div>
          ) : schedules && schedules.length > 0 ? (
            <>
              {/* Search Bar */}
              <div className="mb-4">
                <div className="relative max-w-md">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search schedules by name or VM..."
                    className="w-full pl-10 pr-10 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                  {searchQuery && (
                    <button
                      onClick={() => setSearchQuery('')}
                      className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600"
                    >
                      <XCircle className="h-4 w-4" />
                    </button>
                  )}
                </div>
                {searchQuery && (
                  <p className="text-xs text-gray-500 mt-1">
                    Showing {filteredSchedules.length} of {schedules.length} schedules
                  </p>
                )}
              </div>

              {filteredSchedules.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-gray-500">No schedules found matching "{searchQuery}"</p>
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => setSearchQuery('')}
                    className="mt-2"
                  >
                    Clear search
                  </Button>
                </div>
              ) : (
                <>
                  {/* Bulk Actions Bar */}
                  <div className="mb-4 flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleSelectAll}
                    >
                      <CheckSquare className="h-4 w-4 mr-2" />
                      {selectedScheduleIds.size === filteredSchedules.length && filteredSchedules.length > 0
                        ? 'Deselect All'
                        : 'Select All'}
                    </Button>
                    {selectedScheduleIds.size > 0 && (
                      <span className="text-sm text-gray-600">
                        {selectedScheduleIds.size} of {filteredSchedules.length} selected
                      </span>
                    )}
                  </div>

                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-12">
                          <Checkbox
                            checked={
                              selectedScheduleIds.size === filteredSchedules.length &&
                              filteredSchedules.length > 0
                            }
                            onChange={handleSelectAll}
                          />
                        </TableHead>
                        <TableHead>Name</TableHead>
                        <TableHead>VM</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Schedule</TableHead>
                    <TableHead>Retention</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                {filteredSchedules.map((schedule) => {
                  const getScheduleInfo = () => {
                    switch (schedule.scheduleType) {
                      case 'daily':
                        return `Daily at ${schedule.time || '00:00'}`
                      case 'weekly':
                        const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
                        const selectedDays = schedule.daysOfWeek?.map((d: number) => days[d]).join(', ') || 'Not set'
                        return `${selectedDays} at ${schedule.time || '00:00'}`
                      case 'custom-days':
                        return `${schedule.customDates?.length || 0} custom dates`
                      case 'interval':
                        return `Every ${schedule.intervalValue} ${schedule.intervalUnit}`
                      case 'cron':
                        return schedule.cronHuman || schedule.cronExpression
                      default:
                        return schedule.cronHuman || schedule.cronExpression || 'Unknown'
                    }
                  }

                  const getRetentionInfo = () => {
                    switch (schedule.scheduleType) {
                      case 'daily':
                      case 'interval':
                      case 'cron':
                        return `1 full + ${schedule.incrementalCount || 0} inc`
                      case 'weekly':
                        return '7 backups (1 full + 6 inc)'
                      case 'custom-days':
                        return `Keep ${schedule.retentionCount || 0} sets`
                      default:
                        return 'N/A'
                    }
                  }

                  const getTypeLabel = () => {
                    switch (schedule.scheduleType) {
                      case 'daily': return 'Daily'
                      case 'weekly': return 'Weekly'
                      case 'custom-days': return 'Custom'
                      case 'interval': return 'Interval'
                      case 'cron': return 'Cron'
                      default: return 'Unknown'
                    }
                  }

                  return (
                    <TableRow key={schedule.id}>
                      <TableCell>
                        <Checkbox
                          checked={selectedScheduleIds.has(schedule.id)}
                          onChange={() => handleToggleScheduleSelection(schedule.id)}
                        />
                      </TableCell>
                      <TableCell className="font-medium">{schedule.name}</TableCell>
                      <TableCell>{schedule.vmName}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{getTypeLabel()}</Badge>
                      </TableCell>
                      <TableCell>
                        <div>
                          <p className="text-sm">{getScheduleInfo()}</p>
                        </div>
                      </TableCell>
                      <TableCell>
                        <p className="text-sm text-gray-600">{getRetentionInfo()}</p>
                      </TableCell>
                      <TableCell>
                        <Badge className={schedule.enabled ? getStatusColor('online') : getStatusColor('offline')}>
                          {schedule.enabled ? 'Enabled' : 'Disabled'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center space-x-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleToggle(schedule.id)}
                            disabled={toggleSchedule.isPending}
                            title={schedule.enabled ? 'Disable schedule' : 'Enable schedule'}
                          >
                            <Power className={`h-4 w-4 ${schedule.enabled ? 'text-green-600' : 'text-gray-400'}`} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleEdit(schedule)}
                            title="Edit schedule"
                          >
                            <Edit className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDelete(schedule.id, schedule.name)}
                            disabled={deleteSchedule.isPending}
                            title="Delete schedule"
                          >
                            <Trash2 className="h-4 w-4 text-red-600" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
                </>
              )}
            </>
          ) : (
            <div className="text-center py-8">
              <p className="text-gray-500">No schedules configured</p>
              <Button
                variant="outline"
                className="mt-4"
                onClick={() => setShowForm(true)}
              >
                <Plus className="h-4 w-4 mr-2" />
                Create Your First Schedule
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {showForm && (
        <ScheduleForm
          schedule={editingSchedule}
          onClose={handleCloseForm}
        />
      )}

      {showBulkEditDialog && (
        <BulkEditScheduleDialog
          scheduleIds={Array.from(selectedScheduleIds)}
          schedules={schedules?.filter(s => selectedScheduleIds.has(s.id)) || []}
          onClose={() => {
            setShowBulkEditDialog(false)
            setSelectedScheduleIds(new Set())
          }}
        />
      )}
    </>
  )
}
