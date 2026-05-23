import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { restoreApi } from '@/services/api'
import { toast } from 'sonner'

export interface RestoreJob {
  id: string
  vmName: string
  method: string
  agentName: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  progress: number
  progressText: string
  startTime: string
  endTime: string | null
  error: string | null
  backupPath: string
  restorePath: string
}

// Active Restores
export function useActiveRestores() {
  return useQuery({
    queryKey: ['restores', 'active'],
    queryFn: async () => {
      const response = await restoreApi.getJobs()
      // Filter only active jobs (running or queued)
      const jobs = response.data.data as RestoreJob[]
      return jobs.filter(job => job.status === 'running' || job.status === 'queued')
    },
    refetchInterval: 5000,
    retry: 2, // Retry twice on failure
    retryDelay: 1000,
    throwOnError: false, // Don't throw errors
    // Keep previous data on error
    placeholderData: (previousData) => previousData,
  })
}

// Restore History
export function useRestoreHistory(params?: any) {
  return useQuery({
    queryKey: ['restores', 'history', params],
    queryFn: async () => {
      const response = await restoreApi.getHistory()
      return response.data.data as RestoreJob[]
    },
  })
}

// Single Restore Job
export function useRestoreJob(id: string) {
  return useQuery({
    queryKey: ['restores', 'job', id],
    queryFn: async () => {
      const response = await restoreApi.getStatus(id)
      return response.data.data as RestoreJob
    },
    enabled: !!id,
    refetchInterval: (data) => {
      if (data?.status === 'completed' || data?.status === 'failed') {
        return false
      }
      return 3000
    },
    retry: 2, // Retry twice on failure
    retryDelay: 1000,
    throwOnError: false, // Don't throw errors, return undefined instead
  })
}

// Restore Job Logs
export function useRestoreJobLogs(id: string) {
  return useQuery({
    queryKey: ['restores', 'logs', id],
    queryFn: async () => {
      const response = await restoreApi.getLogs(id)
      return response.data.data.logs as string
    },
    enabled: !!id,
    retry: 1, // Only retry once
    retryDelay: 1000,
    // Return empty string on error instead of throwing
    throwOnError: false,
  })
}

// Trigger Restore
export function useTriggerRestore() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (data: any) => {
      const response = await restoreApi.trigger(data)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['restores'] })
      toast.success('Restore started successfully')
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || 'Failed to start restore')
    },
  })
}

// Kill Restore Job
export function useKillRestoreJob() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (jobId: string) => {
      const response = await restoreApi.killJob(jobId)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['restores'] })
      toast.success('Restore job cancelled')
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || 'Failed to cancel restore job')
    },
  })
}
