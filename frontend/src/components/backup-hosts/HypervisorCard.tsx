import { useState } from 'react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { 
  HardDrive, 
  ChevronDown, 
  ChevronUp, 
  RefreshCw, 
  Trash2,
  Edit,
  Monitor,
  Play,
  Power,
  Pause,
  Square,
  Wrench,
  Search,
  XCircle,
  Calendar,
  CheckSquare
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Hypervisor, VirtualMachine } from '@/types'
import { useVMsByHypervisor, useRefreshVMs, useDeleteHypervisor } from '@/hooks/useBackupHosts'
import TriggerBackupDialog from '../backups/TriggerBackupDialog'
import FixBackupDialog from '../backups/FixBackupDialog'
import EditHypervisorDialog from './EditHypervisorDialog'
import BulkScheduleDialog from '../schedules/BulkScheduleDialog'

interface HypervisorCardProps {
  hypervisor: Hypervisor
  backupHostId: string
}

// Get VM state display
function getVMStateDisplay(state: string) {
  const normalizedState = state?.toLowerCase().trim() || 'unknown';
  
  if (normalizedState === 'running') {
    return (
      <div className="flex items-center space-x-1.5">
        <span className="text-green-600 text-lg leading-none">●</span>
        <Play className="h-3.5 w-3.5 text-green-600 fill-green-600" />
        <span className="text-green-600 font-medium text-sm">Running</span>
      </div>
    );
  }
  if (normalizedState === 'paused') {
    return (
      <div className="flex items-center space-x-1.5">
        <span className="text-yellow-600 text-lg leading-none">●</span>
        <Pause className="h-3.5 w-3.5 text-yellow-600 fill-yellow-600" />
        <span className="text-yellow-600 font-medium text-sm">Paused</span>
      </div>
    );
  }
  if (normalizedState === 'shut off' || normalizedState === 'shutoff') {
    return (
      <div className="flex items-center space-x-1.5">
        <span className="text-red-600 text-lg leading-none">●</span>
        <Power className="h-3.5 w-3.5 text-red-600" />
        <span className="text-red-600 font-medium text-sm">Shutoff</span>
      </div>
    );
  }
  if (normalizedState === 'crashed') {
    return (
      <div className="flex items-center space-x-1.5">
        <span className="text-red-600 text-lg leading-none">●</span>
        <Square className="h-3.5 w-3.5 text-red-600" />
        <span className="text-red-600 font-medium text-sm">Crashed</span>
      </div>
    );
  }
  if (normalizedState === 'idle') {
    return (
      <div className="flex items-center space-x-1.5">
        <span className="text-blue-600 text-lg leading-none">●</span>
        <Power className="h-3.5 w-3.5 text-blue-600" />
        <span className="text-blue-600 font-medium text-sm">Idle</span>
      </div>
    );
  }
  if (normalizedState === 'in shutdown') {
    return (
      <div className="flex items-center space-x-1.5">
        <span className="text-orange-600 text-lg leading-none">●</span>
        <Power className="h-3.5 w-3.5 text-orange-600" />
        <span className="text-orange-600 font-medium text-sm">Shutting Down</span>
      </div>
    );
  }
  if (normalizedState === 'pmsuspended') {
    return (
      <div className="flex items-center space-x-1.5">
        <span className="text-purple-600 text-lg leading-none">●</span>
        <Pause className="h-3.5 w-3.5 text-purple-600" />
        <span className="text-purple-600 font-medium text-sm">PM Suspended</span>
      </div>
    );
  }
  
  return (
    <div className="flex items-center space-x-1.5">
      <span className="text-gray-600 text-lg leading-none">●</span>
      <Monitor className="h-3.5 w-3.5 text-gray-600" />
      <span className="text-gray-600 font-medium text-sm">{state || 'Unknown'}</span>
    </div>
  );
}

