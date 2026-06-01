import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { 
  Server, 
  ChevronDown, 
  ChevronUp, 
  Plus, 
  RefreshCw, 
  Trash2,
  HardDrive,
  Settings,
  Eye,
  Edit
} from 'lucide-react'
import { cn, getStatusColor } from '@/lib/utils'
import type { BackupHost } from '@/types'
import HypervisorCard from './HypervisorCard'
import AddHypervisorDialog from './AddHypervisorDialog'
import OffsiteHostManager from './OffsiteHostManager'
import InitHostDialog from './InitHostDialog'
import EditBackupHostDialog from './EditBackupHostDialog'
import socketService from '@/services/socket'
import { initApi } from '@/services/api'
import { useHypervisorsByBackupHost, useDeleteBackupHost, useHealthCheckBackupHost } from '@/hooks/useBackupHosts'
import { useInitBackupHost } from '@/hooks/useInit'
import { toast } from 'sonner'
import MetricsCard from '@/components/metrics/MetricsCard'
import { useConfirm } from '@/components/ui/confirm-dialog'

interface BackupHostCardProps {
  backupHost: BackupHost
}

export default function BackupHostCard({ backupHost }: BackupHostCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [showAddHypervisor, setShowAddHypervisor] = useState(false)
  const [showEditDialog, setShowEditDialog] = useState(false)
  const [initId, setInitId] = useState<string | null>(null)
  const [showInitDialog, setShowInitDialog] = useState(false)
  const [isInitializing, setIsInitializing] = useState(false)
  const [isSyncing, setIsSyncing] = useState(false)
  
  const { data: hypervisors, isLoading } = useHypervisorsByBackupHost(backupHost.id)
  const deleteHost = useDeleteBackupHost()
  const healthCheck = useHealthCheckBackupHost()
  const initHost = useInitBackupHost()
  const confirm = useConfirm()

  const handleDelete = async () => {
    const ok = await confirm({
      title: 'Delete backup host?',
      description: `This will delete "${backupHost.name}" and all of its hypervisors from the panel.`,
      confirmText: 'Delete',
      variant: 'danger',
    })
    if (ok) deleteHost.mutate(backupHost.id)
  }

  const handleHealthCheck = () => {
    healthCheck.mutate(backupHost.id)
  }

  const handleSyncStoragePools = async () => {
    try {
      setIsSyncing(true)
      const { backupHostsApi } = await import('@/services/api')
      await backupHostsApi.syncStoragePools(backupHost.url)
      toast.success('Storage pools synced successfully')
    } catch (error: any) {
      console.error('Failed to sync storage pools:', error)
      toast.error(error.response?.data?.error || 'Failed to sync storage pools')
    } finally {
      setIsSyncing(false)
    }
  }

  const handleInit = async () => {
    const ok = await confirm({
      title: 'Initialize backup host?',
      description: `Install the required dependencies on "${backupHost.name}".`,
      details: ['virtnbdbackup', 'rsync', 'Other required tools'],
      confirmText: 'Initialize',
    })
    if (ok) {
      try {
        setIsInitializing(true)
        const result = await initHost.mutateAsync(backupHost.id)
        setInitId(result.data.initId)
        // Don't show dialog automatically
      } catch (error) {
        console.error('Failed to start init:', error)
        setIsInitializing(false)
      }
    }
  }

  const handleShowDetails = () => {
    if (initId) {
      setShowInitDialog(true)
    }
  }

  // Listen for init completion to stop spinner
  useEffect(() => {
    if (!initId) return

    const cleanup = socketService.on('init-complete', (data: any) => {
      if (data.initId === initId) {
        setIsInitializing(false)
        if (!data.success) {
          toast.error(`Host initialization failed with exit code ${data.exitCode}`)
        } else {
          toast.success('Host initialization completed successfully')
        }
      }
    })

    const cleanupError = socketService.on('init-error', (data: any) => {
      if (data.initId === initId) {
        setIsInitializing(false)
        const errorMsg = typeof data.error === 'string' ? data.error : 'Unknown error occurred'
        toast.error(`Host initialization error: ${errorMsg}`)
      }
    })

    // Fallback: Poll status every 3 seconds to check if init is still running
    const pollInterval = setInterval(async () => {
      try {
        const response = await initApi.getStatus(initId, backupHost.id)
        const initStatus = response.data.data
        if (initStatus && initStatus.status !== 'running') {
          setIsInitializing(false)
          clearInterval(pollInterval)
        }
      } catch (error) {
        // If error, assume completed
        setIsInitializing(false)
        clearInterval(pollInterval)
      }
    }, 3000)

    return () => {
      cleanup()
      cleanupError()
      clearInterval(pollInterval)
    }
  }, [initId, backupHost.id])

  return (
    <>
      <Card className="overflow-hidden">
        <CardHeader className="bg-gray-50 border-b">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <div className="p-2 bg-blue-100 rounded-lg">
                <Server className="h-6 w-6 text-blue-600" />
              </div>
              <div>
                <div className="flex items-center space-x-2">
                  <h3 className="text-lg font-semibold">{backupHost.name}</h3>
                  <Badge className={getStatusColor(backupHost.status)}>
                    {backupHost.status}
                  </Badge>
                </div>
                <p className="text-sm text-gray-500 font-mono">{backupHost.url}</p>
                <div className="flex items-center space-x-2 mt-1">
                  <p className="text-xs text-gray-400">ID:</p>
                  <code className="text-xs bg-gray-100 px-2 py-0.5 rounded font-mono text-gray-700">
                    {backupHost.id}
                  </code>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2"
                    onClick={() => {
                      navigator.clipboard.writeText(backupHost.id)
                      toast.success('Backup Host ID copied to clipboard!')
                    }}
                    title="Copy Backup Host ID for agent .env file"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                  </Button>
                </div>
              </div>
            </div>

            <div className="flex items-center space-x-2">
              <div className="text-right mr-4">
                <p className="text-sm text-gray-600">
                  <span className="font-medium">{hypervisors?.length || 0}</span> Hypervisors
                </p>
                <p className="text-sm text-gray-600">
                  <span className="font-medium">{backupHost.vmCount || 0}</span> VMs
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  Max: <span className="font-medium">{backupHost.maxConcurrentBackups || 2}</span> concurrent
                </p>
              </div>

              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowEditDialog(true)}
                title="Edit backup host"
              >
                <Edit className="h-4 w-4" />
              </Button>

              <Button
                variant="outline"
                size="sm"
                onClick={handleHealthCheck}
                disabled={healthCheck.isPending}
                title="Check agent health"
              >
                <RefreshCw className={cn("h-4 w-4", healthCheck.isPending && "animate-spin")} />
              </Button>

              <Button
                variant="outline"
                size="sm"
                onClick={handleSyncStoragePools}
                disabled={isSyncing}
                title="Sync storage pools from controller"
              >
                <HardDrive className={cn("h-4 w-4", isSyncing && "animate-pulse")} />
              </Button>

              <Button
                variant="outline"
                size="sm"
                onClick={handleInit}
                disabled={initHost.isPending || isInitializing}
                title="Initialize host with dependencies"
              >
                <Settings className={cn("h-4 w-4", (initHost.isPending || isInitializing) && "animate-spin")} />
              </Button>

              {isInitializing && initId && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleShowDetails}
                  title="Show initialization details"
                >
                  <Eye className="h-4 w-4" />
                </Button>
              )}

              <Button
                variant="outline"
                size="sm"
                onClick={handleDelete}
                disabled={deleteHost.isPending}
              >
                <Trash2 className="h-4 w-4 text-red-600" />
              </Button>

              <Button
                variant="ghost"
                size="sm"
                onClick={() => setExpanded(!expanded)}
              >
                {expanded ? <ChevronUp className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}
              </Button>
            </div>
          </div>
        </CardHeader>

        {expanded && (
          <CardContent className="p-4">
            {/* Metrics Section */}
            <div className="mb-6 p-4 bg-gray-50 rounded-lg">
              <h4 className="text-sm font-medium mb-4">Resource Usage</h4>
              <MetricsCard 
                backupHostId={backupHost.id} 
                backupHostName={backupHost.name}
                compact={true}
              />
            </div>

            {isLoading ? (
              <div className="text-center py-4 text-gray-500">Loading hypervisors...</div>
            ) : hypervisors && hypervisors.length > 0 ? (
              <div className="space-y-4">
                {hypervisors.map((hypervisor) => (
                  <HypervisorCard 
                    key={hypervisor.id} 
                    hypervisor={hypervisor}
                    backupHostId={backupHost.id}
                  />
                ))}
              </div>
            ) : (
              <div className="text-center py-6 border-2 border-dashed border-gray-200 rounded-lg">
                <HardDrive className="h-8 w-8 text-gray-400 mx-auto" />
                <p className="mt-2 text-gray-500">No hypervisors added yet</p>
              </div>
            )}

            <Button
              variant="outline"
              className="w-full mt-4"
              onClick={() => setShowAddHypervisor(true)}
            >
              <Plus className="h-4 w-4 mr-2" />
              Add Hypervisor
            </Button>

            {/* Offsite Hosts Section */}
            <OffsiteHostManager 
              backupHostId={backupHost.id} 
              backupHostName={backupHost.name} 
            />
          </CardContent>
        )}
      </Card>

      <AddHypervisorDialog
        open={showAddHypervisor}
        onOpenChange={setShowAddHypervisor}
        backupHostId={backupHost.id}
        backupHostName={backupHost.name}
      />

      <EditBackupHostDialog
        open={showEditDialog}
        onOpenChange={setShowEditDialog}
        backupHost={backupHost}
      />

      {showInitDialog && initId && (
        <InitHostDialog
          initId={initId}
          backupHostId={backupHost.id}
          hostName={backupHost.name}
          onClose={() => setShowInitDialog(false)}
        />
      )}
    </>
  )
}
