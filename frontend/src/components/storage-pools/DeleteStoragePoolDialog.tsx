import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Loader2, AlertTriangle } from 'lucide-react'
import { StoragePool, useDeleteStoragePool } from '@/hooks/useStoragePools'

interface DeleteStoragePoolDialogProps {
  pool: StoragePool
  open: boolean
  onOpenChange: (open: boolean) => void
}

export default function DeleteStoragePoolDialog({
  pool,
  open,
  onOpenChange,
}: DeleteStoragePoolDialogProps) {
  const deleteMutation = useDeleteStoragePool()

  const handleDelete = async () => {
    try {
      await deleteMutation.mutateAsync(pool.id)
      onOpenChange(false)
    } catch (error) {
      // Error is handled by the mutation
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-red-600">
            <AlertTriangle className="h-5 w-5" />
            Delete Storage Pool
          </DialogTitle>
          <DialogDescription className="space-y-3 pt-4">
            <p className="text-base">
              Are you sure you want to delete the storage pool <strong className="text-foreground">{pool.name}</strong>?
            </p>
            <div className="bg-red-50 border border-red-200 rounded-md p-3">
              <p className="text-red-800 font-medium text-sm">
                ⚠️ Warning: This will prevent new backups from being created to this storage pool.
                Existing backups will not be deleted.
              </p>
            </div>
            <p className="text-sm text-muted-foreground">
              Path: <code className="bg-gray-100 px-2 py-1 rounded text-xs">{pool.path}</code>
            </p>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={deleteMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={handleDelete}
            disabled={deleteMutation.isPending}
          >
            {deleteMutation.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Delete Storage Pool
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
