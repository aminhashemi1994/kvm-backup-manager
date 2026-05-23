import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Plus, Server, Loader2 } from 'lucide-react'
import BackupHostCard from '@/components/backup-hosts/BackupHostCard'
import AddBackupHostDialog from '@/components/backup-hosts/AddBackupHostDialog'
import { useBackupHosts } from '@/hooks/useBackupHosts'

export default function BackupHostsPage() {
  const [showAddDialog, setShowAddDialog] = useState(false)
  const { data: backupHosts, isLoading } = useBackupHosts()

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Backup Hosts</h1>
          <p className="text-gray-600 mt-2">
            Manage your backup infrastructure - hosts, hypervisors, and VMs
          </p>
        </div>
        <Button onClick={() => setShowAddDialog(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Add Backup Host
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
        </div>
      ) : backupHosts && backupHosts.length > 0 ? (
        <div className="space-y-6">
          {backupHosts.map((host) => (
            <BackupHostCard key={host.id} backupHost={host} />
          ))}
        </div>
      ) : (
        <div className="text-center py-12 bg-white rounded-lg border">
          <Server className="h-12 w-12 text-gray-400 mx-auto" />
          <h3 className="mt-4 text-lg font-medium text-gray-900">No backup hosts</h3>
          <p className="mt-2 text-gray-500">
            Get started by adding your first backup host
          </p>
          <Button className="mt-4" onClick={() => setShowAddDialog(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Add Backup Host
          </Button>
        </div>
      )}

      <AddBackupHostDialog 
        open={showAddDialog} 
        onOpenChange={setShowAddDialog} 
      />
    </div>
  )
}
