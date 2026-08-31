import { useEffect, useMemo, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { X, Download, XCircle, Loader2 } from 'lucide-react'
import { useOffsiteJob, useOffsiteJobLog, useCancelOffsiteJob } from '@/hooks/useOffsiteJobs'
import { formatDate, formatDuration, getStatusColor } from '@/lib/utils'
import { useConfirm } from '@/components/ui/confirm-dialog'
import AnsiToHtml from 'ansi-to-html'

const ACTIVE = ['queued', 'running']

/** What asked for the sync, in the same words the job tables use. */
const TRIGGER_LABEL: Record<string, string> = {
  backup: 'AFTER BACKUP',
  manual: 'MANUAL',
  check: 'CHECK',
  retry: 'RETRY',
}

/**
 * The log of one replication job.
 *
 * The agent writes rsync's output to a file rather than streaming it over the
 * socket — a multi-hour transfer emits far too much to push through the event
 * stream — so this polls while the job is live and stops once it is finished.
 *
 * Deliberately built to the same shape as LiveLogViewer (the backup/restore
 * log): same dialog width, same header row of title + status badges with the
 * actions opposite, same auto-scroll strip, same terminal pane. A replication
 * log is a job log like any other, and an operator moving between the two from
 * the same History table should not have to re-learn the window.
 */
export default function OffsiteLogViewer({
  jobId,
  onClose,
}: {
  jobId: string
  onClose: () => void
}) {
  const { data: job } = useOffsiteJob(jobId)
  const isActive = !!job && ACTIVE.includes(job.status)
  const { data: log, isLoading } = useOffsiteJobLog(jobId, isActive)
  const cancelJob = useCancelOffsiteJob()
  const confirm = useConfirm()

  const scrollRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)

  // Same converter settings as the backup viewer so identical rsync/qemu
  // output is coloured identically in both windows.
  const ansi = useMemo(
    () => new AnsiToHtml({
      fg: '#22c55e',
      bg: 'transparent',
      newline: true,
      escapeXML: true,
      stream: false,
      colors: {
        0: '#030712',
        1: '#ef4444',
        2: '#22c55e',
        3: '#eab308',
        4: '#3b82f6',
        5: '#a855f7',
        6: '#06b6d4',
        7: '#f3f4f6',
      },
    }),
    []
  )

  // rsync redraws its progress line with \r. Collapse it the same way the
  // backup viewer does — keep only what a terminal would show on each line and
  // drop consecutive duplicates — otherwise a long transfer renders as tens of
  // thousands of near-identical rows.
  const cleanedLog = useMemo(() => {
    if (!log) return ''
    const lines = log.split('\n').map(l => {
      const clean = l
        .replace(/\x1b\[\?[0-9;]*[a-zA-Z]/g, '')
        .replace(/\x1b\[[0-9;]*[A-LST]/g, '')
      const trimmed = clean.replace(/\r+$/, '')
      const i = trimmed.lastIndexOf('\r')
      return i === -1 ? trimmed : trimmed.slice(i + 1)
    })
    const out: string[] = []
    let blankRun = 0
    for (const l of lines) {
      if (l.trim() === '') {
        blankRun++
        if (blankRun > 1) continue
        out.push(l)
        continue
      }
      blankRun = 0
      if (out.length > 0 && out[out.length - 1] === l) continue
      out.push(l)
    }
    return out.join('\n')
  }, [log])

  const html = useMemo(() => {
    if (!cleanedLog) return ''
    try {
      return ansi.toHtml(cleanedLog)
    } catch {
      return cleanedLog
    }
  }, [cleanedLog, ansi])

  useEffect(() => {
    if (!autoScroll || !scrollRef.current) return
    const el = scrollRef.current.querySelector('[data-radix-scroll-area-viewport]') || scrollRef.current
    el.scrollTop = el.scrollHeight
  }, [html, autoScroll])

  const handleDownload = () => {
    const plain = cleanedLog.replace(/\x1b\[[0-9;]*m/g, '')
    if (!plain.trim()) {
      alert('No logs available to download yet. Please wait for the sync to generate output.')
      return
    }
    const blob = new Blob([plain], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `replication-${job?.vmName || jobId}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleCancel = async () => {
    const ok = await confirm({
      title: `Stop the offsite sync for ${job?.vmName}?`,
      description:
        'The transfer stops where it is. Files already copied stay at the destination and the '
        + 'partially transferred one is kept, so a later sync resumes from it rather than starting over. '
        + 'Nothing at the offsite host is deleted.',
      confirmText: 'Stop sync',
      cancelText: 'Keep running',
      variant: 'danger',
    })
    if (!ok) return
    await cancelJob.mutateAsync({ id: jobId, vmName: job?.vmName })
  }

  const destinations = (job?.offsiteTargets || [])
    .map(t => t.offsiteHostName || t.ip)
    .filter(Boolean)

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-5xl w-[90vw]">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle>Replication Logs - {job?.vmName || '…'}</DialogTitle>
              <div className="flex items-center space-x-2 mt-2 flex-wrap gap-y-1">
                <Badge className={getStatusColor(job?.status || 'unknown')}>
                  {job?.status || 'loading'}
                </Badge>
                {job?.trigger && (
                  <Badge variant="outline">
                    {TRIGGER_LABEL[job.trigger] || job.trigger.toUpperCase()}
                  </Badge>
                )}
                {destinations.length > 0 && (
                  <Badge variant="outline" title={destinations.join('\n')}>
                    → {destinations.join(', ')}
                  </Badge>
                )}
              </div>
            </div>
            <div className="flex items-center space-x-2">
              {isActive && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleCancel}
                  disabled={cancelJob.isPending}
                >
                  {cancelJob.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Stopping...
                    </>
                  ) : (
                    <>
                      <XCircle className="h-4 w-4 mr-2" />
                      Stop Sync
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

        {/* Replication-specific context the backup viewer has no equivalent
            for: which host it came from, where it went, and how long it took.
            Kept to one compact strip so the window still reads as the same
            window. */}
        {job && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs border-b border-gray-200 dark:border-gray-700 pb-3 mb-4">
            <div>
              <div className="text-gray-500">Backup host</div>
              <div className="font-medium truncate" title={job.backupHostName}>{job.backupHostName}</div>
            </div>
            <div>
              <div className="text-gray-500">Hypervisor</div>
              <div className="font-medium truncate" title={job.hypervisorName || undefined}>
                {job.hypervisorName || '-'}
              </div>
            </div>
            <div>
              <div className="text-gray-500">Destination(s)</div>
              <div className="font-medium truncate" title={destinations.join('\n')}>
                {destinations.join(', ') || '-'}
              </div>
            </div>
            <div>
              <div className="text-gray-500">Started</div>
              <div className="font-medium">{job.startTime ? formatDate(job.startTime) : 'Not yet'}</div>
            </div>
            <div>
              <div className="text-gray-500">Duration</div>
              <div className="font-medium tabular-nums">
                {job.startTime ? formatDuration(job.startTime, job.endTime || undefined) : '-'}
              </div>
            </div>
          </div>
        )}

        {job?.error && (
          <div className="text-xs rounded-lg border border-red-200 bg-red-50 text-red-800 p-3 dark:bg-red-950/40 dark:border-red-800/60 dark:text-red-200">
            {job.error}
          </div>
        )}

        <div className="flex items-center justify-between mb-4">
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
          {isActive && (
            <div className="flex items-center space-x-2 text-sm text-gray-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Live updates enabled</span>
            </div>
          )}
        </div>

        <ScrollArea ref={scrollRef} className="h-[500px] w-full rounded-md border bg-gray-950 p-4">
          {isLoading && !log ? (
            <div className="flex items-center gap-2 text-sm text-gray-400">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading log…
            </div>
          ) : (
            <div
              className="text-xs font-mono whitespace-pre-wrap text-green-400"
              dangerouslySetInnerHTML={{ __html: html || 'No logs available yet...' }}
              style={{
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                lineHeight: '1.5',
                color: '#22c55e',
              }}
            />
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
