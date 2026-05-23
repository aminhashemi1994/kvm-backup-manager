import { useQuery } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { RefreshCw, HardDrive, AlertCircle, Plus } from 'lucide-react'
import { metricsApi, storagePoolsApi } from '@/services/api'
import { useNavigate } from 'react-router-dom'
import Gauge from './Gauge'

interface MetricsCardProps {
  backupHostId: string
  backupHostName: string
  compact?: boolean
}

export default function MetricsCard({ backupHostId, backupHostName, compact = false }: MetricsCardProps) {
  const navigate = useNavigate()
  
  const { data: metrics, isLoading, error } = useQuery({
    queryKey: ['metrics', backupHostId],
    queryFn: async () => {
      const response = await metricsApi.getMetrics(backupHostId)
      return response.data
    },
    refetchInterval: 10000, // Refresh every 10 seconds
    retry: 2,
    staleTime: 0, // Always consider data stale
    cacheTime: 0, // Don't cache data
  })

  // Load storage pools for this backup host
  const { data: storagePools, isLoading: poolsLoading } = useQuery({
    queryKey: ['storage-pools', backupHostId],
    queryFn: async () => {
      const response = await storagePoolsApi.getByBackupHost(backupHostId)
      return response.data.data || []
    },
    refetchInterval: 10000, // Refresh every 10 seconds
    staleTime: 0, // Always consider data stale
    cacheTime: 0, // Don't cache data
  })

  if (isLoading || poolsLoading) {
    return (
      <Card>
        <CardContent className="py-12">
          <div className="text-center">
            <RefreshCw className="h-8 w-8 animate-spin text-blue-600 mx-auto mb-2" />
            <p className="text-sm text-gray-600">Loading metrics...</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (error || !metrics?.data) {
    return (
      <Card>
        <CardContent className="py-12">
          <div className="text-center">
            <AlertCircle className="h-8 w-8 text-red-600 mx-auto mb-2" />
            <p className="text-sm text-gray-600">Failed to load metrics</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  const { cpu, memory, disks, backupDisk } = metrics.data

  // Determine which disks to show
  const disksToShow = storagePools && storagePools.length > 0
    ? storagePools.map(pool => {
        // Find matching disk from metrics
        const matchingDisk = disks.find((d: any) => d.mountPoint === pool.path)
        return {
          id: pool.id,
          name: pool.name,
          mountPoint: pool.path,
          device: matchingDisk?.device || 'N/A',
          totalGB: pool.totalGB || matchingDisk?.totalGB || 0,
          usedGB: pool.usedGB || matchingDisk?.usedGB || 0,
          availableGB: pool.availableGB || matchingDisk?.availableGB || 0,
          usage: pool.usedPercentage || matchingDisk?.usage || 0,
          isStoragePool: true,
        }
      })
    : [] // Don't show any disks if no storage pools defined

  // Calculate average usage for compact view
  const averageUsage = disksToShow.length > 0
    ? disksToShow.reduce((sum, disk) => sum + disk.usage, 0) / disksToShow.length
    : 0

  if (compact) {
    return (
      <div className="grid grid-cols-3 gap-4">
        <Gauge value={cpu.usage} label="CPU" size={120} />
        <Gauge value={memory.usage} label="Memory" size={120} />
        <Gauge 
          value={averageUsage} 
          label="Storage Pools" 
          size={120}
        />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* System Metrics */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>System Resources - {backupHostName}</span>
            <Badge variant="outline" className="text-xs">
              Updated: {new Date(metrics.data.timestamp).toLocaleTimeString()}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {/* CPU */}
            <div className="flex flex-col items-center">
              <Gauge value={cpu.usage} label="CPU Usage" />
              <div className="mt-4 text-center text-sm text-gray-600">
                <p>{cpu.cores} cores</p>
                <p className="text-xs truncate max-w-[200px]">{cpu.model}</p>
              </div>
            </div>

            {/* Memory */}
            <div className="flex flex-col items-center">
              <Gauge value={memory.usage} label="Memory Usage" />
              <div className="mt-4 text-center text-sm text-gray-600">
                <p>{memory.usedGB} GB / {memory.totalGB} GB</p>
                <p className="text-xs">{memory.freeGB} GB free</p>
              </div>
            </div>

            {/* Storage Pools Average */}
            <div className="flex flex-col items-center">
              <Gauge 
                value={averageUsage} 
                label="Storage Pools" 
              />
              <div className="mt-4 text-center text-sm text-gray-600">
                {disksToShow.length > 0 ? (
                  <>
                    <p>{disksToShow.length} pool{disksToShow.length !== 1 ? 's' : ''}</p>
                    <p className="text-xs">Average usage</p>
                  </>
                ) : (
                  <p className="text-xs text-red-600">No storage pools</p>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Storage Pool Details */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center space-x-2">
            <HardDrive className="h-5 w-5" />
            <span>Storage Pool Usage</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {disksToShow.length === 0 ? (
            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertDescription className="space-y-3">
                <p>
                  <strong>No storage pools defined for this backup host.</strong>
                </p>
                <p className="text-sm">
                  Storage pools are required to manage backup storage locations. 
                  Create at least one storage pool to start using the backup system.
                </p>
                <Button
                  size="sm"
                  onClick={() => navigate('/storage-pools')}
                  className="mt-2"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Create Storage Pool
                </Button>
              </AlertDescription>
            </Alert>
          ) : (
            <div className="space-y-4">
              {disksToShow.map((disk: any) => (
                <div key={disk.id} className="border rounded-lg p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <p className="font-medium">{disk.name}</p>
                      <p className="text-sm text-gray-500">{disk.mountPoint}</p>
                      {disk.device !== 'N/A' && (
                        <p className="text-xs text-gray-400">{disk.device}</p>
                      )}
                    </div>
                    <Badge className={
                      disk.usage >= 90 ? 'bg-red-100 text-red-800' :
                      disk.usage >= 70 ? 'bg-yellow-100 text-yellow-800' :
                      'bg-green-100 text-green-800'
                    }>
                      {disk.usage}%
                    </Badge>
                  </div>
                  
                  {/* Progress bar */}
                  <div className="w-full bg-gray-200 rounded-full h-3 overflow-hidden">
                    <div
                      className={`h-full transition-all duration-500 ${
                        disk.usage >= 90 ? 'bg-red-500' :
                        disk.usage >= 70 ? 'bg-yellow-500' :
                        'bg-green-500'
                      }`}
                      style={{ width: `${disk.usage}%` }}
                    />
                  </div>
                  
                  <div className="flex justify-between text-sm text-gray-600 mt-2">
                    <span>Used: {disk.usedGB} GB</span>
                    <span>Available: {disk.availableGB} GB</span>
                    <span>Total: {disk.totalGB} GB</span>
                  </div>
                </div>
              ))}
              
              {disksToShow.length > 1 && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm">
                  <p className="font-medium text-blue-900">
                    Average Usage: {averageUsage.toFixed(1)}%
                  </p>
                  <p className="text-blue-700 text-xs mt-1">
                    Across {disksToShow.length} storage pools
                  </p>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
