import { useState } from 'react'
import { ShieldAlert, ShieldX, ChevronDown, ChevronUp, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useCertificateStatus, type CertificateStatus } from '@/hooks/useCertificateStatus'

/**
 * Platform-wide TLS certificate banner.
 *
 * The agents are built to keep backing up through an expired certificate
 * rather than stopping, which means nothing else in the UI will look wrong.
 * This banner is the compensating signal — and it says out loud that backups
 * are still running, because "TLS EXPIRED" with no other context reads like a
 * total outage and sends people hunting for a problem that isn't there.
 */

type Severity = 'warning' | 'critical' | 'expired' | 'error'

function severityOf(status: CertificateStatus): Severity | null {
  if (!status) return null
  if (status.worstStatus === 'ok') {
    return status.degradedAgents?.length ? 'warning' : null
  }
  return status.worstStatus as Severity
}

const STYLES: Record<Severity, { wrap: string; icon: string }> = {
  warning: {
    wrap: 'bg-amber-50 border-amber-300 text-amber-900 dark:bg-amber-950/40 dark:border-amber-800/60 dark:text-amber-200',
    icon: 'text-amber-600 dark:text-amber-400',
  },
  critical: {
    wrap: 'bg-orange-50 border-orange-300 text-orange-900 dark:bg-orange-950/40 dark:border-orange-800/60 dark:text-orange-200',
    icon: 'text-orange-600 dark:text-orange-400',
  },
  expired: {
    wrap: 'bg-red-50 border-red-300 text-red-900 dark:bg-red-950/40 dark:border-red-800/60 dark:text-red-200',
    icon: 'text-red-600 dark:text-red-400',
  },
  error: {
    wrap: 'bg-red-50 border-red-300 text-red-900 dark:bg-red-950/40 dark:border-red-800/60 dark:text-red-200',
    icon: 'text-red-600 dark:text-red-400',
  },
}

function headline(status: CertificateStatus, severity: Severity): string {
  const expired = status.certificates?.filter(c => c.status === 'expired') || []
  if (expired.length > 0) {
    const names = expired.map(c => c.label).join(', ')
    return `TLS certificate expired: ${names}`
  }
  if (severity === 'error') {
    return 'A monitored TLS certificate could not be inspected'
  }
  const soonest = (status.certificates || [])
    .filter(c => typeof c.daysRemaining === 'number' && c.status !== 'ok')
    .sort((a, b) => (a.daysRemaining! - b.daysRemaining!))[0]
  if (soonest) {
    return `TLS certificate expires in ${soonest.daysRemaining} day${soonest.daysRemaining === 1 ? '' : 's'}: ${soonest.label}`
  }
  if (status.degradedAgents?.length) {
    return `${status.degradedAgents.length} agent${status.degradedAgents.length === 1 ? '' : 's'} running on a degraded TLS link`
  }
  return 'TLS certificate needs attention'
}

export default function CertificateAlertBanner() {
  const { data: status } = useCertificateStatus()
  const [expanded, setExpanded] = useState(false)
  const [dismissedKey, setDismissedKey] = useState<string | null>(null)

  if (!status) return null
  const severity = severityOf(status)
  if (!severity) return null

  // Dismissal is scoped to the current posture: if the situation worsens (a
  // warning becomes an expiry) the banner comes back rather than staying
  // hidden because someone closed it last week.
  const postureKey = `${status.worstStatus}:${status.degradedAgents?.length || 0}`
  if (dismissedKey === postureKey) return null

  const anyBlocked = status.degradedAgents?.some(a => a.mode === 'blocked')
  const style = STYLES[severity]
  const Icon = severity === 'warning' ? ShieldAlert : ShieldX

  return (
    <div className={cn('border-b px-4 py-3 text-sm', style.wrap)}>
      <div className="flex items-start gap-3">
        <Icon className={cn('mt-0.5 h-5 w-5 shrink-0', style.icon)} />

        <div className="min-w-0 flex-1">
          <div className="font-semibold">{headline(status, severity)}</div>

          <div className="mt-0.5 opacity-90">
            {anyBlocked ? (
              <>
                An agent link is <strong>blocked</strong> because a certificate is both expired and
                presenting an unfamiliar key. Backups on that host are not reporting in — investigate now.
              </>
            ) : (
              <>
                <strong>Backups are still running.</strong> Agents continue over a pinned-key fallback,
                so no backup is lost — but browser access will break at expiry and certificate
                verification is degraded until you renew.
              </>
            )}
          </div>

          <button
            type="button"
            onClick={() => setExpanded(v => !v)}
            className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium underline underline-offset-2 opacity-80 hover:opacity-100"
          >
            {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            {expanded ? 'Hide details' : 'Show details'}
          </button>

          {expanded && (
            <div className="mt-2 space-y-1.5 text-xs">
              {(status.certificates || []).filter(c => c.status !== 'ok').map(cert => (
                <div key={cert.key} className="rounded border border-current/20 bg-black/5 px-2 py-1.5 dark:bg-white/5">
                  <div className="font-medium">{cert.label}</div>
                  {cert.error ? (
                    <div className="opacity-80">{cert.error}</div>
                  ) : (
                    <div className="opacity-80">
                      {cert.subject && <>Subject {cert.subject} · </>}
                      Expires {cert.validTo}
                      {typeof cert.daysRemaining === 'number' && (
                        <> ({cert.daysRemaining < 0 ? `${Math.abs(cert.daysRemaining)} days ago` : `in ${cert.daysRemaining} days`})</>
                      )}
                      {cert.kind === 'endpoint' && <> · served live on {cert.source}</>}
                    </div>
                  )}
                </div>
              ))}

              {(status.degradedAgents || []).map(agent => (
                <div key={agent.agent} className="rounded border border-current/20 bg-black/5 px-2 py-1.5 dark:bg-white/5">
                  <div className="font-medium">Agent {agent.agent} — {agent.mode}</div>
                  <div className="opacity-80">{agent.reason}</div>
                </div>
              ))}

              <div className="opacity-70">
                To fix: renew the certificate, reload nginx, then restart the controller — it reads
                its certificate only at startup.
                {status.lastCheckedAt && <> Last checked {new Date(status.lastCheckedAt).toLocaleString()}.</>}
              </div>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => setDismissedKey(postureKey)}
          aria-label="Dismiss certificate warning"
          className="shrink-0 rounded p-1 opacity-60 transition-opacity hover:opacity-100"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
