import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  CheckCircle2, Loader2, PlayCircle,
  RefreshCw, Radar, Search, ChevronLeft, ChevronRight, X,
  ArrowUp, ArrowDown, ChevronsUpDown,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  useActiveOffsiteJobs,
  useOffsiteJobEvents,
  useReplicationCheckResults, useRunReplicationCheck, useTriggerOffsiteSync,
} from '@/hooks/useOffsiteJobs'
import { useBackupHosts } from '@/hooks/useBackupHosts'
import { formatDate, formatRelativeTime } from '@/lib/utils'
import { useConfirm } from '@/components/ui/confirm-dialog'
import VmNameCell from '@/components/common/VmNameCell'
import ReplicationStateIcon from './ReplicationStateIcon'
import type { OffsiteJob, ReplicationCheckState, ReplicationCheckVM } from '@/types'
import { getErrorMessage } from '@/lib/errors'

/**
 * The replication check is an audit, not a monitor: it walks every VM with an
 * offsite destination and compares the two trees. Runs on the interval set in
 * Settings, and on demand from here.
 */

type SortKey = 'vm' | 'host' | 'state' | 'targets' | 'checked' | 'action'
type SortDir = 'asc' | 'desc'

/**
 * A column header that sorts. Clicking cycles ascending → descending → off,
 * so the operator can always get back to the controller's own ordering.
 */
