import {
  CheckCircle, AlertTriangle, XCircle, HelpCircle, Loader2, Clock, Lock, RefreshCw,
} from 'lucide-react'
import type { BackupJob } from '@/types'

interface JobStatusIconsProps {
  job: BackupJob
  /**
   * The job that was already running when this one was rejected (resolved by
   * the caller from the history list). Carried separately because the icon
   * has no access to the caller's id→job map.
   */
  coveringJob?: BackupJob
  className?: string
}

type IconKind =
  | 'success'
  | 'warning'
  | 'fail'
  | 'unknown'
  | 'running'
  | 'queued'
  | 'retrying'
  | 'skipped'
  | 'rejected'

/**
 * One icon per backup/restore job summarising the outcome.
 *
 * Four outcome icons cover the request:
 *   - success (green)  — backup completed (exit code 0, agent confirmed)
 *   - warning (amber)  — finished but unverified (no exit code, agent never
 *                        confirmed completion) — the safe read is "verify
 *                        before trusting"
 *   - fail    (red)    — the backup itself failed
 *   - unknown (gray)   — indeterminate: no agent record, no exit code
 *
 * Active jobs get their own transient icons (running/queued/retrying).
 *
 * Replication status used to be folded into this icon (a second dot beside
 * the primary). Replication is now its own job with its own history page, so
 * the offsite half lives there and this component is the backup half alone.
 *
 * The full detail — exit code, failure stage/reason, retry lineage — is on
 * hover so a single icon carries everything without taking column width.
 */
export default function JobStatusIcons({
  job,
  coveringJob,
  className = '',
}: JobStatusIconsProps) {
  const kind = classify(job)
  const { Icon, color, label, animate } = ICONS[kind]
  const tooltip = buildTooltip(job, coveringJob)

  return (
    <div className="inline-flex items-center gap-1">
      <div
        className={`inline-flex items-center justify-center h-7 w-7 rounded-full ${color} ${
          animate ? 'animate-pulse' : ''
        } ${className}`}
        title={tooltip}
        aria-label={label}
      >
        <Icon className="h-4 w-4" />
      </div>
    </div>
  )
}

const ICONS: Record<
  IconKind,
  { Icon: any; color: string; label: string; animate?: boolean }
> = {
  success: {
    Icon: CheckCircle,
    color: 'bg-green-100 text-green-700',
    label: 'Success',
  },
  warning: {
    Icon: AlertTriangle,
    color: 'bg-amber-100 text-amber-700',
    label: 'Unverified',
  },
  fail: {
    Icon: XCircle,
    color: 'bg-red-100 text-red-700',
    label: 'Failed',
  },
  unknown: {
    Icon: HelpCircle,
    color: 'bg-gray-100 text-gray-600',
    label: 'Outcome unknown',
  },
  running: {
    Icon: Loader2,
    color: 'bg-blue-100 text-blue-700',
    label: 'Running',
    animate: true,
  },
  queued: {
    Icon: Clock,
    color: 'bg-gray-100 text-gray-700',
    label: 'Queued',
  },
  retrying: {
    Icon: RefreshCw,
    color: 'bg-purple-100 text-purple-700',
    label: 'Retrying',
    animate: true,
  },
  skipped: {
    Icon: Clock,
    color: 'bg-orange-100 text-orange-700',
    label: 'Skipped',
  },
  rejected: {
    Icon: Lock,
    color: 'bg-amber-100 text-amber-700',
    label: 'Locked by another run',
  },
}

function classify(job: BackupJob): IconKind {
  const {
    status,
    verified,
    unverified,
    failureReason,
    exitCode,
  } = job

  if (status === 'queued') return 'queued'
  if (status === 'retrying') return 'retrying'
  if (status === 'running') return 'running'
  if (status === 'skipped') return 'skipped'
  if (status === 'rejected') return 'rejected'

  if (status === 'failed') {
    // Indeterminate: no agent record and no exit code — we genuinely don't
    // know whether the backup ran. Show as unknown rather than fail so the
    // operator doesn't file it as a confirmed loss.
    if (failureReason === 'indeterminate') return 'unknown'
    return 'fail'
  }

  if (status === 'completed') {
    const noExitEvidence =
      unverified === true ||
      (verified === false && (exitCode === null || exitCode === undefined))

    // If we can't verify completion (no exit code, no agent confirmation),
    // we don't actually know the backup worked — even if the scheduler
    // marks it completed. Treat as warning rather than green.
    if (noExitEvidence) return 'warning'
    return 'success'
  }

  return 'unknown'
}

