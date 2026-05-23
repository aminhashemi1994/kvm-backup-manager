import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { 
  HardDrive, 
  RefreshCw, 
  Trash2, 
  Edit, 
  CheckCircle2, 
  XCircle,
  Loader2 
} from 'lucide-react'
import { StoragePool } from '@/hooks/useStoragePools'
import { useRefreshStoragePool, useDeleteStoragePool } from '@/hooks/useStoragePools'
import { formatBytes } from '@/lib/utils'
import DeleteStoragePoolDialog from './DeleteStoragePoolDialog'
import EditStoragePoolDialog from './EditStoragePoolDialog'

interface StoragePoolCardProps {
  pool: StoragePool
}

export default function StoragePoolCard({ pool }: StoragePoolCardProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [showEditDialog, setShowEditDialog] = useState(false)
  const refreshMutation = useRefreshStoragePool()

  const handleRefresh = () => {
    refreshMutation.mutate(pool.id)
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'online':
        return 'bg-green-100 text-green-800'
      case 'offline':
        return 'bg-red-100 text-red-800'
      default:
        return 'bg-gray-100 text-gray-800'
    }
  }

  const getUsageColor = (percentage: number) => {
    if (percentage >= 90) return 'bg-red-500'
    if (percentage >= 75) return 'bg-yellow-500'
    return 'bg-green-500'
  }

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-blue-100 flex items-center justify-center">
                <HardDrive className="h-5 w-5 text-blue-600" />
              </div>
              <div>
                <CardTitle className="text-lg">{pool.name}</CardTitle>
                <p className="text-sm text-gray-500 font-mono">{pool.path}</p>
              </div>
            </div>
            <Badge className={getStatusColor(pool.status)}>
              {pool.status === 'online' ? (
                <CheckCircle2 className="h-3 w-3 mr-1" />
              ) : (
                <XCircle className="h-3 w-3 mr-1" />
              )}
              {pool.status}
            </Badge>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* Storage Usage */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-600">Storage Usage</span>
              <span className="font-medium">{pool.usedPercentage}%</span>
            </div>
            <Progress 
              value={pool.usedPercentage} 
              className="h-2"
              indicatorClassName={getUsageColor(pool.usedPercentage)}
            />
            <div className="flex items-center justify-between text-xs text-gray-500">
              <span>{formatBytes(pool.usedGB * 1024 * 1024 * 1024)} used</span>
              <span>{formatBytes(pool.availableGB * 1024 * 1024 * 1024)} free</span>
            </div>
          </div>

          {/* Total Capacity */}
          <div className="flex items-center justify-between py-2 border-t">
            <span className="text-sm text-gray-600">Total Capacity</span>
            <span className="text-sm font-medium">
              {formatBytes(pool.totalGB * 1024 * 1024 * 1024)}
            </span>
          </div>

          {/* Mount Point Status */}
          <div className="flex items-center justify-between py-2 border-t">
            <span className="text-sm text-gray-600">Mount Point</span>
            <Badge variant={pool.isMountPoint ? 'default' : 'destructive'}>
              {pool.isMountPoint ? 'Valid' : 'Invalid'}
            </Badge>
          </div>

          {/* Last Checked */}
          <div className="flex items-center justify-between py-2 border-t">
            <span className="text-sm text-gray-600">Last Checked</span>
            <span className="text-sm text-gray-500">
              {new Date(pool.lastChecked).toLocaleString()}
            </span>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 pt-2">
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={handleRefresh}
              disabled={refreshMutation.isPending}
            >
              {refreshMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4 mr-2" />
              )}
              Refresh
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowEditDialog(true)}
            >
              <Edit className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowDeleteDialog(true)}
            >
              <Trash2 className="h-4 w-4 text-red-600" />
            </Button>
          </div>
        </CardContent>
      </Card>

      <DeleteStoragePoolDialog
        pool={pool}
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
      />

      <EditStoragePoolDialog
        pool={pool}
        open={showEditDialog}
        onOpenChange={setShowEditDialog}
      />
    </>
  )
}
