import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { HardDrive, Server, AlertCircle, AlertTriangle, Clock } from 'lucide-react'

// Disk-usage limit above which a pool is considered too full to safely receive
// backups. Kept consistent with the 80% limit used elsewhere in this feature.
const DISK_USAGE_LIMIT = 80

interface RemoteHostMetricsProps {
  metrics: any
  storagePools?: any[]
  showAllDisks?: boolean  // New prop to control filtering
}

export default function RemoteHostMetrics({ metrics, storagePools = [], showAllDisks = true }: RemoteHostMetricsProps) {
  if (!metrics) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="text-center text-gray-500">
            <Clock className="h-8 w-8 mx-auto mb-2" />
            <p className="text-sm">Metrics not available yet</p>
            <p className="text-xs mt-1">Waiting for next collection cycle (every 5 minutes)</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  const isOffline = metrics.status === 'offline'

  // Helper function to get disks to display
  const getDisksToDisplay = () => {
    if (!metrics.disks) {
      return []
    }

    // If showAllDisks is true (Resources page), show all disks without filtering.
    // For offsite hosts the controller now sends per-pool metrics where each
    // disk entry carries its own poolName/poolId, so prefer those and fall back
    // to the mount point for non-offsite (backup host) disks.
    if (showAllDisks) {
      return metrics.disks.map((disk: any) => ({
        ...disk,
        poolName: disk.poolName || disk.mountPoint,
        poolId: disk.poolId
      }))
    }

    // Otherwise (Backup Hosts panel), filter by storage pools
    if (!storagePools || storagePools.length === 0) {
      return []
    }

    // Filter disks to only show those that match storage pool mount points
    return metrics.disks.filter((disk: any) => 
      storagePools.some((pool: any) => 
        pool.mountPoint === disk.mountPoint || pool.offsitePath === disk.mountPoint
      )
    ).map((disk: any) => {
      // Find the matching storage pool to get the name
      const matchingPool = storagePools.find((pool: any) => 
        pool.mountPoint === disk.mountPoint || pool.offsitePath === disk.mountPoint
      )
      return {
        ...disk,
        poolName: matchingPool?.name || disk.mountPoint,
        poolId: matchingPool?.id
      }
    })
  }

  const disksToDisplay = getDisksToDisplay()

  return (
    <Card className={isOffline ? 'border-red-200 bg-red-50' : ''}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <Server className="h-4 w-4" />
            <div className="flex flex-col">
              <span className="font-semibold text-sm">{metrics.name}</span>
              <span className="text-xs text-gray-500">{metrics.ip}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge className={isOffline ? 'bg-red-100 text-red-800' : 'bg-green-100 text-green-800'}>
              {metrics.status}
            </Badge>
            <Badge variant="outline" className="text-xs">
              {new Date(metrics.timestamp).toLocaleTimeString()}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {isOffline ? (
          <div className="text-center py-6">
            <AlertCircle className="h-10 w-10 text-red-600 mx-auto mb-2" />
            <p className="text-red-800 font-medium text-sm">Unable to collect metrics</p>
            {metrics.error && (
              <p className="text-xs text-red-600 mt-1">{metrics.error}</p>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {disksToDisplay.length === 0 ? (
              <div className="text-center py-6 text-gray-400">
                <AlertCircle className="h-8 w-8 mx-auto mb-2" />
                <p className="text-sm font-medium">No disk information available</p>
                <p className="text-xs mt-1">Waiting for metrics collection</p>
              </div>
            ) : (
              disksToDisplay.map((disk: any, index: number) => {
                // A pool at or over the 80% limit is highlighted so operators can
                // immediately spot destinations that are too full (Req 7.4).
                const atLimit = disk.usage >= DISK_USAGE_LIMIT
                return (
                <div
                  key={index}
                  className={`border rounded-lg p-3 ${atLimit ? 'border-red-300 bg-red-50' : ''}`}
                >
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="flex items-start gap-2 min-w-0 flex-1">
                      <HardDrive className="h-4 w-4 text-gray-600 flex-shrink-0 mt-0.5" />
                      <div className="min-w-0">
                        <p className="font-medium text-sm truncate" title={disk.poolName}>{disk.poolName}</p>
                        <p className="text-xs text-gray-500 truncate" title={disk.mountPoint}>{disk.mountPoint}</p>
                        <p className="text-xs text-gray-400 truncate" title={disk.device}>{disk.device}</p>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1 flex-shrink-0">
                      {atLimit && (
                        <Badge className="bg-red-100 text-red-800 flex items-center gap-1 text-xs px-1.5 py-0">
                          <AlertTriangle className="h-3 w-3" />
                          {DISK_USAGE_LIMIT}%+
                        </Badge>
                      )}
                      <Badge className={`text-xs ${
                        disk.usage >= 90 ? 'bg-red-100 text-red-800' :
                        disk.usage >= DISK_USAGE_LIMIT ? 'bg-orange-100 text-orange-800' :
                        disk.usage >= 70 ? 'bg-yellow-100 text-yellow-800' :
                        'bg-green-100 text-green-800'
                      }`}>
                        {disk.usage}%
                      </Badge>
                    </div>
                  </div>
                  
                  {/* Progress bar */}
                  <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden mb-2">
                    <div
                      className={`h-full transition-all duration-300 ${
                        disk.usage >= 90 ? 'bg-red-500' :
                        disk.usage >= DISK_USAGE_LIMIT ? 'bg-orange-500' :
                        disk.usage >= 70 ? 'bg-yellow-500' :
                        'bg-green-500'
                      }`}
                      style={{ width: `${disk.usage}%` }}
                    />
                  </div>
                  
                  <div className="flex justify-between text-xs text-gray-600">
                    <span>{disk.used} GB used</span>
                    <span>{disk.available} GB free</span>
                    <span>{disk.total} GB total</span>
                  </div>
                </div>
                )
              })
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
