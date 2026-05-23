import { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { useTriggerBackup } from '@/hooks/useBackups'
import { useVMById } from '@/hooks/useHypervisors'
import { useQuery } from '@tanstack/react-query'
import { offsiteHostsApi, storagePoolsApi } from '@/services/api'
import { Loader2, Play, HardDrive, AlertCircle } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'

interface TriggerBackupDialogProps {
  vmId: string
  onClose: () => void
}

export default function TriggerBackupDialog({ 
  vmId,
  onClose 
}: TriggerBackupDialogProps) {
  const { data: vm, isLoading, error } = useVMById(vmId)
  
  // Load offsite hosts for this VM's backup host
  const { data: offsiteHosts, isLoading: offsiteLoading, error: offsiteError } = useQuery({
    queryKey: ['offsite-hosts', vm?.backupHostId],
    queryFn: async () => {
      if (!vm?.backupHostId) return []
      try {
        const response = await offsiteHostsApi.getByBackupHost(vm.backupHostId)
        console.log('Offsite hosts loaded:', response.data.data)
        return response.data.data || []
      } catch (error) {
        console.error('Failed to load offsite hosts:', error)
        return []
      }
    },
    enabled: !!vm?.backupHostId,
  })

  // Load storage pools for this VM's backup host
  const { data: storagePools, isLoading: poolsLoading } = useQuery({
    queryKey: ['storage-pools', vm?.backupHostId],
    queryFn: async () => {
      if (!vm?.backupHostId) return []
      const response = await storagePoolsApi.getByBackupHost(vm.backupHostId)
      return response.data.data || []
    },
    enabled: !!vm?.backupHostId,
  })
  
  console.log('TriggerBackupDialog render:', { vmId, vm, isLoading, error, offsiteHosts, offsiteLoading, offsiteError, storagePools })
  
  const [formData, setFormData] = useState({
    storagePoolId: '',
    scheduleType: 'once' as 'once' | 'daily' | 'weekly' | 'monthly',
    retention: 7,
    keepArchive: 2,
    compression: 2,
    noCompression: false,
    noVerify: false,
    syncToOffsite: false,
    offsiteHostIds: [] as string[],
    verbose: false,
  })

  const triggerBackup = useTriggerBackup()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (!vm) return
    
    await triggerBackup.mutateAsync({
      vmId: vm.id,
      vmName: vm.name,
      backupHostId: vm.backupHostId,
      hypervisorIp: vm.hypervisorIp,
      ...formData,
    })
    
    onClose()
  }

  const handleOffsiteHostToggle = (hostId: string) => {
    setFormData(prev => ({
      ...prev,
      offsiteHostIds: prev.offsiteHostIds.includes(hostId)
        ? prev.offsiteHostIds.filter(id => id !== hostId)
        : [...prev.offsiteHostIds, hostId]
    }))
  }

  return (
    <Dialog open={!!vmId} onOpenChange={(open) => {
      console.log('Dialog onOpenChange:', open)
      if (!open) onClose()
    }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Trigger Backup{vm ? ` - ${vm.name}` : ''}</DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
            <span className="ml-2 text-gray-600">Loading VM details...</span>
          </div>
        ) : error ? (
          <div className="py-8 text-center">
            <p className="text-red-600">Failed to load VM details</p>
            <Button variant="outline" onClick={onClose} className="mt-4">
              Close
            </Button>
          </div>
        ) : !vm ? (
          <div className="py-8 text-center">
            <p className="text-gray-600">VM not found</p>
            <Button variant="outline" onClick={onClose} className="mt-4">
              Close
            </Button>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <div className="space-y-4 py-4">
              <div className="p-4 bg-gray-50 rounded-lg">
                <p className="text-sm text-gray-600">
                  <span className="font-medium">VM:</span> {vm.name}
                </p>
              </div>

            {/* Storage Pool Selection - REQUIRED */}
            <div className="space-y-2">
              <Label htmlFor="storagePool" className="flex items-center gap-2">
                <HardDrive className="h-4 w-4" />
                Storage Pool *
              </Label>
              <Select
                id="storagePool"
                value={formData.storagePoolId}
                onChange={(e) => setFormData({ ...formData, storagePoolId: e.target.value })}
                required
              >
                <option value="">Select storage pool...</option>
                {poolsLoading ? (
                  <option disabled>Loading storage pools...</option>
                ) : !storagePools || storagePools.length === 0 ? (
                  <option disabled>No storage pools available</option>
                ) : (
                  storagePools.map((pool: any) => (
                    <option key={pool.id} value={pool.id}>
                      {pool.name} ({pool.availableGB}GB available of {pool.totalGB}GB)
                    </option>
                  ))
                )}
              </Select>
              {!storagePools || storagePools.length === 0 ? (
                <Alert>
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>
                    No storage pools configured for this backup host. Please create a storage pool first.
                  </AlertDescription>
                </Alert>
              ) : (
                <p className="text-xs text-gray-500">
                  Select where the backup will be stored
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="scheduleType">Schedule Type</Label>
              <Select
                id="scheduleType"
                value={formData.scheduleType}
                onChange={(e) => setFormData({ ...formData, scheduleType: e.target.value as any })}
              >
                <option value="once">Once (Copy - Overwrites)</option>
                <option value="daily">Daily (Auto Full/Inc Chain)</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly (Copy - Overwrites)</option>
              </Select>
              <p className="text-xs text-gray-500">
                {formData.scheduleType === 'once' && 'One-time copy backup, overwrites previous'}
                {formData.scheduleType === 'daily' && 'Auto-detects full/inc with retention'}
                {formData.scheduleType === 'weekly' && 'Weekly backup with optional chain'}
                {formData.scheduleType === 'monthly' && 'Monthly copy backup, overwrites previous'}
              </p>
            </div>

            {/* Retention settings for daily/weekly */}
            {['daily', 'weekly'].includes(formData.scheduleType) && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="retention">Retention</Label>
                  <Input
                    id="retention"
                    type="number"
                    min="1"
                    max="30"
                    value={formData.retention}
                    onChange={(e) => setFormData({ ...formData, retention: parseInt(e.target.value) || 7 })}
                  />
                  <p className="text-xs text-gray-500">
                    Number of backups before archiving (default: 7)
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="keepArchive">Keep Archives</Label>
                  <Input
                    id="keepArchive"
                    type="number"
                    min="0"
                    max="10"
                    value={formData.keepArchive}
                    onChange={(e) => setFormData({ ...formData, keepArchive: parseInt(e.target.value) || 2 })}
                  />
                  <p className="text-xs text-gray-500">
                    Number of archived chains to keep (default: 2)
                  </p>
                </div>
              </>
            )}

            <div className="space-y-2">
              <Label htmlFor="compression">Compression Level</Label>
              <Select
                id="compression"
                value={formData.compression.toString()}
                onChange={(e) => setFormData({ ...formData, compression: parseInt(e.target.value) })}
                disabled={formData.noCompression}
              >
                {[...Array(15)].map((_, i) => (
                  <option key={i + 2} value={i + 2}>
                    Level {i + 2}
                  </option>
                ))}
              </Select>
            </div>

            <div className="flex items-center space-x-2">
              <Checkbox
                id="noCompression"
                checked={formData.noCompression}
                onChange={(e: any) => setFormData({ ...formData, noCompression: e.target.checked })}
              />
              <Label htmlFor="noCompression">Disable compression</Label>
            </div>

            <div className="flex items-center space-x-2">
              <Checkbox
                id="noVerify"
                checked={formData.noVerify}
                onChange={(e: any) => setFormData({ ...formData, noVerify: e.target.checked })}
              />
              <Label htmlFor="noVerify">Disable verification</Label>
            </div>

            <div className="border-t pt-4">
              <div className="flex items-center space-x-2 mb-2">
                <Checkbox
                  id="syncToOffsite"
                  checked={formData.syncToOffsite}
                  onChange={(e: any) => setFormData({ ...formData, syncToOffsite: e.target.checked })}
                />
                <Label htmlFor="syncToOffsite">📤 Sync to offsite location(s)</Label>
              </div>

              {formData.syncToOffsite && (
                <div className="space-y-2 ml-6">
                  <Label>Offsite Hosts for this Backup Host</Label>
                  <div className="border rounded-lg p-3 space-y-2 max-h-40 overflow-y-auto bg-white">
                    {offsiteLoading ? (
                      <div className="flex items-center space-x-2 text-sm text-gray-500">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>Loading offsite hosts...</span>
                      </div>
                    ) : offsiteError ? (
                      <p className="text-sm text-red-600">
                        Error loading offsite hosts. Please try again.
                      </p>
                    ) : !vm?.backupHostId ? (
                      <p className="text-sm text-yellow-600">
                        VM backup host not configured. Please configure the VM first.
                      </p>
                    ) : !offsiteHosts || offsiteHosts.length === 0 ? (
                      <div>
                        <p className="text-sm text-gray-500">
                          No offsite hosts configured for this backup host yet
                        </p>
                        <p className="text-xs text-gray-400 mt-1">
                          Add offsite hosts in the Backup Hosts page to enable offsite sync.
                        </p>
                      </div>
                    ) : (
                      offsiteHosts.map((host: any) => (
                        <div key={host.id} className="flex items-center space-x-2">
                          <Checkbox
                            id={`offsite-${host.id}`}
                            checked={formData.offsiteHostIds.includes(host.id)}
                            onChange={() => handleOffsiteHostToggle(host.id)}
                          />
                          <Label htmlFor={`offsite-${host.id}`} className="font-normal cursor-pointer flex-1">
                            {host.name} ({host.ip})
                          </Label>
                          {host.status === 'online' ? (
                            <Badge variant="outline" className="text-xs bg-green-50 text-green-700 border-green-200">
                              Connected
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-xs bg-yellow-50 text-yellow-700 border-yellow-200">
                              {host.status === 'offline' ? 'Disconnected' : (host.status || 'Unknown')}
                            </Badge>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                  <p className="text-xs text-gray-500">
                    Select one or more offsite hosts to sync backup after completion
                  </p>
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={triggerBackup.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={triggerBackup.isPending || !formData.storagePoolId}>
              {triggerBackup.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Play className="mr-2 h-4 w-4" />
              )}
              Start Backup
            </Button>
          </DialogFooter>
        </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
