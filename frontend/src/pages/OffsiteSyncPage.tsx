import { useMemo } from 'react'
import { ArrowRightLeft, Loader2 } from 'lucide-react'
import ReplicationCheckPanel from '@/components/offsite/ReplicationCheckPanel'
import { Link } from 'react-router-dom'
import { useActiveOffsiteJobs, useOffsiteJobEvents } from '@/hooks/useOffsiteJobs'

/**
 * Offsite replication.
 *
 * Its own page rather than a tab under Backups, because replication now runs
 * independently of the backup that asked for it: separate lock, separate tmux
 * session, separate retry budget. A backup can be long finished while its
 * replication is still running, and the two lists should not be read as one.
 */
export default function OffsiteSyncPage() {
  // One socket subscription for the page; both panels read the same cache.
  useOffsiteJobEvents()

  const { data: active } = useActiveOffsiteJobs()

  const runningLabel = useMemo(() => {
    if (!active || active.length === 0) return null
    const running = active.filter(j => j.status === 'running').length
    const queued = active.filter(j => j.status === 'queued').length
    const parts = []
    if (running) parts.push(`${running} running`)
    if (queued) parts.push(`${queued} queued`)
    return parts.join(' · ')
  }, [active])

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white flex items-center gap-3">
            <ArrowRightLeft className="h-7 w-7" />
            Offsite Replication
          </h1>
          <p className="text-gray-600 dark:text-gray-400 mt-2 max-w-3xl">
            Whether every VM's offsite copy matches its backup directory, and the controls to check
            and correct it. The transfers themselves are jobs like any other — they appear in{' '}
            <Link to="/backups/active" className="text-primary hover:underline">Active Jobs</Link> while
            they run and in{' '}
            <Link to="/backups/history" className="text-primary hover:underline">History</Link> once
            they finish.
          </p>
        </div>
        {runningLabel && (
          <div className="flex items-center gap-2 text-sm text-purple-700 dark:text-purple-300 bg-purple-100 dark:bg-purple-950/50 border border-purple-200 dark:border-purple-800 rounded-xl px-3 py-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            {runningLabel}
          </div>
        )}
      </div>

      <ReplicationCheckPanel />
    </div>
  )
}
