import { useState } from 'react'
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
import { Select } from '@/components/ui/select'
import { Loader2, AlertCircle } from 'lucide-react'
import { useBackupHosts } from '@/hooks/useBackupHosts'
import { useCreateStoragePool } from '@/hooks/useStoragePools'
import { Alert, AlertDescription } from '@/components/ui/alert'

interface AddStoragePoolDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface FormData {
  name: string
  path: string
  backupHostId: string
}

export default function AddStoragePoolDialog({
  open,
  onOpenChange,
}: AddStoragePoolDialogProps) {
  const { data: backupHosts } = useBackupHosts()
  const createMutation = useCreateStoragePool()
  const [selectedHostId, setSelectedHostId] = useState('')

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormData>()

  const onSubmit = async (data: FormData) => {
    try {
      await createMutation.mutateAsync({
        ...data,
        backupHostId: selectedHostId,
      })
      reset()
      setSelectedHostId('')
      onOpenChange(false)
    } catch (error) {
      // Error is handled by the mutation
    }
  }

  const handleClose = () => {
    reset()
    setSelectedHostId('')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Add Storage Pool</DialogTitle>
          <DialogDescription>
            Add a new storage pool for backup storage. The path must be on a mounted filesystem.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              The storage path must be on a mounted filesystem (can be a mount point or subdirectory). 
              The system will validate this before creating the pool.
            </AlertDescription>
          </Alert>

          <div className="space-y-2">
            <Label htmlFor="backupHost">Backup Host *</Label>
            <Select 
              id="backupHost"
              value={selectedHostId} 
              onChange={(e) => setSelectedHostId(e.target.value)}
              required
            >
              <option value="">Select backup host</option>
              {backupHosts?.map((host) => (
                <option key={host.id} value={host.id}>
                  {host.name} ({host.url})
                </option>
              ))}
            </Select>
            {!selectedHostId && (
              <p className="text-sm text-red-600">Backup host is required</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="name">Pool Name *</Label>
            <Input
              id="name"
              placeholder="e.g., Primary Storage, SSD Pool"
              {...register('name', { required: 'Name is required' })}
            />
            {errors.name && (
              <p className="text-sm text-red-600">{errors.name.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="path">Storage Path *</Label>
            <Input
              id="path"
              placeholder="/mnt/backup-storage"
              {...register('path', { 
                required: 'Path is required',
                pattern: {
                  value: /^\//,
                  message: 'Path must be absolute (start with /)'
                }
              })}
            />
            {errors.path && (
              <p className="text-sm text-red-600">{errors.path.message}</p>
            )}
            <p className="text-sm text-gray-500">
              Must be an absolute path on a mounted filesystem (e.g., /mnt/backup-storage or /mnt/backup-storage/backups)
            </p>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={handleClose}
              disabled={createMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={createMutation.isPending || !selectedHostId}
            >
              {createMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Add Storage Pool
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
