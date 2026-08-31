import type { OffsiteJob } from '@/types'

/**
 * Present a replication job in the shape the backup/restore tables expect.
 *
 * Replication has its own store, its own statuses and its own vocabulary, but
 * an operator looking at "what is running" should not have to consult a
 * different page to see a transfer. Rather than teaching those tables about a
 * second record type, each job is normalised here once — so the tables stay
 * unaware that two stores exist, and the mapping lives in one place instead of
 * being re-derived in every column.
 */
export interface UnifiedJob {
  id: string
  jobType: 'replication'
  vmName: string
  backupHostName?: string
  status: string
  progress: number
  progressText?: string
  phase: 'rsync'
  method?: string
  scheduleType?: string
  startTime: string
  endTime?: string
  error?: string | null
  /** The original record, for anything replication-specific. */
  offsite: OffsiteJob
}

/** What asked for the sync, in the words the Method column uses. */
const TRIGGER_LABEL: Record<string, string> = {
  backup: 'After backup',
  manual: 'Manual',
  check: 'Check',
  retry: 'Retry',
}

export function toUnifiedJob(job: OffsiteJob): UnifiedJob {
  return {
    id: job.id,
    jobType: 'replication',
    vmName: job.vmName,
    backupHostName: job.backupHostName,
    status: job.status,
    progress: job.progress || 0,
    progressText: job.progressText,
    // Drives the purple bar the backup view already uses for transfers.
    phase: 'rsync',
    method: TRIGGER_LABEL[job.trigger || ''] || job.trigger || 'Replication',
    scheduleType: TRIGGER_LABEL[job.trigger || ''] || 'Replication',
    // A queued sync has no startTime yet, and the tables sort on this field —
    // without the fallback every queued transfer sorts to the epoch and piles
    // up at the bottom of the list.
    startTime: job.startTime || job.createdAt,
    endTime: job.endTime || undefined,
    error: job.error,
    offsite: job,
  }
}

export function toUnifiedJobs(jobs: OffsiteJob[] | undefined): UnifiedJob[] {
  return (jobs || []).map(toUnifiedJob)
}

/** Replication jobs an operator can still act on. */
export const isReplicationActive = (status: string) =>
  status === 'queued' || status === 'running'

/**
 * A finished replication worth retrying. `busy` is included: that job did
 * nothing at all because another transfer held the VM's lock, so re-running it
 * once that one is done is exactly what it is for.
 */
export const isReplicationRetryable = (status: string) =>
  ['failed', 'cancelled', 'busy', 'unsupported'].includes(status)