function buildTooltip(job: BackupJob, coveringJob?: BackupJob): string {
  const lines: string[] = []
  const {
    status,
    jobType,
    exitCode,
    error,
    failureStage,
    failureReason,
    verified,
    unverified,
    progress,
    phase,
    method,
  } = job as any

  const typeLabel = jobType === 'restore' ? 'Restore' : 'Backup'

  if (status === 'running' || status === 'queued' || status === 'retrying') {
    lines.push(`${typeLabel}: ${status}`)
    if (phase) lines.push(`Phase: ${phase}`)
    if (typeof progress === 'number') lines.push(`Progress: ${progress}%`)
    if ((job as any).retryOf) lines.push(`Retry of: ${(job as any).retryOf.substring(0, 8)}`)
    return lines.join('\n')
  }

  if (status === 'completed') {
    lines.push(`${typeLabel}: succeeded${exitCode === 0 ? ' (exit code 0)' : exitCode != null ? ` (exit code ${exitCode})` : ''}`)
    if (unverified || verified === false) {
      lines.push('Verified: no — agent never confirmed completion')
    } else if (verified) {
      lines.push('Verified: yes')
    }
    if (error) lines.push(`Note: ${error}`)
    if ((job as any).retryOf) lines.push(`Retry of: ${(job as any).retryOf.substring(0, 8)}`)
    return lines.join('\n')
  }

  if (status === 'failed') {
    lines.push(`${typeLabel}: failed`)
    if (failureReason === 'indeterminate') {
      lines.push('Outcome: unknown — agent had no record and no exit code captured')
      lines.push('Shown as failed because success was never confirmed')
    } else {
      if (failureStage) lines.push(`Stage: ${failureStage}`)
      if (failureReason) lines.push(`Reason: ${failureReason}`)
      if (exitCode != null) lines.push(`Exit code: ${exitCode}`)
      if (method) lines.push(`Method: ${method}`)
    }
    if (error) lines.push(`Error: ${error}`)
    if ((job as any).retryOf) lines.push(`Retry of: ${(job as any).retryOf.substring(0, 8)}`)
    return lines.join('\n')
  }

  if (status === 'skipped') {
    lines.push(`${typeLabel}: skipped`)
    const reason = (job as any).skippedReason
    lines.push(`Reason: ${reason === 'agent_offline' ? 'Agent offline' : reason || 'unknown'}`)
    if ((job as any).retryOf) lines.push(`Retry of: ${(job as any).retryOf.substring(0, 8)}`)
    return lines.join('\n')
  }

  if (status === 'rejected') {
    lines.push(`${typeLabel}: rejected — VM already being backed up`)
    if (coveringJob) {
      const startedAt = coveringJob.startTime ? new Date(coveringJob.startTime).toLocaleString() : 'unknown time'
      const endedAt = coveringJob.endTime ? new Date(coveringJob.endTime).toLocaleString() : null
      const outcome = coveringJob.status
      if (outcome === 'completed') {
        lines.push(`Covered by run started ${startedAt}`)
        lines.push(`That run completed successfully${endedAt ? ` at ${endedAt}` : ''}`)
      } else {
        lines.push(`Covered by run started ${startedAt}`)
        lines.push(`That run ended as "${outcome}"`)
      }
      lines.push('Nothing failed here and no backup was lost — "View Logs" shows that run\'s log, not this one\'s.')
    } else {
      lines.push('This run never started because the VM was already being backed up.')
      lines.push('Nothing failed and no backup was lost — "View Logs" shows the run that was in progress.')
    }
    if ((job as any).rejectedReason) lines.push(`Reason: ${(job as any).rejectedReason}`)
    return lines.join('\n')
  }

  lines.push(`Status: ${status}`)
  return lines.join('\n')
}
