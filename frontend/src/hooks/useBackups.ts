import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { backupsApi, schedulesApi } from '@/services/api'
import { toast } from 'sonner'
import type { BackupJob, BackupSchedule, BackupStats } from '@/types'
import { getErrorMessage } from '@/lib/errors'

// Backup Jobs
export function useActiveBackups() {
  return useQuery({
    queryKey: ['backups', 'active'],
    queryFn: async () => {
      const response = await backupsApi.getActive()
      return response.data.data as BackupJob[]
    },
    // 5s background refetch as a safety net. Live updates come from
    // socket events (backup-started/progress/complete/error) which
    // invalidate this query, so most state changes appear instantly
    // without waiting for this interval.
    refetchInterval: 5000,
    // Keep showing the previous table while the next refetch runs so
    // rows don't blink to "loading" state every 5 seconds.
    placeholderData: (previousData) => previousData,
  })
}

export function useBackupHistory(params?: any, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['backups', 'history', params],
    queryFn: async () => {
      const response = await backupsApi.getHistory(params)
      return response.data.data as BackupJob[]
    },
    enabled: options?.enabled ?? true,
  })
}

export function useBackupJob(id: string) {
  return useQuery({
    queryKey: ['backups', 'job', id],
    queryFn: async () => {
      const response = await backupsApi.getJob(id)
      return response.data.data as BackupJob
    },
    enabled: !!id,
    refetchInterval: (data) => {
      if (data?.status === 'completed' || data?.status === 'failed') {
        return false
      }
      return 3000
    },
  })
}

export function useBackupJobLogs(id: string) {
  return useQuery({
    queryKey: ['backups', 'logs', id],
    queryFn: async () => {
      const response = await backupsApi.getJobLogs(id)
      return response.data.data.logs as string
    },
    enabled: !!id,
  })
}

export function useTriggerBackup() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (data: any) => {
      const response = await backupsApi.trigger(data)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['backups'] })
      toast.success('Backup triggered successfully')
    },
    onError: (error: any) => {
      toast.error(getErrorMessage(error, 'Failed to trigger backup'))
    },
  })
}

export function useKillBackupJob() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (jobId: string) => {
      const response = await backupsApi.killJob(jobId)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['backups'] })
      toast.success('Backup job cancelled')
    },
    onError: (error: any) => {
      toast.error(getErrorMessage(error, 'Failed to cancel backup job'))
    },
  })
}

export function useForceRemoveJob() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (jobId: string) => {
      const response = await backupsApi.forceRemoveJob(jobId)
      return { ...response.data, jobId }
    },
    onSuccess: (data) => {
      // Optimistically remove the job from all backup-related queries
      queryClient.setQueriesData({ queryKey: ['backups'] }, (oldData: any) => {
        if (!oldData) return oldData
        
        // Handle different data structures
        if (oldData.data?.jobs) {
          // For paginated/structured responses
          return {
            ...oldData,
            data: {
              ...oldData.data,
              jobs: oldData.data.jobs.filter((job: any) => job.id !== data.jobId)
            }
          }
        } else if (Array.isArray(oldData.data)) {
          // For array responses
          return {
            ...oldData,
            data: oldData.data.filter((job: any) => job.id !== data.jobId)
          }
        } else if (Array.isArray(oldData)) {
          // For direct array responses
          return oldData.filter((job: any) => job.id !== data.jobId)
        }
        
        return oldData
      })
      
      // Also invalidate to refetch fresh data
      queryClient.invalidateQueries({ queryKey: ['backups'] })
      
      // Show appropriate message based on whether job was already deleted
      if (data.data?.alreadyDeleted) {
        toast.success('Job removed from panel (was already deleted from database)')
      } else {
        toast.success('Job removed from history')
      }
    },
    onError: (error: any) => {
      toast.error(getErrorMessage(error, 'Failed to remove job'))
    },
  })
}

export type BulkForceRemoveOutcome = {
  jobId: string
  vmName: string
  result: 'removed' | 'error'
  message: string
}

