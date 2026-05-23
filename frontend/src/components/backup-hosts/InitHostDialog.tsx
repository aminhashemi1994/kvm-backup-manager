import { useState, useEffect, useRef } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { X, ChevronDown, ChevronUp, CheckCircle, XCircle, Loader2 } from 'lucide-react'
import { useInitSubscription } from '@/hooks/useInit'

interface InitHostDialogProps {
  initId: string
  backupHostId: string
  hostName: string
  onClose: () => void
}

export default function InitHostDialog({ initId, backupHostId, hostName, onClose }: InitHostDialogProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [showDetails, setShowDetails] = useState(true)
  const [autoScroll, setAutoScroll] = useState(true)
  const { logs, status, exitCode } = useInitSubscription(initId, backupHostId)

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [logs, autoScroll])

  const getLogColor = (type: string) => {
    switch (type) {
      case 'success':
        return 'text-green-400'
      case 'error':
        return 'text-red-400'
      case 'warning':
        return 'text-yellow-400'
      case 'progress':
        return 'text-blue-400'
      default:
        return 'text-gray-300'
    }
  }

  const getStatusIcon = () => {
    if (status === 'completed') {
      return <CheckCircle className="h-5 w-5 text-green-600" />
    } else if (status === 'failed') {
      return <XCircle className="h-5 w-5 text-red-600" />
    } else {
      return <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
    }
  }

  const isRunning = status === 'running'

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-4xl w-full">
        <DialogHeader>
          <div className="flex items-center justify-between">
            <div>
              <DialogTitle>Initialize Host - {hostName}</DialogTitle>
              <div className="flex items-center space-x-2 mt-2">
                {getStatusIcon()}
                <Badge className={status === 'failed' ? 'bg-red-100 text-red-800' : status === 'completed' ? 'bg-green-100 text-green-800' : 'bg-blue-100 text-blue-800'}>
                  {status}
                </Badge>
                {exitCode !== null && (
                  <span className={`text-sm font-medium ${exitCode === 0 ? 'text-green-600' : 'text-red-600'}`}>
                    Exit Code: {exitCode}
                  </span>
                )}
              </div>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="h-5 w-5" />
            </Button>
          </div>
        </DialogHeader>

        <div className="space-y-4">
          {/* Summary Section */}
          <div className="bg-gray-50 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="font-medium text-sm">Installation Progress</h4>
                <p className="text-xs text-gray-600 mt-1">
                  {logs.length} log entries
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowDetails(!showDetails)}
              >
                {showDetails ? (
                  <>
                    <ChevronUp className="h-4 w-4 mr-2" />
                    Hide Details
                  </>
                ) : (
                  <>
                    <ChevronDown className="h-4 w-4 mr-2" />
                    Show Details
                  </>
                )}
              </Button>
            </div>

            {/* Quick Summary */}
            {!showDetails && (
              <div className="mt-3 space-y-1">
                {logs.filter(l => l.type === 'success').length > 0 && (
                  <div className="text-sm text-green-600">
                    ✓ {logs.filter(l => l.type === 'success').length} successful operations
                  </div>
                )}
                {logs.filter(l => l.type === 'error').length > 0 && (
                  <div className="text-sm text-red-600">
                    ✗ {logs.filter(l => l.type === 'error').length} errors
                  </div>
                )}
                {logs.filter(l => l.type === 'warning').length > 0 && (
                  <div className="text-sm text-yellow-600">
                    ⚠ {logs.filter(l => l.type === 'warning').length} warnings
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Detailed Logs */}
          {showDetails && (
            <>
              <div className="flex items-center justify-between">
                <label className="flex items-center space-x-2 text-sm">
                  <input
                    type="checkbox"
                    checked={autoScroll}
                    onChange={(e) => setAutoScroll(e.target.checked)}
                    className="rounded"
                  />
                  <span>Auto-scroll</span>
                </label>
                {isRunning && (
                  <div className="flex items-center space-x-2 text-sm text-gray-500">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>Live updates enabled</span>
                  </div>
                )}
              </div>

              <ScrollArea ref={scrollRef} className="h-[400px] w-full rounded-md border bg-gray-950 p-4">
                {logs.length > 0 ? (
                  <div className="space-y-1">
                    {logs.map((log, index) => (
                      <div key={index} className="text-xs font-mono">
                        <span className="text-gray-500">[{new Date(log.timestamp).toLocaleTimeString()}]</span>
                        <span className={`ml-2 ${getLogColor(log.type)}`}>
                          {log.message}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center text-gray-500 py-8">
                    Waiting for initialization to start...
                  </div>
                )}
              </ScrollArea>
            </>
          )}

          {/* Status Message */}
          {status === 'completed' && (
            <div className="bg-green-50 border border-green-200 rounded-lg p-4">
              <div className="flex items-center space-x-2">
                <CheckCircle className="h-5 w-5 text-green-600" />
                <div>
                  <p className="font-medium text-green-900">Initialization Completed Successfully</p>
                  <p className="text-sm text-green-700 mt-1">
                    The host has been initialized with all required dependencies.
                  </p>
                </div>
              </div>
            </div>
          )}

          {status === 'failed' && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4">
              <div className="flex items-center space-x-2">
                <XCircle className="h-5 w-5 text-red-600" />
                <div>
                  <p className="font-medium text-red-900">Initialization Failed</p>
                  <p className="text-sm text-red-700 mt-1">
                    Check the logs above for error details. Exit code: {exitCode}
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
