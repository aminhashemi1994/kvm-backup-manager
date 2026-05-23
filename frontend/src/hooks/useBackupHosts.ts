import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { backupHostsApi, hypervisorsApi, vmsApi } from '@/services/api'
import { toast } from 'sonner'
import type { BackupHost, Hypervisor, VirtualMachine } from '@/types'

// Backup Hosts
export function useBackupHosts() {
  return useQuery({
    queryKey: ['backup-hosts'],
    queryFn: async () => {
      const response = await backupHostsApi.getAll()
      return response.data.data as BackupHost[]
    },
    refetchInterval: 30000, // Refetch every 30 seconds to show updated health check status
  })
}

export function useBackupHost(id: string) {
  return useQuery({
    queryKey: ['backup-hosts', id],
    queryFn: async () => {
      const response = await backupHostsApi.getOne(id)
      return response.data.data as BackupHost
    },
    enabled: !!id,
  })
}

export function useCreateBackupHost() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (data: any) => {
      const response = await backupHostsApi.create(data)
      return response.data
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['backup-hosts'] })
      if (data.data?.status === 'online') {
        toast.success('Backup host added successfully')
      } else {
        toast.warning('Backup host added but is offline')
      }
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || 'Failed to add backup host')
    },
  })
}

export function useDeleteBackupHost() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (id: string) => {
      const response = await backupHostsApi.delete(id)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['backup-hosts'] })
      toast.success('Backup host deleted successfully')
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || 'Failed to delete backup host')
    },
  })
}

export function useUpdateBackupHost() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      const response = await backupHostsApi.update(id, data)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['backup-hosts'] })
      toast.success('Backup host updated successfully')
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || 'Failed to update backup host')
    },
  })
}

export function useHealthCheckBackupHost() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (id: string) => {
      const response = await backupHostsApi.healthCheck(id)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['backup-hosts'] })
      toast.success('Health check completed')
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || 'Health check failed')
    },
  })
}

// Hypervisors
export function useHypervisorsByBackupHost(backupHostId: string) {
  return useQuery({
    queryKey: ['hypervisors', 'backup-host', backupHostId],
    queryFn: async () => {
      const response = await hypervisorsApi.getByBackupHost(backupHostId)
      return response.data.data as Hypervisor[]
    },
    enabled: !!backupHostId,
    refetchInterval: 30000, // Refetch every 30 seconds to show updated health check status
  })
}

export function useCreateHypervisor() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (data: any) => {
      const response = await hypervisorsApi.create(data)
      return response.data
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['hypervisors'] })
      queryClient.invalidateQueries({ queryKey: ['backup-hosts'] })
      queryClient.invalidateQueries({ queryKey: ['vms'] })
      
      if (data.data?.status === 'connected') {
        toast.success(`Hypervisor added successfully - ${data.data.vmCount || 0} VMs found`)
      } else {
        toast.warning(data.message || 'Hypervisor added but connection failed')
      }
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || 'Failed to add hypervisor')
    },
  })
}

export function useDeleteHypervisor() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (id: string) => {
      const response = await hypervisorsApi.delete(id)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['hypervisors'] })
      queryClient.invalidateQueries({ queryKey: ['backup-hosts'] })
      queryClient.invalidateQueries({ queryKey: ['vms'] })
      toast.success('Hypervisor deleted successfully')
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || 'Failed to delete hypervisor')
    },
  })
}

export function useUpdateHypervisor() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      const response = await hypervisorsApi.update(id, data)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['hypervisors'] })
      queryClient.invalidateQueries({ queryKey: ['backup-hosts'] })
      toast.success('Hypervisor updated successfully')
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || 'Failed to update hypervisor')
    },
  })
}

export function useRefreshVMs() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (hypervisorId: string) => {
      const response = await hypervisorsApi.refreshVMs(hypervisorId)
      return response.data
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['vms'] })
      queryClient.invalidateQueries({ queryKey: ['hypervisors'] })
      toast.success(`VMs refreshed - ${data.data?.length || 0} VMs found`)
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || 'Failed to refresh VMs')
    },
  })
}

// VMs
export function useVMsByHypervisor(hypervisorId: string) {
  return useQuery({
    queryKey: ['vms', 'hypervisor', hypervisorId],
    queryFn: async () => {
      const response = await vmsApi.getByHypervisor(hypervisorId)
      return response.data.data as VirtualMachine[]
    },
    enabled: !!hypervisorId,
  })
}

export function useUpdateVM() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      const response = await vmsApi.update(id, data)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vms'] })
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || 'Failed to update VM')
    },
  })
}

export function useAllVMs() {
  return useQuery({
    queryKey: ['vms'],
    queryFn: async () => {
      const response = await vmsApi.getAll()
      return response.data.data as VirtualMachine[]
    },
  })
}

export function useSelectedVMs() {
  return useQuery({
    queryKey: ['vms', 'selected'],
    queryFn: async () => {
      const response = await vmsApi.getSelected()
      return response.data.data as VirtualMachine[]
    },
  })
}

export function useVMById(id: string) {
  return useQuery({
    queryKey: ['vms', id],
    queryFn: async () => {
      const response = await vmsApi.getOne(id)
      return response.data.data as VirtualMachine
    },
    enabled: !!id,
  })
}

export function useSelectMultipleVMs() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ vmIds, selected }: { vmIds: string[]; selected: boolean }) => {
      const response = await vmsApi.selectMultiple(vmIds, selected)
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vms'] })
      toast.success('VM selection updated')
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || 'Failed to update VM selection')
    },
  })
}
