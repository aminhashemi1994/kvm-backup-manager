import { useQuery, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { offsiteJobsApi } from '@/services/api'
import { toast } from 'sonner'
import { useSocketEvent } from '@/hooks/useSocket'
import { debouncedInvalidate } from '@/lib/debouncedInvalidate'
import type { OffsiteJob, ReplicationCheckSummary } from '@/types'
import { getErrorMessage } from '@/lib/errors'

/**
 * Offsite replication jobs.
 *
 * These deliberately do NOT live under the ['backups'] query key. A backup and
 * its replication are independent now — a backup can be finished and green
 * while its sync is still running, and neither list should refetch because the
 * other changed.
 */

const ACTIVE_STATUSES = ['queued', 'running']

export function useOffsiteJobs(params?: { vmId?: string; status?: string; limit?: number }) {
  return useQuery({
    queryKey: ['offsite-jobs', 'list', params ?? null],
    queryFn: async () => {
      const res = await offsiteJobsApi.getAll(params)
      return res.data.data as OffsiteJob[]
    },
    // Socket events drive the live updates; this is only the safety net for a
    // dropped connection. Slower than the backup list because a replication
    // run is measured in minutes to hours, not seconds.
    refetchInterval: 15000,
    placeholderData: (previous) => previous,
  })
}

export function useActiveOffsiteJobs() {
  return useQuery({
    queryKey: ['offsite-jobs', 'active'],
    queryFn: async () => {
      const res = await offsiteJobsApi.getActive()
      return res.data.data as OffsiteJob[]
    },
    refetchInterval: 5000,
    placeholderData: (previous) => previous,
  })
}

export function useOffsiteJob(id: string | null) {
  return useQuery({
    queryKey: ['offsite-jobs', 'one', id],
    queryFn: async () => {
      const res = await offsiteJobsApi.getOne(id as string)
      return res.data.data as OffsiteJob
    },
    enabled: !!id,
    refetchInterval: (query) => {
      const job = query.state.data as OffsiteJob | undefined
      return job && ACTIVE_STATUSES.includes(job.status) ? 3000 : false
    },
  })
}

export function useOffsiteJobLog(id: string | null, isActive = false) {
  return useQuery({
    queryKey: ['offsite-jobs', 'log', id],
    queryFn: async () => {
      const res = await offsiteJobsApi.getLog(id as string)
      return (res.data.data?.log ?? '') as string
    },
    enabled: !!id,
    // The agent streams into a file rather than over the socket, so a running
    // sync's log is polled. Once it's finished the log is final — stop.
    refetchInterval: isActive ? 3000 : false,
  })
}

export function useTriggerOffsiteSync() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (data: { vmId: string; scheduleId?: string | null; vmName?: string }) => {
      const res = await offsiteJobsApi.create({ vmId: data.vmId, scheduleId: data.scheduleId ?? null })
      return { ...res.data, vmName: data.vmName, httpStatus: res.status }
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['offsite-jobs'] })
      const name = data.vmName ? ` for ${data.vmName}` : ''
      if (data.note) {
        // The controller coalesced onto an existing sync. That is the correct
        // answer, not a failure — say which one covers the request.
        toast.info(`Offsite sync${name} already in progress`, { description: data.note })
      } else {
        toast.success(`Offsite sync queued${name}`)
      }
    },
    onError: (error: any) => {
      toast.error(getErrorMessage(error, 'Could not queue the offsite sync'))
    },
  })
}

export function useRetryOffsiteJob() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (data: { id: string; vmName?: string; resetSourceGuard?: boolean }) => {
      const res = await offsiteJobsApi.retry(data.id, { resetSourceGuard: data.resetSourceGuard })
      return { ...res.data, vmName: data.vmName }
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['offsite-jobs'] })
      toast.success(`Offsite sync re-queued${data.vmName ? ` for ${data.vmName}` : ''}`, {
        description: 'Whatever already reached the offsite host stays — only the remainder is sent.',
      })
    },
    onError: (error: any) => {
      toast.error(getErrorMessage(error, 'Could not retry the offsite sync'))
    },
  })
}

export interface BulkOffsiteRetryOutcome {
  jobId: string
  vmName: string
  result: 'started' | 'coalesced' | 'error'
  message: string
}

/**
 * Retry several replication jobs.
 *
 * Sequential on purpose. The controller coalesces per VM and drains against
 * each host's concurrency limit, so firing them in parallel would only race
 * to be told to wait — and a failure partway through would leave an unclear
 * picture of what was actually re-queued.
 */
export function useBulkRetryOffsiteJobs() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (jobs: { id: string; vmName: string }[]) => {
      const outcomes: BulkOffsiteRetryOutcome[] = []

      for (const job of jobs) {
        try {
          await offsiteJobsApi.retry(job.id)
          outcomes.push({
            jobId: job.id, vmName: job.vmName,
            result: 'started', message: 'Re-queued',
          })
        } catch (error: any) {
          // 409 = a sync for that VM is already queued or running. Not a
          // failure: this VM is already covered, so it is counted apart from
          // the ones that genuinely could not be re-queued.
          const status = error.response?.status
          outcomes.push({
            jobId: job.id, vmName: job.vmName,
            result: status === 409 ? 'coalesced' : 'error',
            message: getErrorMessage(error, 'Retry failed'),
          })
        }
      }

      return outcomes
    },
    onSuccess: (outcomes) => {
      queryClient.invalidateQueries({ queryKey: ['offsite-jobs'] })

      const started = outcomes.filter(o => o.result === 'started').length
      const coalesced = outcomes.filter(o => o.result === 'coalesced').length
      const errored = outcomes.filter(o => o.result === 'error')

      const parts = []
      if (started) parts.push(`${started} re-queued`)
      if (coalesced) parts.push(`${coalesced} already covered by a running sync`)

      if (errored.length === 0) {
        toast.success(`Retried ${outcomes.length} sync(s)`, {
          description: parts.join(' · ') || undefined,
        })
      } else {
        toast.warning(`${errored.length} of ${outcomes.length} could not be retried`, {
          description: [
            ...parts,
            errored.slice(0, 3).map(o => `${o.vmName}: ${o.message}`).join('; '),
          ].filter(Boolean).join(' · '),
        })
      }
    },
    onError: (error: any) => {
      toast.error(getErrorMessage(error, 'Bulk retry failed'))
    },
  })
}

