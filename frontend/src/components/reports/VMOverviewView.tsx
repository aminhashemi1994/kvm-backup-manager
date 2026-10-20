import { useMemo, useState } from 'react'
import { CheckCircle, XCircle, AlertTriangle, HardDrive, ChevronUp, ChevronDown, Clock, Search, ChevronDown as ChevronDownIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface VMOverviewViewProps {
  vms: any[]
  /** Backups older than this are flagged as stale. */
  staleAfterDays?: number
}

type Freshness = 'today' | 'yesterday' | 'recent' | 'stale' | 'never' | 'archived' | 'legacy' | 'disabled' | 'unscheduled'
type SortField = 'vm_name' | 'schedule' | 'last_backup' | 'method' | 'size'
type SortDirection = 'asc' | 'desc'

interface OverviewRow {
  vm: any
  vmName: string
  schedule: string
  lastBackup: Date | null
  method: string
  methods: string[]
  runCount: number
  corrupted: boolean
  sizeBytes: number
  sizeLabel: string
  freshness: Freshness
  hasBackup: boolean
  isArchived: boolean
  isLegacy: boolean
  archiveName: string
  originalSchedule: string
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Display priority for schedules: daily and legacy/once first, then weekly,
 * monthly, custom and finally archived. Anything unknown sorts last.
 */
const SCHEDULE_PRIORITY: Record<string, number> = {
  daily: 0,
  legacy: 1,
  once: 1,
  weekly: 2,
  monthly: 3,
  custom: 4,
  archived: 5,
}

const schedulePriority = (schedule: string): number => {
  const rank = SCHEDULE_PRIORITY[String(schedule).toLowerCase()]
  return rank === undefined ? 90 : rank
}

const formatBytes = (bytes: number): string => {
  if (!bytes || bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`
}

/** Calendar-day difference, so "today" means today and not "< 24h ago". */
const daysAgo = (date: Date): number => {
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  return Math.round((startOf(new Date()) - startOf(date)) / DAY_MS)
}

const getFreshness = (date: Date | null, staleAfterDays: number): Freshness => {
  if (!date) return 'never'
  const diff = daysAgo(date)
  if (diff <= 0) return 'today'
  if (diff === 1) return 'yesterday'
  return diff > staleAfterDays ? 'stale' : 'recent'
}

const relativeLabel = (date: Date | null): string => {
  if (!date) return 'Never'
  const diff = daysAgo(date)
  if (diff <= 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  return `${diff} days ago`
}

const freshnessStyle: Record<Freshness, { badge: string; border: string; label: string }> = {
  today: { badge: 'bg-green-100 text-green-800 border-green-200', border: 'border-l-green-500', label: 'Today' },
  yesterday: { badge: 'bg-lime-100 text-lime-800 border-lime-200', border: 'border-l-lime-500', label: 'Yesterday' },
  recent: { badge: 'bg-yellow-100 text-yellow-800 border-yellow-200', border: 'border-l-yellow-500', label: 'Recent' },
  stale: { badge: 'bg-orange-100 text-orange-800 border-orange-200', border: 'border-l-orange-500', label: 'Stale' },
  never: { badge: 'bg-red-100 text-red-800 border-red-200', border: 'border-l-red-500', label: 'Never' },
  // Archived backups are historical by definition - they are never "stale".
  archived: { badge: 'bg-gray-100 text-gray-700 border-gray-300', border: 'border-l-gray-400', label: 'Archived' },
  // Old-format backups in the VM's `current/` directory: frozen leftovers, not a live schedule.
  legacy: { badge: 'bg-slate-100 text-slate-700 border-slate-300', border: 'border-l-slate-400', label: 'Legacy' },
  // The controller schedule behind these backups is switched off or was removed,
  // so they are expected to age — say why rather than flagging them as stale.
  disabled: { badge: 'bg-gray-100 text-gray-600 border-gray-300', border: 'border-l-gray-400', label: 'Schedule disabled' },
  unscheduled: { badge: 'bg-gray-100 text-gray-600 border-gray-300', border: 'border-l-gray-400', label: 'No schedule' },
}

/**
 * Freshness for a schedule the controller no longer runs. Only applies when the
 * report carries scheduleStates (the controller annotates it) and only to
 * recurring schedules; 'once' backups are expected not to repeat.
 */
const inactiveScheduleFreshness = (vm: any, schedule: string): Freshness | null => {
  const states = vm?.scheduleStates
  if (!states || typeof states !== 'object' || schedule === 'once') return null
  const state = states[schedule]
  if (state === 'active') return null
  return state === 'disabled' ? 'disabled' : 'unscheduled'
}

// Matches the schedule colors used on the Backup Management page.
const scheduleStyle: Record<string, string> = {
  daily: 'bg-blue-100 text-blue-800 border-blue-200',
  weekly: 'bg-green-100 text-green-800 border-green-200',
  monthly: 'bg-purple-100 text-purple-800 border-purple-200',
  once: 'bg-orange-100 text-orange-800 border-orange-200',
  legacy: 'bg-slate-100 text-slate-700 border-slate-300',
  custom: 'bg-teal-100 text-teal-800 border-teal-200',
  archived: 'bg-gray-100 text-gray-800 border-gray-200',
}

const methodStyle: Record<string, string> = {
  full: 'bg-blue-100 text-blue-800 border-blue-200',
  inc: 'bg-purple-100 text-purple-800 border-purple-200',
  incremental: 'bg-purple-100 text-purple-800 border-purple-200',
  diff: 'bg-indigo-100 text-indigo-800 border-indigo-200',
  copy: 'bg-gray-100 text-gray-800 border-gray-200',
}

/** Latest last_backup_date across the schedule's disks (falls back to the schedule-level value). */
const scheduleLastBackup = (schedule: any): Date | null => {
  const dump = schedule?.dump_analysis
  if (!dump) return null
  const candidates: string[] = []
  if (dump.last_backup_date) candidates.push(dump.last_backup_date)
  Object.values(dump.disks || {}).forEach((disk: any) => {
    if (disk?.last_backup_date) candidates.push(disk.last_backup_date)
  })
  let latest: Date | null = null
  candidates.forEach((value) => {
    const d = new Date(value)
    if (!isNaN(d.getTime()) && (!latest || d > latest)) latest = d
  })
  return latest
}

/** Method actually used by the most recent run, with the inferred methods as fallback. */
const scheduleMethods = (schedule: any): string[] => {
  const log = Array.isArray(schedule?.scheduler_log) ? schedule.scheduler_log : []
  const lastMethod = log.length > 0 ? log[log.length - 1]?.method : null
  if (lastMethod) return [lastMethod]
  const inferred = Array.isArray(schedule?.inferred_methods) ? schedule.inferred_methods : []
  return inferred.filter(Boolean)
}

const buildRows = (vms: any[], staleAfterDays: number): OverviewRow[] => {
  const rows: OverviewRow[] = []

  vms.forEach((vm) => {
    const schedules = (Array.isArray(vm.schedules) ? vm.schedules.filter((s: any) => s.available) : [])
      .slice()
      .sort((a: any, b: any) => schedulePriority(a.schedule) - schedulePriority(b.schedule))

    if (schedules.length === 0) {
      rows.push({
        vm,
        vmName: vm.vm_name,
        schedule: '-',
        lastBackup: null,
        method: '-',
        methods: [],
        runCount: 0,
        corrupted: false,
        sizeBytes: vm.total_disk_usage_bytes || 0,
        sizeLabel: vm.total_disk_usage_gb || formatBytes(vm.total_disk_usage_bytes || 0),
        freshness: 'never',
        hasBackup: false,
        isArchived: false,
        isLegacy: false,
        archiveName: '',
        originalSchedule: '',
      })
      return
    }

    schedules.forEach((schedule: any) => {
      const lastBackup = scheduleLastBackup(schedule)
      const methods = scheduleMethods(schedule)
      const isArchived = String(schedule.schedule || '').trim().toLowerCase() === 'archived'
      // The reporter emits the old `current/` directory as a second "daily"
      // entry flagged is_legacy_format. Show it as its own `legacy` schedule so
      // it neither duplicates nor ages the real daily row.
      const isLegacy = (schedule.is_legacy_format === true || schedule.is_legacy_format === 'true')
        && String(schedule.backup_location || 'current').toLowerCase() === 'current'
      rows.push({
        vm,
        vmName: vm.vm_name,
        schedule: isLegacy ? 'legacy' : String(schedule.schedule || '').trim().toLowerCase(),
        lastBackup,
        method: methods[0] || '-',
        methods,
        runCount: schedule.recorded_run_count || 0,
        corrupted: !!schedule.corrupted,
        sizeBytes: schedule.disk_usage_bytes || 0,
        sizeLabel: schedule.disk_usage_gb || formatBytes(schedule.disk_usage_bytes || 0),
        // Archived backups are kept copies, not part of the daily rotation,
        // so they get their own status instead of counting as stale.
        freshness: isArchived ? 'archived' : isLegacy ? 'legacy'
          : inactiveScheduleFreshness(vm, String(schedule.schedule || '').trim().toLowerCase())
            ?? getFreshness(lastBackup, staleAfterDays),
        hasBackup: !!lastBackup,
        isArchived,
        isLegacy,
        archiveName: schedule.archive_name || '',
        originalSchedule: schedule.original_schedule && schedule.original_schedule !== 'unknown'
          ? schedule.original_schedule
          : '',
      })
    })
  })

  return rows
}

export default function VMOverviewView({ vms, staleAfterDays = 7 }: VMOverviewViewProps) {
  const [sortField, setSortField] = useState<SortField>('last_backup')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')
  const [filter, setFilter] = useState<Freshness | 'corrupted' | 'all'>('all')
  const [search, setSearch] = useState('')
  const [methodFilter, setMethodFilter] = useState('all')
  const [scheduleFilter, setScheduleFilter] = useState('all')

  const allRows = useMemo(() => buildRows(vms, staleAfterDays), [vms, staleAfterDays])

  // Listed in display priority: daily, legacy/once, weekly, monthly, custom, archived.
  const availableSchedules = useMemo(() => {
    const counts = new Map<string, number>()
    allRows.forEach((row) => {
      if (row.schedule !== '-') counts.set(row.schedule, (counts.get(row.schedule) || 0) + 1)
    })
    return Array.from(counts.entries()).sort(
      (a, b) => schedulePriority(a[0]) - schedulePriority(b[0]) || a[0].localeCompare(b[0])
    )
  }, [allRows])

  const availableMethods = useMemo(() => {
    const counts = new Map<string, number>()
    allRows.forEach((row) => {
      row.methods.forEach((method) => counts.set(method, (counts.get(method) || 0) + 1))
      if (row.methods.length === 0) counts.set('none', (counts.get('none') || 0) + 1)
    })
    return Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [allRows])

  // Search matches the VM name, its storage pool, the schedule and the method.
  const rows = useMemo(() => {
    const query = search.trim().toLowerCase()
    return allRows.filter((row) => {
      if (scheduleFilter !== 'all' && row.schedule !== scheduleFilter) return false
      if (methodFilter !== 'all') {
        const matchesMethod = methodFilter === 'none'
          ? row.methods.length === 0
          : row.methods.includes(methodFilter)
        if (!matchesMethod) return false
      }
      if (!query) return true
      return (
        row.vmName.toLowerCase().includes(query) ||
        String(row.vm.storage_pool_path || '').toLowerCase().includes(query) ||
        row.schedule.toLowerCase().includes(query) ||
        row.methods.some((method) => method.toLowerCase().includes(query))
      )
    })
  }, [allRows, search, methodFilter, scheduleFilter])

  const counts = useMemo(() => {
    const base = { all: rows.length, today: 0, yesterday: 0, recent: 0, stale: 0, never: 0, archived: 0, legacy: 0, disabled: 0, unscheduled: 0, corrupted: 0 }
    rows.forEach((row) => {
      base[row.freshness] += 1
      if (row.corrupted) base.corrupted += 1
    })
    return base
  }, [rows])

  // A VM counts as backed up today if any of its schedules ran today.
  const vmFreshness = useMemo(() => {
    const byVM = new Map<string, boolean>()
    // Rows whose schedule is off are not expected to back up, so they don't count as missing.
    rows.filter((row) => !row.isArchived && !row.isLegacy && row.freshness !== 'disabled' && row.freshness !== 'unscheduled').forEach((row) => {
      byVM.set(row.vmName, (byVM.get(row.vmName) ?? false) || row.freshness === 'today')
    })
    let backedUpToday = 0
    byVM.forEach((today) => { if (today) backedUpToday += 1 })
    return { total: byVM.size, backedUpToday, missing: byVM.size - backedUpToday }
  }, [rows])

  const visibleRows = useMemo(() => {
    const filtered = filter === 'all'
      ? rows
      : filter === 'corrupted'
        ? rows.filter((row) => row.corrupted)
        : rows.filter((row) => row.freshness === filter)

    const direction = sortDirection === 'asc' ? 1 : -1

    // Rows stay grouped per VM; the sort decides the order of the VM groups,
    // while inside a group the schedules keep their priority order
    // (daily/legacy, weekly, monthly, custom, archived).
    const groups = new Map<string, OverviewRow[]>()
    filtered.forEach((row) => {
      const group = groups.get(row.vmName)
      if (group) group.push(row)
      else groups.set(row.vmName, [row])
    })

    const groupKey = (group: OverviewRow[]): number | string => {
      if (sortField === 'last_backup') {
        // The VM's oldest backup drives the order - that is what needs attention.
        const live = group.filter((row) => !row.isArchived && !row.isLegacy)
        const considered = live.length > 0 ? live : group
        return Math.min(...considered.map((row) => (row.lastBackup ? row.lastBackup.getTime() : 0)))
      }
      if (sortField === 'size') return group.reduce((sum, row) => sum + row.sizeBytes, 0)
      if (sortField === 'vm_name') return group[0].vmName.toLowerCase()
      // Schedule and method describe the VM's highest-priority schedule.
      return String(sortField === 'schedule' ? group[0].schedule : group[0].method).toLowerCase()
    }

    return Array.from(groups.values())
      .map((group) => ({
        rows: group.slice().sort((a, b) => schedulePriority(a.schedule) - schedulePriority(b.schedule)),
        key: groupKey(group),
      }))
      .sort((a, b) => {
        const cmp = typeof a.key === 'number' && typeof b.key === 'number'
          ? a.key - b.key
          : String(a.key).localeCompare(String(b.key))
        if (cmp !== 0) return cmp * direction
        return a.rows[0].vmName.localeCompare(b.rows[0].vmName)
      })
      .flatMap((group) => group.rows)
  }, [rows, filter, sortField, sortDirection])

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDirection('asc')
    }
  }

  const SortableHeader = ({ field, children }: { field: SortField; children: React.ReactNode }) => (
    <th
      onClick={() => handleSort(field)}
      className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider cursor-pointer hover:bg-gray-100 select-none"
    >
      <div className="flex items-center space-x-1">
        <span>{children}</span>
        {sortField !== field
          ? <ChevronDown className="h-3 w-3 opacity-30" />
          : sortDirection === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </div>
    </th>
  )

  const FilterChip = ({ id, label, count, className }: { id: Freshness | 'corrupted' | 'all'; label: string; count: number; className?: string }) => (
    <Button
      variant="outline"
      size="sm"
      onClick={() => setFilter(filter === id ? 'all' : id)}
      className={cn(
        'h-auto px-3 py-1.5 text-xs font-medium',
        filter === id ? 'ring-2 ring-blue-500 ring-offset-1' : '',
        className
      )}
    >
      {label} <span className="ml-1.5 font-bold">{count}</span>
    </Button>
  )

  if (vms.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500">
        <HardDrive className="h-12 w-12 mx-auto mb-2 text-gray-400" />
        <p>No VMs to display</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Today's coverage - the first question an admin asks */}
      <div className="flex flex-wrap items-center gap-4 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-gray-500" />
          <span className="text-sm text-gray-700">
            <span className="font-semibold text-green-700">{vmFreshness.backedUpToday}</span>
            {' / '}{vmFreshness.total} VMs backed up today
          </span>
        </div>
        {vmFreshness.missing > 0 && (
          <Badge variant="outline" className="bg-orange-100 text-orange-800 border-orange-200">
            {vmFreshness.missing} without a backup today
          </Badge>
        )}
        <span className="text-xs text-gray-500">Stale = older than {staleAfterDays} days</span>
      </div>

      {/* Search and method filter */}
      <div className="flex flex-wrap items-center gap-3">
      <div className="relative w-full max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search VM, storage pool, schedule or method..."
          className="w-full pl-10 pr-9 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
        {search && (
          <button
            onClick={() => setSearch('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            aria-label="Clear search"
          >
            <XCircle className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="relative w-full max-w-[220px]">
        <select
          value={scheduleFilter}
          onChange={(e) => setScheduleFilter(e.target.value)}
          className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 pr-8 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 appearance-none"
        >
          <option value="all">All schedules ({allRows.length})</option>
          {availableSchedules.map(([schedule, count]) => (
            <option key={schedule} value={schedule}>
              {schedule} ({count})
            </option>
          ))}
        </select>
        <ChevronDownIcon className="absolute right-3 top-3 h-4 w-4 opacity-50 pointer-events-none" />
      </div>

      <div className="relative w-full max-w-[220px]">
        <select
          value={methodFilter}
          onChange={(e) => setMethodFilter(e.target.value)}
          className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 pr-8 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 appearance-none"
        >
          <option value="all">All methods ({allRows.length})</option>
          {availableMethods.map(([method, count]) => (
            <option key={method} value={method}>
              {method === 'none' ? 'No method recorded' : method} ({count})
            </option>
          ))}
        </select>
        <ChevronDownIcon className="absolute right-3 top-3 h-4 w-4 opacity-50 pointer-events-none" />
      </div>
      </div>

      {/* Freshness filters */}
      <div className="flex flex-wrap items-center gap-2">
        <FilterChip id="all" label="All backups" count={counts.all} />
        <FilterChip id="today" label="Today" count={counts.today} className="text-green-700" />
        <FilterChip id="yesterday" label="Yesterday" count={counts.yesterday} className="text-lime-700" />
        <FilterChip id="recent" label={`Last ${staleAfterDays}d`} count={counts.recent} className="text-yellow-700" />
        <FilterChip id="stale" label="Stale" count={counts.stale} className="text-orange-700" />
        <FilterChip id="never" label="Never" count={counts.never} className="text-red-700" />
        {counts.archived > 0 && (
          <FilterChip id="archived" label="Archived" count={counts.archived} className="text-gray-700" />
        )}
        {counts.legacy > 0 && (
          <FilterChip id="legacy" label="Legacy" count={counts.legacy} className="text-slate-700" />
        )}
        {counts.disabled > 0 && (
          <FilterChip id="disabled" label="Schedule disabled" count={counts.disabled} className="text-gray-700" />
        )}
        {counts.unscheduled > 0 && (
          <FilterChip id="unscheduled" label="No schedule" count={counts.unscheduled} className="text-gray-700" />
        )}
        <FilterChip id="corrupted" label="Corrupted" count={counts.corrupted} className="text-red-700" />
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <SortableHeader field="vm_name">VM Name</SortableHeader>
              <SortableHeader field="schedule">Schedule</SortableHeader>
              <SortableHeader field="last_backup">Last Backup</SortableHeader>
              <SortableHeader field="method">Method</SortableHeader>
              <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Status</th>
              <SortableHeader field="size">Size</SortableHeader>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {visibleRows.map((row, index) => (
              <tr
                key={`${row.vmName}-${row.schedule}-${row.archiveName}-${index}`}
                className={cn('border-l-4 hover:bg-gray-50 transition-colors', freshnessStyle[row.freshness].border)}
              >
                <td className="px-4 py-3">
                  <div className="text-sm font-medium text-gray-900 truncate max-w-xs" title={row.vmName}>
                    {row.vmName}
                  </div>
                  {row.vm.storage_pool_path && (
                    <div className="text-xs text-gray-500 font-mono truncate max-w-xs" title={row.vm.storage_pool_path}>
                      {row.vm.storage_pool_path}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 whitespace-nowrap">
                  {row.schedule === '-' ? (
                    <span className="text-xs text-gray-400">No active schedule</span>
                  ) : (
                    <Badge
                      variant="outline"
                      className={cn('text-xs', scheduleStyle[row.schedule.toLowerCase()] || 'bg-gray-100 text-gray-800 border-gray-200')}
                    >
                      {row.schedule}
                    </Badge>
                  )}
                  {row.isArchived && (row.originalSchedule || row.archiveName) && (
                    <div className="text-xs text-gray-500 mt-1 truncate max-w-[180px]" title={row.archiveName}>
                      {row.originalSchedule ? `from ${row.originalSchedule}` : row.archiveName}
                    </div>
                  )}
                  {row.isLegacy && (
                    <div className="text-xs text-gray-500 mt-1" title="Old backup format stored in the VM's current/ directory">
                      old format (current/)
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 whitespace-nowrap">
                  {row.lastBackup ? (
                    <>
                      <div className="text-sm text-gray-900">{row.lastBackup.toLocaleDateString()}</div>
                      <div className="text-xs text-gray-500">
                        {row.lastBackup.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        {' · '}{relativeLabel(row.lastBackup)}
                      </div>
                    </>
                  ) : (
                    <span className="text-sm text-red-600">Never</span>
                  )}
                </td>
                <td className="px-4 py-3 whitespace-nowrap">
                  <div className="flex flex-wrap gap-1">
                    {row.methods.length > 0 ? (
                      row.methods.map((method) => (
                        <Badge
                          key={method}
                          variant="outline"
                          className={cn('text-xs', methodStyle[method] || 'bg-gray-100 text-gray-800 border-gray-200')}
                        >
                          {method}
                        </Badge>
                      ))
                    ) : (
                      <span className="text-xs text-gray-400">-</span>
                    )}
                    {row.runCount > 0 && (
                      <span className="text-xs text-gray-500 self-center">({row.runCount} runs)</span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3 whitespace-nowrap">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className={cn('text-xs', freshnessStyle[row.freshness].badge)}>
                      {row.freshness === 'recent' ? relativeLabel(row.lastBackup) : freshnessStyle[row.freshness].label}
                    </Badge>
                    {row.corrupted ? (
                      <Badge variant="outline" className="text-xs bg-red-100 text-red-800 border-red-200 flex items-center gap-1">
                        <XCircle className="h-3 w-3" />
                        Corrupted
                      </Badge>
                    ) : row.hasBackup ? (
                      <CheckCircle className="h-4 w-4 text-green-600" />
                    ) : (
                      <AlertTriangle className="h-4 w-4 text-orange-500" />
                    )}
                  </div>
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-sm font-mono text-gray-700">
                  {row.sizeLabel}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {visibleRows.length === 0 && (
          <div className="text-center py-12 text-gray-500">
            <HardDrive className="h-12 w-12 mx-auto mb-2 text-gray-400" />
            <p>{search ? `No VMs match "${search}"` : 'No backups match this filter'}</p>
            {(search || filter !== 'all' || methodFilter !== 'all' || scheduleFilter !== 'all') && (
              <Button
                variant="link"
                size="sm"
                onClick={() => { setSearch(''); setFilter('all'); setMethodFilter('all'); setScheduleFilter('all') }}
                className="mt-1"
              >
                Clear search and filters
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
