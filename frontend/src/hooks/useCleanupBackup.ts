import { useMutation, useQueryClient } from '@tanstack/react-query'
import { cleanupBackupApi } from '@/services/api'
import { toast } from 'sonner'

interface CleanupBackupParams {
  vmId: string
  vmName: string
  backupHostId: string
}

export function useCleanupBackup() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (params: CleanupBackupParams) => {
      const response = await cleanupBackupApi.cleanupBackup(params)
      return response.data
    },
    onSuccess: (data, variables) => {
      // Use the message from the API response
      const message = data.message || `Backup cleanup completed successfully for ${variables.vmName}`
      toast.success(message)
      // Invalidate relevant queries
      queryClient.invalidateQueries({ queryKey: ['vms'] })
      queryClient.invalidateQueries({ queryKey: ['hypervisors'] })
    },
    onError: (error: any, variables) => {
      const message = error.response?.data?.error || error.message || 'Failed to cleanup backup'
      const details = error.response?.data?.message || ''
      const fullMessage = details ? `${message}\n${details}` : message
      toast.error(`Cleanup backup failed for ${variables.vmName}: ${fullMessage}`)
    },
  })
}
