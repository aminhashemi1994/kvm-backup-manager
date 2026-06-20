import { useState, useMemo, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Select } from '@/components/ui/select'
import {
  Plus, Trash2, Edit, Power, Loader2, CheckSquare, Search, XCircle,
  Filter, ChevronDown, ChevronUp, Play, ChevronLeft, ChevronRight,
} from 'lucide-react'
import ScheduleForm from './ScheduleForm'
import BulkEditScheduleDialog from './BulkEditScheduleDialog'
import VmNameCell from '@/components/common/VmNameCell'
import VmNameToggle from '@/components/common/VmNameToggle'
import { useSchedules, useDeleteSchedule, useToggleSchedule, useRunScheduleNow } from '@/hooks/useBackups'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { getStatusColor } from '@/lib/utils'
import { toast } from 'sonner'

type FilterState = {
  search: string
  scheduleType: string  // 'all' | 'daily' | 'weekly' | ...
  enabled: string       // 'all' | 'enabled' | 'disabled'
  backupHostId: string  // 'all' | id
  hypervisorId: string  // 'all' | id
  vmId: string          // 'all' | id
  offsite: string       // 'all' | 'with-offsite' | 'without-offsite' | <offsite-host-id>
  timeRange: string     // 'all' | 'morning' | 'afternoon' | 'evening' | 'night'
}

const initialFilters: FilterState = {
  search: '',
  scheduleType: 'all',
  enabled: 'all',
  backupHostId: 'all',
  hypervisorId: 'all',
  vmId: 'all',
  offsite: 'all',
  timeRange: 'all',
}

