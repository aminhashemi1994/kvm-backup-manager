import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Plus, HardDrive, Loader2, FolderDown, RefreshCw, Cloud } from 'lucide-react'
import { useStoragePools, useRestoreStoragePools } from '@/hooks/useStoragePools'
import { useBackupHosts } from '@/hooks/useBackupHosts'
import { useOffsiteHosts } from '@/hooks/useOffsiteHosts'
import StoragePoolCard from '@/components/storage-pools/StoragePoolCard'
import RestoreStoragePoolCard from '@/components/storage-pools/RestoreStoragePoolCard'
import OffsiteStoragePoolManager from '@/components/storage-pools/OffsiteStoragePoolManager'
import AddStoragePoolDialog from '@/components/storage-pools/AddStoragePoolDialog'
import AddRestoreStoragePoolDialog from '@/components/storage-pools/AddRestoreStoragePoolDialog'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

export default function StoragePoolsPage() {
  const [showAddBackupDialog, setShowAddBackupDialog] = useState(false)
  const [showAddRestoreDialog, setShowAddRestoreDialog] = useState(false)
  const [activeTab, setActiveTab] = useState<'backup' | 'restore' | 'offsite'>('backup')
  const [syncingHosts, setSyncingHosts] = useState<Set<string>>(new Set())
  const { data: storagePools, isLoading: poolsLoading } = useStoragePools()
  const { data: restorePools, isLoading: restorePoolsLoading } = useRestoreStoragePools()
  const { data: backupHosts, isLoading: hostsLoading } = useBackupHosts()
  const { data: offsiteHosts, isLoading: offsiteHostsLoading } = useOffsiteHosts()

  const isLoading = poolsLoading || hostsLoading || restorePoolsLoading

  const handleSyncStoragePools = async (hostUrl: string, hostId: string, hostName: string) => {
    try {
      setSyncingHosts(prev => new Set(prev).add(hostId))
      const { backupHostsApi } = await import('@/services/api')
      await backupHostsApi.syncStoragePools(hostUrl)
      toast.success(`Storage pools synced successfully for ${hostName}`)
    } catch (error: any) {
      console.error('Failed to sync storage pools:', error)
      toast.error(error.response?.data?.error || 'Failed to sync storage pools')
    } finally {
      setSyncingHosts(prev => {
        const next = new Set(prev)
        next.delete(hostId)
        return next
      })
    }
  }

  // Group storage pools by backup host
  const poolsByHost = (storagePools || []).reduce((acc, pool) => {
    if (!acc[pool.backupHostId]) {
      acc[pool.backupHostId] = []
    }
    acc[pool.backupHostId].push(pool)
    return acc
  }, {} as Record<string, typeof storagePools>)

  // Group restore pools by backup host
  const restorePoolsByHost = (restorePools || []).reduce((acc, pool) => {
    if (!acc[pool.backupHostId]) {
      acc[pool.backupHostId] = []
    }
    acc[pool.backupHostId].push(pool)
    return acc
  }, {} as Record<string, typeof restorePools>)

  // Group offsite hosts by their owning backup host (keeps offsite tab linked to
  // the backup-host context per Req 3.2)
  const offsiteHostsByBackupHost = (offsiteHosts || []).reduce((acc, host) => {
    if (!acc[host.backupHostId]) {
      acc[host.backupHostId] = []
    }
    acc[host.backupHostId].push(host)
    return acc
  }, {} as Record<string, typeof offsiteHosts>)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Storage Pools</h1>
          <p className="text-gray-600 mt-2">
            Manage storage pools for backup and restore destinations
          </p>
        </div>
      </div>

      {/* Simple Tab Buttons */}
      <div className="border-b border-gray-200">
        <nav className="-mb-px flex space-x-8">
          <button
            onClick={() => setActiveTab('backup')}
            className={`${
              activeTab === 'backup'
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            } whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm flex items-center gap-2`}
          >
            <HardDrive className="h-4 w-4" />
            Backup Storage Pools
          </button>
          <button
            onClick={() => setActiveTab('restore')}
            className={`${
              activeTab === 'restore'
                ? 'border-green-500 text-green-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            } whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm flex items-center gap-2`}
          >
            <FolderDown className="h-4 w-4" />
            Restore Storage Pools
          </button>
          <button
            onClick={() => setActiveTab('offsite')}
            className={`${
              activeTab === 'offsite'
                ? 'border-purple-500 text-purple-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            } whitespace-nowrap py-4 px-1 border-b-2 font-medium text-sm flex items-center gap-2`}
          >
            <Cloud className="h-4 w-4" />
            Offsite Storage Pools
          </button>
        </nav>
      </div>

      {/* Backup Storage Pools */}
      {activeTab === 'backup' && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-600">
              Storage pools where VM backups are stored
            </p>
            <Button onClick={() => setShowAddBackupDialog(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Add Backup Pool
            </Button>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
            </div>
          ) : storagePools && storagePools.length > 0 ? (
            <div className="space-y-8">
              {backupHosts?.map((host) => {
                const hostPools = poolsByHost?.[host.id] || []
                if (hostPools.length === 0) return null

                return (
                  <div key={host.id} className="space-y-4">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 rounded-lg bg-blue-100 flex items-center justify-center">
                        <HardDrive className="h-5 w-5 text-blue-600" />
                      </div>
                      <div>
                        <h2 className="text-xl font-semibold text-gray-900">{host.name}</h2>
                        <p className="text-sm text-gray-500">{host.url}</p>
                      </div>
                      <div className="ml-auto flex items-center gap-3">
                        <span className="text-sm text-gray-500">
                          {hostPools.length} {hostPools.length === 1 ? 'pool' : 'pools'}
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleSyncStoragePools(host.url, host.id, host.name)}
                          disabled={syncingHosts.has(host.id)}
                          title="Sync storage pools to agent"
                        >
                          <RefreshCw className={cn("h-4 w-4 mr-2", syncingHosts.has(host.id) && "animate-spin")} />
                          Sync to Agent
                        </Button>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {hostPools.map((pool) => (
                        <StoragePoolCard key={pool.id} pool={pool} />
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="text-center py-12 bg-white rounded-lg border">
              <HardDrive className="h-12 w-12 text-gray-400 mx-auto" />
              <h3 className="mt-4 text-lg font-medium text-gray-900">No backup storage pools</h3>
              <p className="mt-2 text-gray-500">
                Get started by adding your first backup storage pool
              </p>
              <Button className="mt-4" onClick={() => setShowAddBackupDialog(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Add Backup Pool
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Restore Storage Pools */}
      {activeTab === 'restore' && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-600">
              Storage pools where VMs are restored to
            </p>
            <Button onClick={() => setShowAddRestoreDialog(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Add Restore Pool
            </Button>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
            </div>
          ) : restorePools && restorePools.length > 0 ? (
            <div className="space-y-8">
              {backupHosts?.map((host) => {
                const hostPools = restorePoolsByHost?.[host.id] || []
                if (hostPools.length === 0) return null

                return (
                  <div key={host.id} className="space-y-4">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 rounded-lg bg-green-100 flex items-center justify-center">
                        <FolderDown className="h-5 w-5 text-green-600" />
                      </div>
                      <div>
                        <h2 className="text-xl font-semibold text-gray-900">{host.name}</h2>
                        <p className="text-sm text-gray-500">{host.url}</p>
                      </div>
                      <div className="ml-auto flex items-center gap-3">
                        <span className="text-sm text-gray-500">
                          {hostPools.length} {hostPools.length === 1 ? 'pool' : 'pools'}
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleSyncStoragePools(host.url, host.id, host.name)}
                          disabled={syncingHosts.has(host.id)}
                          title="Sync storage pools to agent"
                        >
                          <RefreshCw className={cn("h-4 w-4 mr-2", syncingHosts.has(host.id) && "animate-spin")} />
                          Sync to Agent
                        </Button>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {hostPools.map((pool) => (
                        <RestoreStoragePoolCard key={pool.id} pool={pool} />
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="text-center py-12 bg-white rounded-lg border">
              <FolderDown className="h-12 w-12 text-gray-400 mx-auto" />
              <h3 className="mt-4 text-lg font-medium text-gray-900">No restore storage pools</h3>
              <p className="mt-2 text-gray-500">
                Get started by adding your first restore storage pool
              </p>
              <Button className="mt-4" onClick={() => setShowAddRestoreDialog(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Add Restore Pool
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Offsite Storage Pools */}
      {activeTab === 'offsite' && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-600">
              Storage pools on offsite hosts where backups are replicated
            </p>
          </div>

          {isLoading || offsiteHostsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
            </div>
          ) : offsiteHosts && offsiteHosts.length > 0 ? (
            <div className="space-y-8">
              {backupHosts?.map((host) => {
                const hostOffsiteHosts = offsiteHostsByBackupHost?.[host.id] || []
                if (hostOffsiteHosts.length === 0) return null

                return (
                  <div key={host.id} className="space-y-4">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 rounded-lg bg-purple-100 flex items-center justify-center">
                        <HardDrive className="h-5 w-5 text-purple-600" />
                      </div>
                      <div>
                        <h2 className="text-xl font-semibold text-gray-900">{host.name}</h2>
                        <p className="text-sm text-gray-500">{host.url}</p>
                      </div>
                      <div className="ml-auto flex items-center gap-3">
                        <span className="text-sm text-gray-500">
                          {hostOffsiteHosts.length}{' '}
                          {hostOffsiteHosts.length === 1 ? 'offsite host' : 'offsite hosts'}
                        </span>
                      </div>
                    </div>

                    <div className="space-y-4">
                      {hostOffsiteHosts.map((offsiteHost) => (
                        <OffsiteStoragePoolManager
                          key={offsiteHost.id}
                          offsiteHost={offsiteHost}
                        />
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="text-center py-12 bg-white rounded-lg border">
              <Cloud className="h-12 w-12 text-gray-400 mx-auto" />
              <h3 className="mt-4 text-lg font-medium text-gray-900">No offsite hosts</h3>
              <p className="mt-2 text-gray-500">
                Add an offsite host to a backup host to manage its storage pools here
              </p>
            </div>
          )}
        </div>
      )}

      <AddStoragePoolDialog 
        open={showAddBackupDialog} 
        onOpenChange={setShowAddBackupDialog} 
      />
      
      <AddRestoreStoragePoolDialog 
        open={showAddRestoreDialog} 
        onOpenChange={setShowAddRestoreDialog} 
      />
    </div>
  )
}
