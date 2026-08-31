import { CheckCircle, AlertTriangle, XCircle, HelpCircle, Loader2, Clock } from 'lucide-react'
import type { ReplicationCheckVM } from '@/types'

interface ReplicationStateIconProps {
  vm: ReplicationCheckVM
  className?: string
}

type IconKind = 'success' | 'warning' | 'fail' | 'unknown' | 'running' | 'pending'

/**
 * One icon per VM summarising the replication-check outcome.
 *
 * Mirrors the four outcome icons used by the Job History so an operator
 * moving between the two tabs reads the same colour coding:
 *   - success (green)  — every offsite target is in sync
 *   - warning (amber)  — partial: at least one target is in sync AND at
 *                        least one is behind/unreachable
 *   - fail    (red)    — no target is in sync (all behind or unreachable)
 *                        OR the source pool is not mounted / the check
 *                        itself errored
 *   - unknown (gray)   — skipped, agent too old, or all targets unreachable
 *
 * The full per-target breakdown (which offsite is behind, which is synced,
 * exact reason text) lives on hover so the state cell never crowds the
 * column.
 */
export default function ReplicationStateIcon({ vm, className = '' }: ReplicationStateIconProps) {
  const kind = classify(vm)
  const { Icon, color, label, animate } = ICONS[kind]
  const tooltip = buildTooltip(vm)

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
  success: { Icon: CheckCircle, color: 'bg-green-100 text-green-700', label: 'In sync' },
  warning: { Icon: AlertTriangle, color: 'bg-amber-100 text-amber-700', label: 'Partially behind' },
  fail: { Icon: XCircle, color: 'bg-red-100 text-red-700', label: 'Out of sync' },
  unknown: { Icon: HelpCircle, color: 'bg-gray-100 text-gray-600', label: 'Outcome unknown' },
  running: { Icon: Loader2, color: 'bg-blue-100 text-blue-700', label: 'Checking', animate: true },
  // Replication is configured but nothing has been compared yet. Deliberately
  // not `unknown`: nothing is wrong and nothing is in doubt — the audit simply
  // has not reached this VM since it was switched on.
  pending: { Icon: Clock, color: 'bg-blue-50 text-blue-700', label: 'Not checked yet' },
}

function classify(vm: ReplicationCheckVM): IconKind {
  // The replication check panel does not run continuously; this is only here
  // so a stale "Checking…" state could be rendered if it ever appears.
  if ((vm as any).state === 'checking' || (vm as any).state === 'in_progress') return 'running'

  if (vm.state === 'not_checked') return 'pending'

  if (vm.state === 'source_unavailable') return 'fail'
  // Offsite is on but points at nothing that still exists, so no copy is being
  // made at all. A failure, not an "unknown" — nothing is in doubt here.
  if (vm.state === 'no_target') return 'fail'
  if (vm.state === 'error') return 'fail'

  if (vm.state === 'in_sync') return 'success'

  if (vm.state === 'unreachable' || vm.state === 'skipped') return 'unknown'

  // out_of_sync: use the per-target breakdown to split partial vs total.
  const detail = Array.isArray(vm.targetDetail) ? vm.targetDetail : []
  if (detail.length > 0) {
    const inSync = detail.filter(t => t && (t.state === 'in_sync')).length
    if (inSync === detail.length) return 'success'
    if (inSync === 0) return 'fail'
    return 'warning'
  }

  // No per-target detail available — fall back to counts the service carries.
  if ((vm.outOfSyncTargets || 0) > 0 && (vm.unreachableTargets || 0) === 0) return 'warning'
  return 'warning'
}

function buildTooltip(vm: ReplicationCheckVM): string {
  const lines: string[] = []
  const { state, targetDetail, targets, outOfSyncTargets, unreachableTargets, reason } = vm as any

  lines.push(`Replication: ${stateLabel(state)}`)

  if (Array.isArray(targetDetail) && targetDetail.length > 0) {
    lines.push('')
    lines.push('Per offsite host:')
    for (const t of targetDetail) {
      const name = t.offsiteHostName || t.ip || '?'
      const tState = t.state || 'unknown'
      const detail: string[] = [tState]
      if (typeof t.differences === 'number' && t.differences > 0) {
        detail.push(`${t.differences} file(s) differ`)
      }
      if (typeof t.pendingRotations === 'number' && t.pendingRotations > 0) {
        detail.push(`${t.pendingRotations} rotation(s) pending`)
      }
      if (t.reason) detail.push(t.reason)
      lines.push(`  ${name}: ${detail.join(' — ')}`)
    }
  } else if (Array.isArray(targets) && targets.length > 0) {
    lines.push('')
    lines.push('Configured destinations:')
    for (const t of targets) {
      lines.push(`  ${t.offsiteHostName || t.ip}${t.path ? ` → ${t.path}` : ''}`)
    }
    if (outOfSyncTargets || unreachableTargets) {
      lines.push('')
      lines.push(`${outOfSyncTargets || 0} destination(s) behind`)
      if (unreachableTargets) lines.push(`${unreachableTargets} unreachable`)
    }
  }

  if (reason) {
    lines.push('')
    lines.push(`Reason: ${reason}`)
  }

  if ((vm as any).agentUnsupported) {
    lines.push('')
    lines.push('Agent on this host is too old to answer the check.')
  }
  if ((vm as any).syncJobId) {
    lines.push('Sync was queued automatically for this VM.')
  }
  if ((vm as any).syncNote) {
    lines.push(`Sync note: ${(vm as any).syncNote}`)
  }

  return lines.join('\n')
}

function stateLabel(state: ReplicationCheckVM['state']): string {
  switch (state) {
    case 'in_sync': return 'in sync'
    case 'out_of_sync': return 'behind'
    case 'skipped': return 'skipped'
    case 'unreachable': return 'unreachable'
    case 'error': return 'check failed'
    case 'source_unavailable': return 'source pool not mounted'
    case 'no_target': return 'no offsite destination left'
    case 'not_checked': return 'on, not compared yet'
    default: return String(state)
  }
}
