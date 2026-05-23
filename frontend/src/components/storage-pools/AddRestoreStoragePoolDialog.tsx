import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Loader2 } from 'lucide-react'
import { useBackupHosts } from '@/hooks/useBackupHosts'
import { useCreateRestoreStoragePool } from '@/hooks/useStoragePools'

interface AddRestoreStoragePoolDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export default function AddRestoreStoragePoolDialog({
  open,
  onOpenChange,
}: AddRestoreStoragePoolDialogProps) {
  const [formData, setFormData] = useState({
    backupHostId: '',
    name: '',
    path: '',
  })

  const { data: backupHosts, isLoading: hostsLoading } = useBackupHosts()
  const createPool = useCreateRestoreStoragePool()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    createPool.mutate(formData, {
      onSuccess: () => {
        setFormData({ backupHostId: '', name: '', path: '' })
        onOpenChange(false)
      },
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add Restore Storage Pool</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="backupHost">Backup Host *</Label>
              <Select
                value={formData.backupHostId}
                onChange={(e) =>
                  setFormData({ ...formData, backupHostId: e.target.value })
                }
                disabled={hostsLoading}
              >
                <option value="">Select backup host</option>
                {backupHosts?.map((host) => (
                  <option key={host.id} value={host.id}>
                    {host.name} ({host.url})
                  </option>
                ))}
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="name">Pool Name *</Label>
              <Input
                id="name"
                placeholder="e.g., Restore_Pool_1"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="path">Path *</Label>
              <Input
                id="path"
                placeholder="/opt/kvm_pool/restore"
                value={formData.path}
                onChange={(e) => setFormData({ ...formData, path: e.target.value })}
                required
              />
              <p className="text-xs text-gray-500">
                Path where VMs will be restored to
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={createPool.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={createPool.isPending}>
              {createPool.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Add Restore Pool
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
