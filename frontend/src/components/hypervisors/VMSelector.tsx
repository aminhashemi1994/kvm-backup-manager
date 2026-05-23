import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { X, Loader2, CheckCircle, Play, Pause, Power, Wrench } from 'lucide-react'
import { useVMsByHypervisor, useUpdateVM, useSelectMultipleVMs } from '@/hooks/useHypervisors'
import { useTriggerBackup } from '@/hooks/useBackups'
import TriggerBackupDialog from '../backups/TriggerBackupDialog'
import FixBackupDialog from '../backups/FixBackupDialog'

interface VMSelectorProps {
  hypervisorId: string
  hypervisorIp: string
  backupHostId: string
  onClose: () => void
}

const getVMStatusIcon = (state: string) => {
  const stateLower = state.toLowerCase()
  
  if (stateLower === 'running') {
    return (
      <div className="flex items-center space-x-1.5">
        <span className="text-green-600 text-lg leading-none">●</span>
        <Play className="h-3.5 w-3.5 text-green-600 fill-green-600" />
        <span className="text-green-600 font-medium">{state}</span>
      </div>
    )
  } else if (stateLower === 'paused') {
    return (
      <div className="flex items-center space-x-1.5">
        <span className="text-yellow-600 text-lg leading-none">●</span>
        <Pause className="h-3.5 w-3.5 text-yellow-600 fill-yellow-600" />
        <span className="text-yellow-600 font-medium">{state}</span>
      </div>
    )
  } else if (stateLower === 'shutoff' || stateLower === 'shut off') {
    return (
      <div className="flex items-center space-x-1.5">
        <span className="text-red-600 text-lg leading-none">●</span>
        <Power className="h-3.5 w-3.5 text-red-600" />
        <span className="text-red-600 font-medium">{state}</span>
      </div>
    )
  }
  
  return (
    <div className="flex items-center space-x-1.5">
      <span className="text-gray-600 text-lg leading-none">●</span>
      <span className="text-gray-600 font-medium">{state}</span>
    </div>
  )
}

export default function VMSelector({ hypervisorId, hypervisorIp, backupHostId, onClose }: VMSelectorProps) {
  const { data: vms, isLoading } = useVMsByHypervisor(hypervisorId)
  const updateVM = useUpdateVM()
  const selectMultiple = useSelectMultipleVMs()
  
  const [selectedVMs, setSelectedVMs] = useState<string[]>([])
  const [backupVmId, setBackupVmId] = useState<string | null>(null)
  const [fixBackupVm, setFixBackupVm] = useState<{ id: string; name: string } | null>(null)

  console.log('VMSelector render:', { hypervisorId, vmsCount: vms?.length, backupVmId })

  const handleToggleVM = async (vmId: string, selected: boolean) => {
    await updateVM.mutateAsync({ id: vmId, data: { selected } })
  }

  const handleSelectAll = () => {
    if (vms) {
      const allIds = vms.map(vm => vm.id)
      setSelectedVMs(allIds)
    }
  }

  const handleDeselectAll = () => {
    setSelectedVMs([])
  }

  const handleApplySelection = async () => {
    if (vms) {
      const vmIds = vms.map(vm => vm.id)
      await selectMultiple.mutateAsync({ 
        vmIds, 
        selected: selectedVMs.includes(vmIds[0]) 
      })
    }
  }

  return (
    <>
      {createPortal(
        <div className="dialog-overlay flex items-start justify-center py-[5vh] px-4" onClick={onClose}>
          <div className="dialog-overlay-backdrop" />
        <Card className="relative w-full max-w-4xl flex flex-col" onClick={(e) => e.stopPropagation()}>
          <CardHeader className="border-b">
            <div className="flex items-center justify-between">
              <CardTitle>Virtual Machines</CardTitle>
              <Button variant="ghost" size="icon" onClick={onClose}>
                <X className="h-5 w-5" />
              </Button>
            </div>
            <p className="text-sm text-gray-600 mt-2">
              Select VMs to include in backup schedules
            </p>
          </CardHeader>
          
          <CardContent className="flex-1 overflow-y-auto p-6">
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
              </div>
            ) : vms && vms.length > 0 ? (
              <>
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center space-x-2">
                    <Button variant="outline" size="sm" onClick={handleSelectAll}>
                      Select All
                    </Button>
                    <Button variant="outline" size="sm" onClick={handleDeselectAll}>
                      Deselect All
                    </Button>
                  </div>
                  <p className="text-sm text-gray-600">
                    {vms.filter(vm => vm.selected).length} of {vms.length} selected
                  </p>
                </div>

                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-12">
                        <Checkbox />
                      </TableHead>
                      <TableHead>VM Name</TableHead>
                      <TableHead>State</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {vms.map((vm) => (
                      <TableRow key={vm.id}>
                        <TableCell>
                          <Checkbox
                            checked={vm.selected}
                            onChange={(e: any) => handleToggleVM(vm.id, e.target.checked)}
                          />
                        </TableCell>
                        <TableCell className="font-medium">{vm.name}</TableCell>
                        <TableCell>
                          {getVMStatusIcon(vm.state)}
                        </TableCell>
                        <TableCell>
                          {vm.selected && (
                            <div className="flex items-center text-green-600">
                              <CheckCircle className="h-4 w-4 mr-1" />
                              <span className="text-xs">Included in backups</span>
                            </div>
                          )}
                        </TableCell>
                        <TableCell>
                          {vm.selected && (
                            <div className="flex items-center space-x-2">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  console.log('Backup button clicked for VM:', vm.id, vm.name)
                                  setBackupVmId(vm.id)
                                }}
                              >
                                <Play className="h-4 w-4 mr-2" />
                                Backup Now
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  console.log('Fix backup button clicked for VM:', vm.id, vm.name)
                                  setFixBackupVm({ id: vm.id, name: vm.name })
                                }}
                                title="Fix Backup - Reset checkpoint metadata"
                              >
                                <Wrench className="h-4 w-4" />
                              </Button>
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </>
            ) : (
              <div className="text-center py-8">
                <p className="text-gray-500">No VMs found on this hypervisor</p>
                <p className="text-sm text-gray-400 mt-2">
                  Make sure the hypervisor is accessible and VMs are running
                </p>
              </div>
            )}
          </CardContent>

          <div className="border-t p-4 flex items-center justify-end space-x-2">
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          </div>
        </Card>
      </div>,
      document.body
      )}

      {backupVmId && (
        <TriggerBackupDialog
          vmId={backupVmId}
          onClose={() => setBackupVmId(null)}
        />
      )}

      {fixBackupVm && (
        <FixBackupDialog
          vmId={fixBackupVm.id}
          vmName={fixBackupVm.name}
          hypervisorIp={hypervisorIp}
          backupHostId={backupHostId}
          onClose={() => setFixBackupVm(null)}
        />
      )}
    </>
  )
}