/**
 * Force-remove several jobs in one action.
 *
 * Sequential like the bulk retry: each removal asks the agent to kill any live
 * process and then deletes the record, and firing them in parallel would race
 * the shared history file. Never rejects — a failure mid-list must not abandon
 * the jobs behind it; every outcome is collected and summarised at the end.
 */
export function useBulkForceRemoveJobs() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (jobs: { id: string; vmName: string }[]) => {
      const outcomes: BulkForceRemoveOutcome[] = []

      for (const job of jobs) {
        try {
          await backupsApi.forceRemoveJob(job.id)
          outcomes.push({
            jobId: job.id,
            vmName: job.vmName,
            result: 'removed',
            message: 'Removed',
          })
        } catch (error: any) {
          outcomes.push({
            jobId: job.id,
            vmName: job.vmName,
            result: 'error',
            message: getErrorMessage(error, 'Remove failed'),
          })
        }
      }

      return outcomes
    },
    onSuccess: (outcomes: BulkForceRemoveOutcome[]) => {
      queryClient.invalidateQueries({ queryKey: ['backups'] })

      const removed = outcomes.filter(o => o.result === 'removed').length
      const errored = outcomes.filter(o => o.result === 'error').length

      const parts: string[] = []
      if (removed) parts.push(`${removed} removed`)
      if (errored) parts.push(`${errored} failed`)
      const summary = parts.join(' · ') || 'Nothing to remove'

      if (errored) {
        const names = outcomes
          .filter(o => o.result === 'error')
          .map(o => `${o.vmName}: ${o.message}`)
        const shown = names.slice(0, 3).join(' · ')
        toast.error(summary, {
          description: names.length > 3 ? `${shown} · +${names.length - 3} more` : shown,
          duration: 8000,
        })
      } else {
        toast.success(summary)
      }
    },
    onError: (error: any) => {
      toast.error(error?.message || 'Bulk force remove failed')
    },
  })
}

export function useRetryBackup() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (jobId: string) => {
      const response = await backupsApi.retryJob(jobId)
      return response.data
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ['backups'] })
      // "adopted" means a backup for this VM was already in progress and the
      // skipped records were resolved against it — surface that message.
      toast.success(data?.message || 'Backup retry initiated')
    },
    onError: (error: any) => {
      toast.error(getErrorMessage(error, 'Failed to retry backup'))
    },
  })
}

export type BulkRetryOutcome = {
  jobId: string
  vmName: string
  result: 'started' | 'adopted' | 'limited' | 'error'
  message: string
}

/**
 * Retry several jobs in one action.
 *
 * Deliberately sequential: the retry endpoint takes a per-host lock and counts
 * concurrency slots, so firing these in parallel just makes most of them lose
 * the race and come back 429. One at a time, each retry claims its slot before
 * the next is asked for.
 *
 * Never rejects — a failure mid-list must not abandon the jobs behind it, so
 * each outcome is captured and reported together at the end.
 */
export function useBulkRetryBackups() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (jobs: { id: string; vmName: string }[]) => {
      const outcomes: BulkRetryOutcome[] = []

      for (const job of jobs) {
        try {
          const { data } = await backupsApi.retryJob(job.id)
          outcomes.push({
            jobId: job.id,
            vmName: job.vmName,
            result: data?.adopted ? 'adopted' : 'started',
            message: data?.message || 'Retry initiated',
          })
        } catch (error: any) {
          const status = error.response?.status
          outcomes.push({
            jobId: job.id,
            vmName: job.vmName,
            // 429 = host at its concurrent limit. Not a failure: the backup is
            // simply waiting for a slot, so it is called out separately.
            result: status === 429 ? 'limited' : 'error',
            message: getErrorMessage(error, 'Retry failed'),
          })
        }
      }

      return outcomes
    },
    onSuccess: (outcomes: BulkRetryOutcome[]) => {
      queryClient.invalidateQueries({ queryKey: ['backups'] })

      const count = (r: BulkRetryOutcome['result']) =>
        outcomes.filter(o => o.result === r).length
      const started = count('started')
      const adopted = count('adopted')
      const limited = count('limited')
      const errored = count('error')

      const parts: string[] = []
      if (started) parts.push(`${started} retry started`)
      if (adopted) parts.push(`${adopted} already running`)
      if (limited) parts.push(`${limited} waiting for a free slot`)
      if (errored) parts.push(`${errored} failed`)
      const summary = parts.join(' · ') || 'Nothing to retry'

      if (errored) {
        // Name the ones that actually failed, but bounded — a bulk retry of 20
        // jobs must not paste 20 error strings into a toast.
        const names = outcomes
          .filter(o => o.result === 'error')
          .map(o => `${o.vmName}: ${o.message}`)
        const shown = names.slice(0, 3).join(' · ')
        toast.error(summary, {
          description: names.length > 3 ? `${shown} · +${names.length - 3} more` : shown,
          duration: 8000,
        })
      } else {
        toast.success(summary)
      }
    },
    onError: (error: any) => {
      toast.error(error?.message || 'Bulk retry failed')
    },
  })
}

