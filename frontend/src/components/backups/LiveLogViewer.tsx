import { useEffect, useRef, useState, useMemo } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { X, Download, XCircle, Loader2 } from 'lucide-react'
import { useBackupJob, useBackupJobLogs, useKillBackupJob } from '@/hooks/useBackups'
import { useRestoreJob, useRestoreJobLogs, useKillRestoreJob } from '@/hooks/useRestores'
import { useJobSubscription } from '@/hooks/useSocket'
import { getStatusColor } from '@/lib/utils'
import AnsiToHtml from 'ansi-to-html'

interface LiveLogViewerProps {
  jobId: string
  jobType?: 'backup' | 'restore'
  onClose: () => void
}

export default function LiveLogViewer({ jobId, jobType = 'backup', onClose }: LiveLogViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const [progressBars, setProgressBars] = useState<string[]>([])
  
  // Use appropriate hooks based on job type - conditionally enable to avoid 404s
  const { data: backupJob } = useBackupJob(jobType === 'backup' ? jobId : '')
  const { data: restoreJob } = useRestoreJob(jobType === 'restore' ? jobId : '')
  const { data: backupLogs, refetch: refetchBackupLogs } = useBackupJobLogs(jobType === 'backup' ? jobId : '')
  const { data: restoreLogs, refetch: refetchRestoreLogs } = useRestoreJobLogs(jobType === 'restore' ? jobId : '')
  const { logs: liveLogs, status } = useJobSubscription(jobId)
  const killBackupMutation = useKillBackupJob()
  const killRestoreMutation = useKillRestoreJob()

  const job = jobType === 'backup' ? backupJob : restoreJob
  const staticLogs = jobType === 'backup' ? backupLogs : restoreLogs
  const refetchLogs = jobType === 'backup' ? refetchBackupLogs : refetchRestoreLogs
  const killMutation = jobType === 'backup' ? killBackupMutation : killRestoreMutation

  // Listen for progress bar updates
  useEffect(() => {
    const socket = (window as any).socket
    if (!socket) return

    const eventName = jobType === 'backup' ? 'backup-progress-bar' : 'restore-progress-bar'
    const handleProgressBar = (data: { jobId: string; progress: string }) => {
      if (data.jobId === jobId) {
        setProgressBars(prev => {
          // Keep only last 5 progress bars
          const updated = [...prev, data.progress]
          return updated.slice(-5)
        })
      }
    }

    socket.on(eventName, handleProgressBar)
    return () => {
      socket.off(eventName, handleProgressBar)
    }
  }, [jobId, jobType])

  // Create ANSI converter instance
  const ansiConverter = useMemo(() => new AnsiToHtml({
    fg: '#22c55e', // green-400
    bg: 'transparent', // Use transparent background
    newline: true,
    escapeXML: true,
    stream: false,
    colors: {
      0: '#030712',  // black -> gray-950
      1: '#ef4444',  // red -> red-500
      2: '#22c55e',  // green -> green-500
      3: '#eab308',  // yellow -> yellow-500
      4: '#3b82f6',  // blue -> blue-500
      5: '#a855f7',  // magenta -> purple-500
      6: '#06b6d4',  // cyan -> cyan-500
      7: '#f3f4f6',  // white -> gray-100
    }
  }), [])

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [liveLogs, staticLogs, autoScroll])

  // Refetch logs periodically for running jobs
  useEffect(() => {
    if (status === 'running' || job?.status === 'running') {
      const interval = setInterval(() => {
        refetchLogs()
      }, 2000)
      return () => clearInterval(interval)
    }
  }, [status, job?.status, refetchLogs])

  const allLogs = staticLogs || ''
  const liveLogLines = liveLogs.map(l => `[${l.timestamp}] ${l.message}`).join('\n')
  const combinedLogs = allLogs + (liveLogLines ? '\n' + liveLogLines : '')

  // Convert ANSI codes to HTML
  const htmlLogs = useMemo(() => {
    if (!combinedLogs) return 'No logs available yet...'
    return ansiConverter.toHtml(combinedLogs)
  }, [combinedLogs, ansiConverter])

  const handleDownload = () => {
    // Download plain text without ANSI codes
    const plainLogs = combinedLogs.replace(/\x1b\[[0-9;]*m/g, '')
    
    // Check if logs are empty
    if (!plainLogs || plainLogs.trim() === '' || plainLogs === 'No logs available yet...') {
      alert('No logs available to download yet. Please wait for the job to generate logs.')
      return
    }
    
    const blob = new Blob([plainLogs], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${jobType}-${jobId}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleKill = async () => {
    const action = jobType === 'backup' ? 'backup' : 'restore'
    if (confirm(`Are you sure you want to cancel this ${action} job? This will terminate the running process.`)) {
      await killMutation.mutateAsync(jobId)
    }
  }

  const isRunning = status === 'running' || job?.status === 'running' || job?.status === 'queued'

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-5xl w-[90vw]">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle>{jobType === 'backup' ? 'Backup' : 'Restore'} Logs - {job?.vmName}</DialogTitle>
              <div className="flex items-center space-x-2 mt-2">
                <Badge className={getStatusColor(job?.status || status || 'unknown')}>
                  {job?.status || status}
                </Badge>
                {(job?.scheduleType || job?.method) && (
                  <Badge variant="outline">{(job.scheduleType || job.method).toUpperCase()}</Badge>
                )}
              </div>
            </div>
            <div className="flex items-center space-x-2">
              {isRunning && (
                <Button 
                  variant="destructive" 
                  size="sm" 
                  onClick={handleKill}
                  disabled={killMutation.isPending}
                >
                  {killMutation.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Cancelling...
                    </>
                  ) : (
                    <>
                      <XCircle className="h-4 w-4 mr-2" />
                      Cancel Job
                    </>
                  )}
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={handleDownload}>
                <Download className="h-4 w-4 mr-2" />
                Download
              </Button>
              <Button variant="ghost" size="icon" onClick={onClose}>
                <X className="h-5 w-5" />
              </Button>
            </div>
          </div>
        </DialogHeader>

        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center space-x-2">
            <label className="flex items-center space-x-2 text-sm">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={(e) => setAutoScroll(e.target.checked)}
                className="rounded"
              />
              <span>Auto-scroll</span>
            </label>
          </div>
          {isRunning && (
            <div className="flex items-center space-x-2 text-sm text-gray-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Live updates enabled</span>
            </div>
          )}
        </div>

        {/* Progress Bars */}
        {progressBars.length > 0 && (
          <div className="mb-2 p-3 bg-gray-900 rounded-md border border-gray-700">
            <div className="space-y-1">
              {progressBars.map((progress, index) => (
                <div key={index} className="text-xs font-mono text-green-400 whitespace-pre">
                  {progress}
                </div>
              ))}
            </div>
          </div>
        )}

        <ScrollArea ref={scrollRef} className="h-[500px] w-full rounded-md border bg-gray-950 p-4">
          <div 
            className="text-xs font-mono whitespace-pre-wrap text-green-400"
            dangerouslySetInnerHTML={{ __html: htmlLogs }}
            style={{ 
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              lineHeight: '1.5',
              color: '#22c55e' // Ensure default text color
            }}
          />
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
