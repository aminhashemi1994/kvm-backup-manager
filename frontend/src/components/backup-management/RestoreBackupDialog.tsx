import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Loader2, AlertTriangle, HardDrive, Database, Calendar, Layers } from 'lucide-react'
import { restoreApi } from '@/services/api'
import { toast } from 'sonner'

interface RestoreBackupDialogProps {
  vmName: string
  backupHostId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onRestoreStarted?: (restoreId: string) => void
}

interface RestoreOptions {
  vmName: string
  backupHostId: string
  availableMethods: Array<{
    method: string
    backupPath: string
    maxDepth: number
    checkpoints: Array<{
      name: string
      depth: number
      date: string
      incremental: boolean
      size: string
    }>
    disks: string[]
  }>
  restoreStoragePools: Array<{
    id: string
    name: string
    path: string
    availableGB: number
    totalGB: number
  }>
}

export default function RestoreBackupDialog({
  vmName,
  backupHostId,
  open,
  onOpenChange,
  onRestoreStarted,
}: RestoreBackupDialogProps) {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [triggering, setTriggering] = useState(false)
  const [options, setOptions] = useState<RestoreOptions | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [selectedMethod, setSelectedMethod] = useState('')
  const [selectedRestorePool, setSelectedRestorePool] = useState('')
  const [selectedDepth, setSelectedDepth] = useState<number | null>(null)
  const [selectedDisk, setSelectedDisk] = useState<string | null>(null)

  // Load restore options when dialog opens
  useEffect(() => {
    if (open && vmName && backupHostId) {
      loadOptions()
    } else {
      // Reset state when dialog closes
      setOptions(null)
      setError(null)
      setSelectedMethod('')
      setSelectedRestorePool('')
      setSelectedDepth(null)
      setSelectedDisk(null)
    }
  }, [open, vmName, backupHostId])

  const loadOptions = async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await restoreApi.getOptions(vmName, backupHostId)
      if (response.data.success) {
        setOptions(response.data.data)
        // Auto-select first method if only one available
        if (response.data.data.availableMethods.length === 1) {
          setSelectedMethod(response.data.data.availableMethods[0].method)
        }
        // Auto-select first restore pool if only one available
        if (response.data.data.restoreStoragePools.length === 1) {
          setSelectedRestorePool(response.data.data.restoreStoragePools[0].id)
        }
      } else {
        setError(response.data.error || 'Failed to load restore options')
      }
    } catch (err: any) {
      console.error('Failed to load restore options:', err)
      setError(err.response?.data?.error || 'Failed to load restore options')
    } finally {
      setLoading(false)
    }
  }

  const handleRestore = async () => {
    if (!selectedMethod || !selectedRestorePool) {
      toast.error('Missing Selection', {
        description: 'Please select a backup method and restore storage pool',
      })
      return
    }

    setTriggering(true)
    try {
      const response = await restoreApi.trigger({
        vmName,
        backupHostId,
        method: selectedMethod,
        restoreStoragePoolId: selectedRestorePool,
        depth: selectedDepth,
        disk: selectedDisk,
      })

      if (response.data.success) {
        toast.success('Restore Started', {
          description: `Restore operation for ${vmName} has been started. View progress in Active Jobs.`,
          duration: 5000,
        })
        onOpenChange(false)
        // Navigate to Active Jobs page
        navigate('/backups/active')
      } else {
        toast.error('Restore Failed', {
          description: response.data.error || 'Failed to start restore',
        })
      }
    } catch (err: any) {
      console.error('Failed to trigger restore:', err)
      toast.error('Restore Failed', {
        description: err.response?.data?.error || 'Failed to start restore',
      })
    } finally {
      setTriggering(false)
    }
  }

  const selectedMethodData = options?.availableMethods.find(m => m.method === selectedMethod)
  const selectedRestorePoolData = options?.restoreStoragePools.find(p => p.id === selectedRestorePool)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl w-full">
        <DialogHeader>
          <DialogTitle>Restore Backup: {vmName}</DialogTitle>
          <DialogDescription>
            Select restore options and destination storage pool
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex flex-col items-center justify-center py-12">
            <Loader2 className="h-12 w-12 animate-spin text-gray-400 mb-4" />
            <p className="text-gray-600">Loading restore options...</p>
            <p className="text-sm text-gray-500 mt-2">This may take a moment</p>
          </div>
        ) : error ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>{String(error)}</AlertDescription>
          </Alert>
        ) : options ? (
          <div className="space-y-6">
            {/* Backup Method Selection */}
            <div className="space-y-2">
              <Label htmlFor="method" className="flex items-center gap-2">
                <Calendar className="h-4 w-4" />
                Backup Method
              </Label>
              <Select
                id="method"
                value={selectedMethod}
                onChange={(e) => setSelectedMethod(e.target.value)}
              >
                <option value="">Select backup method</option>
                {options.availableMethods.map((method) => {
                  // Calculate unique checkpoints (not disk entries)
                  const uniqueCheckpoints = new Set(method.checkpoints.map(cp => cp.name)).size;
                  
                  // Format method display name
                  let displayName = method.method;
                  if (method.isArchived && method.archiveName) {
                    // Extract timestamp from archive name (e.g., "2026-05-05_09-54-00_vmname_daily")
                    const parts = method.archiveName.split('_');
                    const timestamp = parts.slice(0, 2).join(' ').replace(/-/g, ':');
                    const originalSchedule = method.originalSchedule || parts[parts.length - 1];
                    displayName = `Archived ${originalSchedule} (${timestamp})`;
                  } else if (method.isLegacyFormat && method.backupLocation === 'current') {
                    // Legacy-daily backup from "current" directory - show as daily with indicator
                    displayName = `${method.method} (Legacy Format)`;
                  }
                  
                  return (
                    <option key={method.method} value={method.method}>
                      {displayName} ({uniqueCheckpoints} checkpoint{uniqueCheckpoints !== 1 ? 's' : ''}, {method.disks.length} disk{method.disks.length !== 1 ? 's' : ''})
                    </option>
                  );
                })}
              </Select>
            </div>

            {/* Restore Storage Pool Selection */}
            <div className="space-y-2">
              <Label htmlFor="restore-pool" className="flex items-center gap-2">
                <HardDrive className="h-4 w-4" />
                Restore Storage Pool
              </Label>
              <Select
                id="restore-pool"
                value={selectedRestorePool}
                onChange={(e) => setSelectedRestorePool(e.target.value)}
              >
                <option value="">Select restore storage pool</option>
                {options.restoreStoragePools.map((pool) => (
                  <option key={pool.id} value={pool.id}>
                    {pool.name} (Available: {pool.availableGB} GB / {pool.totalGB} GB)
                  </option>
                ))}
              </Select>
              {selectedRestorePoolData && (
                <p className="text-sm text-gray-600">
                  Path: {selectedRestorePoolData.path}
                </p>
              )}
            </div>

            {/* Depth Selection (only if method selected) */}
            {selectedMethodData && (() => {
              // Get unique depths from checkpoints
              const uniqueDepths = Array.from(
                new Set(selectedMethodData.checkpoints.map(cp => cp.depth))
              ).sort((a, b) => a - b);
              
              // Get a representative checkpoint for each depth (first one found)
              const depthCheckpoints = uniqueDepths.map(depth => 
                selectedMethodData.checkpoints.find(cp => cp.depth === depth)!
              );

              return (
                <div className="space-y-2">
                  <Label htmlFor="depth" className="flex items-center gap-2">
                    <Layers className="h-4 w-4" />
                    Restore Point
                  </Label>
                  <Select
                    id="depth"
                    value={selectedDepth === null ? 'latest' : selectedDepth.toString()}
                    onChange={(e) => setSelectedDepth(e.target.value === 'latest' ? null : parseInt(e.target.value))}
                  >
                    <option value="latest">
                      Latest (Depth {selectedMethodData.maxDepth})
                    </option>
                    {depthCheckpoints.map((checkpoint) => (
                      <option key={`depth-${checkpoint.depth}`} value={checkpoint.depth.toString()}>
                        Depth {checkpoint.depth} - {new Date(checkpoint.date).toLocaleString()} ({checkpoint.incremental ? 'incremental' : 'full'})
                      </option>
                    ))}
                  </Select>
                  <p className="text-sm text-gray-600">
                    {selectedDepth === null
                      ? 'Restore to the most recent checkpoint'
                      : `Restore up to checkpoint depth ${selectedDepth} (${depthCheckpoints.find(cp => cp.depth === selectedDepth)?.incremental ? 'incremental' : 'full'})`}
                  </p>
                </div>
              );
            })()}

            {/* Disk Selection (only if method selected) */}
            {selectedMethodData && selectedMethodData.disks.length > 1 && (
              <div className="space-y-2">
                <Label htmlFor="disk" className="flex items-center gap-2">
                  <Database className="h-4 w-4" />
                  Disk Selection
                </Label>
                <Select
                  id="disk"
                  value={selectedDisk || 'all'}
                  onChange={(e) => setSelectedDisk(e.target.value === 'all' ? null : e.target.value)}
                >
                  <option value="all">All Disks ({selectedMethodData.disks.length})</option>
                  {selectedMethodData.disks.map((disk) => (
                    <option key={disk} value={disk}>
                      {disk}
                    </option>
                  ))}
                </Select>
              </div>
            )}

            {/* Summary */}
            {selectedMethod && selectedRestorePool && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 space-y-2">
                <h4 className="font-semibold text-blue-900">Restore Summary</h4>
                <div className="text-sm text-blue-800 space-y-1">
                  <p><strong>VM:</strong> {vmName}</p>
                  <p><strong>Method:</strong> {(() => {
                    const methodData = selectedMethodData;
                    if (methodData?.isArchived && methodData?.archiveName) {
                      const parts = methodData.archiveName.split('_');
                      const timestamp = parts.slice(0, 2).join(' ').replace(/-/g, ':');
                      const originalSchedule = methodData.originalSchedule || parts[parts.length - 1];
                      return `Archived ${originalSchedule} (${timestamp})`;
                    } else if (methodData?.isLegacyFormat && methodData?.backupLocation === 'current') {
                      return `${selectedMethod} (Legacy Format)`;
                    }
                    return selectedMethod;
                  })()}</p>
                  <p><strong>Restore Pool:</strong> {selectedRestorePoolData?.name}</p>
                  <p><strong>Restore Point:</strong> {selectedDepth === null ? 'Latest (all checkpoints)' : `Depth ${selectedDepth}`}</p>
                  <p><strong>Disks:</strong> {selectedDisk || 'All disks'}</p>
                </div>
              </div>
            )}

            {/* Warning */}
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                <strong>Important:</strong> The restore operation will create a new directory in the restore storage pool. 
                Make sure you have enough space available. The restore process cannot be undone.
              </AlertDescription>
            </Alert>
          </div>
        ) : null}

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 pt-4 border-t">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={triggering}
          >
            Cancel
          </Button>
          <Button
            onClick={handleRestore}
            disabled={!selectedMethod || !selectedRestorePool || triggering || loading}
          >
            {triggering ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Starting Restore...
              </>
            ) : (
              'Start Restore'
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