export function useBackupStats() {
  return useQuery({
    queryKey: ['backups', 'stats'],
    queryFn: async () => {
      const response = await backupsApi.getStats()
      return response.data.data as BackupStats
    },
    refetchInterval: 10000,
  })
}

// Schedules
export function useSchedules() {
  return useQuery({
    queryKey: ['schedules'],
    queryFn: async () => {
      const response = await schedulesApi.getAll()
      return response.data.data as BackupSchedule[]
    },
  })
}

export function useCreateSchedule() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (data: any) => {
      const response = await schedulesApi.create(data)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['schedules'] })
      // Which VMs replicate offsite is derived from the schedules, and the
      // Offsite page renders that list — so ticking or unticking offsite here
      // must show up there without waiting for its own refetch interval.
      queryClient.invalidateQueries({ queryKey: ['offsite-check'] })
      toast.success('Schedule created successfully')
    },
    onError: (error: any) => {
      toast.error(getErrorMessage(error, 'Failed to create schedule'))
    },
  })
}

export function useUpdateSchedule() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      const response = await schedulesApi.update(id, data)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['schedules'] })
      // Which VMs replicate offsite is derived from the schedules, and the
      // Offsite page renders that list — so ticking or unticking offsite here
      // must show up there without waiting for its own refetch interval.
      queryClient.invalidateQueries({ queryKey: ['offsite-check'] })
      toast.success('Schedule updated successfully')
    },
    onError: (error: any) => {
      toast.error(getErrorMessage(error, 'Failed to update schedule'))
    },
  })
}

export function useDeleteSchedule() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (id: string) => {
      const response = await schedulesApi.delete(id)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['schedules'] })
      // Which VMs replicate offsite is derived from the schedules, and the
      // Offsite page renders that list — so ticking or unticking offsite here
      // must show up there without waiting for its own refetch interval.
      queryClient.invalidateQueries({ queryKey: ['offsite-check'] })
      toast.success('Schedule deleted successfully')
    },
    onError: (error: any) => {
      toast.error(getErrorMessage(error, 'Failed to delete schedule'))
    },
  })
}

export function useToggleSchedule() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (id: string) => {
      const response = await schedulesApi.toggle(id)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['schedules'] })
      // Which VMs replicate offsite is derived from the schedules, and the
      // Offsite page renders that list — so ticking or unticking offsite here
      // must show up there without waiting for its own refetch interval.
      queryClient.invalidateQueries({ queryKey: ['offsite-check'] })
      toast.success('Schedule toggled successfully')
    },
    onError: (error: any) => {
      toast.error(getErrorMessage(error, 'Failed to toggle schedule'))
    },
  })
}

export function useRunScheduleNow() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (id: string) => {
      const response = await schedulesApi.runNow(id)
      return response.data
    },
    onSuccess: (data) => {
      // Invalidate active backups and history so the new job shows up
      // immediately, plus the schedules list (lastFiredAt updates).
      queryClient.invalidateQueries({ queryKey: ['backups', 'active'] })
      queryClient.invalidateQueries({ queryKey: ['backups', 'history'] })
      queryClient.invalidateQueries({ queryKey: ['schedules'] })
      const name = data?.data?.name || 'Schedule'
      toast.success(`${name} triggered`)
    },
    onError: (error: any) => {
      toast.error(getErrorMessage(error, 'Failed to trigger schedule'))
    },
  })
}
