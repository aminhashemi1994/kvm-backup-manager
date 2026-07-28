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
  diskUsageThreshold: number
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
      diskUsageThreshold: pool.diskUsageThreshold ?? 80,
    },
  })

  useEffect(() => {
    if (open) {
      reset({ name: pool.name, diskUsageThreshold: pool.diskUsageThreshold ?? 80 })
    }
  }, [open, pool.name, pool.diskUsageThreshold, reset])

  const onSubmit = async (data: FormData) => {
    try {
      await updateMutation.mutateAsync({
        id: pool.id,
        data: {
          name: data.name,
          diskUsageThreshold: Number(data.diskUsageThreshold),
        },
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
            <Label htmlFor="diskUsageThreshold">Disk Usage Threshold (%)</Label>
            <Input
              id="diskUsageThreshold"
              type="number"
              min={1}
              max={100}
              {...register('diskUsageThreshold', {
                required: 'Threshold is required',
                min: { value: 1, message: 'Must be between 1 and 100' },
                max: { value: 100, message: 'Must be between 1 and 100' },
                valueAsNumber: true,
              })}
            />
            {errors.diskUsageThreshold && (
              <p className="text-sm text-red-600">{errors.diskUsageThreshold.message}</p>
            )}
            <p className="text-sm text-gray-500">
              Backups (including offsite syncs) are refused when this pool — or an
              offsite destination — is used above this percentage.
            </p>
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
