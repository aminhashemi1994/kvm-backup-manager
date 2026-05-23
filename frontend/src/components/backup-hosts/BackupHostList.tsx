import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Plus, Trash2, CheckCircle, Loader2 } from 'lucide-react'
import AddBackupHostDialog from './AddBackupHostDialog'
import { useBackupHosts, useDeleteBackupHost } from '@/hooks/useBackupHosts'
import { Badge } from '@/components/ui/badge'
import { getStatusColor } from '@/lib/utils'

export default function BackupHostList() {
  const [showAddDialog, setShowAddDialog] = useState(false)
  const { data: hosts, isLoading } = useBackupHosts()
  const deleteHost = useDeleteBackupHost()

  const handleDelete = async (id: string, name: string) => {
    if (confirm(`Are you sure you want to delete offsite host "${name}"?`)) {
      await deleteHost.mutateAsync(id)
    }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Offsite Backup Hosts</CardTitle>
            <Button onClick={() => setShowAddDialog(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Add Offsite Host
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
            </div>
          ) : hosts && hosts.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>IP Address</TableHead>
                  <TableHead>Path</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {hosts.map((host) => (
                  <TableRow key={host.id}>
                    <TableCell className="font-medium">{host.name}</TableCell>
                    <TableCell className="font-mono text-sm">
                      {host.ip}:{host.port}
                    </TableCell>
                    <TableCell className="font-mono text-sm">{host.path}</TableCell>
                    <TableCell>
                      <Badge className={getStatusColor(host.status)}>
                        {host.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDelete(host.id, host.name)}
                        disabled={deleteHost.isPending}
                      >
                        <Trash2 className="h-4 w-4 text-red-600" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="text-center py-8">
              <p className="text-gray-500">No offsite backup hosts configured</p>
              <Button
                variant="outline"
                className="mt-4"
                onClick={() => setShowAddDialog(true)}
              >
                <Plus className="h-4 w-4 mr-2" />
                Add Offsite Host
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <AddBackupHostDialog open={showAddDialog} onOpenChange={setShowAddDialog} />
    </>
  )
}
