import {
  CheckCircle, AlertTriangle, XCircle, HelpCircle, Loader2, Clock,
  Lock, Ban, ShieldAlert,
} from 'lucide-react'
import type { OffsiteJob } from '@/types'

interface OffsiteJobStatusIconProps {
  job: OffsiteJob
  className?: string
}

type IconKind =
  | 'success'
  | 'warning'
  | 'fail'
  | 'unknown'
  | 'running'
  | 'queued'
  | 'cancelled'
  | 'busy'
  | 'unsupported'

/**
 * One icon per offsite replication job.
 *
 * Mirrors the four-outcome icons used by the backup history and the
 * replication check panel so an operator reading any of the three sees the
 * same colour coding:
 *   - success (green)  — every offsite target reports success
 *   - warning (amber)  — partial: at least one target synced, at least one
 *                        did not (per-host breakdown on hover)
 *   - fail    (red)    — every target failed, OR the sync as a whole failed
 *                        without per-target results to explain it
 *   - unknown (gray)   — busy / cancelled / unsupported: nothing actually
 *                        happened, so a verdict would be misleading
 *
 * Active jobs get transient icons (running/queued) and the per-target live
 * progress lives next to them in the OffsiteProgressCard component.
 *
 * The full per-target detail (which host succeeded, which failed and why,
 * which is still syncing) lives on hover so the status cell never gets
 * crowded.
 */
export default function OffsiteJobStatusIcon({ job, className = '' }: OffsiteJobStatusIconProps) {
  const kind = classify(job)
  const { Icon, color, label, animate } = ICONS[kind]
  const tooltip = buildTooltip(job, kind)

  return (
    <div
      className={`inline-flex items-center justify-center h-7 w-7 rounded-full ${color} ${
        animate ? 'animate-pulse' : ''
      } ${className}`}
      title={tooltip}
      aria-label={label}
    >
      <Icon className="h-4 w-4" />
    </div>
  )
}

const ICONS: Record<IconKind, { Icon: any; color: string; label: string; animate?: boolean }> = {
  success: { Icon: CheckCircle, color: 'bg-green-100 text-green-700', label: 'Synced on all targets' },
  warning: { Icon: AlertTriangle, color: 'bg-amber-100 text-amber-700', label: 'Partial sync' },
  fail: { Icon: XCircle, color: 'bg-red-100 text-red-700', label: 'Out of sync' },
  unknown: { Icon: HelpCircle, color: 'bg-gray-100 text-gray-600', label: 'Outcome unknown' },
  running: { Icon: Loader2, color: 'bg-blue-100 text-blue-700', label: 'Syncing', animate: true },
  queued: { Icon: Clock, color: 'bg-gray-100 text-gray-700', label: 'Queued' },
  busy: { Icon: Lock, color: 'bg-amber-100 text-amber-700', label: 'Locked by another sync' },
  cancelled: { Icon: Ban, color: 'bg-gray-100 text-gray-600', label: 'Cancelled' },
  unsupported: { Icon: ShieldAlert, color: 'bg-orange-100 text-orange-700', label: 'Agent too old' },
}

function classify(job: OffsiteJob): IconKind {
  switch (job.status) {
    case 'queued': return 'queued'
    case 'running': return 'running'
    case 'busy': return 'busy'
    case 'cancelled': return 'cancelled'
    case 'unsupported': return 'unsupported'
    case 'completed':
    case 'failed': {
      const results = Array.isArray(job.offsiteResults) ? job.offsiteResults : []
      if (results.length === 0) {
        // A terminal status with no per-target breakdown — the agent never
        // produced one (refused at the source guard, agent crashed, etc.).
        // For 'completed' trust the agent's overall verdict; for 'failed'
        // we genuinely don't know which target is to blame, so paint it as
        // a fail rather than guess.
        return job.status === 'completed' ? 'success' : 'fail'
      }
      const ok = results.filter(r => r && (r.status === 'success' || r.status === 'synced')).length
      if (ok === results.length) return 'success'
      if (ok === 0) return 'fail'
      return 'warning'
    }
    default:
      return 'unknown'
  }
}

function buildTooltip(job: OffsiteJob, kind: IconKind): string {
  const lines: string[] = []

  switch (kind) {
    case 'queued':
      lines.push('Offsite sync: queued')
      lines.push('Waiting for a replication slot on its backup host.')
      break
    case 'running':
      lines.push('Offsite sync: running')
      if (typeof job.progress === 'number') lines.push(`Overall: ${job.progress}%`)
      if (job.progressText) lines.push(`Activity: ${job.progressText}`)
      break
    case 'busy':
      lines.push('Offsite sync: locked by another sync')
      lines.push('Another rsync for this VM already held the lock, so this job did nothing at all.')
      lines.push('Nothing was transferred and nothing was removed at the destination.')
      break
    case 'cancelled':
      lines.push('Offsite sync: cancelled')
      lines.push('Stopped by an operator. Data already transferred was kept — the next sync resumes from it.')
      break
    case 'unsupported':
      lines.push('Offsite sync: agent too old')
      lines.push('The agent on this backup host cannot run an independent rsync.')
      lines.push('Update the agent — replication is not running for this host.')
      break
    case 'success':
    case 'warning':
    case 'fail': {
      lines.push(`Offsite sync: ${job.status}`)
      const results = Array.isArray(job.offsiteResults) ? job.offsiteResults : []
      if (results.length > 0) {
        lines.push('')
        lines.push('Per offsite host:')
        for (const r of results) {
          const ip = r.ip || '?'
          const state = r.status || 'unknown'
          lines.push(`  ${ip}: ${state}${r.reason ? ` — ${r.reason}` : ''}`)
        }
      }
      break
    }
    default:
      lines.push(`Offsite sync: ${job.status || 'unknown'}`)
  }

  if (job.error && (job.status === 'failed' || job.status === 'unsupported')) {
    lines.push('')
    lines.push(`Error: ${job.error}`)
  }

  if (Array.isArray(job.offsiteProgress) && job.offsiteProgress.length > 0) {
    lines.push('')
    lines.push('Live per-target progress:')
    for (const t of job.offsiteProgress) {
      lines.push(`  ${t.ip}: ${typeof t.percentage === 'number' ? `${t.percentage}%` : '?'}${t.text ? ` — ${t.text}` : ''}`)
    }
  }

  if (typeof job.exitCode === 'number') {
    lines.push('')
    lines.push(`Exit code: ${job.exitCode}`)
  }

  return lines.join('\n')
}
