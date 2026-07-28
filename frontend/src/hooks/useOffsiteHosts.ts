import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { offsiteHostsApi } from '@/services/api'
import { toast } from 'sonner'
import type { OffsiteHost } from '@/types'

export function useOffsiteHosts() {
  return useQuery({
    queryKey: ['offsite-hosts'],
    queryFn: async () => {
      const response = await offsiteHostsApi.getAll()
      return response.data.data as OffsiteHost[]
    },
    refetchInterval: 30000, // Refetch every 30 seconds to show updated health check status
  })
}

export function useOffsiteHostsByBackupHost(backupHostId: string) {
  return useQuery({
    queryKey: ['offsite-hosts', 'backup-host', backupHostId],
    queryFn: async () => {
      const response = await offsiteHostsApi.getByBackupHost(backupHostId)
      return response.data.data as OffsiteHost[]
    },
    enabled: !!backupHostId,
    refetchInterval: 30000, // Refetch every 30 seconds to show updated health check status
  })
}

export function useCreateOffsiteHost() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (data: any) => {
      const response = await offsiteHostsApi.create(data)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['offsite-hosts'] })
      toast.success('Offsite host added successfully')
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || 'Failed to add offsite host')
    },
  })
}

export function useDeleteOffsiteHost() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (id: string) => {
      const response = await offsiteHostsApi.delete(id)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['offsite-hosts'] })
      toast.success('Offsite host deleted successfully')
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || 'Failed to delete offsite host')
    },
  })
}

export function useUpdateOffsiteHost() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      const response = await offsiteHostsApi.update(id, data)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['offsite-hosts'] })
      toast.success('Offsite host updated successfully')
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || 'Failed to update offsite host')
    },
  })
}

export function useTestOffsiteHost() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (id: string) => {
      const response = await offsiteHostsApi.test(id)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['offsite-hosts'] })
      toast.success('Connection test completed')
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || 'Connection test failed')
    },
  })
}

// ---------------------------------------------------------------------------
// Offsite host storage pool CRUD
//
// Pools live inside each offsite host record (`storagePools` array), so every
// mutation invalidates the ['offsite-hosts'] query to refresh the embedded
// pools and their usage snapshots.
// ---------------------------------------------------------------------------

export function useCreateOffsitePool() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      hostId,
      data,
    }: {
      hostId: string
      data: { name: string; path: string; diskUsageThreshold?: number }
    }) => {
      const response = await offsiteHostsApi.createPool(hostId, data)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['offsite-hosts'] })
      toast.success('Storage pool added successfully')
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || 'Failed to add storage pool')
    },
  })
}

export function useUpdateOffsitePool() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      hostId,
      poolId,
      data,
    }: {
      hostId: string
      poolId: string
      data: { name?: string; path?: string; diskUsageThreshold?: number }
    }) => {
      const response = await offsiteHostsApi.updatePool(hostId, poolId, data)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['offsite-hosts'] })
      toast.success('Storage pool updated successfully')
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || 'Failed to update storage pool')
    },
  })
}

export function useDeleteOffsitePool() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ hostId, poolId }: { hostId: string; poolId: string }) => {
      const response = await offsiteHostsApi.deletePool(hostId, poolId)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['offsite-hosts'] })
      toast.success('Storage pool deleted successfully')
    },
    onError: (error: any) => {
      // Surfaces the 409 message when a schedule still references the pool.
      toast.error(error.response?.data?.error || 'Failed to delete storage pool')
    },
  })
}

export function useValidateOffsitePool() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ hostId, poolId }: { hostId: string; poolId: string }) => {
      const response = await offsiteHostsApi.validatePool(hostId, poolId)
      return response.data
    },
    onSuccess: (result: any) => {
      queryClient.invalidateQueries({ queryKey: ['offsite-hosts'] })
      if (result?.success) {
        toast.success('Storage pool validated successfully')
      } else {
        const reason = result?.validation?.reason || 'Validation failed'
        toast.error(`Storage pool validation failed: ${reason}`)
      }
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || 'Failed to validate storage pool')
    },
  })
}
