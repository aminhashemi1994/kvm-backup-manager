import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Plus, Trash2, RefreshCw, Cloud, Loader2, Settings, Edit, ChevronDown, ChevronUp, AlertCircle, Clock } from 'lucide-react'
import { useOffsiteHostsByBackupHost, useDeleteOffsiteHost, useTestOffsiteHost } from '@/hooks/useOffsiteHosts'
import EditOffsiteHostDialog from './EditOffsiteHostDialog'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { offsiteHostsApi, metricsApi, storagePoolsApi } from '@/services/api'
import { toast } from 'sonner'
import { getStatusColor } from '@/lib/utils'
import { useInitOffsiteHost } from '@/hooks/useInit'
import { useConfirm } from '@/components/ui/confirm-dialog'

interface OffsiteHostManagerProps {
  backupHostId: string
  backupHostName: string
}

export default function OffsiteHostManager({ backupHostId, backupHostName }: OffsiteHostManagerProps) {
  const [expanded, setExpanded] = useState(false)
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [editingHost, setEditingHost] = useState<any>(null)
  const [formData, setFormData] = useState({
    name: '',
    ip: '',
    username: 'root',
  })

  const queryClient = useQueryClient()
  const initOffsiteHost = useInitOffsiteHost()
  
  const { data: offsiteHosts, isLoading } = useOffsiteHostsByBackupHost(backupHostId)
  const deleteHost = useDeleteOffsiteHost()
  const testHost = useTestOffsiteHost()
  const confirm = useConfirm()

  const handleDeleteOffsite = async (id: string, name: string) => {
    const ok = await confirm({
      title: 'Delete offsite host?',
      description: `Are you sure you want to delete the offsite host "${name}"?`,
      confirmText: 'Delete',
      variant: 'danger',
    })
    if (ok) deleteHost.mutate(id)
  }

  const handleInitOffsite = async (id: string, name: string) => {
    const ok = await confirm({
      title: 'Initialize offsite host?',
      description: `Install the required dependencies on "${name}".`,
      confirmText: 'Initialize',
    })
    if (ok) initOffsiteHost.mutate(id)
  }

  // Fetch offsite metrics
  const { data: offsiteMetrics } = useQuery({
    queryKey: ['offsite-metrics'],
    queryFn: async () => {
      const response = await metricsApi.getAllOffsiteMetrics()
      return response.data
    },
    refetchInterval: 5 * 60 * 1000, // Refetch every 5 minutes
  })

  // Fetch storage pools for this backup host
  const { data: storagePools } = useQuery({
    queryKey: ['storage-pools', backupHostId],
    queryFn: async () => {
      const response = await storagePoolsApi.getByBackupHost(backupHostId)
      return response.data.data || []
    },
  })

  // Helper function to get storage pool disks for an offsite host
  const getStoragePoolDisks = (offsiteMetrics: any) => {
    if (!offsiteMetrics?.disks) {
      return []
    }

    // The backend now returns disks with pool information already attached
    // Just return them directly
    return offsiteMetrics.disks.map((disk: any) => ({
      ...disk,
      poolName: disk.poolName || disk.mountPoint,
      poolId: disk.poolId
    }))
  }

  const createHost = useMutation({
    mutationFn: async (data: any) => {
      const response = await offsiteHostsApi.create({ ...data, backupHostId })
      return response.data
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['offsite-hosts'] })
      if (data.data?.status === 'connected') {
        toast.success('Offsite host added successfully')
      } else {
        toast.warning('Offsite host added but connection test failed')
      }
      setShowAddDialog(false)
      setFormData({ name: '', ip: '', username: 'root' })
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.error || 'Failed to add offsite host')
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    createHost.mutate(formData)
  }

  return (
    <>
      <Card className="mt-4 border-dashed">
        <CardHeader className="py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <Cloud className="h-4 w-4 text-blue-500" />
              <CardTitle className="text-sm">Offsite Hosts for {backupHostName}</CardTitle>
              <Badge variant="outline" className="ml-2">
                {offsiteHosts?.length || 0}
              </Badge>
            </div>
            <div className="flex items-center space-x-2">
              <Button size="sm" variant="outline" onClick={() => setShowAddDialog(true)}>
                <Plus className="h-3 w-3 mr-1" />
                Add Offsite
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setExpanded(!expanded)}
              >
                {expanded ? (
                  <ChevronUp className="h-4 w-4" />
                ) : (
                  <ChevronDown className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>
        </CardHeader>
        {expanded && (
          <CardContent className="py-2">
            <div className="mb-2 p-2 bg-blue-50 border border-blue-200 rounded text-xs text-blue-700">
              <strong>Note:</strong> SSH keys and paths are configured manually on the backup host server.
              Offsite sync is handled by backup_manager.sh script.
            </div>
            {isLoading ? (
              <p className="text-xs text-gray-500">Loading...</p>
            ) : offsiteHosts && offsiteHosts.length > 0 ? (
              <div className="space-y-4">
                {offsiteHosts.map((host: any) => {
                  // Find metrics for this offsite host
                  const metrics = offsiteMetrics?.data?.find((m: any) => m.id === host.id)
                  const isOffline = metrics?.status === 'offline' || !metrics
                  
                  // Get only storage pool disks
                  const storagePoolDisks = metrics ? getStoragePoolDisks(metrics) : []
                  
                  return (
                    <Card key={host.id} className="border">
                      <CardContent className="p-4">
                        {/* Host Header */}
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center space-x-3">
                            <Cloud className="h-5 w-5 text-blue-500" />
                            <div>
                              <p className="text-sm font-semibold">{host.name}</p>
                              <p className="text-xs text-gray-500 font-mono">
                                {host.username || 'root'}@{host.ip}
                              </p>
                            </div>
                            <Badge className={getStatusColor(host.status)} variant="outline">
                              {host.status}
                            </Badge>
                          </div>
                          <div className="flex items-center space-x-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setEditingHost(host)}
                              title="Edit offsite host"
                            >
                              <Edit className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleInitOffsite(host.id, host.name)}
                              disabled={initOffsiteHost.isPending}
                              title="Initialize with dependencies"
                            >
                              <Settings className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => testHost.mutate(host.id)}
                              disabled={testHost.isPending}
                              title="Test connection (ping)"
                            >
                              <RefreshCw className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleDeleteOffsite(host.id, host.name)}
                              disabled={deleteHost.isPending}
                            >
                              <Trash2 className="h-4 w-4 text-red-500" />
                            </Button>
                          </div>
                        </div>

                        {/* Storage Pool Metrics */}
                        <div className="bg-gray-50 rounded-lg p-4">
                          {!metrics ? (
                            <div className="text-center py-6 text-gray-400">
                              <Clock className="h-8 w-8 mx-auto mb-2" />
                              <p className="text-sm font-medium">Metrics not available yet</p>
                              <p className="text-xs">Updates every 5 minutes</p>
                            </div>
                          ) : isOffline ? (
                            <div className="text-center py-6 text-red-500">
                              <AlertCircle className="h-8 w-8 mx-auto mb-2" />
                              <p className="text-sm font-semibold">Unable to collect metrics</p>
                              {metrics.error && (
                                <p className="text-xs mt-1">{metrics.error}</p>
                              )}
                            </div>
                          ) : storagePoolDisks.length === 0 ? (
                            <div className="text-center py-6 text-gray-400">
                              <AlertCircle className="h-8 w-8 mx-auto mb-2" />
                              <p className="text-sm font-medium">No storage pools configured</p>
                              <p className="text-xs mt-1">Configure storage pools with offsite paths to see metrics</p>
                            </div>
                          ) : (
                            <div>
                              <div className="mb-3">
                                <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide">
                                  Storage Pool Usage
                                </p>
                              </div>
                              
                              {/* Progress Bars */}
                              <div className="space-y-4">
                                {storagePoolDisks.map((disk: any, index: number) => (
                                  <div key={index} className="border rounded-lg p-4">
                                    <div className="flex items-center justify-between mb-2">
                                      <div>
                                        <p className="font-medium text-sm">{disk.poolName}</p>
                                        <p className="text-xs text-gray-600">{disk.mountPoint}</p>
                                        <p className="text-xs text-gray-400">{disk.device}</p>
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
                                    <div className="w-full bg-gray-200 rounded-full h-3 overflow-hidden mb-2">
                                      <div
                                        className={`h-full transition-all duration-500 ${
                                          disk.usage >= 90 ? 'bg-red-500' :
                                          disk.usage >= 70 ? 'bg-yellow-500' :
                                          'bg-green-500'
                                        }`}
                                        style={{ width: `${disk.usage}%` }}
                                      />
                                    </div>
                                    
                                    <div className="flex justify-between text-xs text-gray-600">
                                      <span>Used: {disk.used} GB</span>
                                      <span>Available: {disk.available} GB</span>
                                      <span>Total: {disk.total} GB</span>
                                    </div>
                                  </div>
                                ))}
                              </div>
                              
                              {/* Last Updated */}
                              {metrics.timestamp && (
                                <div className="mt-4 pt-3 border-t border-gray-200">
                                  <p className="text-xs text-gray-500 text-center">
                                    Last updated: {new Date(metrics.timestamp).toLocaleTimeString()}
                                  </p>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  )
                })}
              </div>
            ) : (
              <p className="text-xs text-gray-500 text-center py-2">No offsite hosts configured</p>
            )}
          </CardContent>
        )}
      </Card>

      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add Offsite Host to {backupHostName}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit}>
            <div className="space-y-4 py-4">
              <div className="p-3 bg-blue-50 border border-blue-200 rounded text-xs text-blue-700">
                <strong>Adding offsite host for:</strong> {backupHostName}
                <br />
                SSH keys and paths must be configured manually on the backup host server.
              </div>

              <div className="space-y-2">
                <Label htmlFor="name">Name *</Label>
                <Input
                  id="name"
                  placeholder="Offsite DC2"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  required
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="ip">IP Address *</Label>
                  <Input
                    id="ip"
                    placeholder="192.168.2.100"
                    value={formData.ip}
                    onChange={(e) => setFormData({ ...formData, ip: e.target.value })}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="username">Username</Label>
                  <Input
                    id="username"
                    placeholder="root"
                    value={formData.username}
                    onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                  />
                </div>
              </div>

              <p className="text-xs text-gray-500">
                This offsite host will be available when backing up VMs from <strong>{backupHostName}</strong>.
                The IP will be passed to backup_manager.sh via --offsite-ip parameter.
              </p>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowAddDialog(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createHost.isPending}>
                {createHost.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Add Offsite Host
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {editingHost && (
        <EditOffsiteHostDialog
          open={!!editingHost}
          onOpenChange={(open) => !open && setEditingHost(null)}
          offsiteHost={editingHost}
        />
      )}
    </>
  )
}
