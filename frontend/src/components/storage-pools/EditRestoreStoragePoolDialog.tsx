import { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Loader2 } from 'lucide-react'
import { RestoreStoragePool, useUpdateRestoreStoragePool } from '@/hooks/useStoragePools'

interface EditRestoreStoragePoolDialogProps {
  pool: RestoreStoragePool
  open: boolean
  onOpenChange: (open: boolean) => void
}

export default function EditRestoreStoragePoolDialog({
  pool,
  open,
  onOpenChange,
}: EditRestoreStoragePoolDialogProps) {
  const [formData, setFormData] = useState({
    name: pool.name,
    path: pool.path,
  })

  const updatePool = useUpdateRestoreStoragePool()

  useEffect(() => {
    if (open) {
      setFormData({
        name: pool.name,
        path: pool.path,
      })
    }
  }, [open, pool])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    updatePool.mutate(
      { id: pool.id, data: formData },
      {
        onSuccess: () => {
          onOpenChange(false)
        },
      }
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Restore Storage Pool</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="name">Pool Name *</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="path">Path *</Label>
              <Input
                id="path"
                value={formData.path}
                onChange={(e) => setFormData({ ...formData, path: e.target.value })}
                required
              />
              <p className="text-xs text-gray-500">
                Path where VMs will be restored to
              </p>
            </div>

            <div className="p-3 bg-gray-50 rounded-lg space-y-1">
              <p className="text-xs text-gray-600">Current Details:</p>
              <p className="text-xs font-mono">Mount: {pool.mountPoint}</p>
              <p className="text-xs font-mono">Device: {pool.device}</p>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={updatePool.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={updatePool.isPending}>
              {updatePool.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