export default function ScheduleList() {
  const [showForm, setShowForm] = useState(false)
  const [editingSchedule, setEditingSchedule] = useState<any>(null)
  const [selectedScheduleIds, setSelectedScheduleIds] = useState<Set<string>>(new Set())
  const [showBulkEditDialog, setShowBulkEditDialog] = useState(false)
  const [filters, setFilters] = useState<FilterState>(initialFilters)
  const [filtersExpanded, setFiltersExpanded] = useState(false)
  
  // Pagination state. Defaults to 10/page; user can pick from 10/20/50/100.
  // Persist preference in localStorage so it survives reloads.
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(() => {
    const saved = parseInt(localStorage.getItem('schedules-page-size') || '10', 10)
    return [10, 20, 50, 100].includes(saved) ? saved : 10
  })

  useEffect(() => {
    localStorage.setItem('schedules-page-size', String(pageSize))
  }, [pageSize])

  // VM name display mode (short readable name vs full raw name). Shared
  // preference key across tabs so it stays consistent app-wide.
  const [showFullVmNames, setShowFullVmNames] = useState<boolean>(() => {
    return localStorage.getItem('vm-name-display') === 'full'
  })
  useEffect(() => {
    localStorage.setItem('vm-name-display', showFullVmNames ? 'full' : 'short')
  }, [showFullVmNames])

  const { data: schedules, isLoading } = useSchedules()
  const deleteSchedule = useDeleteSchedule()
  const toggleSchedule = useToggleSchedule()
  const runScheduleNow = useRunScheduleNow()
  const confirm = useConfirm()

  // Build filter options from current schedules
  const filterOptions = useMemo(() => {
    const backupHosts = new Map<string, string>()
    const hypervisors = new Map<string, string>()
    const vms = new Map<string, string>()
    const offsiteHosts = new Map<string, string>()
    for (const s of schedules || []) {
      if (s.backupHostId && s.backupHostName) backupHosts.set(s.backupHostId, s.backupHostName)
      if (s.hypervisorId && s.hypervisorName) hypervisors.set(s.hypervisorId, s.hypervisorName)
      if (s.vmId && s.vmName) vms.set(s.vmId, s.vmName)
      const offsiteIds = (s as any).offsiteHostIds || []
      const offsiteNames = (s as any).offsiteHostNames || []
      offsiteIds.forEach((id: string, idx: number) => {
        if (id && offsiteNames[idx]) offsiteHosts.set(id, offsiteNames[idx])
      })
    }
    return {
      backupHosts: Array.from(backupHosts.entries()).sort((a, b) => a[1].localeCompare(b[1])),
      hypervisors: Array.from(hypervisors.entries()).sort((a, b) => a[1].localeCompare(b[1])),
      vms: Array.from(vms.entries()).sort((a, b) => a[1].localeCompare(b[1])),
      offsiteHosts: Array.from(offsiteHosts.entries()).sort((a, b) => a[1].localeCompare(b[1])),
    }
  }, [schedules])

  // Apply filters
  const filteredSchedules = useMemo(() => {
    if (!schedules) return []
    const q = filters.search.trim().toLowerCase()
    return schedules.filter((s: any) => {
      // Free-text search across all relevant fields
      if (q) {
        const searchable = [
          s.name, s.vmName, s.hypervisorName, s.hypervisorIp,
          s.backupHostName, s.scheduleType, s.cronHuman, s.cronExpression,
          s.storagePoolName, ...(s.offsiteHostNames || []),
        ].filter(Boolean).join(' ').toLowerCase()
        if (!searchable.includes(q)) return false
      }
      if (filters.scheduleType !== 'all' && s.scheduleType !== filters.scheduleType) return false
      if (filters.enabled === 'enabled' && !s.enabled) return false
      if (filters.enabled === 'disabled' && s.enabled) return false
      if (filters.backupHostId !== 'all' && s.backupHostId !== filters.backupHostId) return false
      if (filters.hypervisorId !== 'all' && s.hypervisorId !== filters.hypervisorId) return false
      if (filters.vmId !== 'all' && s.vmId !== filters.vmId) return false
      if (filters.offsite === 'with-offsite' && !(s.offsiteHostIds && s.offsiteHostIds.length > 0)) return false
      if (filters.offsite === 'without-offsite' && s.offsiteHostIds && s.offsiteHostIds.length > 0) return false
      if (
        filters.offsite !== 'all' &&
        filters.offsite !== 'with-offsite' &&
        filters.offsite !== 'without-offsite'
      ) {
        if (!s.offsiteHostIds || !s.offsiteHostIds.includes(filters.offsite)) return false
      }
      if (filters.timeRange !== 'all' && s.time) {
        const [hh] = (s.time || '00:00').split(':').map(Number)
        const inRange = (
          (filters.timeRange === 'morning' && hh >= 6 && hh < 12) ||
          (filters.timeRange === 'afternoon' && hh >= 12 && hh < 18) ||
          (filters.timeRange === 'evening' && hh >= 18 && hh < 22) ||
          (filters.timeRange === 'night' && (hh >= 22 || hh < 6))
        )
        if (!inRange) return false
      }
      return true
    })
  }, [schedules, filters])

  const activeFilterCount = useMemo(() => {
    let n = 0
    if (filters.search.trim()) n++
    if (filters.scheduleType !== 'all') n++
    if (filters.enabled !== 'all') n++
    if (filters.backupHostId !== 'all') n++
    if (filters.hypervisorId !== 'all') n++
    if (filters.vmId !== 'all') n++
    if (filters.offsite !== 'all') n++
    if (filters.timeRange !== 'all') n++
    return n
  }, [filters])

  // Reset to page 1 whenever filters change so the user isn't stranded on
  // a now-out-of-range page after narrowing the result set.
  useEffect(() => {
    setCurrentPage(1)
  }, [filters])

  // Pagination math. Always run after filtering.
  const totalItems = filteredSchedules.length
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
  const startIndex = (currentPage - 1) * pageSize
  const endIndex = startIndex + pageSize
  const paginatedSchedules = filteredSchedules.slice(startIndex, endIndex)

  // Clamp current page if total shrinks below current page (e.g. after deletion
  // or filter change reduces result count).
  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages)
    }
  }, [currentPage, totalPages])

  const resetFilters = () => setFilters(initialFilters)

  const handleDelete = async (id: string, name: string) => {
    const ok = await confirm({
      title: 'Delete schedule?',
      description: `Are you sure you want to delete the schedule "${name}"?`,
      confirmText: 'Delete',
      variant: 'danger',
    })
    if (ok) await deleteSchedule.mutateAsync(id)
  }
  const handleToggle = async (id: string) => { await toggleSchedule.mutateAsync(id) }
  const handleEdit = (schedule: any) => { setEditingSchedule(schedule); setShowForm(true) }
  const handleCloseForm = () => { setShowForm(false); setEditingSchedule(null) }
  const handleRunNow = async (id: string, name: string) => {
    const ok = await confirm({
      title: 'Run schedule now?',
      description: `A new backup will start immediately for "${name}" using this schedule's configuration.`,
      confirmText: 'Run now',
    })
    if (ok) await runScheduleNow.mutateAsync(id)
  }
  const handleToggleScheduleSelection = (scheduleId: string) => {
    setSelectedScheduleIds(prev => {
      const newSet = new Set(prev)
      if (newSet.has(scheduleId)) newSet.delete(scheduleId)
      else newSet.add(scheduleId)
      return newSet
    })
  }
  const handleSelectAll = () => {
    if (selectedScheduleIds.size === paginatedSchedules.length && paginatedSchedules.length > 0) {
      // Currently all visible items are selected → deselect them
      setSelectedScheduleIds(prev => {
        const next = new Set(prev)
        paginatedSchedules.forEach(s => next.delete(s.id))
        return next
      })
    } else {
      // Select all visible items (additive across pages)
      setSelectedScheduleIds(prev => {
        const next = new Set(prev)
        paginatedSchedules.forEach(s => next.add(s.id))
        return next
      })
    }
  }
  const handleBulkDelete = async () => {
    if (selectedScheduleIds.size === 0) return
    const ok = await confirm({
      title: `Delete ${selectedScheduleIds.size} schedule(s)?`,
      description: 'This will permanently remove the selected schedules.',
      confirmText: 'Delete all',
      variant: 'danger',
    })
    if (!ok) return
    let success = 0, failed = 0
    for (const id of selectedScheduleIds) {
      try { await deleteSchedule.mutateAsync(id); success++ } catch { failed++ }
    }
    setSelectedScheduleIds(new Set())
    if (failed === 0) toast.success(`Deleted ${success} schedule(s)`)
    else toast.warning(`Deleted ${success}, ${failed} failed`)
  }
  const handleBulkEdit = () => { if (selectedScheduleIds.size > 0) setShowBulkEditDialog(true) }
  
  const handleBulkRunNow = async () => {
    if (selectedScheduleIds.size === 0) return
    
    const ok = await confirm({
      title: `Run ${selectedScheduleIds.size} schedule(s) now?`,
      description: `${selectedScheduleIds.size} new backup job(s) will start immediately using each schedule's configuration.`,
      confirmText: 'Run all now',
    })
    
    if (!ok) return
    
    let success = 0, failed = 0
    for (const id of selectedScheduleIds) {
      try {
        await runScheduleNow.mutateAsync(id)
        success++
      } catch {
        failed++
      }
    }
    
    setSelectedScheduleIds(new Set())
    
    if (failed === 0) toast.success(`Started ${success} backup(s)`)
    else toast.warning(`Started ${success} backup(s), ${failed} failed`)
  }

  // ─── render ──────────────────────────────────────────────────────────────

  const filterDropdownClass = "border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 text-sm bg-white dark:bg-gray-800 min-w-[140px]"

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle>Backup Schedules</CardTitle>
            <div className="flex items-center gap-2">
              {selectedScheduleIds.size > 0 && (
                <>
                  <Button variant="outline" size="sm" onClick={handleBulkRunNow}>
                    <Play className="h-4 w-4 mr-2 text-blue-600" />
                    Run Now ({selectedScheduleIds.size})
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleBulkEdit}>
                    <Edit className="h-4 w-4 mr-2" />
                    Edit ({selectedScheduleIds.size})
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleBulkDelete}>
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
              <div className="flex items-center gap-2 mb-3 flex-wrap">
                <div className="relative flex-1 min-w-[260px] max-w-md">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <input
                    type="text"
                    value={filters.search}
                    onChange={(e) => setFilters(f => ({ ...f, search: e.target.value }))}
                    placeholder="Search by name, VM, host, hypervisor..."
                    className="w-full pl-10 pr-10 py-2 text-sm border border-gray-300 dark:border-gray-700 rounded-md bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  {filters.search && (
                    <button
                      onClick={() => setFilters(f => ({ ...f, search: '' }))}
                      className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600"
                    >
                      <XCircle className="h-4 w-4" />
                    </button>
                  )}
                </div>

                <Button
                  variant={filtersExpanded ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setFiltersExpanded(v => !v)}
                >
                  <Filter className="h-4 w-4 mr-2" />
                  Filters
                  {activeFilterCount > 0 && (
                    <Badge variant="secondary" className="ml-2 px-1.5 py-0 text-[10px]">
                      {activeFilterCount}
                    </Badge>
                  )}
                  {filtersExpanded ? (
                    <ChevronUp className="h-4 w-4 ml-1" />
                  ) : (
                    <ChevronDown className="h-4 w-4 ml-1" />
                  )}
                </Button>

                {activeFilterCount > 0 && (
                  <Button variant="ghost" size="sm" onClick={resetFilters}>
                    Reset
                  </Button>
                )}

                <div className="ml-auto">
                  <VmNameToggle showFull={showFullVmNames} onToggle={setShowFullVmNames} />
                </div>
              </div>

              {/* Expanded filters */}
              {filtersExpanded && (
                <div className="mb-4 p-4 border border-gray-200 dark:border-gray-700 rounded-xl bg-gray-50 dark:bg-gray-800/40 space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                    {/* Schedule Type */}
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Schedule Type</label>
                      <select
                        className={filterDropdownClass + ' w-full'}
                        value={filters.scheduleType}
                        onChange={(e) => setFilters(f => ({ ...f, scheduleType: e.target.value }))}
                      >
                        <option value="all">All Types</option>
                        <option value="daily">Daily</option>
                        <option value="weekly">Weekly</option>
                        <option value="monthly">Monthly</option>
                        <option value="custom-days">Custom Days</option>
                        <option value="interval">Interval</option>
                        <option value="cron">Cron</option>
                        <option value="once">Once</option>
                      </select>
                    </div>

                    {/* Status */}
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Status</label>
                      <select
                        className={filterDropdownClass + ' w-full'}
                        value={filters.enabled}
                        onChange={(e) => setFilters(f => ({ ...f, enabled: e.target.value }))}
                      >
                        <option value="all">All Statuses</option>
                        <option value="enabled">Enabled only</option>
                        <option value="disabled">Disabled only</option>
                      </select>
                    </div>

                    {/* Backup Host */}
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Backup Host</label>
                      <select
                        className={filterDropdownClass + ' w-full'}
                        value={filters.backupHostId}
                        onChange={(e) => setFilters(f => ({ ...f, backupHostId: e.target.value, hypervisorId: 'all', vmId: 'all' }))}
                      >
                        <option value="all">All Hosts ({filterOptions.backupHosts.length})</option>
                        {filterOptions.backupHosts.map(([id, name]) => (
                          <option key={id} value={id}>{name}</option>
                        ))}
                      </select>
                    </div>

                    {/* Hypervisor */}
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Hypervisor</label>
                      <select
                        className={filterDropdownClass + ' w-full'}
                        value={filters.hypervisorId}
                        onChange={(e) => setFilters(f => ({ ...f, hypervisorId: e.target.value, vmId: 'all' }))}
                      >
                        <option value="all">All Hypervisors ({filterOptions.hypervisors.length})</option>
                        {filterOptions.hypervisors.map(([id, name]) => (
                          <option key={id} value={id}>{name}</option>
                        ))}
                      </select>
                    </div>

                    {/* VM */}
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Virtual Machine</label>
                      <select
                        className={filterDropdownClass + ' w-full'}
                        value={filters.vmId}
                        onChange={(e) => setFilters(f => ({ ...f, vmId: e.target.value }))}
                      >
                        <option value="all">All VMs ({filterOptions.vms.length})</option>
                        {filterOptions.vms.map(([id, name]) => (
                          <option key={id} value={id}>{name}</option>
                        ))}
                      </select>
                    </div>

                    {/* Offsite */}
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Offsite</label>
                      <select
                        className={filterDropdownClass + ' w-full'}
                        value={filters.offsite}
                        onChange={(e) => setFilters(f => ({ ...f, offsite: e.target.value }))}
                      >
                        <option value="all">All Schedules</option>
                        <option value="with-offsite">With offsite sync</option>
                        <option value="without-offsite">Without offsite sync</option>
                        {filterOptions.offsiteHosts.length > 0 && (
                          <optgroup label="Specific offsite host">
                            {filterOptions.offsiteHosts.map(([id, name]) => (
                              <option key={id} value={id}>{name}</option>
                            ))}
                          </optgroup>
                        )}
                      </select>
                    </div>

                    {/* Time of day */}
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Time of day</label>
                      <select
                        className={filterDropdownClass + ' w-full'}
                        value={filters.timeRange}
                        onChange={(e) => setFilters(f => ({ ...f, timeRange: e.target.value }))}
                      >
                        <option value="all">Any time</option>
                        <option value="morning">Morning (06:00–12:00)</option>
                        <option value="afternoon">Afternoon (12:00–18:00)</option>
                        <option value="evening">Evening (18:00–22:00)</option>
                        <option value="night">Night (22:00–06:00)</option>
                      </select>
                    </div>
                  </div>
                </div>
              )}

              {/* Results count */}
              <p className="text-xs text-gray-500 mb-3">
                {totalItems > 0
                  ? `Showing ${startIndex + 1}–${Math.min(endIndex, totalItems)} of ${totalItems}`
                  : 'Showing 0'}
                {' '}schedules
                {schedules.length !== totalItems && ` (filtered from ${schedules.length})`}
                {activeFilterCount > 0 && ` • ${activeFilterCount} filter${activeFilterCount === 1 ? '' : 's'} active`}
              </p>

              {filteredSchedules.length === 0 ? (
                <div className="text-center py-12 border border-dashed border-gray-200 dark:border-gray-700 rounded-xl">
                  <Filter className="h-10 w-10 text-gray-300 mx-auto mb-3" />
                  <p className="text-gray-500">No schedules match the current filters</p>
                  <Button variant="link" size="sm" onClick={resetFilters} className="mt-2">
                    Clear filters
                  </Button>
                </div>
              ) : (
                <>
                  {/* Bulk Actions Bar */}
                  <div className="mb-4 flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={handleSelectAll}>
                      <CheckSquare className="h-4 w-4 mr-2" />
                      {paginatedSchedules.length > 0 && paginatedSchedules.every(s => selectedScheduleIds.has(s.id))
                        ? 'Deselect Page'
                        : 'Select Page'}
                    </Button>
                    {selectedScheduleIds.size > 0 && (
                      <span className="text-sm text-gray-600">
                        {selectedScheduleIds.size} selected
                        {selectedScheduleIds.size > paginatedSchedules.length && ' (across pages)'}
                      </span>
                    )}
                  </div>

                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-12">
                          <Checkbox
                            checked={paginatedSchedules.length > 0 && paginatedSchedules.every(s => selectedScheduleIds.has(s.id))}
                            onChange={handleSelectAll}
                          />
                        </TableHead>
                        <TableHead>Name</TableHead>
                        <TableHead>VM</TableHead>
                        <TableHead>Backup Host</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Schedule</TableHead>
                        <TableHead>Offsite</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {paginatedSchedules.map((schedule: any) => {
                        const getScheduleInfo = () => {
                          switch (schedule.scheduleType) {
                            case 'daily': return `Daily at ${schedule.time || '00:00'}`
                            case 'weekly': {
                              const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
                              const sel = schedule.daysOfWeek?.map((d: number) => days[d]).join(', ') || 'Not set'
                              return `${sel} at ${schedule.time || '00:00'}`
                            }
                            case 'custom-days': return `${schedule.customDates?.length || 0} custom dates`
                            case 'interval': return `Every ${schedule.intervalValue} ${schedule.intervalUnit}`
                            case 'cron': return schedule.cronHuman || schedule.cronExpression
                            case 'monthly': return `Monthly on day 1 at ${schedule.time || '00:00'}`
                            case 'once': return `Once at ${schedule.time || '00:00'}`
                            default: return schedule.cronHuman || schedule.cronExpression || 'Unknown'
                          }
                        }

                        const getTypeLabel = () => {
                          switch (schedule.scheduleType) {
                            case 'daily': return 'Daily'
                            case 'weekly': return 'Weekly'
                            case 'monthly': return 'Monthly'
                            case 'custom-days': return 'Custom'
                            case 'interval': return 'Interval'
                            case 'cron': return 'Cron'
                            case 'once': return 'Once'
                            default: return 'Unknown'
                          }
                        }

                        const offsiteCount = schedule.offsiteHostIds?.length || 0

                        return (
                          <TableRow key={schedule.id}>
                            <TableCell>
                              <Checkbox
                                checked={selectedScheduleIds.has(schedule.id)}
                                onChange={() => handleToggleScheduleSelection(schedule.id)}
                              />
                            </TableCell>
                            <TableCell className="font-medium">
                              <div className="truncate max-w-[240px]" title={schedule.name}>
                                {schedule.name}
                              </div>
                            </TableCell>
                            <TableCell>
                              <VmNameCell
                                vmName={schedule.vmName}
                                showFull={showFullVmNames}
                                subtitle={schedule.hypervisorName}
                                maxWidthClass="max-w-[240px]"
                              />
                            </TableCell>
                            <TableCell className="text-sm text-gray-600">
                              {schedule.backupHostName || '—'}
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline">{getTypeLabel()}</Badge>
                            </TableCell>
                            <TableCell>
                              <p className="text-sm">{getScheduleInfo()}</p>
                            </TableCell>
                            <TableCell>
                              {offsiteCount > 0 ? (
                                <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200">
                                  {offsiteCount} {offsiteCount === 1 ? 'host' : 'hosts'}
                                </Badge>
                              ) : (
                                <span className="text-xs text-gray-400">—</span>
                              )}
                            </TableCell>
                            <TableCell>
                              <Badge className={schedule.enabled ? getStatusColor('online') : getStatusColor('offline')}>
                                {schedule.enabled ? 'Enabled' : 'Disabled'}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center space-x-1">
                                <Button variant="ghost" size="sm"
                                  onClick={() => handleRunNow(schedule.id, schedule.name)}
                                  disabled={runScheduleNow.isPending}
                                  title="Run this schedule now"
                                  className="text-blue-600 hover:text-blue-700 hover:bg-blue-50 dark:hover:bg-blue-900/20"
                                >
                                  {runScheduleNow.isPending && runScheduleNow.variables === schedule.id
                                    ? <Loader2 className="h-4 w-4 animate-spin" />
                                    : <Play className="h-4 w-4" />}
                                </Button>
                                <Button variant="ghost" size="sm"
                                  onClick={() => handleToggle(schedule.id)}
                                  disabled={toggleSchedule.isPending}
                                  title={schedule.enabled ? 'Disable' : 'Enable'}
                                >
                                  <Power className={`h-4 w-4 ${schedule.enabled ? 'text-green-600' : 'text-gray-400'}`} />
                                </Button>
                                <Button variant="ghost" size="sm" onClick={() => handleEdit(schedule)} title="Edit">
                                  <Edit className="h-4 w-4" />
                                </Button>
                                <Button variant="ghost" size="sm"
                                  onClick={() => handleDelete(schedule.id, schedule.name)}
                                  disabled={deleteSchedule.isPending} title="Delete"
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

                  {/* Pagination Controls. The page-size selector is shown
                      whenever there are items so users can switch between
                      sizes (10/20/50/100) even if the result fits in one
                      page. The page navigation only renders when there's
                      more than one page. */}
                  {totalItems > 0 && (
                    <div className="mt-4 flex items-center justify-between flex-wrap gap-3 border-t pt-4">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-gray-600">Items per page:</span>
                        <Select
                          value={pageSize.toString()}
                          onChange={(e) => {
                            setPageSize(Number(e.target.value))
                            setCurrentPage(1) // Reset to first page when changing page size
                          }}
                          className="w-20"
                        >
                          <option value="10">10</option>
                          <option value="20">20</option>
                          <option value="50">50</option>
                          <option value="100">100</option>
                        </Select>
                        <span className="text-sm text-gray-500 hidden sm:inline">
                          Page {currentPage} of {totalPages}
                        </span>
                      </div>

                      {totalPages > 1 && (
                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                            disabled={currentPage === 1}
                          >
                            <ChevronLeft className="h-4 w-4 mr-1" />
                            Previous
                          </Button>

                          <div className="flex items-center gap-1">
                            {/* First page + ellipsis when far from start */}
                            {currentPage > 3 && (
                              <>
                                <Button
                                  variant={currentPage === 1 ? 'default' : 'outline'}
                                  size="sm"
                                  onClick={() => setCurrentPage(1)}
                                  className="w-10"
                                >
                                  1
                                </Button>
                                {currentPage > 4 && (
                                  <span className="px-2 text-gray-400">…</span>
                                )}
                              </>
                            )}

                            {/* Pages around current page (±2) */}
                            {Array.from({ length: totalPages }, (_, i) => i + 1)
                              .filter(page => page >= currentPage - 2 && page <= currentPage + 2)
                              .map(page => (
                                <Button
                                  key={page}
                                  variant={currentPage === page ? 'default' : 'outline'}
                                  size="sm"
                                  onClick={() => setCurrentPage(page)}
                                  className="w-10"
                                >
                                  {page}
                                </Button>
                              ))}

                            {/* Last page + ellipsis when far from end */}
                            {currentPage < totalPages - 2 && (
                              <>
                                {currentPage < totalPages - 3 && (
                                  <span className="px-2 text-gray-400">…</span>
                                )}
                                <Button
                                  variant={currentPage === totalPages ? 'default' : 'outline'}
                                  size="sm"
                                  onClick={() => setCurrentPage(totalPages)}
                                  className="w-10"
                                >
                                  {totalPages}
                                </Button>
                              </>
                            )}
                          </div>

                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                            disabled={currentPage === totalPages}
                          >
                            Next
                            <ChevronRight className="h-4 w-4 ml-1" />
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </>
          ) : (
            <div className="text-center py-8">
              <p className="text-gray-500">No schedules configured</p>
              <Button variant="outline" className="mt-4" onClick={() => setShowForm(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Create Your First Schedule
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {showForm && (
        <ScheduleForm schedule={editingSchedule} onClose={handleCloseForm} />
      )}

      {showBulkEditDialog && (
        <BulkEditScheduleDialog
          scheduleIds={Array.from(selectedScheduleIds)}
          schedules={schedules?.filter(s => selectedScheduleIds.has(s.id)) || []}
          onClose={() => { setShowBulkEditDialog(false); setSelectedScheduleIds(new Set()) }}
        />
      )}
    </>
  )
}