// Get VM state color and icon (kept for backward compatibility)
function getVMStateInfo(state: string): { color: string; icon: any; label: string } {
  const normalizedState = state?.toLowerCase().trim() || 'unknown';
  
  if (normalizedState === 'running') {
    return { 
      color: 'bg-green-100 text-green-800 border-green-200', 
      icon: Power, 
      label: 'Running' 
    };
  }
  if (normalizedState === 'shut off' || normalizedState === 'shutoff') {
    return { 
      color: 'bg-gray-100 text-gray-800 border-gray-200', 
      icon: Square, 
      label: 'Shut Off' 
    };
  }
  if (normalizedState === 'paused') {
    return { 
      color: 'bg-yellow-100 text-yellow-800 border-yellow-200', 
      icon: Pause, 
      label: 'Paused' 
    };
  }
  if (normalizedState === 'crashed') {
    return { 
      color: 'bg-red-100 text-red-800 border-red-200', 
      icon: Square, 
      label: 'Crashed' 
    };
  }
  if (normalizedState === 'idle') {
    return { 
      color: 'bg-blue-100 text-blue-800 border-blue-200', 
      icon: Power, 
      label: 'Idle' 
    };
  }
  if (normalizedState === 'in shutdown') {
    return { 
      color: 'bg-orange-100 text-orange-800 border-orange-200', 
      icon: Power, 
      label: 'Shutting Down' 
    };
  }
  if (normalizedState === 'pmsuspended') {
    return { 
      color: 'bg-purple-100 text-purple-800 border-purple-200', 
      icon: Pause, 
      label: 'PM Suspended' 
    };
  }
  
  return { 
    color: 'bg-gray-100 text-gray-600 border-gray-200', 
    icon: Monitor, 
    label: state || 'Unknown' 
  };
}

