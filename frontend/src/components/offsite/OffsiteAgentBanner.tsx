import { useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useSocketEvent } from '@/hooks/useSocket'

/**
 * Platform-wide banner for a backup host whose agent is too old to run an
 * independent rsync.
 *
 * This is a mixed-version rollout hazard with no other symptom: backups keep
 * succeeding, the panel looks entirely healthy, and replication simply never
 * happens for that host. The controller emits `offsite-agent-unsupported` the
 * first time it tries and is refused (rate-limited to once an hour per host),
 * and this is the visible half of that.
 *
 * Dismissal is per host and lasts for the session only — the underlying
 * problem is still there on the next page load, and it should say so.
 */

interface UnsupportedHost {
  backupHostId: string
  backupHostName: string
  message?: string
}

export default function OffsiteAgentBanner() {
  const [hosts, setHosts] = useState<UnsupportedHost[]>([])
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const navigate = useNavigate()

  useSocketEvent('offsite-agent-unsupported', (data: UnsupportedHost) => {
    if (!data?.backupHostId) return
    setHosts(prev =>
      prev.some(h => h.backupHostId === data.backupHostId) ? prev : [...prev, data]
    )
  })

  const visible = hosts.filter(h => !dismissed.has(h.backupHostId))
  if (visible.length === 0) return null

  return (
    <div className="border-b border-orange-300 bg-orange-50 dark:bg-orange-950/40 dark:border-orange-800/60">
      {visible.map(host => (
        <div
          key={host.backupHostId}
          className="flex items-start gap-3 px-4 sm:px-6 py-2.5 text-sm text-orange-900 dark:text-orange-200"
        >
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-orange-600 dark:text-orange-400" />
          <div className="flex-1 min-w-0">
            <span className="font-semibold">
              Offsite replication is not running on {host.backupHostName}.
            </span>{' '}
            <span className="opacity-90">
              Its agent predates independent replication and refuses the job. Backups on this host
              still succeed, so nothing else will look wrong — but nothing is reaching the offsite
              hosts. Update the agent to resume replication.
            </span>
            {host.message && (
              <div className="text-xs opacity-75 mt-0.5 truncate" title={host.message}>
                {host.message}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => navigate('/backup-hosts')}
            className="text-xs font-medium underline underline-offset-2 whitespace-nowrap shrink-0"
          >
            Backup hosts
          </button>
          <button
            type="button"
            onClick={() => setDismissed(prev => new Set(prev).add(host.backupHostId))}
            className="shrink-0 opacity-60 hover:opacity-100"
            aria-label={`Dismiss the warning for ${host.backupHostName}`}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  )
}
