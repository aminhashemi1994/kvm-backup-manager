import { useQuery, useQueryClient } from '@tanstack/react-query'
import { certificatesApi } from '@/services/api'
import { useSocketEvent } from '@/hooks/useSocket'

export interface MonitoredCertificate {
  key: string
  kind: 'file' | 'endpoint'
  label: string
  source: string
  status: 'ok' | 'warning' | 'critical' | 'expired' | 'error'
  daysRemaining?: number
  subject?: string
  issuer?: string
  validFrom?: string
  validTo?: string
  authorized?: boolean
  authorizationError?: string
  error?: string
}

export interface DegradedAgent {
  agent: string
  mode: string
  reason?: string
  cert?: { validTo?: string; daysRemaining?: number }
  degradedSince?: string
}

export interface CertificateStatus {
  worstStatus: 'ok' | 'warning' | 'critical' | 'expired' | 'error'
  lastCheckedAt: string | null
  monitored: number
  certificates: MonitoredCertificate[]
  degradedAgents: DegradedAgent[]
  backupsContinue: boolean
}

/**
 * Certificate expiry posture for the whole platform.
 *
 * Backups deliberately keep running through an expired certificate, so this is
 * the only signal that anything is wrong. It polls on a slow cadence (expiry
 * moves in days) and refreshes immediately on the socket event the controller
 * emits when it re-checks.
 */
export function useCertificateStatus() {
  const queryClient = useQueryClient()

  const query = useQuery<CertificateStatus>({
    queryKey: ['certificate-status'],
    queryFn: async () => {
      const res = await certificatesApi.getStatus()
      return res.data.data
    },
    // Expiry is a days-granularity signal; every 10 minutes is ample.
    refetchInterval: 10 * 60 * 1000,
    staleTime: 5 * 60 * 1000,
    retry: false,
  })

  useSocketEvent('certificate-status', (data: CertificateStatus) => {
    queryClient.setQueryData(['certificate-status'], data)
  })

  useSocketEvent('agent-tls-status', () => {
    queryClient.invalidateQueries({ queryKey: ['certificate-status'] })
  })

  return query
}
