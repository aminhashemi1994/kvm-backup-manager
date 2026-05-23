import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { offsiteHostsApi } from '@/services/api'
import { toast } from 'sonner'
import type { OffsiteHost } from '@/types'

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
