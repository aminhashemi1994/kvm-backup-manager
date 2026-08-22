import { CheckCircle, AlertTriangle, XCircle, HelpCircle, Loader2, Clock, Lock, RefreshCw } from 'lucide-react'
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
 * One icon per job summarising the outcome.
 *
 * Four outcome icons cover the request:
 *   - success (green)  — backup and (if scheduled) offsite sync both ok
 *   - warning (amber)  — partial success: e.g. backup ok but rsync failed,
 *                        or rsync ended as `partial`. An indeterminate failure
 *                        (no evidence either way) also lands here because the
 *                        safe read is "verify before trusting".
 *   - fail    (red)    — the backup itself failed
 *   - unknown (gray)   — we don't know: agent never confirmed the outcome,
 *                        or the only evidence is a `unknown` offsite result.
 *
 * Active jobs get their own transient icons (running/queued/retrying) plus
 * the matching OffsiteSyncBadge further down for the sync side.
 *
 * The full detail — exit code, offsite results, failure stage/reason,
 * verification status — is on hover so a single icon carries all four
 * status words without taking column width.
 */
export default function JobStatusIcons({ job, coveringJob, className = '' }: JobStatusIconsProps) {
  const kind = classify(job)
  const { Icon, color, label, animate } = ICONS[kind]
  const tooltip = buildTooltip(job, coveringJob)

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
    label: 'Partial success',
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
    offsiteSyncStatus,
    offsiteResults,
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
    // Trust the per-target offsite results: if every configured offsite
    // target reports `success`, the job is fully successful regardless of
    // a stale `failureStage === 'offsite'` flag left over from an earlier
    // terminal update (a later retry/ingest can leave the flag set even
    // after the sync has since completed). Without this, "backup ok,
    // offsite ok after a retry" would still be painted as a warning.
    const results = Array.isArray(offsiteResults) ? offsiteResults : []
    let offsiteOk: boolean | null = null
    if (results.length > 0) {
      offsiteOk = results.every(r => r && (r.status === 'success' || r.status === 'synced'))
    } else if (offsiteSyncStatus === 'completed') {
      offsiteOk = true
    } else if (offsiteSyncStatus === 'partial' || offsiteSyncStatus === 'failed') {
      offsiteOk = false
    } else if (offsiteSyncStatus === 'unknown') {
      offsiteOk = null
    }

    const noExitEvidence =
      unverified === true ||
      (verified === false && (exitCode === null || exitCode === undefined))

    // If we can't verify completion (no exit code, no agent confirmation),
    // we don't actually know the backup worked — even if the scheduler
    // marks it completed. Treat the same as `unknown`.
    if (noExitEvidence) {
      // Without a confirmed backup, offsite couldn't have legitimately
      // succeeded either — collapse to unknown.
      return 'unknown'
    }
    if (offsiteOk === false) return 'warning'
    if (offsiteOk === null && offsiteSyncStatus) return 'unknown'
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
    offsiteSyncStatus,
    offsiteResults,
    progress,
    phase,
    method,
  } = job as any

  const typeLabel = jobType === 'restore' ? 'Restore' : 'Backup'

  if (status === 'running' || status === 'queued' || status === 'retrying') {
    lines.push(`${typeLabel}: ${status}`)
    if (phase) lines.push(`Phase: ${phase}`)
    if (typeof progress === 'number') lines.push(`Progress: ${progress}%`)
    if (offsiteSyncStatus) lines.push(`Offsite sync: ${offsiteSyncStatus}`)
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
    if (offsiteSyncStatus) {
      lines.push(`Offsite sync: ${offsiteSyncStatus}`)
      if (offsiteResults?.length) {
        for (const r of offsiteResults) {
          lines.push(`  ${r.ip}: ${r.status}${r.reason ? ` — ${r.reason}` : ''}`)
        }
      }
      if (failureStage === 'offsite') lines.push('Offsite stage failed')
    } else {
      lines.push('Offsite sync: not scheduled')
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
    if (offsiteSyncStatus) {
      lines.push(`Offsite sync: ${offsiteSyncStatus}`)
      if (offsiteResults?.length) {
        for (const r of offsiteResults) {
          lines.push(`  ${r.ip}: ${r.status}${r.reason ? ` — ${r.reason}` : ''}`)
        }
      }
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
