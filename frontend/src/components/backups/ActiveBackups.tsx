import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Eye, Loader2, XCircle, Download, Upload, Search } from 'lucide-react'
import { useActiveBackups, useKillBackupJob } from '@/hooks/useBackups'
import { useActiveRestores, useKillRestoreJob } from '@/hooks/useRestores'
import { formatDuration } from '@/lib/utils'
import LiveLogViewer from './LiveLogViewer'
import JobStatusBadge from './JobStatusBadge'
import JobProgressBar from './JobProgressBar'
import socketService from '@/services/socket'
import { useQueryClient } from '@tanstack/react-query'
import { useConfirm } from '@/components/ui/confirm-dialog'

export default function ActiveBackups() {
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [selectedJobType, setSelectedJobType] = useState<'backup' | 'restore'>('backup')
  const [searchQuery, setSearchQuery] = useState('')
  const queryClient = useQueryClient()
  const { data: activeBackups, isLoading: isLoadingBackups } = useActiveBackups()
  const { data: activeRestores, isLoading: isLoadingRestores } = useActiveRestores()
  const killBackupMutation = useKillBackupJob()
  const killRestoreMutation = useKillRestoreJob()
  const confirm = useConfirm()

  // Combine backups and restores into a single list
  const allActiveJobs = [
    ...(activeBackups || []).map(job => ({ ...job, jobType: 'backup' as const })),
    ...(activeRestores || []).map(job => ({ ...job, jobType: 'restore' as const }))
  ].sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime())

  // Filter jobs based on search query
  const activeJobs = allActiveJobs.filter(job => {
    if (!searchQuery) return true
    const query = searchQuery.toLowerCase()
    return (
      job.vmName?.toLowerCase().includes(query) ||
      job.backupHostName?.toLowerCase().includes(query) ||
      job.scheduleType?.toLowerCase().includes(query) ||
      job.method?.toLowerCase().includes(query) ||
      job.status?.toLowerCase().includes(query) ||
      job.jobType?.toLowerCase().includes(query)
    )
  })

  // Real-time countdown for retrying jobs
  const [, setTick] = useState(0)
  useEffect(() => {
    // Update countdown every second for retrying jobs
    const hasRetryingJobs = activeJobs.some(job => job.status === 'retrying')
    if (!hasRetryingJobs) return

    const interval = setInterval(() => {
      setTick(tick => tick + 1) // Force re-render to update countdown
    }, 1000)

    return () => clearInterval(interval)
  }, [activeJobs])

  // Calculate countdown text for retrying jobs
  const getProgressTextWithCountdown = (job: any) => {
    if (job.status === 'retrying' && job.retryAt) {
      const remainingMs = new Date(job.retryAt).getTime() - Date.now()
      const seconds = Math.max(0, Math.floor(remainingMs / 1000))
      const minutes = Math.floor(seconds / 60)
      const secs = seconds % 60
      return `Retrying in ${minutes}:${secs.toString().padStart(2, '0')}...`
    }
    return job.progressText
  }

  // Show the spinner only on the very first render, before any data has
  // arrived. After that — including during background refetches and after
  // socket-driven invalidations — render the table even if temporarily
  // empty. Otherwise React-Query's `isLoading` flag (which can briefly
  // flip on errors / refetches) would replace the table with a spinner
  // every few seconds and make the section feel like it's constantly
  // reloading.
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false)
  useEffect(() => {
    if (activeBackups !== undefined || activeRestores !== undefined) {
      setHasLoadedOnce(true)
    }
  }, [activeBackups, activeRestores])
  const isLoading = !hasLoadedOnce && (isLoadingBackups || isLoadingRestores)

  // Real-time updates come from socket events below. The hook's built-in
  // 5-second refetch acts as a safety net. The previous 1-second
  // setInterval was hammering /backups/active (which itself does a
  // multi-second agent-status sync) and causing the table to flash
  // constantly — making it impossible to read the rows.

  // Listen for real-time backup updates. We deliberately patch the cached
  // list with setQueryData rather than invalidating on each event — every
  // invalidation triggers a /backups/active fetch which itself does a
  // multi-second agent-status sync, and the resulting "progress jumps
  // backward then forward" pattern is what made the bar feel laggy.
  // The hook's 5-second refetchInterval reconciles authoritative state.
  useEffect(() => {
    const cleanupBackupProgress = socketService.on('backup-progress', (data: any) => {
      queryClient.setQueryData(['backups', 'active'], (old: any) => {
        if (!old) return old
        return old.map((job: any) =>
          job.id === data.jobId
            ? { ...job, status: data.status, progress: data.progress, progressText: data.progressText }
            : job
        )
      })
    })

    const cleanupBackupComplete = socketService.on('backup-complete', (data: any) => {
      // Remove the completed job from the active list optimistically. The
      // next refetch will confirm it's gone.
      queryClient.setQueryData(['backups', 'active'], (old: any) => {
        if (!old) return old
        return old.filter((job: any) => job.id !== data.id)
      })
    })

    const cleanupBackupError = socketService.on('backup-error', (data: any) => {
      queryClient.setQueryData(['backups', 'active'], (old: any) => {
        if (!old) return old
        return old.filter((job: any) => job.id !== (data.id || data.jobId))
      })
    })

    const cleanupBackupStarted = socketService.on('backup-started', (data: any) => {
      // A new job appeared — the optimistic insert keeps the UI snappy
      // even before the next refetch lands.
      queryClient.setQueryData(['backups', 'active'], (old: any) => {
        const list = old || []
        if (list.some((job: any) => job.id === data.id)) return list
        return [data, ...list]
      })
    })

    // Listen for real-time restore updates
    const cleanupRestoreProgress = socketService.on('restore-progress', (data: any) => {
      queryClient.setQueryData(['restores', 'active'], (old: any) => {
        if (!old) return old
        return old.map((job: any) =>
          job.id === data.jobId
            ? { ...job, status: data.status, progress: data.progress, progressText: data.progressText }
            : job
        )
      })
    })

    const cleanupRestoreComplete = socketService.on('restore-complete', (data: any) => {
      queryClient.setQueryData(['restores', 'active'], (old: any) => {
        if (!old) return old
        return old.filter((job: any) => job.id !== (data.id || data.jobId))
      })
    })

    const cleanupRestoreError = socketService.on('restore-error', (data: any) => {
      queryClient.setQueryData(['restores', 'active'], (old: any) => {
        if (!old) return old
        return old.filter((job: any) => job.id !== (data.id || data.jobId))
      })
    })

    const cleanupRestoreStarted = socketService.on('restore-started', (data: any) => {
      queryClient.setQueryData(['restores', 'active'], (old: any) => {
        const list = old || []
        if (list.some((job: any) => job.id === data.id)) return list
        return [data, ...list]
      })
    })

    return () => {
      cleanupBackupProgress()
      cleanupBackupComplete()
      cleanupBackupError()
      cleanupBackupStarted()
      cleanupRestoreProgress()
      cleanupRestoreComplete()
      cleanupRestoreError()
      cleanupRestoreStarted()
    }
  }, [queryClient])

  const handleKill = async (jobId: string, vmName: string, jobType: 'backup' | 'restore') => {
    const action = jobType === 'backup' ? 'backup' : 'restore'
    const ok = await confirm({
      title: `Cancel ${action}?`,
      description: `This will terminate the running ${action} for "${vmName}".`,
      confirmText: `Cancel ${action}`,
      cancelText: 'Keep running',
      variant: 'danger',
    })
    if (ok) {
      if (jobType === 'backup') {
        await killBackupMutation.mutateAsync(jobId)
      } else {
        await killRestoreMutation.mutateAsync(jobId)
      }
    }
  }

  const handleViewLogs = (jobId: string, jobType: 'backup' | 'restore') => {
    setSelectedJobId(jobId)
    setSelectedJobType(jobType)
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Active & Queued Jobs</CardTitle>
            <div className="flex items-center gap-2">
              <div className="relative w-64">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                <Input
                  type="text"
                  placeholder="Search jobs..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
            </div>
          ) : activeJobs && activeJobs.length > 0 ? (
            <>
              {searchQuery && (
                <div className="mb-4 text-sm text-gray-600">
                  Found {activeJobs.length} job{activeJobs.length !== 1 ? 's' : ''} matching "{searchQuery}"
                </div>
              )}
              <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>VM Name</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Progress</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activeJobs.map((job) => (
                  <TableRow key={`${job.jobType}-${job.id}`}>
                    <TableCell>
                      <div className="flex items-center space-x-2">
                        {job.jobType === 'backup' ? (
                          <Upload className="h-4 w-4 text-blue-600" />
                        ) : (
                          <Download className="h-4 w-4 text-green-600" />
                        )}
                        <span className="font-medium capitalize">{job.jobType}</span>
                      </div>
                    </TableCell>
                    <TableCell className="font-medium">
                      <div className="truncate max-w-[280px]" title={job.vmName}>
                        {job.vmName}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{(job.scheduleType || job.method || job.jobType).toUpperCase()}</Badge>
                    </TableCell>
                    <TableCell>{job.backupHostName || '-'}</TableCell>
                    <TableCell>
                      <JobStatusBadge
                        status={job.status === 'queued' && (job.progress || 0) > 0 ? 'running' : job.status}
                        phase={job.phase}
                        jobType={job.jobType}
                        failureReason={job.failureReason}
                        replay={job.replay}
                      />
                    </TableCell>
                    <TableCell>
                      <JobProgressBar
                        progress={job.progress || 0}
                        phase={job.phase}
                        progressText={getProgressTextWithCountdown(job)}
                        jobType={job.jobType}
                        status={job.status === 'queued' && (job.progress || 0) > 0 ? 'running' : job.status}
                      />
                    </TableCell>
                    <TableCell>
                      {formatDuration(job.startTime, job.endTime)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center space-x-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleViewLogs(job.id, job.jobType)}
                        >
                          <Eye className="h-4 w-4 mr-2" />
                          View Logs
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleKill(job.id, job.vmName, job.jobType)}
                          disabled={killBackupMutation.isPending || killRestoreMutation.isPending}
                          className="text-red-600 hover:text-red-700 hover:bg-red-50"
                        >
                          <XCircle className="h-4 w-4 mr-2" />
                          Cancel
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </>
          ) : searchQuery ? (
            <div className="text-center py-12">
              <div className="mx-auto w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mb-4">
                <Search className="h-8 w-8 text-gray-400" />
              </div>
              <p className="text-gray-600 font-medium">No jobs found</p>
              <p className="text-sm text-gray-500 mt-2">
                No active jobs match "{searchQuery}"
              </p>
            </div>
          ) : (
            <div className="text-center py-12">
              <div className="mx-auto w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mb-4">
                <div className="flex items-center space-x-1">
                  <Upload className="h-6 w-6 text-gray-400" />
                  <Download className="h-6 w-6 text-gray-400" />
                </div>
              </div>
              <p className="text-gray-600 font-medium">No active jobs</p>
              <p className="text-sm text-gray-500 mt-2">
                Backup and restore jobs will appear here when they are running
              </p>
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
    </>
  )
}
