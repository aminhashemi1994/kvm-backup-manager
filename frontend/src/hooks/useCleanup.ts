import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { cleanupApi } from '@/services/api'
import { toast } from 'sonner'

export interface CleanupFile {
  path: string
  name: string
  size: number
  age: number
  type: 'progress' | 'log' | 'lock' | 'temp'
}

export interface AgentCleanupData {
  agentId: string
  agentName: string
  agentUrl: string
  progressFiles: CleanupFile[]
  logFiles: CleanupFile[]
  lockFiles: CleanupFile[]
  tempFiles: CleanupFile[]
  totalCount: number
  totalSize: number
}

export interface CleanupScanResult {
  agents: AgentCleanupData[]
  totalFiles: number
  totalSize: number
  errors: Array<{
    agentId: string
    agentName: string
    error: string
  }>
  controllerJobs?: {
    count: number
    jobs: Array<{
      id: string
      vmName: string
      status: string
      startTime: string
    }>
  }
}

// Scan for cleanable files
export function useCleanupScan(olderThanHours: number = 6) {
  return useQuery({
    queryKey: ['cleanup', 'scan', olderThanHours],
    queryFn: async () => {
      const response = await cleanupApi.scan(olderThanHours)
      return response.data.data as CleanupScanResult
    },
    enabled: false, // Manual trigger only
    staleTime: 0, // Always fetch fresh data
  })
}

// Execute cleanup on agent
export function useExecuteCleanup() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ agentId, files }: { agentId: string; files: string[] }) => {
      const response = await cleanupApi.execute(agentId, files)
      return response.data
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['cleanup'] })
      toast.success(`Deleted ${data.data.totalDeleted} files (${formatBytes(data.data.totalSize)})`)
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || 'Failed to execute cleanup')
    },
  })
}

// Clean up controller jobs
export function useCleanupControllerJobs() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (olderThanHours: number = 24) => {
      const response = await cleanupApi.cleanupControllerJobs(olderThanHours)
      return response.data
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['cleanup'] })
      queryClient.invalidateQueries({ queryKey: ['restores'] })
      toast.success(`Deleted ${data.data.deletedCount} old restore jobs`)
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || 'Failed to cleanup controller jobs')
    },
  })
}

// Get cleanup stats
export function useCleanupStats() {
  return useQuery({
    queryKey: ['cleanup', 'stats'],
    queryFn: async () => {
      const response = await cleanupApi.getStats()
      return response.data.data
    },
    refetchInterval: 30000, // Refresh every 30 seconds
  })
}

// Helper function
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}
