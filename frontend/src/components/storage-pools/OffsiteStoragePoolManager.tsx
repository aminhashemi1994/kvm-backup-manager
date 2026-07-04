import { useEffect, useState } from 'react'
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
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Cloud,
  Plus,
  HardDrive,
  Edit,
  Trash2,
  RefreshCw,
  Loader2,
  AlertTriangle,
} from 'lucide-react'
import type { OffsiteHost, OffsiteStoragePool } from '@/types'
import {
  useCreateOffsitePool,
  useUpdateOffsitePool,
  useDeleteOffsitePool,
  useValidateOffsitePool,
} from '@/hooks/useOffsiteHosts'
import { cn } from '@/lib/utils'

// Pools at or over this used-percentage are considered too full to safely
// receive backups and are highlighted in the UI (Req 7.4, 7.5, 3.4).
const USAGE_LIMIT = 80

interface OffsiteStoragePoolManagerProps {
  offsiteHost: OffsiteHost
}

// Renders one offsite host with its own storage pools. Provides add/edit/delete
// pool actions (Req 3.3) and per-pool usage bars mirroring StoragePoolCard,
// highlighting pools at/over 80% used (Req 3.4, 7.4, 7.5).
export default function OffsiteStoragePoolManager({
  offsiteHost,
}: OffsiteStoragePoolManagerProps) {
  const [showAddDialog, setShowAddDialog] = useState(false)
  const pools = offsiteHost.storagePools || []

  return (
    <div className="rounded-lg border bg-white p-4 space-y-4">
      {/* Offsite host header */}
      <div className="flex items-center gap-3">
        <div className="h-9 w-9 rounded-lg bg-purple-50 flex items-center justify-center">
          <Cloud className="h-5 w-5 text-purple-600" />
        </div>
        <div>
          <h3 className="text-base font-semibold text-gray-900">{offsiteHost.name}</h3>
          <p className="text-sm text-gray-500">
            {offsiteHost.username}@{offsiteHost.ip}:{offsiteHost.port}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <span className="text-sm text-gray-500">
            {pools.length} {pools.length === 1 ? 'pool' : 'pools'}
          </span>
          <Button size="sm" onClick={() => setShowAddDialog(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Add Pool
          </Button>
        </div>
      </div>

      {/* Pools grid */}
      {pools.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {pools.map((pool) => (
            <OffsitePoolCard key={pool.id} offsiteHost={offsiteHost} pool={pool} />
          ))}
        </div>
      ) : (
        <div className="text-center py-8 rounded-md border border-dashed">
          <HardDrive className="h-8 w-8 text-gray-400 mx-auto" />
          <p className="mt-2 text-sm text-gray-500">
            No storage pools defined for this offsite host
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => setShowAddDialog(true)}
          >
            <Plus className="h-4 w-4 mr-2" />
            Add Pool
          </Button>
        </div>
      )}

      <AddOffsitePoolDialog
        offsiteHost={offsiteHost}
        open={showAddDialog}
        onOpenChange={setShowAddDialog}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pool card with usage bar
// ---------------------------------------------------------------------------

interface OffsitePoolCardProps {
  offsiteHost: OffsiteHost
  pool: OffsiteStoragePool
}

function OffsitePoolCard({ offsiteHost, pool }: OffsitePoolCardProps) {
  const [showEditDialog, setShowEditDialog] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const validateMutation = useValidateOffsitePool()

  const hasMetrics = pool.usagePercent != null
  const usagePercent = pool.usagePercent ?? 0
  const isOverLimit = hasMetrics && usagePercent >= USAGE_LIMIT

  const getUsageColor = (percentage: number) => {
    if (percentage >= 90) return 'bg-red-500'
    if (percentage >= USAGE_LIMIT) return 'bg-yellow-500'
    return 'bg-green-500'
  }

  const handleValidate = () => {
    validateMutation.mutate({ hostId: offsiteHost.id, poolId: pool.id })
  }

  return (
    <>
      <div
        className={cn(
          'rounded-lg border p-4 space-y-4',
          isOverLimit ? 'border-red-300 bg-red-50' : 'bg-white'
        )}
      >
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-purple-100 flex items-center justify-center">
              <HardDrive className="h-5 w-5 text-purple-600" />
            </div>
            <div>
              <p className="text-base font-semibold text-gray-900">{pool.name}</p>
              <p className="text-sm text-gray-500 font-mono break-all">{pool.path}</p>
            </div>
          </div>
          <Badge
            className={
              pool.status === 'active'
                ? 'bg-green-100 text-green-800'
                : 'bg-red-100 text-red-800'
            }
          >
            {pool.status}
          </Badge>
        </div>

        {/* Usage */}
        {hasMetrics ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-600">Disk Usage</span>
              <span className={cn('font-medium', isOverLimit && 'text-red-600')}>
                {usagePercent}%
              </span>
            </div>
            <Progress
              value={usagePercent}
              className="h-2"
              indicatorClassName={getUsageColor(usagePercent)}
            />
            <div className="flex items-center justify-between text-xs text-gray-500">
              <span>{pool.usedGB != null ? `${pool.usedGB} GB used` : '—'}</span>
              <span>
                {pool.availableGB != null ? `${pool.availableGB} GB free` : '—'}
              </span>
            </div>
            {pool.totalGB != null && (
              <div className="flex items-center justify-between text-xs text-gray-500 pt-1 border-t">
                <span>Total Capacity</span>
                <span>{pool.totalGB} GB</span>
              </div>
            )}
            {isOverLimit && (
              <p className="flex items-center gap-1 text-xs text-red-600 font-medium">
                <AlertTriangle className="h-3.5 w-3.5" />
                At or over {USAGE_LIMIT}% — too full for new backups
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-gray-500">No usage metrics available yet</p>
        )}

        {pool.lastError && (
          <p className="text-xs text-red-600 break-words">{pool.lastError}</p>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 pt-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={handleValidate}
            disabled={validateMutation.isPending}
          >
            {validateMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-2" />
            )}
            Validate
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowEditDialog(true)}>
            <Edit className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowDeleteDialog(true)}>
            <Trash2 className="h-4 w-4 text-red-600" />
          </Button>
        </div>
      </div>

      <EditOffsitePoolDialog
        offsiteHost={offsiteHost}
        pool={pool}
        open={showEditDialog}
        onOpenChange={setShowEditDialog}
      />

      <DeleteOffsitePoolDialog
        offsiteHost={offsiteHost}
        pool={pool}
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
      />
    </>
  )
}

// ---------------------------------------------------------------------------
// Add pool dialog (name + absolute path)
// ---------------------------------------------------------------------------

interface AddOffsitePoolDialogProps {
  offsiteHost: OffsiteHost
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface PoolFormData {
  name: string
  path: string
}

function AddOffsitePoolDialog({
  offsiteHost,
  open,
  onOpenChange,
}: AddOffsitePoolDialogProps) {
  const createMutation = useCreateOffsitePool()

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<PoolFormData>()

  const onSubmit = async (data: PoolFormData) => {
    try {
      await createMutation.mutateAsync({ hostId: offsiteHost.id, data })
      reset()
      onOpenChange(false)
    } catch (error) {
      // Error surfaced via the mutation's toast
    }
  }

  const handleClose = () => {
    reset()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Add Storage Pool</DialogTitle>
          <DialogDescription>
            Add a storage pool to <strong>{offsiteHost.name}</strong>. The path is
            validated over SSH before the pool is created.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="offsite-pool-name">Pool Name *</Label>
            <Input
              id="offsite-pool-name"
              placeholder="e.g., Offsite Primary"
              {...register('name', { required: 'Name is required' })}
            />
            {errors.name && (
              <p className="text-sm text-red-600">{errors.name.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="offsite-pool-path">Storage Path *</Label>
            <Input
              id="offsite-pool-path"
              placeholder="/mnt/offsite-backups"
              {...register('path', {
                required: 'Path is required',
                pattern: {
                  value: /^\//,
                  message: 'Path must be absolute (start with /)',
                },
              })}
            />
            {errors.path && (
              <p className="text-sm text-red-600">{errors.path.message}</p>
            )}
            <p className="text-sm text-gray-500">
              Absolute path on the offsite host on a mounted, writable filesystem
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
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Add Pool
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Edit pool dialog (name / path)
// ---------------------------------------------------------------------------

interface EditOffsitePoolDialogProps {
  offsiteHost: OffsiteHost
  pool: OffsiteStoragePool
  open: boolean
  onOpenChange: (open: boolean) => void
}

function EditOffsitePoolDialog({
  offsiteHost,
  pool,
  open,
  onOpenChange,
}: EditOffsitePoolDialogProps) {
  const updateMutation = useUpdateOffsitePool()

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<PoolFormData>({
    defaultValues: { name: pool.name, path: pool.path },
  })

  useEffect(() => {
    if (open) {
      reset({ name: pool.name, path: pool.path })
    }
  }, [open, pool.name, pool.path, reset])

  const onSubmit = async (data: PoolFormData) => {
    try {
      await updateMutation.mutateAsync({
        hostId: offsiteHost.id,
        poolId: pool.id,
        data,
      })
      onOpenChange(false)
    } catch (error) {
      // Error surfaced via the mutation's toast
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Edit Storage Pool</DialogTitle>
          <DialogDescription>
            Update the pool name or path. A changed path is re-validated over SSH.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="edit-offsite-pool-name">Pool Name *</Label>
            <Input
              id="edit-offsite-pool-name"
              {...register('name', { required: 'Name is required' })}
            />
            {errors.name && (
              <p className="text-sm text-red-600">{errors.name.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-offsite-pool-path">Storage Path *</Label>
            <Input
              id="edit-offsite-pool-path"
              {...register('path', {
                required: 'Path is required',
                pattern: {
                  value: /^\//,
                  message: 'Path must be absolute (start with /)',
                },
              })}
            />
            {errors.path && (
              <p className="text-sm text-red-600">{errors.path.message}</p>
            )}
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

// ---------------------------------------------------------------------------
// Delete pool dialog
// ---------------------------------------------------------------------------

interface DeleteOffsitePoolDialogProps {
  offsiteHost: OffsiteHost
  pool: OffsiteStoragePool
  open: boolean
  onOpenChange: (open: boolean) => void
}

function DeleteOffsitePoolDialog({
  offsiteHost,
  pool,
  open,
  onOpenChange,
}: DeleteOffsitePoolDialogProps) {
  const deleteMutation = useDeleteOffsitePool()

  const handleDelete = async () => {
    try {
      await deleteMutation.mutateAsync({ hostId: offsiteHost.id, poolId: pool.id })
      onOpenChange(false)
    } catch (error) {
      // A 409 (pool referenced by a schedule) is surfaced via the mutation's
      // toast; keep the dialog open so the operator can read the reason.
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
            <span className="block text-base">
              Are you sure you want to delete{' '}
              <strong className="text-foreground">{pool.name}</strong> on{' '}
              <strong className="text-foreground">{offsiteHost.name}</strong>?
            </span>
            <span className="block text-sm text-muted-foreground">
              Path:{' '}
              <code className="bg-gray-100 px-2 py-1 rounded text-xs">{pool.path}</code>
            </span>
            <span className="block text-sm text-muted-foreground">
              A pool that is still referenced by a schedule cannot be deleted.
            </span>
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
            Delete Pool
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
