import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { X, AlertTriangle, Wrench, Loader2 } from 'lucide-react'
import { useFixBackup } from '@/hooks/useFixBackup'

interface FixBackupDialogProps {
  vmId: string
  vmName: string
  hypervisorIp: string
  backupHostId: string
  onClose: () => void
}

export default function FixBackupDialog({
  vmId,
  vmName,
  hypervisorIp,
  backupHostId,
  onClose,
}: FixBackupDialogProps) {
  const fixBackup = useFixBackup()
  const [isExecuting, setIsExecuting] = useState(false)

  const handleConfirm = async () => {
    setIsExecuting(true)
    try {
      await fixBackup.mutateAsync({
        vmId,
        vmName,
        hypervisorIp,
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
              <AlertTriangle className="h-5 w-5 text-yellow-600" />
              <CardTitle>Fix Backup - Confirmation Required</CardTitle>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose} disabled={isExecuting}>
              <X className="h-5 w-5" />
            </Button>
          </div>
        </CardHeader>

        <CardContent className="p-6">
          <div className="space-y-4">
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
              <div className="flex items-start space-x-3">
                <AlertTriangle className="h-5 w-5 text-yellow-600 mt-0.5 flex-shrink-0" />
                <div className="flex-1">
                  <h4 className="font-semibold text-yellow-900 mb-2">Warning</h4>
                  <p className="text-sm text-yellow-800">
                    Fixing backups for <span className="font-semibold">{vmName}</span> will reset all checkpoint metadata.
                  </p>
                  <p className="text-sm text-yellow-800 mt-2">
                    This will cause the next backup to run as a <span className="font-semibold">full backup</span>, and existing backups will be archived.
                  </p>
                </div>
              </div>
            </div>

            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <div className="flex items-start space-x-3">
                <Wrench className="h-5 w-5 text-blue-600 mt-0.5 flex-shrink-0" />
                <div className="flex-1">
                  <h4 className="font-semibold text-blue-900 mb-2">What will happen?</h4>
                  <ul className="text-sm text-blue-800 space-y-1 list-disc list-inside">
                    <li>Backup checkpoint metadata will be reset</li>
                    <li>Incremental backup chain will be broken</li>
                    <li>Next backup will be a full backup</li>
                    <li>Existing backups will be moved to archive</li>
                  </ul>
                </div>
              </div>
            </div>

            <div className="text-sm text-gray-600">
              <p>
                <span className="font-semibold">VM:</span> {vmName}
              </p>
              <p>
                <span className="font-semibold">Hypervisor:</span> {hypervisorIp}
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
                Fixing Backup...
              </>
            ) : (
              <>
                <Wrench className="h-4 w-4 mr-2" />
                Confirm Fix Backup
              </>
            )}
          </Button>
        </div>
      </Card>
    </div>
  )

  return createPortal(dialogContent, document.body)
}
