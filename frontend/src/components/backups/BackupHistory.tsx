import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Select } from '@/components/ui/select'
import { Eye, Loader2, Trash2, AlertTriangle, RefreshCw, Search, ChevronLeft, ChevronRight } from 'lucide-react'
import { useBackupHistory, useForceRemoveJob, useRetryBackup } from '@/hooks/useBackups'
import { formatDate, formatDuration, getStatusColor } from '@/lib/utils'
import LiveLogViewer from './LiveLogViewer'
import JobProgressBar from './JobProgressBar'
import VmNameCell from '@/components/common/VmNameCell'
import VmNameToggle from '@/components/common/VmNameToggle'
import socketService from '@/services/socket'
import { useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { useConfirm } from '@/components/ui/confirm-dialog'

export default function BackupHistory() {
  const [searchParams, setSearchParams] = useSearchParams()
  const initialStatus = searchParams.get('status') || ''
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)
  const [selectedJobType, setSelectedJobType] = useState<'backup' | 'restore'>('backup')
  const [statusFilter, setStatusFilter] = useState<string>(initialStatus)
  const [searchQuery, setSearchQuery] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const [showFullVmNames, setShowFullVmNames] = useState<boolean>(() => {
    return localStorage.getItem('vm-name-display') === 'full'
  })
  useEffect(() => {
    localStorage.setItem('vm-name-display', showFullVmNames ? 'full' : 'short')
  }, [showFullVmNames])
  const queryClient = useQueryClient()
  
  const { data: allHistory, isLoading } = useBackupHistory({ 
    status: statusFilter || undefined,
    limit: 1000 // Fetch up to 1000 records for search across all
  })
  
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
      job.error?.toLowerCase().includes(query)
    )
  })

  // Calculate pagination
  const totalItems = filteredHistory?.length || 0
  const totalPages = Math.ceil(totalItems / pageSize)
  const startIndex = (currentPage - 1) * pageSize
  const endIndex = startIndex + pageSize
  const history = filteredHistory?.slice(startIndex, endIndex)

  // Reset to page 1 when search query or filter changes
  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, statusFilter])
  
  const forceRemoveJob = useForceRemoveJob()
  const retryBackup = useRetryBackup()
  const confirm = useConfirm()

  // Update URL when filter changes
  useEffect(() => {
    if (statusFilter) {
      setSearchParams({ status: statusFilter })
    } else {
      setSearchParams({})
    }
  }, [statusFilter, setSearchParams])

  // Poll for updates every second for running jobs
  useEffect(() => {
    const interval = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: ['backups', 'history'] })
    }, 1000)

    return () => clearInterval(interval)
  }, [queryClient])

  // Listen for real-time backup updates
  useEffect(() => {
    const cleanupProgress = socketService.on('backup-progress', (data: any) => {
      // Update the specific job in cache
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
      // Refetch to get the new job
      queryClient.invalidateQueries({ queryKey: ['backups', 'history'] })
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
      description: `Force remove the backup job for "${vmName}".`,
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

  const handleRetry = async (jobId: string, vmName: string) => {
    const ok = await confirm({
      title: 'Retry backup?',
      description: `Create a new backup job for "${vmName}" using the same configuration.`,
      confirmText: 'Retry',
    })
    if (ok) await retryBackup.mutateAsync(jobId)
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Job History</CardTitle>
            <div className="flex items-center gap-2">
              <VmNameToggle showFull={showFullVmNames} onToggle={setShowFullVmNames} />
              <div className="relative w-64">
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
                <option value="retrying">Retrying</option>
                <option value="skipped">Skipped</option>
                <option value="running">Running</option>
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
              <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>VM Name</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Progress</TableHead>
                  <TableHead>Start Time</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Exit Code</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell>
                      <Badge variant="outline" className={job.jobType === 'restore' ? 'bg-purple-50 text-purple-700 border-purple-200' : 'bg-blue-50 text-blue-700 border-blue-200'}>
                        {job.jobType === 'restore' ? 'RESTORE' : 'BACKUP'}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-medium">
                      <VmNameCell vmName={job.vmName} showFull={showFullVmNames} />
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{(job.scheduleType || job.method || 'backup').toUpperCase()}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge className={getStatusColor(job.status === 'queued' && (job.progress || 0) > 0 ? 'running' : job.status)}>
                        {job.status === 'queued' && (job.progress || 0) > 0 ? 'running' : job.status}
                      </Badge>
                      {job.status === 'skipped' && job.skippedReason && (
                        <div className="text-xs text-gray-500 mt-1">
                          {job.skippedReason === 'agent_offline' ? 'Agent offline' : job.skippedReason}
                        </div>
                      )}
                      {job.retryOf && (
                        <div className="text-xs text-blue-600 mt-1">
                          Retry of {job.retryOf.substring(0, 8)}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      {job.status === 'running' || job.status === 'queued' ? (
                        <JobProgressBar
                          progress={job.progress || 0}
                          phase={job.phase}
                          progressText={job.progressText}
                          jobType={job.jobType || 'backup'}
                          status={job.status}
                        />
                      ) : job.status === 'completed' ? (
                        <div className="flex items-center space-x-2">
                          <div className="flex-1 bg-green-200 rounded-full h-2">
                            <div className="bg-green-600 h-full w-full" />
                          </div>
                          <span className="text-xs font-medium text-green-600">100%</span>
                        </div>
                      ) : (
                        <span className="text-xs text-gray-400">-</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {formatDate(job.startTime)}
                    </TableCell>
                    <TableCell>
                      {formatDuration(job.startTime, job.endTime)}
                    </TableCell>
                    <TableCell>
                      {job.exitCode !== null && job.exitCode !== undefined ? (
                        <span className={job.exitCode === 0 ? 'text-green-600' : 'text-red-600'}>
                          {job.exitCode}
                        </span>
                      ) : (
                        '-'
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center space-x-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setSelectedJobId(job.id)
                            setSelectedJobType(job.jobType === 'restore' ? 'restore' : 'backup')
                          }}
                        >
                          <Eye className="h-4 w-4 mr-2" />
                          View Logs
                        </Button>
                        {(job.status === 'skipped' || job.status === 'failed') && job.canRetry && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRetry(job.id, job.vmName)}
                            disabled={retryBackup.isPending}
                            className="text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                            title="Retry this backup"
                          >
                            {retryBackup.isPending ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <>
                                <RefreshCw className="h-4 w-4 mr-2" />
                                Retry
                              </>
                            )}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleForceRemove(job.id, job.vmName)}
                          disabled={forceRemoveJob.isPending}
                          className="text-red-600 hover:text-red-700 hover:bg-red-50"
                          title="Force remove this job from history"
                        >
                          {forceRemoveJob.isPending ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <>
                              <Trash2 className="h-4 w-4 mr-2" />
                              Force Remove
                            </>
                          )}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            {/* Pagination Controls */}
            {totalItems > 0 && (
              <div className="mt-4 flex items-center justify-between border-t pt-4">
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
                      {/* First page */}
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

                      {/* Pages around current page */}
                      {Array.from({ length: totalPages }, (_, i) => i + 1)
                        .filter(page => {
                          // Show pages within 2 of current page
                          return page >= currentPage - 2 && page <= currentPage + 2
                        })
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

                      {/* Last page */}
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
    </>
  )
}
