import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Loader2 } from 'lucide-react'
import { StoragePool, useUpdateStoragePool } from '@/hooks/useStoragePools'

interface EditStoragePoolDialogProps {
  pool: StoragePool
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface FormData {
  name: string
}

export default function EditStoragePoolDialog({
  pool,
  open,
  onOpenChange,
}: EditStoragePoolDialogProps) {
  const updateMutation = useUpdateStoragePool()

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormData>({
    defaultValues: {
      name: pool.name,
    },
  })

  useEffect(() => {
    if (open) {
      reset({ name: pool.name })
    }
  }, [open, pool.name, reset])

  const onSubmit = async (data: FormData) => {
    try {
      await updateMutation.mutateAsync({
        id: pool.id,
        data,
      })
      onOpenChange(false)
    } catch (error) {
      // Error is handled by the mutation
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Edit Storage Pool</DialogTitle>
          <DialogDescription>
            Update the storage pool name. The path cannot be changed.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Pool Name *</Label>
            <Input
              id="name"
              {...register('name', { required: 'Name is required' })}
            />
            {errors.name && (
              <p className="text-sm text-red-600">{errors.name.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label>Storage Path</Label>
            <Input value={pool.path} disabled className="bg-gray-50" />
            <p className="text-sm text-gray-500">
              Path cannot be changed after creation
            </p>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={updateMutation.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Save Changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