function SortableHead({ label, sortKey, sort, onSort, className }: {
  label: string
  sortKey: SortKey
  sort: { key: SortKey; dir: SortDir } | null
  onSort: (key: SortKey) => void
  className?: string
}) {
  const active = sort?.key === sortKey
  const Icon = !active ? ChevronsUpDown : sort!.dir === 'asc' ? ArrowUp : ArrowDown
  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 hover:text-gray-900 dark:hover:text-white transition-colors ${
          active ? 'text-gray-900 dark:text-white font-semibold' : ''
        }`}
        title={
          !active
            ? `Sort by ${label.toLowerCase()}`
            : sort!.dir === 'asc'
              ? `Sort by ${label.toLowerCase()} descending`
              : 'Clear sorting'
        }
      >
        {label}
        <Icon className={`h-3.5 w-3.5 ${active ? 'opacity-100' : 'opacity-40'}`} />
      </button>
    </TableHead>
  )
}

function Stat({ label, value, cls, onClick, active }: {
  label: string
  value: number
  cls: string
  onClick?: () => void
  active?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={`rounded-xl border p-3 text-left transition-all ${cls} ${
        onClick ? 'hover:shadow-sm cursor-pointer' : 'cursor-default'
      } ${active ? 'ring-2 ring-offset-1 ring-blue-500' : ''}`}
    >
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      <div className="text-xs opacity-80">{label}</div>
    </button>
  )
}

export default function ReplicationCheckPanel() {
  const { data: results, isLoading } = useReplicationCheckResults()
  const { data: activeJobs } = useActiveOffsiteJobs()
  const runCheck = useRunReplicationCheck()
  const triggerSync = useTriggerOffsiteSync()
  const { data: hosts } = useBackupHosts()
  const confirm = useConfirm()

  // Subscribe to the offsite socket stream so a finished sync immediately
  // updates this panel: the controller emits `offsite-check-updated` when a
  // successful sync changes a VM's verdict, and the active-jobs cache is
  // patched in place as the run progresses. Without this hook the panel
  // waits for the next refetch (60s for check results, 5s for active jobs)
  // so an operator sees a stale "Behind" row for up to a minute after the
  // sync that fixed it has already finished.
  useOffsiteJobEvents()

  // VMs with a sync already queued or running. The Sync button for these
  // rows goes into a loading state and refuses new clicks — the backend
  // coalesces anyway, but reflecting it in the UI stops a double-click
  // from creating the impression nothing happened.
  // Keyed by VM so a row can show *which* stage its sync is at, not merely
  // that one exists: a queued sync and one 60% through a 400GB tree look
  // identical otherwise, and that was the whole complaint about this table.
  const syncingJobByVmId = useMemo(() => {
    const byVm = new Map<string, OffsiteJob>()
    for (const j of activeJobs || []) {
      if ((j.status === 'queued' || j.status === 'running') && j.vmId) {
        // A running job wins over a queued one for the same VM: it is the
        // transfer actually moving bytes right now.
        const prev = byVm.get(j.vmId)
        if (!prev || (prev.status === 'queued' && j.status === 'running')) byVm.set(j.vmId, j)
      }
    }
    return byVm
  }, [activeJobs])
  const syncingVmIds = useMemo(() => new Set(syncingJobByVmId.keys()), [syncingJobByVmId])

  const [hostFilter, setHostFilter] = useState('')
  const [stateFilter, setStateFilter] = useState<ReplicationCheckState | ''>('')
  // Independent of stateFilter: a VM being synced right now can be in any
  // check state, so "show me what is moving" cannot be one of those buttons.
  const [syncingOnly, setSyncingOnly] = useState(false)
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir } | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  // Per-row selection for the bulk-sync action. Only VMs that can actually be
  // synced (no broken source pool, no missing destination, supported agent)
  // are eligible — the per-row checkbox hides or disables for the rest so the
  // bulk button cannot queue something the controller would refuse.
  const [selectedVmIds, setSelectedVmIds] = useState<Set<string>>(new Set())
  const [bulkSyncing, setBulkSyncing] = useState(false)

  const vms = results?.vms || []

  const filtered = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    return vms.filter(v => {
      if (hostFilter && v.backupHostId !== hostFilter) return false
      if (stateFilter && v.state !== stateFilter) return false
      if (syncingOnly && !syncingVmIds.has(v.vmId)) return false
      if (query) {
        const targets = (v.targets || [])
          .map(t => `${t.offsiteHostName || ''} ${t.ip || ''} ${t.path || ''}`)
          .join(' ')
        const haystack = [
          v.vmName,
          v.backupHostName,
          v.state,
          v.reason,
          targets,
        ].filter(Boolean).join(' ').toLowerCase()
        if (!haystack.includes(query)) return false
      }
      return true
    })
  }, [vms, hostFilter, stateFilter, searchQuery, syncingOnly, syncingVmIds])

  const counts = useMemo(() => ({
    in_sync: vms.filter(v => v.state === 'in_sync').length,
    out_of_sync: vms.filter(v => v.state === 'out_of_sync').length,
    source_unavailable: vms.filter(v => v.state === 'source_unavailable').length,
    no_target: vms.filter(v => v.state === 'no_target').length,
    not_checked: vms.filter(v => v.state === 'not_checked').length,
    other: vms.filter(v => ['skipped', 'unreachable', 'error'].includes(v.state)).length,
    syncing: vms.filter(v => syncingVmIds.has(v.vmId)).length,
  }), [vms, syncingVmIds])

  const toggleState = (s: ReplicationCheckState) =>
    setStateFilter(prev => (prev === s ? '' : s))

  // Eligible rows: VMs the agent can actually sync. Anything else (broken
  // source pool, missing destination, agent too old) is excluded from the
  // bulk action so the controller cannot end up with a queue of doomed
  // requests.
  const isSelectable = (vm: ReplicationCheckVM) =>
    vm.state !== 'source_unavailable' &&
    vm.state !== 'no_target' &&
    !vm.agentUnsupported

  const toggleSelected = (vmId: string) =>
    setSelectedVmIds(prev => {
      const next = new Set(prev)
      if (next.has(vmId)) next.delete(vmId)
      else next.add(vmId)
      return next
    })

  const clearSelection = () => setSelectedVmIds(new Set())

  // Reset to page 1 when search query or filter changes. Selection is dropped
  // too — keeping rows selected that the new filter has hidden would mean
  // syncing VMs the user can no longer see.
  useEffect(() => {
    setCurrentPage(1)
    setSelectedVmIds(new Set())
  }, [searchQuery, hostFilter, stateFilter, syncingOnly])

  // Pagination — slice the filtered list to the current page. Same shape as
  // the History tab: the controller already returns VMs in a stable order, so
  // this is a client-side slice over `filtered`. Selection persists across
  // pages so a bulk sync can reach beyond the current view. Declared before
  // the page-scoped selectors below so they read a defined `pageItems`.
  // Sorting. Applied after filtering and before paging, so a sort reaches the
  // whole result set rather than reshuffling the current page.
  //
  // "Action" is the interesting one: it orders by how much attention a row
  // wants — what is transferring now, then what is behind, then failures,
  // then the rows that need nothing — which is what clicking that column is
  // actually asking for.
  const ACTION_RANK: Record<string, number> = {
    out_of_sync: 1, error: 2, unreachable: 2, not_checked: 3,
    source_unavailable: 4, no_target: 4, skipped: 5, in_sync: 6,
  }
  const sortValue = (vm: ReplicationCheckVM, key: SortKey): string | number => {
    switch (key) {
      case 'vm': return (vm.vmName || '').toLowerCase()
      case 'host': return (vm.backupHostName || '').toLowerCase()
      case 'state': return vm.state || ''
      case 'targets':
        return (vm.targets || [])
          .map(t => t.offsiteHostName || t.ip || '')
          .join(', ')
          .toLowerCase()
      case 'checked': {
        // Never-checked rows sort as the oldest possible: they are the ones
        // with no verdict at all, so ascending puts them first.
        const t = vm.checkedAt ? new Date(vm.checkedAt).getTime() : 0
        return Number.isFinite(t) ? t : 0
      }
      case 'action':
        return syncingVmIds.has(vm.vmId) ? 0 : (ACTION_RANK[vm.state] ?? 7)
    }
  }

  const sorted = useMemo(() => {
    if (!sort) return filtered
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      const av = sortValue(a, sort.key)
      const bv = sortValue(b, sort.key)
      if (av < bv) return -1 * dir
      if (av > bv) return 1 * dir
      // Stable tiebreak on name so equal rows don't shuffle between renders.
      return (a.vmName || '').localeCompare(b.vmName || '')
    })
  }, [filtered, sort, syncingVmIds])

  // asc → desc → off, so the controller's own ordering stays reachable.
  const handleSort = (key: SortKey) => {
    setSort(prev => {
      if (!prev || prev.key !== key) return { key, dir: 'asc' }
      if (prev.dir === 'asc') return { key, dir: 'desc' }
      return null
    })
    setCurrentPage(1)
  }

  const totalItems = sorted.length
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
  const startIndex = (currentPage - 1) * pageSize
  const endIndex = startIndex + pageSize
  const pageItems = sorted.slice(startIndex, endIndex)

  // The "select all on this view" checkbox scopes to the current page; the
  // selection set itself persists across pages so a bulk sync can reach
  // beyond the visible page.
  const eligiblePageItems = useMemo(() => pageItems.filter(isSelectable), [pageItems])
  const eligiblePageSelected =
    eligiblePageItems.length > 0 && eligiblePageItems.every(v => selectedVmIds.has(v.vmId))

  const toggleEligiblePage = () =>
    setSelectedVmIds(prev => {
      const next = new Set(prev)
      if (eligiblePageSelected) {
        eligiblePageItems.forEach(v => next.delete(v.vmId))
      } else {
        eligiblePageItems.forEach(v => next.add(v.vmId))
      }
      return next
    })

  // Queue one rsync per selected VM, sequentially. The controller coalesces
  // per-VM (a 409 means "already covered"), so a VM with a sync already in
  // flight counts as success here — it has nothing to do but is not failing.
  const handleBulkSync = async () => {
    const selected = filtered.filter(v => selectedVmIds.has(v.vmId) && isSelectable(v))
    if (selected.length === 0) return
    const ok = await confirm({
      title: `Sync ${selected.length} VM${selected.length === 1 ? '' : 's'} offsite?`,
      description:
        'One rsync is queued for each selected VM. Anything that already reached the destination '
        + 'stays — only the remainder is sent. A VM with a sync already running is left alone.',
      confirmText: `Sync ${selected.length}`,
    })
    if (!ok) return
    setBulkSyncing(true)
    let queued = 0
    let coalesced = 0
    const errored: string[] = []
    for (const vm of selected) {
      try {
        const res = await triggerSync.mutateAsync({
          vmId: vm.vmId,
          scheduleId: vm.scheduleId,
          vmName: vm.vmName,
        } as any)
        const data = res as any
        if (data?.note) coalesced++
        else queued++
      } catch (err: any) {
        errored.push(`${vm.vmName}: ${getErrorMessage(err, 'sync failed')}`)
      }
    }
    setBulkSyncing(false)
    clearSelection()
    const parts: string[] = []
    if (queued) parts.push(`${queued} queued`)
    if (coalesced) parts.push(`${coalesced} already covered`)
    if (errored.length === 0) {
      toast.success(`Synced ${selected.length} VM${selected.length === 1 ? '' : 's'}`, {
        description: parts.join(' · ') || undefined,
      })
    } else {
      toast.warning(`${errored.length} of ${selected.length} could not be synced`, {
        description: [...parts, errored.slice(0, 3).join(' · ')].filter(Boolean).join(' · '),
        duration: 8000,
      })
    }
  }

  const handleRun = async (withSync: boolean) => {
    const scoped = hostFilter ? hosts?.find(h => h.id === hostFilter)?.name : null
    const ok = await confirm({
      title: withSync ? 'Check replication and sync what is behind?' : 'Run the replication check now?',
      description: withSync
        ? 'Every VM with an offsite destination is compared against its offsite copy, and a sync is '
          + 'queued for each one found behind. A VM that already has a sync queued or running is left alone.'
        : 'Every VM with an offsite destination is compared against its offsite copy. Nothing is '
          + 'transferred — this only reports.',
      details: [
        scoped ? `Scope: ${scoped}` : 'Scope: all backup hosts',
        'The check stats the whole backup tree at both ends, so it can take a while on large VMs.',
      ],
      confirmText: withSync ? 'Check and sync' : 'Run check',
    })
    if (!ok) return
    await runCheck.mutateAsync({ backupHostId: hostFilter || null, sync: withSync })
  }

  const handleSyncOne = async (vm: ReplicationCheckVM) => {
    const ok = await confirm({
      title: `Sync ${vm.vmName} offsite now?`,
      description:
        'Only what is missing at the destination is sent — files that already arrived are left alone. '
        + 'If a sync for this VM is already queued or running, this request joins it rather than starting a second one.',
      confirmText: 'Sync now',
    })
    if (!ok) return
    await triggerSync.mutateAsync({ vmId: vm.vmId, scheduleId: vm.scheduleId, vmName: vm.vmName })
  }

  const unsupportedHosts = useMemo(() => {
    const names = new Set<string>()
    for (const v of vms) if (v.agentUnsupported) names.add(v.backupHostName)
    return [...names]
  }, [vms])

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 flex-wrap">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Radar className="h-5 w-5" />
            Replication check
          </CardTitle>
          <p className="text-xs text-gray-500 mt-1">
            {results?.finishedAt ? (
              <>
                Last run {formatRelativeTime(results.finishedAt)}
                <span className="text-gray-400"> · {formatDate(results.finishedAt)}</span>
              </>
            ) : (
              'Has not run yet. The interval is set on the Settings page.'
            )}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="outline" size="sm"
              onClick={() => handleRun(false)}
              disabled={runCheck.isPending}
            >
              {runCheck.isPending
                ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                : <RefreshCw className="h-4 w-4 mr-2" />}
              Check now
            </Button>
            <Button
              size="sm"
              onClick={() => handleRun(true)}
              disabled={runCheck.isPending}
            >
              {runCheck.isPending
                ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                : <PlayCircle className="h-4 w-4 mr-2" />}
              Check and sync
            </Button>
          </div>
          {runCheck.isPending && (
            <span className="text-[11px] text-gray-500">
              Comparing both ends — this can take a few minutes.
            </span>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {unsupportedHosts.length > 0 && (
          <div className="rounded-lg border border-orange-300 bg-orange-50 text-orange-900 p-3 text-xs dark:bg-orange-950/40 dark:border-orange-800/60 dark:text-orange-200">
            <strong>Replication cannot be verified on {unsupportedHosts.join(', ')}.</strong>{' '}
            The agent there predates independent replication and does not answer the check.
            Update the agent on those hosts.
          </div>
        )}

        {counts.no_target > 0 && (
          <div className="rounded-lg border border-orange-300 bg-orange-50 text-orange-900 p-3 text-xs dark:bg-orange-950/40 dark:border-orange-800/60 dark:text-orange-200">
            <strong>
              {counts.no_target} VM{counts.no_target === 1 ? ' has' : 's have'} offsite sync on with no destination left.
            </strong>{' '}
            The offsite host or pool they pointed at was deleted, so nothing is being replicated for
            them — while their schedules still say it is. Pick a destination again, or turn offsite
            sync off for those schedules.
          </div>
        )}

        {counts.not_checked > 0 && (
          <div className="rounded-lg border border-blue-300 bg-blue-50 text-blue-900 p-3 text-xs dark:bg-blue-950/40 dark:border-blue-800/60 dark:text-blue-200">
            <strong>
              {counts.not_checked} VM{counts.not_checked === 1 ? ' is' : 's are'} replicating offsite but
              {counts.not_checked === 1 ? ' has' : ' have'} not been compared yet.
            </strong>{' '}
            Offsite sync was switched on for {counts.not_checked === 1 ? 'it' : 'them'} since the last
            check ran, so there is no verdict to show. The check picks them up on its next run — or use
            "Check now" to compare them immediately. Their backups already replicate in the meantime.
          </div>
        )}

        {counts.source_unavailable > 0 && (
          <div className="rounded-lg border border-red-300 bg-red-50 text-red-900 p-3 text-xs dark:bg-red-950/40 dark:border-red-800/60 dark:text-red-200">
            <strong>
              {counts.source_unavailable} VM{counts.source_unavailable === 1 ? '' : 's'} — backup pool not mounted.
            </strong>{' '}
            Replication is deliberately refused for these: syncing from an empty mount point would
            delete their offsite copies, which may be the only copies left. Mount the pool, then re-run the check.
          </div>
        )}

        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <Stat
            label="Syncing now" value={counts.syncing}
            cls={`border-purple-200 bg-purple-50 text-purple-900 dark:bg-purple-950/40 dark:border-purple-800/60 dark:text-purple-200 ${
              counts.syncing > 0 ? 'ring-1 ring-purple-300 dark:ring-purple-700' : ''
            }`}
            onClick={() => setSyncingOnly(v => !v)} active={syncingOnly}
          />
          <Stat
            label="In sync" value={counts.in_sync}
            cls="border-emerald-200 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:border-emerald-800/60 dark:text-emerald-200"
            onClick={() => toggleState('in_sync')} active={stateFilter === 'in_sync'}
          />
          <Stat
            label="Behind" value={counts.out_of_sync}
            cls="border-amber-200 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:border-amber-800/60 dark:text-amber-200"
            onClick={() => toggleState('out_of_sync')} active={stateFilter === 'out_of_sync'}
          />
          <Stat
            label="Source not mounted" value={counts.source_unavailable}
            cls="border-red-200 bg-red-50 text-red-900 dark:bg-red-950/40 dark:border-red-800/60 dark:text-red-200"
            onClick={() => toggleState('source_unavailable')} active={stateFilter === 'source_unavailable'}
          />
          <Stat
            label="Not checked yet" value={counts.not_checked}
            cls="border-blue-200 bg-blue-50 text-blue-900 dark:bg-blue-950/40 dark:border-blue-800/60 dark:text-blue-200"
            onClick={() => toggleState('not_checked')} active={stateFilter === 'not_checked'}
          />
          <Stat
            label="Skipped / errored" value={counts.other}
            cls="border-gray-200 bg-gray-50 text-gray-800 dark:bg-gray-800/60 dark:border-gray-700 dark:text-gray-300"
          />
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative w-full sm:w-72 min-w-0">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
            <Input
              type="text"
              placeholder="Search VM, host, destination..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>
          <Select
            value={hostFilter}
            onChange={(e) => setHostFilter(e.target.value)}
            className="w-[240px]"
          >
            <option value="">All backup hosts</option>
            {(hosts || []).map(h => (
              <option key={h.id} value={h.id}>{h.name}</option>
            ))}
          </Select>
          {stateFilter && (
            <Button variant="ghost" size="sm" onClick={() => setStateFilter('')}>
              Clear "{stateFilter}" filter
            </Button>
          )}
          {syncingOnly && (
            <Button variant="ghost" size="sm" onClick={() => setSyncingOnly(false)}>
              Clear "syncing now" filter
            </Button>
          )}
          {sort && (
            <Button variant="ghost" size="sm" onClick={() => setSort(null)}>
              Clear sorting
            </Button>
          )}
        </div>

        {/* Bulk-action bar — only shown when at least one VM is selected.
            The Sync button fans out one rsync per selected VM; Clear drops
            the selection without sending anything. */}
        {selectedVmIds.size > 0 && (
          <div className="flex items-center justify-between rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 dark:border-blue-900 dark:bg-blue-950">
            <span className="text-sm font-medium text-blue-900 dark:text-blue-100">
              {selectedVmIds.size} VM{selectedVmIds.size !== 1 ? 's' : ''} selected
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost" size="sm"
                onClick={clearSelection}
                disabled={bulkSyncing}
              >
                <X className="h-4 w-4 mr-1" />
                Clear
              </Button>
              <Button
                size="sm"
                onClick={handleBulkSync}
                disabled={bulkSyncing}
              >
                {bulkSyncing
                  ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  : <PlayCircle className="h-4 w-4 mr-2" />}
                Sync selected ({selectedVmIds.size})
              </Button>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-gray-500 py-10 justify-center">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading check results…
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-10 text-sm text-gray-500">
            {vms.length === 0
              ? 'No VM has offsite sync switched on. Turn it on in a schedule and it appears here straight away.'
              : searchQuery
                ? `No VM matches "${searchQuery}"${hostFilter || stateFilter ? ' with the current filters' : ''}.`
                : 'No VM matches those filters.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={eligiblePageSelected}
                      onChange={toggleEligiblePage}
                      disabled={eligiblePageItems.length === 0}
                      aria-label="Select every syncable VM in this view"
                      title={eligiblePageSelected ? 'Clear selection on this view' : 'Select every syncable VM in this view'}
                    />
                  </TableHead>
                  <SortableHead label="VM" sortKey="vm" sort={sort} onSort={handleSort} />
                  <SortableHead label="Backup host" sortKey="host" sort={sort} onSort={handleSort} />
                  <SortableHead label="State" sortKey="state" sort={sort} onSort={handleSort} />
                  <TableHead>Detail</TableHead>
                  <SortableHead label="Destination(s)" sortKey="targets" sort={sort} onSort={handleSort} />
                  <SortableHead label="Checked" sortKey="checked" sort={sort} onSort={handleSort} />
                  <SortableHead
                    label="Actions" sortKey="action" sort={sort} onSort={handleSort}
                    className="text-right"
                  />
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageItems.map(vm => {
                  const targets = vm.targets || []
                  const behind = vm.state === 'out_of_sync'
                  const inSync = vm.state === 'in_sync'
                  // The last attempt could not be completed — a retry is the
                  // right verb, not "sync".
                  const errored = vm.state === 'error' || vm.state === 'unreachable'
                  // A VM whose source pool is not mounted must not offer a sync
                  // button: the agent would refuse, and offering it invites the
                  // one action that could destroy the remaining copy.
                  // Nothing to sync to: a broken configuration needs fixing in
                  // the schedule, not a transfer.
                  const canSync = isSelectable(vm)
                  // A sync for this VM is already queued or running on the
                  // agent. Show the button in its loading state so the next
                  // click does not look like a no-op while the request is in
                  // flight (or while a still-running job is queued behind it).
                  const syncJob = syncingJobByVmId.get(vm.vmId)
                  const syncInFlight = !!syncJob
                  const selected = selectedVmIds.has(vm.vmId)

                  // A row with a transfer in flight is the one thing on this
                  // page that is changing, so it gets the whole row: a purple
                  // tint and a left edge, not just a spinner in the last
                  // column where it is easy to miss among 20 quiet rows.
                  const rowClass = syncInFlight
                    ? 'bg-purple-50/70 dark:bg-purple-950/30 border-l-4 border-l-purple-500'
                    : selected
                      ? 'bg-blue-50/40 dark:bg-blue-950/20'
                      : ''

                  return (
                    <TableRow key={vm.vmId} className={rowClass}>
                      <TableCell className="w-10">
                        <Checkbox
                          checked={selected}
                          onChange={() => toggleSelected(vm.vmId)}
                          disabled={!canSync}
                          aria-label={`Select ${vm.vmName}`}
                          title={canSync ? `Select ${vm.vmName} for a bulk sync` : 'Cannot be synced from this state'}
                        />
                      </TableCell>
                      <TableCell>
                        <VmNameCell vmName={vm.vmName} maxWidthClass="max-w-[240px]" />
                      </TableCell>
                      <TableCell className="text-xs">{vm.backupHostName}</TableCell>
                      <TableCell>
                        {/* One icon for the whole VM. Per-offsite breakdown,
                            sync-queued note, agent-too-old and any reason text
                            all live on the icon's tooltip so the row stays a
                            single dot. */}
                        <ReplicationStateIcon vm={vm} />
                      </TableCell>
                      <TableCell className="text-xs max-w-[280px]">
                        {/* Quiet rows keep this column empty — the per-target
                            breakdown lives on the status icon's hover. A row
                            with a transfer in flight is the exception: what
                            stage it is at is worth the space. */}
                        {syncJob ? (
                          <div className="space-y-1">
                            <div className="flex items-center gap-1.5 font-medium text-purple-800 dark:text-purple-200">
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              {syncJob.status === 'queued'
                                ? 'Queued'
                                : `Syncing${syncJob.progress ? ` · ${Math.round(syncJob.progress)}%` : ''}`}
                            </div>
                            {syncJob.status === 'running' && (
                              <div className="h-1 w-full rounded-full bg-purple-200 dark:bg-purple-900 overflow-hidden">
                                <div
                                  className="h-full bg-purple-600 transition-all duration-500"
                                  style={{ width: `${Math.min(100, Math.max(2, syncJob.progress || 2))}%` }}
                                />
                              </div>
                            )}
                            {syncJob.progressText && (
                              <div className="truncate text-purple-700/80 dark:text-purple-300/80" title={syncJob.progressText}>
                                {syncJob.progressText}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div
                          className="text-xs max-w-[180px] truncate"
                          title={targets.map(t => `${t.offsiteHostName || t.ip}${t.path ? ` → ${t.path}` : ''}`).join('\n')}
                        >
                          {targets.map(t => t.offsiteHostName || t.ip).join(', ') || '-'}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs whitespace-nowrap">
                        {vm.checkedAt ? (
                          formatRelativeTime(vm.checkedAt)
                        ) : (
                          // "-" reads as "no data"; this row means something
                          // more specific — the audit has not reached it yet.
                          <span className="text-blue-600 dark:text-blue-300">Not yet</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {/* Four states, four affordances:
                            in sync   → Sync offered but disabled; there is
                                        nothing to send, and an enabled button
                                        invites a pointless full-tree walk.
                            errored   → Retry, because the last attempt failed
                                        and this resumes it rather than starting
                                        something new.
                            behind    → Sync, active; this is the one case where
                                        there is real work to do.
                            syncing   → the same Sync / Retry button but with a
                                        spinner and disabled, so a second click
                                        does not queue a duplicate request while
                                        the original is still in flight. */}
                        {!canSync ? null : syncInFlight ? (
                          <Button
                            variant={behind ? 'default' : 'outline'}
                            size="sm"
                            disabled
                            title="A sync for this VM is already queued or running — wait for it to finish."
                          >
                            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                            {errored ? 'Retrying…' : 'Syncing…'}
                          </Button>
                        ) : inSync ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled
                            title="Already in sync — nothing to send."
                          >
                            <CheckCircle2 className="h-4 w-4 mr-1" />
                            Synced
                          </Button>
                        ) : errored ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleSyncOne(vm)}
                            disabled={triggerSync.isPending}
                            title="Retry — resumes from whatever already reached the destination"
                          >
                            <RefreshCw className="h-4 w-4 mr-1" />
                            Retry
                          </Button>
                        ) : (
                          <Button
                            variant={behind ? 'default' : 'ghost'}
                            size="sm"
                            onClick={() => handleSyncOne(vm)}
                            disabled={triggerSync.isPending}
                            title="Queue an offsite sync for this VM"
                          >
                            <PlayCircle className="h-4 w-4 mr-1" />
                            Sync
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Result counter — shown above the pager so the user can read both
            before paging. Same wording as the History tab. */}
        {!isLoading && totalItems > 0 && (
          <div className="text-sm text-gray-600">
            {searchQuery
              ? `Found ${totalItems} VM${totalItems !== 1 ? 's' : ''} matching "${searchQuery}" (showing ${startIndex + 1}-${Math.min(endIndex, totalItems)})`
              : `Showing ${startIndex + 1}-${Math.min(endIndex, totalItems)} of ${totalItems} VM${totalItems !== 1 ? 's' : ''}`}
          </div>
        )}

        {/* Pagination — same controls and layout as the History tab so the two
            tables feel identical: items-per-page selector on the left,
            page buttons + Previous/Next on the right. */}
        {!isLoading && totalItems > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-600">Items per page:</span>
              <Select
                value={pageSize.toString()}
                onChange={(e) => {
                  setPageSize(Number(e.target.value))
                  setCurrentPage(1)
                }}
                className="w-20"
              >
                <option value="10">10</option>
                <option value="20">20</option>
                <option value="50">50</option>
                <option value="100">100</option>
              </Select>
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
                  {currentPage > 3 && (
                    <>
                      <Button
                        variant={currentPage === 1 ? "default" : "outline"}
                        size="sm"
                        onClick={() => setCurrentPage(1)}
                        className="w-10"
                      >
                        1
                      </Button>
                      {currentPage > 4 && (
                        <span className="px-2 text-gray-400">...</span>
                      )}
                    </>
                  )}

                  {Array.from({ length: totalPages }, (_, i) => i + 1)
                    .filter(page => page >= currentPage - 2 && page <= currentPage + 2)
                    .map(page => (
                      <Button
                        key={page}
                        variant={currentPage === page ? "default" : "outline"}
                        size="sm"
                        onClick={() => setCurrentPage(page)}
                        className="w-10"
                      >
                        {page}
                      </Button>
                    ))}

                  {currentPage < totalPages - 2 && (
                    <>
                      {currentPage < totalPages - 3 && (
                        <span className="px-2 text-gray-400">...</span>
                      )}
                      <Button
                        variant={currentPage === totalPages ? "default" : "outline"}
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
      </CardContent>
    </Card>
  )
}
