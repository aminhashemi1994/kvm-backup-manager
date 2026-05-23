import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { backupRemovalApi } from '@/services/api'
import { toast } from 'sonner'

// List all VMs (quick)
export function useVMList(backupHostId: string) {
  return useQuery({
    queryKey: ['backup-removal-vms', backupHostId],
    queryFn: async () => {
      const response = await backupRemovalApi.listVMs(backupHostId)
      return response.data.data
    },
    enabled: !!backupHostId,
  })
}

// Get detailed backup info for a specific VM (slow, runs Backup_Reporter.sh)
export function useVMDetails(backupHostId: string, vmName: string) {
  return useQuery({
    queryKey: ['backup-removal-details', backupHostId, vmName],
    queryFn: async () => {
      const response = await backupRemovalApi.getVMDetails(backupHostId, vmName)
      return response.data.data
    },
    enabled: !!backupHostId && !!vmName,
    staleTime: 0, // Always fetch fresh data
    gcTime: 0, // Don't cache
    // Don't keep old data - show loading state instead
  })
}

export function useRemoveScheduleBackup() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ backupHostId, vmName, scheduleType }: { 
      backupHostId: string
      vmName: string
      scheduleType: string
    }) => {
      const response = await backupRemovalApi.removeSchedule(backupHostId, vmName, scheduleType)
      return response.data
    },
    onSuccess: (_data, variables) => {
      toast.success(`Successfully removed ${variables.scheduleType} backup for ${variables.vmName}`)
      // Invalidate the VM details to trigger refresh
      queryClient.invalidateQueries({ 
        queryKey: ['backup-removal-details', variables.backupHostId, variables.vmName] 
      })
    },
    onError: (error: any, variables) => {
      const message = error.response?.data?.error || error.message || 'Failed to remove backup'
      toast.error(`Failed to remove ${variables.scheduleType} backup: ${message}`)
    },
  })
}

export function useRemoveVMBackup() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ backupHostId, vmName }: { 
      backupHostId: string
      vmName: string
    }) => {
      const response = await backupRemovalApi.removeVM(backupHostId, vmName)
      return response.data
    },
    onSuccess: (_data, variables) => {
      toast.success(`Successfully removed all backups for ${variables.vmName}`)
      // Invalidate both VM list and details
      queryClient.invalidateQueries({ 
        queryKey: ['backup-removal-vms', variables.backupHostId] 
      })
      queryClient.invalidateQueries({ 
        queryKey: ['backup-removal-details', variables.backupHostId, variables.vmName] 
      })
    },
    onError: (error: any, variables) => {
      const message = error.response?.data?.error || error.message || 'Failed to remove VM backup'
      toast.error(`Failed to remove VM backup: ${message}`)
    },
  })
}
