import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Eye, Loader2, XCircle, Download, Upload } from 'lucide-react'
import { useActiveBackups, useKillBackupJob } from '@/hooks/useBackups'
import { useActiveRestores, useKillRestoreJob } from '@/hooks/useRestores'
import { formatDuration } from '@/lib/utils'
import LiveLogViewer from './LiveLogViewer'
import JobStatusBadge from './JobStatusBadge'
import JobProgressBar from './JobProgressBar'
import socketService from '@/services/socket'
import { useQueryClient } from '@tanstack/react-query'

export default function ActiveBackups() {
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [selectedJobType, setSelectedJobType] = useState<'backup' | 'restore'>('backup')
  const queryClient = useQueryClient()
  const { data: activeBackups, isLoading: isLoadingBackups } = useActiveBackups()
  const { data: activeRestores, isLoading: isLoadingRestores } = useActiveRestores()
  const killBackupMutation = useKillBackupJob()
  const killRestoreMutation = useKillRestoreJob()

  // Combine backups and restores into a single list
  const activeJobs = [
    ...(activeBackups || []).map(job => ({ ...job, jobType: 'backup' as const })),
    ...(activeRestores || []).map(job => ({ ...job, jobType: 'restore' as const }))
  ].sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime())

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
    if (confirm(`Are you sure you want to cancel the ${action} for ${vmName}?`)) {
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
          <CardTitle>Active & Queued Jobs</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
            </div>
          ) : activeJobs && activeJobs.length > 0 ? (
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
                    <TableCell className="font-medium">{job.vmName}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{(job.scheduleType || job.method || job.jobType).toUpperCase()}</Badge>
                    </TableCell>
                    <TableCell>{job.agentName}</TableCell>
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
                        progressText={job.progressText}
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
