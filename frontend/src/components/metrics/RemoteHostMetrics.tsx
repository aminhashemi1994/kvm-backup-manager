import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { HardDrive, Server, AlertCircle, Clock } from 'lucide-react'

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

    // If showAllDisks is true (Resources page), show all disks without filtering
    if (showAllDisks) {
      return metrics.disks.map((disk: any) => ({
        ...disk,
        poolName: disk.mountPoint
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
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Server className="h-5 w-5" />
            <span>{metrics.name}</span>
            <span className="text-sm text-gray-500">({metrics.ip})</span>
          </div>
          <div className="flex items-center space-x-2">
            <Badge className={isOffline ? 'bg-red-100 text-red-800' : 'bg-green-100 text-green-800'}>
              {metrics.status}
            </Badge>
            <Badge variant="outline" className="text-xs">
              {new Date(metrics.timestamp).toLocaleTimeString()}
            </Badge>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isOffline ? (
          <div className="text-center py-8">
            <AlertCircle className="h-12 w-12 text-red-600 mx-auto mb-2" />
            <p className="text-red-800 font-medium">Unable to collect metrics</p>
            {metrics.error && (
              <p className="text-sm text-red-600 mt-1">{metrics.error}</p>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {disksToDisplay.length === 0 ? (
              <div className="text-center py-8 text-gray-400">
                <AlertCircle className="h-8 w-8 mx-auto mb-2" />
                <p className="text-sm font-medium">No disk information available</p>
                <p className="text-xs mt-1">Waiting for metrics collection</p>
              </div>
            ) : (
              disksToDisplay.map((disk: any, index: number) => (
                <div key={index} className="border rounded-lg p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center space-x-2">
                      <HardDrive className="h-4 w-4 text-gray-600" />
                      <div>
                        <p className="font-medium">{disk.poolName}</p>
                        <p className="text-sm text-gray-500">{disk.mountPoint}</p>
                        <p className="text-xs text-gray-400">{disk.device}</p>
                      </div>
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
                    <span>Used: {disk.used} GB</span>
                    <span>Available: {disk.available} GB</span>
                    <span>Total: {disk.total} GB</span>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
