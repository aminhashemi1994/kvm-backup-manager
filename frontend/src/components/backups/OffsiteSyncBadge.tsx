import { Badge } from '@/components/ui/badge'
import { ArrowRightLeft } from 'lucide-react'
import type { BackupJob } from '@/types'

/**
 * Small badge showing the offsite replication outcome for a job. Rendered in
 * Active jobs and History so the user can see the sync worked (or didn't)
 * even when the backup itself failed — the agent runs the offsite sync on
 * failed backups too, replicating the VM's existing chain.
 */
export default function OffsiteSyncBadge({ job }: { job: BackupJob }) {
  if (!job.offsiteSyncStatus) return null

  const styles: Record<string, string> = {
    running: 'bg-purple-100 text-purple-800 border-purple-200 animate-pulse',
    completed: 'bg-emerald-100 text-emerald-800 border-emerald-200',
    partial: 'bg-amber-100 text-amber-800 border-amber-200',
    failed: 'bg-red-100 text-red-800 border-red-200',
    unknown: 'bg-gray-100 text-gray-600 border-gray-200',
  }
  const labels: Record<string, string> = {
    running: 'Syncing offsite',
    completed: 'Offsite synced',
    partial: 'Offsite partial',
    failed: 'Offsite sync failed',
    unknown: 'Offsite: unknown',
  }

  const detail = (job.offsiteResults || [])
    .map(r => `${r.ip}: ${r.status}${r.reason ? ` (${r.reason})` : ''}`)
    .join('\n')

  return (
    <Badge
      variant="outline"
      className={`text-xs whitespace-nowrap ${styles[job.offsiteSyncStatus] || styles.unknown}`}
      title={detail || labels[job.offsiteSyncStatus]}
    >
      <ArrowRightLeft className="h-3 w-3 mr-1" />
      {labels[job.offsiteSyncStatus] || job.offsiteSyncStatus}
    </Badge>
  )
}
