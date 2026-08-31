import { useState, useEffect, useMemo } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Select } from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { Eye, Loader2, Trash2, RefreshCw, Search, ChevronLeft, ChevronRight } from 'lucide-react'
import { useBackupHistory, useForceRemoveJob, useRetryBackup, useBulkRetryBackups, useBulkForceRemoveJobs } from '@/hooks/useBackups'
import { useOffsiteJobs, useRetryOffsiteJob, useOffsiteJobEvents } from '@/hooks/useOffsiteJobs'
import { toUnifiedJobs, isReplicationRetryable } from '@/lib/offsiteJobAdapter'
import OffsiteLogViewer from '@/components/offsite/OffsiteLogViewer'
import OffsiteJobStatusIcon from '@/components/offsite/OffsiteJobStatusIcon'
import { formatDate, formatDateCompact, formatDuration, jobTypeCode, methodCode } from '@/lib/utils'
import LiveLogViewer from './LiveLogViewer'
import JobProgressBar from './JobProgressBar'
import JobStatusIcons from './JobStatusIcons'
import VmNameCell from '@/components/common/VmNameCell'
import VmNameToggle from '@/components/common/VmNameToggle'
import socketService from '@/services/socket'
import { useQueryClient } from '@tanstack/react-query'
import { debouncedInvalidate } from '@/lib/debouncedInvalidate'
import { useSearchParams } from 'react-router-dom'
import { useConfirm } from '@/components/ui/confirm-dialog'

/**
 * Whether a row offers a Retry action. Single source of truth for both the
 * row button and the bulk-selection checkbox.
 *
 * - Replication has its own notion of retryable — `busy` is retryable there
 *   (the job did nothing because another transfer held the lock).
 * - A rejected backup never executed — retrying it once the backup it
 *   collided with has finished is exactly what it is for.
 * - Restores are never retried from this page.
 */
const isRetryable = (job: any) =>
  (job.jobType === 'rsync' && isReplicationRetryable(job.status)) ||
  (job.status === 'skipped' && job.canRetry) ||
  (job.status === 'rejected' && job.canRetry !== false && job.jobType !== 'restore') ||
  (job.status === 'failed' && job.canRetry !== false && job.jobType !== 'restore')

/**
 * Job History.
 *
 * One table for backup, restore and rsync (offsite replication) jobs. Each
 * backup that triggers an rsync records the transfer as its own job, so the
 * rsync appears as its own row here with its own status icon — one icon per
 * row, scoped to the job. The two used to share a row, with the backup's
 * icon joined by a second dot for the transfer; that double-icon was
 * confusing because the same run was being described twice.
 */
