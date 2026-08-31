import { useMutation, useQueryClient } from '@tanstack/react-query'
import { backupStatusApi } from '@/services/api'
import { toast } from 'sonner'
import { getErrorMessage } from '@/lib/errors'

interface ClearInProgressParams {
  vmId: string
  vmName: string
  scheduleType: string
  storagePoolId?: string
  schedulePath?: string
}

/**
 * Force-clear a stuck "in progress" state (stale lock/progress files left by
 * a failed backup). The backend refuses when the backup is genuinely running.
 */
export function useClearInProgress() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (params: ClearInProgressParams) => {
      const { vmName, ...payload } = params
      const response = await backupStatusApi.clearInProgress(payload)
      return response.data
    },
    onSuccess: (data, variables) => {
      const message = data.message || `Cleared in-progress state for ${variables.vmName}`
      toast.success(message)
      // Refresh report + backup views so the "In Progress" badge disappears
      queryClient.invalidateQueries({ queryKey: ['backup-report'] })
      queryClient.invalidateQueries({ queryKey: ['backup-report-status'] })
      queryClient.invalidateQueries({ queryKey: ['backups'] })
      queryClient.invalidateQueries({ queryKey: ['vms'] })
    },
    onError: (error: any, variables) => {
      const message = getErrorMessage(error, 'Failed to clear in-progress state')
      toast.error(`Clear in-progress failed for ${variables.vmName}: ${message}`)
    },
  })
}
