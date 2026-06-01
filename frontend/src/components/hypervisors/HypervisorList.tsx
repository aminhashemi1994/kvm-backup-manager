import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Plus, Trash2, RefreshCw, Server, Loader2 } from 'lucide-react'
import AddHypervisorDialog from './AddHypervisorDialog'
import VMSelector from './VMSelector'
import { useHypervisors, useDeleteHypervisor, useRefreshVMs } from '@/hooks/useHypervisors'
import { Badge } from '@/components/ui/badge'
import { getStatusColor } from '@/lib/utils'
import { useConfirm } from '@/components/ui/confirm-dialog'

export default function HypervisorList() {
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [selectedHypervisor, setSelectedHypervisor] = useState<string | null>(null)
  
  const { data: hypervisors, isLoading } = useHypervisors()
  const deleteHypervisor = useDeleteHypervisor()
  const refreshVMs = useRefreshVMs()
  const confirm = useConfirm()

  const handleDelete = async (id: string, name: string) => {
    const ok = await confirm({
      title: 'Delete hypervisor?',
      description: `This will delete the hypervisor "${name}" and all of its virtual machines from the panel.`,
      confirmText: 'Delete',
      variant: 'danger',
    })
    if (ok) await deleteHypervisor.mutateAsync(id)
  }

  const handleRefreshVMs = async (id: string) => {
    await refreshVMs.mutateAsync(id)
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Hypervisors</CardTitle>
            <Button onClick={() => setShowAddDialog(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Add Hypervisor
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
            </div>
          ) : hypervisors && hypervisors.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>IP Address</TableHead>
                  <TableHead>VMs</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {hypervisors.map((hypervisor) => (
                  <TableRow key={hypervisor.id}>
                    <TableCell className="font-medium">{hypervisor.name}</TableCell>
                    <TableCell className="font-mono text-sm">
                      {hypervisor.ip}:{hypervisor.port}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setSelectedHypervisor(hypervisor.id)}
                      >
                        <Server className="h-4 w-4 mr-2" />
                        {hypervisor.vmCount} VMs
                      </Button>
                    </TableCell>
                    <TableCell>
                      <Badge className={getStatusColor(hypervisor.status)}>
                        {hypervisor.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center space-x-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRefreshVMs(hypervisor.id)}
                          disabled={refreshVMs.isPending}
                          title="Refresh VMs"
                        >
                          <RefreshCw className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(hypervisor.id, hypervisor.name)}
                          disabled={deleteHypervisor.isPending}
                        >
                          <Trash2 className="h-4 w-4 text-red-600" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="text-center py-8">
              <p className="text-gray-500">No hypervisors found</p>
              <Button
                variant="outline"
                className="mt-4"
                onClick={() => setShowAddDialog(true)}
              >
                <Plus className="h-4 w-4 mr-2" />
                Add Your First Hypervisor
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {selectedHypervisor && hypervisors && (
        <VMSelector
          hypervisorId={selectedHypervisor}
          hypervisorIp={hypervisors.find(h => h.id === selectedHypervisor)?.ip || ''}
          backupHostId={hypervisors.find(h => h.id === selectedHypervisor)?.backupHostId || ''}
          onClose={() => setSelectedHypervisor(null)}
        />
      )}

      <AddHypervisorDialog open={showAddDialog} onOpenChange={setShowAddDialog} />
    </>
  )
}
