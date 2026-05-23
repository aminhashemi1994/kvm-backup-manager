import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { RestoreStoragePool, useDeleteRestoreStoragePool } from '@/hooks/useStoragePools'

interface DeleteRestoreStoragePoolDialogProps {
  pool: RestoreStoragePool
  open: boolean
  onOpenChange: (open: boolean) => void
}

export default function DeleteRestoreStoragePoolDialog({
  pool,
  open,
  onOpenChange,
}: DeleteRestoreStoragePoolDialogProps) {
  const deletePool = useDeleteRestoreStoragePool()

  const handleDelete = () => {
    deletePool.mutate(pool.id, {
      onSuccess: () => {
        onOpenChange(false)
      },
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-full bg-red-100 flex items-center justify-center">
              <AlertTriangle className="h-5 w-5 text-red-600" />
            </div>
            <div>
              <DialogTitle>Delete Restore Storage Pool</DialogTitle>
              <DialogDescription>
                This action cannot be undone
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="py-4">
          <p className="text-sm text-gray-600">
            Are you sure you want to delete the restore storage pool <strong>{pool.name}</strong>?
          </p>
          <div className="mt-4 p-3 bg-gray-50 rounded-lg">
            <p className="text-sm font-mono text-gray-700">{pool.path}</p>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={deletePool.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={deletePool.isPending}
          >
            {deletePool.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Delete Pool
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
