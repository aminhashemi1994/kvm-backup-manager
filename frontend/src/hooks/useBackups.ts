import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { backupsApi, schedulesApi } from '@/services/api'
import { toast } from 'sonner'
import type { BackupJob, BackupSchedule, BackupStats } from '@/types'

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

export function useBackupHistory(params?: any) {
  return useQuery({
    queryKey: ['backups', 'history', params],
    queryFn: async () => {
      const response = await backupsApi.getHistory(params)
      return response.data.data as BackupJob[]
    },
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
      toast.error(error.response?.data?.error || 'Failed to trigger backup')
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
      toast.error(error.response?.data?.error || 'Failed to cancel backup job')
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
      toast.error(error.response?.data?.error || 'Failed to remove job')
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['backups'] })
      toast.success('Backup retry initiated')
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || 'Failed to retry backup')
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
      toast.success('Schedule created successfully')
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || 'Failed to create schedule')
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
      toast.success('Schedule updated successfully')
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || 'Failed to update schedule')
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
      toast.success('Schedule deleted successfully')
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || 'Failed to delete schedule')
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
      toast.success('Schedule toggled successfully')
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || 'Failed to toggle schedule')
    },
  })
}