export default function HypervisorCard({ hypervisor, backupHostId }: HypervisorCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [selectedVM, setSelectedVM] = useState<VirtualMachine | null>(null)
  const [fixBackupVM, setFixBackupVM] = useState<VirtualMachine | null>(null)
  const [showEditDialog, setShowEditDialog] = useState(false)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState<string>('')
  const [selectedVMsForSchedule, setSelectedVMsForSchedule] = useState<Set<string>>(new Set())
  const [showBulkScheduleDialog, setShowBulkScheduleDialog] = useState(false)
  
  const { data: vms, isLoading, refetch } = useVMsByHypervisor(hypervisor.id)
  const refreshVMs = useRefreshVMs()
  const deleteHypervisor = useDeleteHypervisor()

  const handleDelete = () => {
    if (confirm(`Are you sure you want to delete hypervisor "${hypervisor.name}"?`)) {
      deleteHypervisor.mutate(hypervisor.id)
    }
  }

  const handleRefresh = async () => {
    await refreshVMs.mutateAsync(hypervisor.id)
    refetch()
  }

  const handleToggleVMForSchedule = (vmId: string) => {
    setSelectedVMsForSchedule(prev => {
      const newSet = new Set(prev)
      if (newSet.has(vmId)) {
        newSet.delete(vmId)
      } else {
        newSet.add(vmId)
      }
      return newSet
    })
  }

  const handleSelectAllForSchedule = (filter?: 'all' | 'running' | 'paused' | 'shutoff') => {
    if (filter === undefined) {
      // Toggle behavior - if all are selected, deselect all
      if (selectedVMsForSchedule.size === filteredVMs.length) {
        setSelectedVMsForSchedule(new Set())
      } else {
        setSelectedVMsForSchedule(new Set(filteredVMs.map(vm => vm.id)))
      }
      return
    }

    // Filter-based selection
    let vmsToSelect: VirtualMachine[] = []
    
    switch (filter) {
      case 'all':
        vmsToSelect = filteredVMs
        break
      case 'running':
        vmsToSelect = filteredVMs.filter(vm => vm.state === 'running')
        break
      case 'paused':
        vmsToSelect = filteredVMs.filter(vm => vm.state === 'paused')
        break
      case 'shutoff':
        vmsToSelect = filteredVMs.filter(vm => vm.state === 'shut off' || vm.state === 'shutoff')
        break
    }
    
    setSelectedVMsForSchedule(new Set(vmsToSelect.map(vm => vm.id)))
  }

  const handleBulkSchedule = () => {
    if (selectedVMsForSchedule.size === 0) {
      alert('Please select at least one VM')
      return
    }
    setShowBulkScheduleDialog(true)
  }

  // Filter VMs by search query
  const filteredVMs = vms?.filter(vm => {
    if (!searchQuery.trim()) return true
    return vm.name.toLowerCase().includes(searchQuery.toLowerCase().trim())
  }) || []

  // Count VMs by state (from filtered list)
  const runningCount = filteredVMs.filter(vm => vm.state?.toLowerCase() === 'running').length
  const stoppedCount = filteredVMs.filter(vm => vm.state?.toLowerCase().includes('shut')).length
  const otherCount = filteredVMs.length - runningCount - stoppedCount

  return (
    <>
      <Card className="border-l-4 border-l-purple-500">
        <div className="p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-purple-100 rounded-lg">
                <HardDrive className="h-5 w-5 text-purple-600" />
              </div>
              <div>
                <div className="flex items-center space-x-2">
                  <h4 className="font-medium">{hypervisor.name}</h4>
                  <Badge 
                    className={hypervisor.status === 'connected' 
                      ? 'bg-green-100 text-green-800' 
                      : 'bg-red-100 text-red-800'
                    } 
                    variant="outline"
                  >
                    {hypervisor.status}
                  </Badge>
                </div>
                <p className="text-sm text-gray-500 font-mono">
                  {hypervisor.ip}:{hypervisor.port}
                </p>
              </div>
            </div>

            <div className="flex items-center space-x-4">
              {/* VM Summary */}
              <div className="flex items-center space-x-2 text-sm">
                <span className="text-gray-600">
                  {vms?.length || 0} VM{(vms?.length || 0) !== 1 ? 's' : ''}
                </span>
                {runningCount > 0 && (
                  <Badge className="bg-green-100 text-green-800 text-xs">
                    {runningCount} running
                  </Badge>
                )}
                {stoppedCount > 0 && (
                  <Badge className="bg-gray-100 text-gray-600 text-xs">
                    {stoppedCount} stopped
                  </Badge>
                )}
              </div>
              
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowEditDialog(true)}
                title="Edit Hypervisor"
              >
                <Edit className="h-4 w-4" />
              </Button>

              <Button
                variant="ghost"
                size="sm"
                onClick={handleRefresh}
                disabled={refreshVMs.isPending}
                title="Refresh VMs"
              >
                <RefreshCw className={cn("h-4 w-4", refreshVMs.isPending && "animate-spin")} />
              </Button>

              <Button
                variant="ghost"
                size="sm"
                onClick={handleDelete}
                disabled={deleteHypervisor.isPending}
                title="Delete Hypervisor"
              >
                <Trash2 className="h-4 w-4 text-red-600" />
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

          {expanded && (
            <div className="mt-4 pl-10">
              {/* Search Bar and Bulk Actions */}
              {vms && vms.length > 0 && (
                <div className="mb-4 space-y-3">
                  <div className="relative max-w-md">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search VMs..."
                      className="w-full pl-10 pr-10 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    />
                    {searchQuery && (
                      <button
                        onClick={() => setSearchQuery('')}
                        className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600"
                      >
                        <XCircle className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                  
                  {/* Bulk Schedule Actions */}
                  <div className="flex items-center gap-2">
                    <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                        >
                          <CheckSquare className="h-4 w-4 mr-2" />
                          {selectedVMsForSchedule.size === filteredVMs.length && filteredVMs.length > 0
                            ? 'Deselect All'
                            : selectedVMsForSchedule.size > 0
                              ? `Selected (${selectedVMsForSchedule.size})`
                              : 'Select VMs'}
                          <ChevronDown className="h-4 w-4 ml-2" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start">
                        <DropdownMenuItem onClick={() => {
                          handleSelectAllForSchedule('all')
                          setDropdownOpen(false)
                        }}>
                          <CheckSquare className="h-4 w-4 mr-2" />
                          Select All ({filteredVMs.length})
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => {
                          handleSelectAllForSchedule('running')
                          setDropdownOpen(false)
                        }}>
                          <Play className="h-4 w-4 mr-2 text-green-600" />
                          Select Running ({filteredVMs.filter(vm => vm.state === 'running').length})
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => {
                          handleSelectAllForSchedule('paused')
                          setDropdownOpen(false)
                        }}>
                          <Pause className="h-4 w-4 mr-2 text-yellow-600" />
                          Select Paused ({filteredVMs.filter(vm => vm.state === 'paused').length})
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => {
                          handleSelectAllForSchedule('shutoff')
                          setDropdownOpen(false)
                        }}>
                          <Power className="h-4 w-4 mr-2 text-gray-600" />
                          Select Shutoff ({filteredVMs.filter(vm => vm.state === 'shut off' || vm.state === 'shutoff').length})
                        </DropdownMenuItem>
                        {selectedVMsForSchedule.size > 0 && (
                          <DropdownMenuItem onClick={() => {
                            setSelectedVMsForSchedule(new Set())
                            setDropdownOpen(false)
                          }}>
                            <XCircle className="h-4 w-4 mr-2 text-red-600" />
                            Clear Selection
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    
                    {selectedVMsForSchedule.size > 0 && (
                      <Button
                        type="button"
                        variant="default"
                        size="sm"
                        onClick={handleBulkSchedule}
                      >
                        <Calendar className="h-4 w-4 mr-2" />
                        Schedule Backup ({selectedVMsForSchedule.size} VMs)
                      </Button>
                    )}
                  </div>
                  
                  {searchQuery && (
                    <p className="text-xs text-gray-500">
                      Showing {filteredVMs.length} of {vms.length} VMs
                    </p>
                  )}
                </div>
              )}

              {isLoading ? (
                <p className="text-sm text-gray-500">Loading VMs...</p>
              ) : filteredVMs.length > 0 ? (
                <div className="space-y-2">
                  {/* Sort VMs: running first, then shut off, then others */}
                  {[...filteredVMs]
                    .sort((a, b) => {
                      const stateOrder = (state: string) => {
                        const s = state?.toLowerCase() || '';
                        if (s === 'running') return 0;
                        if (s.includes('shut')) return 1;
                        return 2;
                      };
                      return stateOrder(a.state) - stateOrder(b.state);
                    })
                    .map((vm) => {
                      return (
                        <div
                          key={vm.id}
                          className={cn(
                            "flex items-center justify-between p-3 rounded-lg border transition-colors",
                            vm.selected ? "bg-blue-50 border-blue-200" : "bg-gray-50 border-gray-100 hover:bg-gray-100"
                          )}
                        >
                          <div className="flex items-center space-x-3">
                            {/* Schedule Selection Checkbox */}
                            <Checkbox
                              checked={selectedVMsForSchedule.has(vm.id)}
                              onChange={() => handleToggleVMForSchedule(vm.id)}
                              title="Select for bulk schedule"
                            />
                            <Monitor className="h-4 w-4 text-gray-500" />
                            <span className="font-medium">{vm.name}</span>
                            {getVMStateDisplay(vm.state)}
                          </div>

                          <div className="flex items-center space-x-2">
                            {vm.selected && (
                              <span className="text-xs text-green-600 mr-2">
                                ✓ Backup enabled
                              </span>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setSelectedVM(vm)}
                              title="Trigger Backup Now"
                            >
                              <Play className="h-4 w-4 text-blue-600" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setFixBackupVM(vm)}
                              title="Fix Backup - Reset checkpoint metadata"
                            >
                              <Wrench className="h-4 w-4 text-orange-600" />
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                </div>
              ) : vms && vms.length > 0 ? (
                <div className="text-center py-4 border border-dashed border-gray-200 rounded-lg">
                  <p className="text-sm text-gray-500">No VMs found matching "{searchQuery}"</p>
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => setSearchQuery('')}
                    className="mt-1"
                  >
                    Clear search
                  </Button>
                </div>
              ) : (
                <div className="text-center py-4 border border-dashed border-gray-200 rounded-lg">
                  <p className="text-sm text-gray-500">No VMs found</p>
                  <Button
                    variant="link"
                    size="sm"
                    onClick={handleRefresh}
                    className="mt-1"
                  >
                    <RefreshCw className="h-3 w-3 mr-1" />
                    Refresh VM List
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </Card>

      {selectedVM && (
        <TriggerBackupDialog
          vmId={selectedVM.id}
          onClose={() => setSelectedVM(null)}
        />
      )}

      {fixBackupVM && (
        <FixBackupDialog
          vmId={fixBackupVM.id}
          vmName={fixBackupVM.name}
          hypervisorIp={hypervisor.ip}
          backupHostId={backupHostId}
          onClose={() => setFixBackupVM(null)}
        />
      )}

      {showEditDialog && (
        <EditHypervisorDialog
          open={showEditDialog}
          onOpenChange={setShowEditDialog}
          hypervisor={hypervisor}
        />
      )}

      {showBulkScheduleDialog && (
        <BulkScheduleDialog
          vmIds={Array.from(selectedVMsForSchedule)}
          backupHostId={backupHostId}
          hypervisorId={hypervisor.id}
          onClose={() => {
            setShowBulkScheduleDialog(false)
            setSelectedVMsForSchedule(new Set())
          }}
        />
      )}
    </>
  )
}