export default function BackupHistory() {
  const [searchParams, setSearchParams] = useSearchParams()
  const initialStatus = searchParams.get('status') || ''
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [selectedJobType, setSelectedJobType] = useState<'backup' | 'restore'>('backup')
  const [selectedLogId, setSelectedLogId] = useState<{ id: string; type: 'backup' | 'restore' | 'rsync' } | null>(null)
  const [statusFilter, setStatusFilter] = useState<string>(initialStatus)
  // Type filter: backup / restore / rsync. The server-side history endpoint
  // does not know about rsync (that lives in its own store), so this filter
  // is applied client-side alongside the existing status filter — it trims
  // the merged list down to one of the three job kinds.
  const [typeFilter, setTypeFilter] = useState<string>('')
  const [searchQuery, setSearchQuery] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [showFullVmNames, setShowFullVmNames] = useState<boolean>(() => {
    return localStorage.getItem('vm-name-display') === 'full'
  })
  useEffect(() => {
    localStorage.setItem('vm-name-display', showFullVmNames ? 'full' : 'short')
  }, [showFullVmNames])
  const queryClient = useQueryClient()

  const { data: backupHistory, isLoading } = useBackupHistory({
    status: statusFilter || undefined,
    limit: 1000,
  })
  const { data: replicationHistory } = useOffsiteJobs({ limit: 500 })
  // Keep rsync rows moving at the same rate as backup rows.
  useOffsiteJobEvents()

  const retryOffsite = useRetryOffsiteJob()

  // Replication is a job like any other from the operator's point of view: it
  // ran, it took time, it succeeded or it did not. It belongs in the same
  // history rather than on a page of its own — every backup that asked for a
  // sync records that transfer as a separate row here.
  const allHistory = useMemo(() => {
    const replications = toUnifiedJobs(replicationHistory)
      // The status filter is applied server-side for backups; apply the same
      // one here so a filtered view does not silently show every replication.
      .filter(j => !statusFilter || j.status === statusFilter)
      // Repurpose the replication jobType for the merged table.
      .map((j: any) => ({ ...j, jobType: 'rsync' }))
    // The type filter trims the merged list down to one kind. Empty = all.
    const base = [...(backupHistory || []), ...replications]
    const filtered = !typeFilter ? base : base.filter(j => j.jobType === typeFilter)
    return filtered.sort((a, b) =>
      new Date(b.startTime || b.createdAt || 0).getTime() -
      new Date(a.startTime || a.createdAt || 0).getTime())
  }, [backupHistory, replicationHistory, statusFilter, typeFilter])

  // A rejected run points at the backup that WAS running via `coveredBy`.
  // Without resolving it the row reads "rejected / - / 0s" and the operator
  // has no way to see that the VM was in fact backed up seconds earlier by
  // another run — the row and its log then appear to contradict each other.
  const jobsById = useMemo(() => {
    const map = new Map<string, any>()
    for (const job of allHistory || []) map.set(job.id, job)
    return map
  }, [allHistory])

  // Filter history based on search query
  const filteredHistory = allHistory?.filter(job => {
    if (!searchQuery) return true
    const query = searchQuery.toLowerCase()
    return (
      job.vmName?.toLowerCase().includes(query) ||
      job.backupHostName?.toLowerCase().includes(query) ||
      job.scheduleType?.toLowerCase().includes(query) ||
      job.method?.toLowerCase().includes(query) ||
      job.status?.toLowerCase().includes(query) ||
      job.jobType?.toLowerCase().includes(query) ||
      job.error?.toLowerCase().includes(query) ||
      job.trigger?.toLowerCase().includes(query) ||
      // Searchable by id so the covering job named on a rejected row (and in
      // the log header) can actually be found.
      job.id?.toLowerCase().includes(query)
    )
  })

  // Calculate pagination
  const totalItems = filteredHistory?.length || 0
  const totalPages = Math.ceil(totalItems / pageSize)
  const startIndex = (currentPage - 1) * pageSize
  const endIndex = startIndex + pageSize
  const history = filteredHistory?.slice(startIndex, endIndex)

  // Reset to page 1 when search query or filter changes. Selection is dropped
  // too — keeping rows selected that the new filter has hidden would mean
  // retrying jobs the user can no longer see.
  useEffect(() => {
    setCurrentPage(1)
    setSelectedIds(new Set())
  }, [searchQuery, statusFilter, typeFilter])

  const forceRemoveJob = useForceRemoveJob()
  const retryBackup = useRetryBackup()
  const bulkRetry = useBulkRetryBackups()
  const bulkForceRemove = useBulkForceRemoveJobs()
  const confirm = useConfirm()

  // Selection survives paging, so a bulk action can span pages. Resolving it
  // against filteredHistory (not the Set) means ids that have since vanished —
  // a retried failure is deleted from history — silently drop out instead of
  // inflating the count.
  const selectedAllJobs = (filteredHistory || []).filter(j => selectedIds.has(j.id))
  const selectedRetryableJobs = selectedAllJobs.filter(isRetryable)
  const pageJobs = history || []
  const allPageSelected =
    pageJobs.length > 0 && pageJobs.every(j => selectedIds.has(j.id))
  const bulkBusy = bulkRetry.isPending || bulkForceRemove.isPending

  const toggleOne = (id: string) =>
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const togglePage = () =>
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (allPageSelected) pageJobs.forEach(j => next.delete(j.id))
      else pageJobs.forEach(j => next.add(j.id))
      return next
    })

  const handleBulkRetry = async () => {
    const n = selectedRetryableJobs.length
    const ok = await confirm({
      title: `Retry ${n} job${n !== 1 ? 's' : ''}?`,
      description:
        `Each selected backup or rsync is retried in turn using its original configuration. ` +
        `Retried failures are removed from history and replaced by the new attempt. ` +
        `Any that exceed the host's concurrent limit will wait for a free slot.`,
      confirmText: `Retry ${n}`,
    })
    if (!ok) return
    await bulkRetry.mutateAsync(selectedRetryableJobs.map(j => ({ id: j.id, vmName: j.vmName })))
    setSelectedIds(new Set())
  }

  // Every failed job across the current filter/search (not just the page), for
  // the one-click "remove every failed job" action.
  const failedJobs = (filteredHistory || []).filter(j => j.status === 'failed')

  const handleRemoveAllFailed = async () => {
    const n = failedJobs.length
    if (n === 0) return
    const ok = await confirm({
      title: `Remove ${n} failed job${n !== 1 ? 's' : ''}?`,
      description: `Every failed backup and rsync${searchQuery || statusFilter ? ' matching the current filter' : ''} is removed from history in turn.`,
      details: [
        'Removes the failed jobs from history',
        'Attempts to kill any live process on the agent',
        'Cannot be undone',
      ],
      confirmText: `Remove ${n} failed`,
      variant: 'danger',
      requireInput: 'REMOVE',
    })
    if (!ok) return
    await bulkForceRemove.mutateAsync(failedJobs.map(j => ({ id: j.id, vmName: j.vmName })))
    setSelectedIds(new Set())
  }

  const handleBulkForceRemove = async () => {
    const n = selectedAllJobs.length
    const ok = await confirm({
      title: `Force remove ${n} job${n !== 1 ? 's' : ''}?`,
      description: `Each selected job is removed from history in turn.`,
      details: [
        'Removes the jobs from history',
        'Attempts to kill any live process on the agent',
        'Cannot be undone',
      ],
      confirmText: `Force remove ${n}`,
      variant: 'danger',
      requireInput: 'REMOVE',
    })
    if (!ok) return
    await bulkForceRemove.mutateAsync(selectedAllJobs.map(j => ({ id: j.id, vmName: j.vmName })))
    setSelectedIds(new Set())
  }

  // Update URL when filter changes
  useEffect(() => {
    if (statusFilter) {
      setSearchParams({ status: statusFilter })
    } else {
      setSearchParams({})
    }
  }, [statusFilter, setSearchParams])

  // Periodic reconcile as a safety net. Real-time changes arrive via the
  // socket handlers below (which patch the cache in place); refetching the
  // full history every second hammered the controller — each request also
  // runs a per-job agent sync — and was a major cause of panel lag when
  // many jobs run at once.
  useEffect(() => {
    const interval = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: ['backups', 'history'] })
      queryClient.invalidateQueries({ queryKey: ['offsite-jobs'] })
    }, 10000)

    return () => clearInterval(interval)
  }, [queryClient])

  // Listen for real-time backup updates
  useEffect(() => {
    const cleanupProgress = socketService.on('backup-progress', (data: any) => {
      queryClient.setQueryData(['backups', 'history', { status: statusFilter || undefined, limit: 1000 }], (old: any) => {
        if (!old) return old
        return old.map((job: any) =>
          job.id === data.jobId
            ? { ...job, status: data.status, progress: data.progress, progressText: data.progressText }
            : job
        )
      })
    })

    const cleanupComplete = socketService.on('backup-complete', (data: any) => {
      queryClient.setQueryData(['backups', 'history', { status: statusFilter || undefined, limit: 1000 }], (old: any) => {
        if (!old) return old
        return old.map((job: any) =>
          job.id === data.id
            ? { ...job, status: 'completed', progress: 100, endTime: data.endTime }
            : job
        )
      })
    })

    const cleanupError = socketService.on('backup-error', (data: any) => {
      queryClient.setQueryData(['backups', 'history', { status: statusFilter || undefined, limit: 1000 }], (old: any) => {
        if (!old) return old
        return old.map((job: any) =>
          job.id === data.id
            ? { ...job, status: 'failed', error: data.error, endTime: data.endTime }
            : job
        )
      })
    })

    const cleanupStarted = socketService.on('backup-started', () => {
      debouncedInvalidate(queryClient, ['backups', 'history'])
    })

    return () => {
      cleanupProgress()
      cleanupComplete()
      cleanupError()
      cleanupStarted()
    }
  }, [queryClient, statusFilter])

  const handleForceRemove = async (jobId: string, vmName: string) => {
    const ok = await confirm({
      title: 'Force remove job?',
      description: `Force remove the job for "${vmName}".`,
      details: [
        'Removes the job from history',
        'Attempts to kill the process on the agent',
        'Cannot be undone',
      ],
      confirmText: 'Force remove',
      variant: 'danger',
    })
    if (ok) await forceRemoveJob.mutateAsync(jobId)
  }

  const handleRetry = async (jobId: string, vmName: string, jobType?: string) => {
    if (jobType === 'rsync') {
      const ok = await confirm({
        title: 'Retry rsync?',
        description:
          `Resume the offsite rsync for "${vmName}". Files that already arrived stay, and a `
          + 'partly transferred file resumes from where it stopped — this sends the remainder, not the whole chain.',
        confirmText: 'Retry rsync',
      })
      if (ok) await retryOffsite.mutateAsync({ id: jobId, vmName })
      return
    }
    const ok = await confirm({
      title: 'Retry backup?',
      description: `Create a new backup job for "${vmName}" using the same configuration.`,
      confirmText: 'Retry',
    })
    if (ok) await retryBackup.mutateAsync(jobId)
  }

  const openLogs = (job: any) => {
    if (job.jobType === 'rsync') {
      setSelectedLogId({ id: job.id, type: 'rsync' })
      return
    }
    setSelectedJobId(job.id)
    setSelectedJobType(job.jobType === 'restore' ? 'restore' : 'backup')
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Job History</CardTitle>
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              <Button
                variant="outline"
                size="sm"
                onClick={handleRemoveAllFailed}
                disabled={bulkBusy || failedJobs.length === 0}
                className="text-red-600 hover:text-red-700 hover:bg-red-50 border-red-200"
                title="Force remove every failed job in the current view"
              >
                {bulkForceRemove.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4 mr-2" />
                )}
                Remove failed{failedJobs.length > 0 ? ` (${failedJobs.length})` : ''}
              </Button>
              <VmNameToggle showFull={showFullVmNames} onToggle={setShowFullVmNames} />
              <div className="relative w-full sm:w-56 min-w-0">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                <Input
                  type="text"
                  placeholder="Search history..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>
              <Select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <option value="">All Status</option>
                <option value="completed">Completed</option>
                <option value="failed">Failed</option>
                <option value="rejected">Rejected</option>
                <option value="retrying">Retrying</option>
                <option value="skipped">Skipped</option>
                <option value="running">Running</option>
                <option value="busy">Busy</option>
                <option value="cancelled">Cancelled</option>
                <option value="unsupported">Unsupported</option>
              </Select>
              {/* Job-type filter: trims the merged list down to one kind.
                  The history endpoint does not accept a jobType param, so
                  this is applied client-side after the merge. */}
              <Select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
                title="Job type"
                aria-label="Filter by job type"
              >
                <option value="">All Types</option>
                <option value="backup">Backup</option>
                <option value="restore">Restore</option>
                <option value="rsync">Rsync</option>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
            </div>
          ) : history && history.length > 0 ? (
            <>
              {searchQuery && (
                <div className="mb-4 text-sm text-gray-600">
                  Found {totalItems} job{totalItems !== 1 ? 's' : ''} matching "{searchQuery}" (showing {startIndex + 1}-{Math.min(endIndex, totalItems)})
                </div>
              )}
              {!searchQuery && totalItems > 0 && (
                <div className="mb-4 text-sm text-gray-600">
                  Showing {startIndex + 1}-{Math.min(endIndex, totalItems)} of {totalItems} job{totalItems !== 1 ? 's' : ''}
                </div>
              )}
              {selectedAllJobs.length > 0 && (
                <div className="mb-4 flex items-center justify-between rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 dark:border-blue-900 dark:bg-blue-950">
                  <span className="text-sm font-medium text-blue-900 dark:text-blue-100">
                    {selectedAllJobs.length} job{selectedAllJobs.length !== 1 ? 's' : ''} selected
                    {selectedRetryableJobs.length > 0 && selectedRetryableJobs.length !== selectedAllJobs.length && (
                      <span className="font-normal text-blue-700 dark:text-blue-300">
                        {' '}({selectedRetryableJobs.length} retryable)
                      </span>
                    )}
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setSelectedIds(new Set())}
                      disabled={bulkBusy}
                    >
                      Clear
                    </Button>
                    <Button
                      size="sm"
                      onClick={handleBulkRetry}
                      disabled={bulkBusy || selectedRetryableJobs.length === 0}
                    >
                      {bulkRetry.isPending ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Retrying…
                        </>
                      ) : (
                        <>
                          <RefreshCw className="mr-2 h-4 w-4" />
                          Retry selected{selectedRetryableJobs.length > 0 ? ` (${selectedRetryableJobs.length})` : ''}
                        </>
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={handleBulkForceRemove}
                      disabled={bulkBusy}
                    >
                      {bulkForceRemove.isPending ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Removing…
                        </>
                      ) : (
                        <>
                          <Trash2 className="mr-2 h-4 w-4" />
                          Force remove selected ({selectedAllJobs.length})
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              )}
              <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={allPageSelected}
                      onChange={togglePage}
                      disabled={pageJobs.length === 0}
                      aria-label="Select all jobs on this page"
                    />
                  </TableHead>
                  <TableHead className="w-[90px]" title="Job type">Type</TableHead>
                  <TableHead>VM</TableHead>
                  <TableHead className="w-[90px]" title="Schedule / method">Method</TableHead>
                  <TableHead className="w-[80px] pl-3 pr-0" title="Job outcome">Status</TableHead>
                  <TableHead className="w-[28%] pl-3">Progress</TableHead>
                  <TableHead className="w-[90px]">Duration</TableHead>
                  <TableHead className="w-[140px] whitespace-nowrap ">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((job) => (
                  <TableRow key={job.id} className="group">
                    <TableCell className="w-10">
                      <Checkbox
                        checked={selectedIds.has(job.id)}
                        onChange={() => toggleOne(job.id)}
                        aria-label={`Select ${job.vmName}`}
                      />
                    </TableCell>
                    <TableCell className="w-[90px]">
                      {(() => {
                        const t = jobTypeCode(job.jobType)
                        return (
                          <Badge variant="outline" className={`${t.className} justify-center px-2 font-semibold`} title={t.label}>
                            {t.label}
                          </Badge>
                        )
                      })()}
                    </TableCell>
                    <TableCell className="font-medium max-w-0 min-w-0">
                      <VmNameCell vmName={job.vmName} showFull={showFullVmNames} />
                    </TableCell>
                    <TableCell className="w-[90px] text-center">
                      {(() => {
                        const m = methodCode(job.scheduleType || job.method || job.trigger)
                        return (
                          <span className="text-xs text-gray-600" title={m.label}>{m.label}</span>
                        )
                      })()}
                    </TableCell>
                    {/* One icon per row, scoped to the job. A backup gets its
                        backup outcome, an rsync gets its transfer outcome —
                        each row carries its own verdict, not both. */}
                    <TableCell className="w-[80px] pl-3 pr-0">
                      {job.jobType === 'rsync' ? (
                        // The replication record itself, not the unified row.
                        // toUnifiedJob() normalises a transfer into the shape
                        // this table's columns expect and keeps everything
                        // replication-specific under `.offsite` — so the
                        // unified row has no offsiteResults, no offsiteProgress
                        // and no exitCode. Handed that, the icon fell into its
                        // "terminal status with no per-target breakdown" branch:
                        // the tooltip read only "Offsite sync: completed", and a
                        // PARTIAL sync was painted green because the per-target
                        // results that would have made it amber were not there.
                        <OffsiteJobStatusIcon job={job.offsite ?? job} />
                      ) : (
                        <JobStatusIcons
                          job={job}
                          coveringJob={job.coveredBy ? jobsById.get(job.coveredBy) : undefined}
                        />
                      )}
                    </TableCell>
                    <TableCell className="pl-3">
                      {job.jobType === 'rsync' ? (
                        job.status === 'running' || job.status === 'queued' ? (
                          <JobProgressBar
                            progress={job.progress || 0}
                            phase="rsync"
                            progressText={job.progressText}
                            jobType="replication"
                            status={job.status}
                          />
                        ) : job.status === 'completed' || job.status === 'failed' ? (
                          // Match the finished-row shape used for backup/restore:
                          // a completed rsync fills the bar, a failed one keeps
                          // however far it actually got. The dashed "-" that
                          // used to appear here made finished rsyncs look
                          // different from the rest of the table.
                          <JobProgressBar
                            progress={job.status === 'completed' ? 100 : (job.progress || 0)}
                            phase="rsync"
                            jobType="replication"
                            status={job.status}
                          />
                        ) : (
                          <span className="text-xs text-gray-400">-</span>
                        )
                      ) : job.status === 'running' || job.status === 'queued' || job.status === 'retrying' ? (
                        <JobProgressBar
                          progress={job.progress || 0}
                          phase={job.phase}
                          progressText={job.progressText}
                          jobType={job.jobType === 'restore' ? 'restore' : 'backup'}
                          status={job.status}
                        />
                      ) : job.status === 'completed' || job.status === 'failed' ? (
                        <JobProgressBar
                          progress={job.status === 'completed' ? 100 : (job.progress || 0)}
                          phase={job.phase}
                          jobType={job.jobType === 'restore' ? 'restore' : 'backup'}
                          status={job.status}
                        />
                      ) : (
                        <span className="text-xs text-gray-400">-</span>
                      )}
                    </TableCell>
                    <TableCell
                      className="text-sm whitespace-nowrap"
                      title={formatDate(job.startTime || job.createdAt)}
                    >
                      <div>{formatDateCompact(job.startTime || job.createdAt)}</div>
                      <div className="text-xs text-gray-500">
                        {job.startTime
                          ? formatDuration(job.startTime, job.endTime ?? undefined)
                          : '-'}
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openLogs(job)}
                          title="View logs"
                          className="h-8 w-8 p-0"
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleForceRemove(job.id, job.vmName)}
                          disabled={forceRemoveJob.isPending}
                          className="h-8 w-8 p-0 text-red-600 hover:text-red-700 hover:bg-red-50"
                          title="Force remove this job from history"
                        >
                          {forceRemoveJob.isPending ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="h-4 w-4" />
                          )}
                        </Button>
                        <div
                          className={isRetryable(job) ? '' : 'invisible pointer-events-none'}
                          aria-hidden={!isRetryable(job)}
                        >
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRetry(job.id, job.vmName, job.jobType)}
                            disabled={retryBackup.isPending || retryOffsite.isPending}
                            className="h-8 w-8 p-0 text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                            title="Retry this job"
                          >
                            {retryBackup.isPending || retryOffsite.isPending ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <RefreshCw className="h-4 w-4" />
                            )}
                          </Button>
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {/* Pagination Controls */}
            {totalItems > 0 && (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
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
            </>
          ) : searchQuery ? (
            <div className="text-center py-12">
              <div className="mx-auto w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mb-4">
                <Search className="h-8 w-8 text-gray-400" />
              </div>
              <p className="text-gray-600 font-medium">No jobs found</p>
              <p className="text-sm text-gray-500 mt-2">
                No jobs in history match "{searchQuery}"
              </p>
            </div>
          ) : (
            <div className="text-center py-8">
              <p className="text-gray-500">No job history found</p>
            </div>
          )}
        </CardContent>
      </Card>

      {selectedJobId && (
        <LiveLogViewer
          jobId={selectedJobId}
          jobType={selectedJobType}
          onClose={() => setSelectedJobId(null)}
        />
      )}
      {selectedLogId?.type === 'rsync' && (
        <OffsiteLogViewer
          jobId={selectedLogId.id}
          onClose={() => setSelectedLogId(null)}
        />
      )}
    </>
  )
}
