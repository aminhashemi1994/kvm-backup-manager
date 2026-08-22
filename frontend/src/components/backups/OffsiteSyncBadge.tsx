import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { ArrowRightLeft } from 'lucide-react'
import type { BackupJob } from '@/types'

/**
 * Small badge showing the offsite replication outcome for a job. Rendered in
 * Active jobs and History so the user can see the sync worked (or didn't)
 * even when the backup itself failed — the agent runs the offsite sync on
 * failed backups too, replicating the VM's existing chain.
 *
 * When a resync is queued the badge also says WHEN it will run. "Queued" with
 * no time reads as indefinite, which is the thing operators actually want to
 * know: whether to wait or to intervene.
 */

/** "in 4m", "in 1h 20m", or "now" once the moment has passed. */
function formatCountdown(target: Date, now: number): string {
  const ms = target.getTime() - now
  if (ms <= 0) return 'now'
  const totalMinutes = Math.round(ms / 60000)
  if (totalMinutes < 1) return 'in <1m'
  if (totalMinutes < 60) return `in ${totalMinutes}m`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes === 0 ? `in ${hours}h` : `in ${hours}h ${minutes}m`
}

function formatClock(target: Date): string {
  return target.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export default function OffsiteSyncBadge({ job }: { job: BackupJob }) {
  const queuedAt = job.offsiteSyncStatus === 'retrying' && job.offsiteRetryAt
    ? new Date(job.offsiteRetryAt)
    : null
  const hasValidQueueTime = !!queuedAt && !isNaN(queuedAt.getTime())

  // Re-render once a minute so the countdown stays honest without the caller
  // having to refetch. Only ticks while something is actually queued.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!hasValidQueueTime) return
    const id = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(id)
  }, [hasValidQueueTime])

  if (!job.offsiteSyncStatus) return null

  const styles: Record<string, string> = {
    running: 'bg-purple-100 text-purple-800 border-purple-200 animate-pulse',
    retrying: 'bg-purple-100 text-purple-800 border-purple-200 animate-pulse',
    completed: 'bg-emerald-100 text-emerald-800 border-emerald-200',
    partial: 'bg-amber-100 text-amber-800 border-amber-200',
    failed: 'bg-red-100 text-red-800 border-red-200',
    unknown: 'bg-gray-100 text-gray-600 border-gray-200',
  }
  const labels: Record<string, string> = {
    running: 'Syncing offsite',
    retrying: 'Offsite resync queued',
    completed: 'Offsite synced',
    partial: 'Offsite partial',
    failed: 'Offsite sync failed',
    unknown: 'Offsite: unknown',
  }

  const attemptLabel = job.offsiteRetryNextAttempt && job.offsiteRetryMaxAttempts
    ? `attempt ${job.offsiteRetryNextAttempt} of ${job.offsiteRetryMaxAttempts}`
    : job.offsiteRetryNextAttempt
      ? `attempt ${job.offsiteRetryNextAttempt}`
      : null

  let label = labels[job.offsiteSyncStatus] || job.offsiteSyncStatus
  if (hasValidQueueTime && queuedAt) {
    label = `Offsite resync ${formatCountdown(queuedAt, now)} · ${formatClock(queuedAt)}`
  }

  const detail = (job.offsiteResults || [])
    .map(r => `${r.ip}: ${r.status}${r.reason ? ` (${r.reason})` : ''}`)
    .join('\n')

  const tooltip = [
    hasValidQueueTime && queuedAt
      ? `Offsite-only resync scheduled for ${queuedAt.toLocaleString()}${attemptLabel ? ` (${attemptLabel})` : ''}. The VM backup is not re-run.`
      : null,
    detail || null,
  ].filter(Boolean).join('\n\n') || labels[job.offsiteSyncStatus]

  return (
    <Badge
      variant="outline"
      className={`text-xs whitespace-nowrap ${styles[job.offsiteSyncStatus] || styles.unknown}`}
      title={tooltip}
    >
      <ArrowRightLeft className="h-3 w-3 mr-1" />
      {label}
      {hasValidQueueTime && attemptLabel && (
        <span className="ml-1 opacity-70">({attemptLabel})</span>
      )}
    </Badge>
  )
}
