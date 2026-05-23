import { useState } from 'react'
import React from 'react'
import { createPortal } from 'react-dom'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { 
  Trash2, 
  Loader2, 
  HardDrive, 
  AlertTriangle,
  FolderOpen,
  Calendar,
  Archive,
  ChevronRight,
  RefreshCw,
  Database,
  Plus,
  RotateCcw,
  Search
} from 'lucide-react'
import { useBackupHosts } from '@/hooks/useBackupHosts'
import { useVMList, useVMDetails, useRemoveScheduleBackup, useRemoveVMBackup } from '@/hooks/useBackupRemoval'
import { useQuery } from '@tanstack/react-query'
import { storagePoolsApi } from '@/services/api'
import { useNavigate } from 'react-router-dom'
import RestoreBackupDialog from '@/components/backup-management/RestoreBackupDialog'

export default function BackupManagement() {
  const navigate = useNavigate()
  const { data: backupHosts, isLoading: hostsLoading } = useBackupHosts()
  const [selectedHostId, setSelectedHostId] = useState<string>('')
  const [selectedVMName, setSelectedVMName] = useState<string>('')
  const [selectedPoolPath, setSelectedPoolPath] = useState<string>('all') // Storage pool filter
  const [searchQuery, setSearchQuery] = useState<string>('') // Search query for VM names
  const [confirmDelete, setConfirmDelete] = useState<{
    type: 'schedule' | 'vm'
    vmName: string
    scheduleType?: string
    scheduleName?: string
  } | null>(null)
  
  // Restore dialog states
  const [restoreDialogOpen, setRestoreDialogOpen] = useState(false)
  const [restoreVMName, setRestoreVMName] = useState('')
  const [restoreBackupHostId, setRestoreBackupHostId] = useState('')

  const { data: vmList, isLoading: vmListLoading } = useVMList(selectedHostId)
  const { data: vmDetails, isLoading: vmDetailsLoading, refetch: refetchDetails, isFetching: vmDetailsFetching } = useVMDetails(selectedHostId, selectedVMName)
  const removeSchedule = useRemoveScheduleBackup()
  const removeVM = useRemoveVMBackup()

  // Load storage pools for selected backup host
  const { data: storagePools, isLoading: poolsLoading } = useQuery({
    queryKey: ['storage-pools', selectedHostId],
    queryFn: async () => {
      if (!selectedHostId) return []
      const response = await storagePoolsApi.getByBackupHost(selectedHostId)
      return response.data.data || []
    },
    enabled: !!selectedHostId,
  })

  // Reset pool filter and search when host changes
  React.useEffect(() => {
    setSelectedPoolPath('all')
    setSelectedVMName('')
    setSearchQuery('')
  }, [selectedHostId])

  // Filter VMs by selected storage pool and search query
  const filteredVMs = React.useMemo(() => {
    if (!vmList) return []
    
    let filtered = vmList
    
    // Filter by storage pool
    if (selectedPoolPath !== 'all') {
      filtered = filtered.filter((vm: any) => vm.storagePoolPath === selectedPoolPath)
    }
    
    // Filter by search query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase().trim()
      filtered = filtered.filter((vm: any) => 
        vm.name.toLowerCase().includes(query)
      )
    }
    
    return filtered
  }, [vmList, selectedPoolPath, searchQuery])

  // Get unique storage pools from VMs
  const availableStoragePools = React.useMemo(() => {
    if (!vmList) return []
    const pools = new Map<string, { path: string; name: string; count: number }>()
    vmList.forEach((vm: any) => {
      if (vm.storagePoolPath) {
        const existing = pools.get(vm.storagePoolPath)
        if (existing) {
          existing.count++
        } else {
          pools.set(vm.storagePoolPath, {
            path: vm.storagePoolPath,
            name: vm.storagePoolName || vm.storagePoolPath,
            count: 1
          })
        }
      }
    })
    return Array.from(pools.values()).sort((a, b) => a.path.localeCompare(b.path))
  }, [vmList])

  const handleRemoveSchedule = async (vmName: string, scheduleType: string) => {
    if (!selectedHostId) return
    
    await removeSchedule.mutateAsync({
      backupHostId: selectedHostId,
      vmName,
      scheduleType,
    })
    setConfirmDelete(null)
    // Refetch details after removal
    refetchDetails()
  }

  const handleRemoveVM = async (vmName: string) => {
    if (!selectedHostId) return
    
    await removeVM.mutateAsync({
      backupHostId: selectedHostId,
      vmName,
    })
    setConfirmDelete(null)
    // Clear selection after VM removal
    setSelectedVMName('')
  }

  const handleRestoreClick = (vmName: string) => {
    setRestoreVMName(vmName)
    setRestoreBackupHostId(selectedHostId)
    setRestoreDialogOpen(true)
  }

  const handleRestoreStarted = (restoreId: string) => {
    // Navigate to Active Jobs page to see the restore progress
    navigate('/backups/active')
  }

  const getScheduleIcon = (scheduleType: string) => {
    switch (scheduleType) {
      case 'daily':
        return <Calendar className="h-4 w-4 text-blue-600" />
      case 'weekly':
        return <Calendar className="h-4 w-4 text-green-600" />
      case 'monthly':
        return <Calendar className="h-4 w-4 text-purple-600" />
      case 'once':
      case 'legacy':
        return <FolderOpen className="h-4 w-4 text-orange-600" />
      case 'archived':
        return <Archive className="h-4 w-4 text-gray-600" />
      default:
        return <FolderOpen className="h-4 w-4 text-gray-600" />
    }
  }

  const getScheduleBadgeColor = (scheduleType: string) => {
    switch (scheduleType) {
      case 'daily':
        return 'bg-blue-100 text-blue-800 border-blue-200'
      case 'weekly':
        return 'bg-green-100 text-green-800 border-green-200'
      case 'monthly':
        return 'bg-purple-100 text-purple-800 border-purple-200'
      case 'once':
      case 'legacy':
        return 'bg-orange-100 text-orange-800 border-orange-200'
      case 'archived':
        return 'bg-gray-100 text-gray-800 border-gray-200'
      default:
        return 'bg-gray-100 text-gray-800 border-gray-200'
    }
  }

  const getHealthBadge = (health: string) => {
    switch (health) {
      case 'healthy':
        return <Badge className="bg-green-100 text-green-800 border-green-200">Healthy</Badge>
      case 'in_progress':
        return <Badge className="bg-blue-100 text-blue-800 border-blue-200">Backup In Progress</Badge>
      case 'partially_corrupted':
        return <Badge className="bg-yellow-100 text-yellow-800 border-yellow-200">Partially Corrupted</Badge>
      case 'all_corrupted':
        return <Badge className="bg-red-100 text-red-800 border-red-200">All Corrupted</Badge>
      case 'no_backups':
        return <Badge className="bg-gray-100 text-gray-800 border-gray-200">No Backups</Badge>
      default:
        return <Badge className="bg-gray-100 text-gray-800 border-gray-200">{health}</Badge>
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Backup Management</h1>
        <p className="text-gray-600 mt-2">
          View and manage VM backups across all backup hosts
        </p>
      </div>

      {/* Backup Host Selection */}
      <Card>
        <CardHeader>
          <CardTitle>Select Backup Host</CardTitle>
        </CardHeader>
        <CardContent>
          {hostsLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
            </div>
          ) : backupHosts && backupHosts.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {backupHosts.map((host) => (
                <button
                  key={host.id}
                  onClick={() => {
                    setSelectedHostId(host.id)
                    setSelectedVMName('') // Reset VM selection
                  }}
                  className={`p-4 rounded-lg border-2 transition-all text-left ${
                    selectedHostId === host.id
                      ? 'border-blue-500 bg-blue-50'
                      : 'border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <div className="flex items-center space-x-3">
                    <HardDrive className="h-5 w-5 text-gray-600" />
                    <div>
                      <div className="font-semibold">{host.name}</div>
                      <div className="text-sm text-gray-600">{host.url}</div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-gray-500">
              No backup hosts found
            </div>
          )}
        </CardContent>
      </Card>

      {/* VM List */}
      {selectedHostId && (
        <>
          {/* Storage Pool Warning */}
          {!poolsLoading && (!storagePools || storagePools.length === 0) && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription className="space-y-3">
                <p>
                  <strong>No storage pools defined for this backup host.</strong>
                </p>
                <p className="text-sm">
                  The VM list below shows backups from the old system. To use the new storage pool system, 
                  you need to create at least one storage pool for this backup host.
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
          )}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left: VM List */}
          <Card className="lg:col-span-1">
            <CardHeader>
              <CardTitle>Virtual Machines ({filteredVMs.length})</CardTitle>
              
              {/* Search Bar */}
              <div className="mt-4">
                <label className="text-sm font-medium text-gray-700 block mb-2">
                  Search Virtual Machines:
                </label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search by VM name..."
                    className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  {searchQuery && (
                    <button
                      onClick={() => setSearchQuery('')}
                      className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600"
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>
              
              {/* Storage Pool Filter */}
              {availableStoragePools.length > 0 && (
                <div className="mt-4">
                  <label className="text-sm font-medium text-gray-700 block mb-2">
                    Filter by Storage Pool:
                  </label>
                  <select
                    value={selectedPoolPath}
                    onChange={(e) => {
                      setSelectedPoolPath(e.target.value)
                      setSelectedVMName('')
                    }}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="all">All Storage Pools ({vmList?.length || 0} VMs)</option>
                    {availableStoragePools.map((pool) => (
                      <option key={pool.path} value={pool.path}>
                        {pool.name} ({pool.count} VMs)
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </CardHeader>
            <CardContent>
              {vmListLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
                </div>
              ) : filteredVMs && filteredVMs.length > 0 ? (
                <div className="space-y-2 max-h-[600px] overflow-y-auto">
                  {filteredVMs.map((vm: any) => (
                    <button
                      key={vm.name}
                      onClick={() => setSelectedVMName(vm.name)}
                      className={`w-full p-3 rounded-lg border transition-all text-left flex items-center justify-between ${
                        selectedVMName === vm.name
                          ? 'border-blue-500 bg-blue-50'
                          : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
                      }`}
                    >
                      <div className="flex items-center space-x-2 flex-1 min-w-0">
                        <Database className="h-4 w-4 text-gray-600 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium truncate">{vm.name}</div>
                          {vm.storagePoolName && (
                            <div className="text-xs text-gray-500 truncate">📁 {vm.storagePoolName}</div>
                          )}
                        </div>
                      </div>
                      <ChevronRight className="h-4 w-4 text-gray-400 flex-shrink-0" />
                    </button>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8 text-gray-500">
                  {searchQuery ? (
                    <>
                      <Search className="h-12 w-12 mx-auto mb-4 text-gray-400" />
                      <p>No VMs found matching "{searchQuery}"</p>
                      <button
                        onClick={() => setSearchQuery('')}
                        className="mt-2 text-sm text-blue-600 hover:text-blue-800"
                      >
                        Clear search
                      </button>
                    </>
                  ) : selectedPoolPath === 'all' ? (
                    'No VMs found on this host'
                  ) : (
                    'No VMs found in this storage pool'
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Right: VM Details */}
          <Card className="lg:col-span-2">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>
                  {selectedVMName ? `Backup Details: ${selectedVMName}` : 'Select a VM'}
                </CardTitle>
                {selectedVMName && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => refetchDetails()}
                    disabled={vmDetailsLoading || vmDetailsFetching}
                  >
                    <RefreshCw className={`h-4 w-4 mr-2 ${(vmDetailsLoading || vmDetailsFetching) ? 'animate-spin' : ''}`} />
                    {(vmDetailsLoading || vmDetailsFetching) ? 'Loading...' : 'Refresh'}
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {!selectedVMName ? (
                <div className="text-center py-12 text-gray-500">
                  <Database className="h-12 w-12 mx-auto mb-4 text-gray-400" />
                  <p>Select a VM from the list to view backup details</p>
                </div>
              ) : (vmDetailsLoading || vmDetailsFetching) ? (
                <div className="flex flex-col items-center justify-center py-12">
                  <Loader2 className="h-12 w-12 animate-spin text-gray-400 mb-4" />
                  <p className="text-gray-600">Loading backup details...</p>
                  <p className="text-sm text-gray-500 mt-2">This may take a few minutes</p>
                </div>
              ) : vmDetails ? (
                <div className="space-y-6">
                  {/* VM Summary */}
                  <div className="bg-gray-50 rounded-lg p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-gray-600">Health Status:</span>
                      {getHealthBadge(vmDetails.health)}
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-gray-600">Total Size:</span>
                      <span className="text-sm font-semibold">{vmDetails.total_disk_usage_gb}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-gray-600">Available Schedules:</span>
                      <span className="text-sm font-semibold">{vmDetails.available_schedule_count}</span>
                    </div>
                    {vmDetails.archived_backup_count > 0 && (
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-gray-600">Archived Backups:</span>
                        <span className="text-sm font-semibold">{vmDetails.archived_backup_count}</span>
                      </div>
                    )}
                    {vmDetails.corrupted_schedule_count > 0 && (
                      <div className="flex items-center justify-between text-red-600">
                        <span className="text-sm font-medium">Corrupted:</span>
                        <span className="text-sm font-semibold">{vmDetails.corrupted_schedule_count}</span>
                      </div>
                    )}
                  </div>

                  {/* Remove All Button */}
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      onClick={() => handleRestoreClick(vmDetails.vm_name)}
                      className="border-blue-600 text-blue-600 hover:bg-blue-50"
                    >
                      <RotateCcw className="h-4 w-4 mr-2" />
                      Restore Backup
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={() =>
                        setConfirmDelete({
                          type: 'vm',
                          vmName: vmDetails.vm_name,
                        })
                      }
                    >
                      <Trash2 className="h-4 w-4 mr-2" />
                      Remove All Backups
                    </Button>
                  </div>

                  {/* Schedules */}
                  <div className="space-y-4">
                    <h3 className="font-semibold text-lg">Backup Schedules</h3>
                    {vmDetails.schedules && vmDetails.schedules.length > 0 ? (
                      <div className="space-y-3">
                        {vmDetails.schedules.map((schedule: any, index: number) => {
                          if (!schedule.available) return null
                          
                          const isInProgress = schedule.in_progress === true || schedule.in_progress === 'true'
                          const isLegacyFormat = schedule.is_legacy_format === true || schedule.is_legacy_format === 'true'
                          
                          return (
                            <div
                              key={index}
                              className={`border rounded-lg p-4 ${
                                schedule.corrupted 
                                  ? 'border-red-300 bg-red-50' 
                                  : isInProgress
                                  ? 'border-blue-300 bg-blue-50'
                                  : 'border-gray-200 bg-white'
                              }`}
                            >
                              <div className="flex items-start justify-between mb-3">
                                <div className="flex items-center space-x-2 flex-wrap">
                                  {getScheduleIcon(schedule.schedule)}
                                  <Badge className={getScheduleBadgeColor(schedule.schedule)}>
                                    {schedule.archive_name || schedule.schedule}
                                  </Badge>
                                  {isLegacyFormat && (
                                    <Badge className="bg-amber-100 text-amber-800 border-amber-200">
                                      Legacy Format
                                    </Badge>
                                  )}
                                  {isInProgress && (
                                    <Badge className="bg-blue-100 text-blue-800 border-blue-200">
                                      <Loader2 className="h-3 w-3 mr-1 inline animate-spin" />
                                      In Progress
                                    </Badge>
                                  )}
                                  {schedule.corrupted && (
                                    <Badge className="bg-red-100 text-red-800 border-red-200">
                                      Corrupted
                                    </Badge>
                                  )}
                                </div>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() =>
                                    setConfirmDelete({
                                      type: 'schedule',
                                      vmName: vmDetails.vm_name,
                                      scheduleType: schedule.schedule,
                                      scheduleName: schedule.archive_name || schedule.schedule,
                                    })
                                  }
                                  disabled={isInProgress}
                                  title={isInProgress ? 'Cannot delete backup in progress' : 'Delete backup'}
                                >
                                  <Trash2 className={`h-4 w-4 ${isInProgress ? 'text-gray-400' : 'text-red-600'}`} />
                                </Button>
                              </div>
                              
                              <div className="grid grid-cols-2 gap-3 text-sm">
                                <div>
                                  <span className="text-gray-600">Size:</span>
                                  <span className="ml-2 font-medium">{schedule.disk_usage_gb}</span>
                                </div>
                                {schedule.dump_analysis && (
                                  <>
                                    <div>
                                      <span className="text-gray-600">Disks:</span>
                                      <span className="ml-2 font-medium">{schedule.dump_analysis.disk_count}</span>
                                    </div>
                                    <div>
                                      <span className="text-gray-600">Chain Depth:</span>
                                      <span className="ml-2 font-medium">{schedule.dump_analysis.chain_depth}</span>
                                    </div>
                                    <div>
                                      <span className="text-gray-600">Incremental:</span>
                                      <span className="ml-2 font-medium">
                                        {schedule.dump_analysis.has_incremental ? 'Yes' : 'No'}
                                      </span>
                                    </div>
                                  </>
                                )}
                              </div>

                              {schedule.dump_error && (
                                <div className="mt-3 text-sm text-red-600 bg-red-50 p-2 rounded">
                                  Error: {schedule.dump_error}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    ) : (
                      <div className="text-center py-8 text-gray-500">
                        No backup schedules found
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="text-center py-12 text-gray-500">
                  <AlertTriangle className="h-12 w-12 mx-auto mb-4 text-gray-400" />
                  <p>Failed to load backup details</p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
        </>
      )}

      {/* Confirmation Dialog */}
      {confirmDelete && createPortal(
        <div className="dialog-overlay flex items-start justify-center py-[5vh] px-4" onClick={() => setConfirmDelete(null)}>
          <div className="dialog-overlay-backdrop" />
          <Card className="relative w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <CardHeader className="border-b">
              <div className="flex items-center space-x-2">
                <AlertTriangle className="h-5 w-5 text-red-600" />
                <CardTitle>Confirm Deletion</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="p-6">
              <div className="space-y-4">
                <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                  <p className="text-sm text-red-800">
                    {confirmDelete.type === 'vm' ? (
                      <>
                        Are you sure you want to remove <strong>ALL backups</strong> for{' '}
                        <strong>{confirmDelete.vmName}</strong>?
                        <br />
                        <br />
                        This will delete all schedule types and cannot be undone.
                      </>
                    ) : (
                      <>
                        Are you sure you want to remove the{' '}
                        <strong>{confirmDelete.scheduleName}</strong> backup for{' '}
                        <strong>{confirmDelete.vmName}</strong>?
                        <br />
                        <br />
                        This action cannot be undone.
                      </>
                    )}
                  </p>
                </div>
              </div>
            </CardContent>
            <div className="border-t p-4 flex items-center justify-end space-x-2">
              <Button
                variant="outline"
                onClick={() => setConfirmDelete(null)}
                disabled={removeSchedule.isPending || removeVM.isPending}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  if (confirmDelete.type === 'vm') {
                    handleRemoveVM(confirmDelete.vmName)
                  } else if (confirmDelete.scheduleType) {
                    handleRemoveSchedule(
                      confirmDelete.vmName,
                      confirmDelete.scheduleType
                    )
                  }
                }}
                disabled={removeSchedule.isPending || removeVM.isPending}
              >
                {removeSchedule.isPending || removeVM.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Removing...
                  </>
                ) : (
                  <>
                    <Trash2 className="h-4 w-4 mr-2" />
                    Confirm Delete
                  </>
                )}
              </Button>
            </div>
          </Card>
        </div>,
        document.body
      )}

      {/* Restore Dialog */}
      <RestoreBackupDialog
        vmName={restoreVMName}
        backupHostId={restoreBackupHostId}
        open={restoreDialogOpen}
        onOpenChange={setRestoreDialogOpen}
        onRestoreStarted={handleRestoreStarted}
      />
    </div>
  )
}
