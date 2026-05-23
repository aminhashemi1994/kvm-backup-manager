import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { storagePoolsApi, restoreStoragePoolsApi } from '@/services/api'
import { toast } from 'sonner'

export interface StoragePool {
  id: string
  backupHostId: string
  name: string
  path: string
  totalGB: number
  usedGB: number
  availableGB: number
  usedPercentage: number
  isMountPoint: boolean
  status: 'online' | 'offline'
  lastChecked: string
  createdAt: string
}

export interface RestoreStoragePool {
  id: string
  backupHostId: string
  name: string
  path: string
  mountPoint: string
  device: string
  totalGB: number
  usedGB: number
  availableGB: number
  usagePercent: number
  status: 'active' | 'inactive'
  createdAt: string
  updatedAt: string
}

export function useStoragePools(backupHostId?: string) {
  return useQuery({
    queryKey: backupHostId ? ['storage-pools', backupHostId] : ['storage-pools'],
    queryFn: async () => {
      const response = backupHostId
        ? await storagePoolsApi.getByBackupHost(backupHostId)
        : await storagePoolsApi.getAll()
      return response.data.data as StoragePool[]
    },
    refetchInterval: 10000, // Refresh every 10 seconds
    staleTime: 0, // Always consider data stale
    cacheTime: 0, // Don't cache data
  })
}

export function useStoragePool(id: string) {
  return useQuery({
    queryKey: ['storage-pool', id],
    queryFn: async () => {
      const response = await storagePoolsApi.getOne(id)
      return response.data.data as StoragePool
    },
    enabled: !!id,
  })
}

export function useCreateStoragePool() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: storagePoolsApi.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['storage-pools'] })
      toast.success('Storage pool created successfully')
    },
    onError: (error: any) => {
      const message = error.response?.data?.error || 'Failed to create storage pool'
      toast.error(message)
    },
  })
}

export function useUpdateStoragePool() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: any }) =>
      storagePoolsApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['storage-pools'] })
      toast.success('Storage pool updated successfully')
    },
    onError: (error: any) => {
      const message = error.response?.data?.error || 'Failed to update storage pool'
      toast.error(message)
    },
  })
}

export function useDeleteStoragePool() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: storagePoolsApi.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['storage-pools'] })
      toast.success('Storage pool deleted successfully')
    },
    onError: (error: any) => {
      const message = error.response?.data?.error || 'Failed to delete storage pool'
      toast.error(message)
    },
  })
}

export function useRefreshStoragePool() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: storagePoolsApi.refresh,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['storage-pools'] })
      toast.success('Storage pool refreshed successfully')
    },
    onError: (error: any) => {
      const message = error.response?.data?.error || 'Failed to refresh storage pool'
      toast.error(message)
    },
  })
}

// Restore Storage Pool Hooks
export function useRestoreStoragePools(backupHostId?: string) {
  return useQuery({
    queryKey: backupHostId ? ['restore-storage-pools', backupHostId] : ['restore-storage-pools'],
    queryFn: async () => {
      const response = backupHostId
        ? await restoreStoragePoolsApi.getByBackupHost(backupHostId)
        : await restoreStoragePoolsApi.getAll()
      return response.data.data as RestoreStoragePool[]
    },
    refetchInterval: 10000, // Refresh every 10 seconds
    staleTime: 0, // Always consider data stale
    cacheTime: 0, // Don't cache data
  })
}

export function useRestoreStoragePool(id: string) {
  return useQuery({
    queryKey: ['restore-storage-pool', id],
    queryFn: async () => {
      const response = await restoreStoragePoolsApi.getOne(id)
      return response.data.data as RestoreStoragePool
    },
    enabled: !!id,
  })
}

export function useCreateRestoreStoragePool() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: restoreStoragePoolsApi.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['restore-storage-pools'] })
      toast.success('Restore storage pool created successfully')
    },
    onError: (error: any) => {
      const message = error.response?.data?.error || 'Failed to create restore storage pool'
      toast.error(message)
    },
  })
}

export function useUpdateRestoreStoragePool() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: any }) =>
      restoreStoragePoolsApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['restore-storage-pools'] })
      toast.success('Restore storage pool updated successfully')
    },
    onError: (error: any) => {
      const message = error.response?.data?.error || 'Failed to update restore storage pool'
      toast.error(message)
    },
  })
}

export function useDeleteRestoreStoragePool() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: restoreStoragePoolsApi.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['restore-storage-pools'] })
      toast.success('Restore storage pool deleted successfully')
    },
    onError: (error: any) => {
      const message = error.response?.data?.error || 'Failed to delete restore storage pool'
      toast.error(message)
    },
  })
}

export function useRefreshRestoreStoragePool() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: restoreStoragePoolsApi.refresh,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['restore-storage-pools'] })
      toast.success('Restore storage pool refreshed successfully')
    },
    onError: (error: any) => {
      const message = error.response?.data?.error || 'Failed to refresh restore storage pool'
      toast.error(message)
    },
  })
}