export function useCancelOffsiteJob() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (data: { id: string; vmName?: string }) => {
      const res = await offsiteJobsApi.cancel(data.id)
      return { ...res.data, vmName: data.vmName }
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['offsite-jobs'] })
      toast.success(`Offsite sync cancelled${data.vmName ? ` for ${data.vmName}` : ''}`, {
        description: 'Nothing already transferred was removed. A later sync resumes from it.',
      })
    },
    onError: (error: any) => {
      toast.error(getErrorMessage(error, 'Could not cancel the offsite sync'))
    },
  })
}

// ── Replication check ──────────────────────────────────────────────────────

export function useReplicationCheckResults() {
  return useQuery({
    queryKey: ['offsite-check', 'results'],
    queryFn: async () => {
      const res = await offsiteJobsApi.getCheckResults()
      return res.data.data as ReplicationCheckSummary
    },
    // The check itself runs on an hours-scale interval; this only needs to
    // notice a run that finished while the page was open, and the
    // offsite-check-complete socket event already covers the common case.
    refetchInterval: 60000,
    placeholderData: (previous) => previous,
  })
}

export function useRunReplicationCheck() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (data?: { backupHostId?: string | null; sync?: boolean }) => {
      const res = await offsiteJobsApi.runCheck(data)
      return res.data.data as ReplicationCheckSummary
    },
    onSuccess: (summary) => {
      queryClient.invalidateQueries({ queryKey: ['offsite-check'] })
      queryClient.invalidateQueries({ queryKey: ['offsite-jobs'] })
      if (!summary || summary.checked === 0) {
        toast.info('Replication check finished', {
          description: 'No VM currently has an offsite destination to check.',
        })
        return
      }
      const parts = [`${summary.inSync ?? 0} in sync`, `${summary.outOfSync ?? 0} behind`]
      if (summary.sourceUnavailable) parts.push(`${summary.sourceUnavailable} source unavailable`)
      if (summary.failed) parts.push(`${summary.failed} could not be checked`)
      if (summary.synced) parts.push(`${summary.synced} sync(s) queued`)
      toast.success(`Checked ${summary.checked} VM(s)`, { description: parts.join(' · ') })
    },
    onError: (error: any) => {
      // A full check stats every VM's tree at both ends, so the request can
      // outlive a proxy's read timeout on a large estate. The check itself
      // carries on server-side and announces itself over the socket, which
      // this page already listens for — so say that rather than reporting a
      // failure that did not happen.
      const timedOut =
        error.code === 'ECONNABORTED' ||
        error.response?.status === 504 ||
        error.response?.status === 502
      if (timedOut) {
        toast.info('The replication check is still running', {
          description: 'It is taking longer than the request would wait. Results appear here as soon as it finishes.',
        })
        return
      }
      toast.error(getErrorMessage(error, 'The replication check could not be run'))
    },
  })
}

// ── Live updates ───────────────────────────────────────────────────────────

/**
 * Apply an offsite job update straight into the cached lists.
 *
 * A sync emits a progress update every few seconds for a run that can last
 * hours; refetching the whole list each time would be pure waste. The row is
 * patched in place, and a create/finish (which changes membership, ordering or
 * counts) falls back to a debounced invalidate.
 */
function patchCachedJob(queryClient: QueryClient, job: OffsiteJob) {
  queryClient.setQueriesData({ queryKey: ['offsite-jobs'] }, (old: any) => {
    if (Array.isArray(old)) {
      let found = false
      const next = old.map((j: OffsiteJob) => {
        if (j.id !== job.id) return j
        found = true
        return { ...j, ...job }
      })
      return found ? next : old
    }
    if (old && typeof old === 'object' && old.id === job.id) return { ...old, ...job }
    return old
  })
}

/**
 * Wire the offsite socket stream into the query cache. Mount once per page
 * that shows offsite data.
 */
export function useOffsiteJobEvents() {
  const queryClient = useQueryClient()

  useSocketEvent('offsite-job-updated', (job: OffsiteJob) => {
    if (job?.id) patchCachedJob(queryClient, job)
  })

  useSocketEvent('offsite-job-created', () => {
    debouncedInvalidate(queryClient, ['offsite-jobs'])
  })

  useSocketEvent('offsite-job-finished', (job: OffsiteJob) => {
    if (job?.id) patchCachedJob(queryClient, job)
    debouncedInvalidate(queryClient, ['offsite-jobs'])
    // A finished sync is what the backup history's offsite badge reflects.
    debouncedInvalidate(queryClient, ['backups'])
  })

  useSocketEvent('offsite-check-complete', (summary: ReplicationCheckSummary) => {
    queryClient.setQueryData(['offsite-check', 'results'], summary)
    debouncedInvalidate(queryClient, ['offsite-jobs'])
  })

  // A finished offsite sync reconciled one VM's check entry on the server.
  // The full summary payload replaces the cached one so the panel reflects
  // the new verdict without waiting for the next scheduled check.
  useSocketEvent('offsite-check-updated', (summary: ReplicationCheckSummary) => {
    queryClient.setQueryData(['offsite-check', 'results'], summary)
  })
}
