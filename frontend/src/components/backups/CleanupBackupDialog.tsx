import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { X, AlertTriangle, Loader2, Info } from 'lucide-react'
import { useCleanupBackup } from '@/hooks/useCleanupBackup'
import CleanupIcon from '../icons/CleanupIcon'

interface CleanupBackupDialogProps {
  vmId: string
  vmName: string
  backupHostId: string
  onClose: () => void
}

export default function CleanupBackupDialog({
  vmId,
  vmName,
  backupHostId,
  onClose,
}: CleanupBackupDialogProps) {
  const cleanupBackup = useCleanupBackup()
  const [isExecuting, setIsExecuting] = useState(false)

  const handleConfirm = async () => {
    setIsExecuting(true)
    try {
      await cleanupBackup.mutateAsync({
        vmId,
        vmName,
        backupHostId,
      })
      onClose()
    } catch (error) {
      // Error is handled by the mutation
    } finally {
      setIsExecuting(false)
    }
  }

  const dialogContent = (
    <div
      className="dialog-overlay flex items-start justify-center py-[5vh] px-4"
      onClick={onClose}
    >
      <div className="dialog-overlay-backdrop" />
      <Card className="relative w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <CardHeader className="border-b">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <AlertTriangle className="h-5 w-5 text-red-600" />
              <CardTitle>Cleanup Failed Backup - Confirmation Required</CardTitle>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose} disabled={isExecuting}>
              <X className="h-5 w-5" />
            </Button>
          </div>
        </CardHeader>

        <CardContent className="p-6">
          <div className="space-y-4">
            <div className="bg-red-50 border border-red-200 rounded-lg p-4">
              <div className="flex items-start space-x-3">
                <AlertTriangle className="h-5 w-5 text-red-600 mt-0.5 flex-shrink-0" />
                <div className="flex-1">
                  <h4 className="font-semibold text-red-900 mb-2">⚠️ Warning - Read Carefully</h4>
                  <p className="text-sm text-red-800">
                    This action will remove the <span className="font-semibold">last broken backup chain</span> for <span className="font-semibold">{vmName}</span>.
                  </p>
                  <p className="text-sm text-red-800 mt-2">
                    This will <span className="font-semibold underline">permanently delete</span> partial files and the latest checkpoint.
                  </p>
                  <p className="text-sm text-red-800 mt-2 font-semibold">
                    Make sure this is what you want before proceeding!
                  </p>
                </div>
              </div>
            </div>

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <div className="flex items-start space-x-3">
                <Info className="h-5 w-5 text-blue-600 mt-0.5 flex-shrink-0" />
                <div className="flex-1">
                  <h4 className="font-semibold text-blue-900 mb-2">What will happen?</h4>
                  <ul className="text-sm text-blue-800 space-y-1 list-disc list-inside">
                    <li>Safety checks will verify no backup is currently running</li>
                    <li>All <code className="bg-blue-100 px-1 rounded">*.partial</code> files will be removed</li>
                    <li>Latest failed checkpoint will be removed</li>
                    <li>Older valid checkpoints will be preserved</li>
                    <li><span className="font-semibold">No backup will be started</span> - you must manually retry</li>
                  </ul>
                </div>
              </div>
            </div>

            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
              <div className="flex items-start space-x-3">
                <CleanupIcon className="h-5 w-5 flex-shrink-0" />
                <div className="flex-1">
                  <h4 className="font-semibold text-yellow-900 mb-2">After cleanup</h4>
                  <p className="text-sm text-yellow-800">
                    The backup directory will be ready for a retry. You must manually trigger a new backup or wait for the next scheduled backup.
                  </p>
                </div>
              </div>
            </div>

            <div className="text-sm text-gray-600 border-t pt-4">
              <p>
                <span className="font-semibold">VM:</span> {vmName}
              </p>
            </div>
          </div>
        </CardContent>

        <div className="border-t p-4 flex items-center justify-end space-x-2">
          <Button variant="outline" onClick={onClose} disabled={isExecuting}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={isExecuting}
          >
            {isExecuting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Cleaning up...
              </>
            ) : (
              <>
                <CleanupIcon className="h-4 w-4 mr-2" />
                Yes, Cleanup Failed Backup
              </>
            )}
          </Button>
        </div>
      </Card>
    </div>
  )

  return createPortal(dialogContent, document.body)
}
