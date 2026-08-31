import { useMutation, useQueryClient } from '@tanstack/react-query'
import { fixBackupApi } from '@/services/api'
import { toast } from 'sonner'
import { getErrorMessage } from '@/lib/errors'

interface FixBackupParams {
  vmId: string
  vmName: string
  hypervisorIp: string
  backupHostId: string
}

export function useFixBackup() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (params: FixBackupParams) => {
      const response = await fixBackupApi.fixBackup(params)
      return response.data
    },
    onSuccess: (data, variables) => {
      toast.success(`Backup fix completed successfully for ${variables.vmName}`)
      // Invalidate relevant queries
      queryClient.invalidateQueries({ queryKey: ['vms'] })
      queryClient.invalidateQueries({ queryKey: ['hypervisors'] })
    },
    onError: (error: any, variables) => {
      const message = getErrorMessage(error, 'Failed to fix backup')
      toast.error(`Fix backup failed for ${variables.vmName}: ${message}`)
    },
  })
}
