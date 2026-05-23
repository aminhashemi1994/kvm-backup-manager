import { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { Loader2, CheckCircle2, XCircle, Clock, Calendar } from 'lucide-react'
import { restoreApi } from '@/services/api'

interface RestoreProgressDialogProps {
  restoreId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface RestoreStatus {
  id: string
  vmName: string
  method: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  progress: number
  progressText: string
  startTime: string
  endTime: string | null
  error: string | null
}

export default function RestoreProgressDialog({
  restoreId,
  open,
  onOpenChange,
}: RestoreProgressDialogProps) {
  const [status, setStatus] = useState<RestoreStatus | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!open || !restoreId) {
      setStatus(null)
      setLoading(true)
      return
    }

    // Initial load
    loadStatus()

    // Poll for updates every 2 seconds
    const interval = setInterval(() => {
      loadStatus()
    }, 2000)

    return () => clearInterval(interval)
  }, [open, restoreId])

  const loadStatus = async () => {
    try {
      const response = await restoreApi.getStatus(restoreId)
      if (response.data.success) {
        setStatus(response.data.data)
        setLoading(false)
      }
    } catch (err) {
      console.error('Failed to load restore status:', err)
      setLoading(false)
    }
  }

  const getStatusBadge = () => {
    if (!status) return null

    switch (status.status) {
      case 'queued':
        return (
          <Badge className="bg-gray-100 text-gray-800 border-gray-200">
            <Clock className="h-3 w-3 mr-1" />
            Queued
          </Badge>
        )
      case 'running':
        return (
          <Badge className="bg-blue-100 text-blue-800 border-blue-200">
            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
            Running
          </Badge>
        )
      case 'completed':
        return (
          <Badge className="bg-green-100 text-green-800 border-green-200">
            <CheckCircle2 className="h-3 w-3 mr-1" />
            Completed
          </Badge>
        )
      case 'failed':
        return (
          <Badge className="bg-red-100 text-red-800 border-red-200">
            <XCircle className="h-3 w-3 mr-1" />
            Failed
          </Badge>
        )
      default:
        return null
    }
  }

  const formatDuration = (startTime: string, endTime: string | null) => {
    const start = new Date(startTime)
    const end = endTime ? new Date(endTime) : new Date()
    const durationMs = end.getTime() - start.getTime()
    const seconds = Math.floor(durationMs / 1000)
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`
    } else {
      return `${seconds}s`
    }
  }

  const canClose = status?.status === 'completed' || status?.status === 'failed'

  return (
    <Dialog open={open} onOpenChange={canClose ? onOpenChange : undefined}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between">
            <span>Restore Progress</span>
            {status && getStatusBadge()}
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex flex-col items-center justify-center py-12">
            <Loader2 className="h-12 w-12 animate-spin text-gray-400 mb-4" />
            <p className="text-gray-600">Loading restore status...</p>
          </div>
        ) : status ? (
          <div className="space-y-6">
            {/* VM Info */}
            <div className="bg-gray-50 rounded-lg p-4 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-600">VM Name:</span>
                <span className="text-sm font-semibold">{status.vmName}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-600">Backup Method:</span>
                <span className="text-sm font-semibold">{status.method}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-600">Started:</span>
                <span className="text-sm font-semibold">
                  {new Date(status.startTime).toLocaleString()}
                </span>
              </div>
              {status.endTime && (
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-600">
                    {status.status === 'completed' ? 'Completed:' : 'Failed:'}
                  </span>
                  <span className="text-sm font-semibold">
                    {new Date(status.endTime).toLocaleString()}
                  </span>
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-600">Duration:</span>
                <span className="text-sm font-semibold">
                  {formatDuration(status.startTime, status.endTime)}
                </span>
              </div>
            </div>

            {/* Progress Bar */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-700">Progress</span>
                <span className="text-sm font-semibold text-gray-900">{status.progress}%</span>
              </div>
              <Progress value={status.progress} className="h-3" />
              <p className="text-sm text-gray-600">{status.progressText}</p>
            </div>

            {/* Error Message */}
            {status.error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                <div className="flex items-start gap-2">
                  <XCircle className="h-5 w-5 text-red-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <h4 className="font-semibold text-red-900 mb-1">Error</h4>
                    <p className="text-sm text-red-800">{status.error}</p>
                  </div>
                </div>
              </div>
            )}

            {/* Success Message */}
            {status.status === 'completed' && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="h-5 w-5 text-green-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <h4 className="font-semibold text-green-900 mb-1">Restore Completed</h4>
                    <p className="text-sm text-green-800">
                      The backup has been successfully restored. You can now close this dialog.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Running Message */}
            {status.status === 'running' && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <div className="flex items-start gap-2">
                  <Loader2 className="h-5 w-5 text-blue-600 flex-shrink-0 mt-0.5 animate-spin" />
                  <div>
                    <h4 className="font-semibold text-blue-900 mb-1">Restore In Progress</h4>
                    <p className="text-sm text-blue-800">
                      Please wait while the restore operation completes. This dialog will update automatically.
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="text-center py-12 text-gray-500">
            <XCircle className="h-12 w-12 mx-auto mb-4 text-gray-400" />
            <p>Failed to load restore status</p>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 pt-4 border-t">
          <Button
            onClick={() => onOpenChange(false)}
            disabled={!canClose}
            variant={canClose ? 'default' : 'outline'}
          >
            {canClose ? 'Close' : 'Restore in progress...'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
