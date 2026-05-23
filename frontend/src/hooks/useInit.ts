import { useMutation, useQueryClient } from '@tanstack/react-query'
import { initApi } from '@/services/api'
import { toast } from 'sonner'
import { useState, useEffect } from 'react'
import socketService from '@/services/socket'

export function useInitBackupHost() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (backupHostId: string) => {
      const response = await initApi.initHost({ backupHostId })
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['backup-hosts'] })
      toast.success('Host initialization started')
    },
    onError: (error: any) => {
      const errorMessage = error.response?.data?.error || error.message || 'Failed to start host initialization'
      toast.error(errorMessage)
    },
  })
}

export function useInitOffsiteHost() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (backupHostId: string) => {
      const response = await initApi.initHost({ backupHostId })
      return response.data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['offsite-hosts'] })
      toast.success('Offsite host initialization started')
    },
    onError: (error: any) => {
      const errorMessage = error.response?.data?.error || error.message || 'Failed to start offsite host initialization'
      toast.error(errorMessage)
    },
  })
}

export function useInitSubscription(initId: string | null, backupHostId: string | null) {
  const [logs, setLogs] = useState<Array<{ timestamp: string; message: string; type: string }>>([])
  const [status, setStatus] = useState<string>('running')
  const [exitCode, setExitCode] = useState<number | null>(null)
  const [lastLogLength, setLastLogLength] = useState(0)

  useEffect(() => {
    if (!initId || !backupHostId) return

    // Subscribe to init
    socketService.subscribeToInit(initId)

    // Listen for logs via WebSocket
    const cleanupLog = socketService.on('init-log', (data: any) => {
      if (data.initId === initId) {
        console.log(`[Frontend] Received init-log for ${initId}:`, data.message);
        setLogs((prev) => [...prev, { 
          timestamp: data.timestamp, 
          message: data.message,
          type: data.type || 'info'
        }])
      }
    })

    // Listen for completion
    const cleanupComplete = socketService.on('init-complete', (data: any) => {
      if (data.initId === initId) {
        console.log(`[Frontend] Received init-complete for ${initId}: success=${data.success}, exitCode=${data.exitCode}`);
        setStatus(data.success ? 'completed' : 'failed')
        setExitCode(data.exitCode)
      }
    })

    // Listen for errors
    const cleanupError = socketService.on('init-error', (data: any) => {
      if (data.initId === initId) {
        console.log(`[Frontend] Received init-error for ${initId}:`, data.error);
        setStatus('failed')
        setLogs((prev) => [...prev, { 
          timestamp: new Date().toISOString(), 
          message: data.error,
          type: 'error'
        }])
      }
    })

    // Fallback: Poll logs from API every 2 seconds
    const pollInterval = setInterval(async () => {
      try {
        const response = await initApi.getLogs(initId, backupHostId)
        const logText = response.data.data.logs || ''
        
        if (logText) {
          const lines = logText.split('\n').filter(l => l.trim())
          
          // Only add new lines
          if (lines.length > lastLogLength) {
            const newLines = lines.slice(lastLogLength)
            newLines.forEach(line => {
              const match = line.match(/\[(.*?)\] \[(.*?)\] (.*)/)
              if (match) {
                setLogs((prev) => [...prev, {
                  timestamp: match[1],
                  type: match[2],
                  message: match[3]
                }])
              }
            })
            setLastLogLength(lines.length)
          }
        }

        // Check status
        const statusResponse = await initApi.getStatus(initId, backupHostId)
        const initStatus = statusResponse.data.data
        if (initStatus && initStatus.status !== 'running') {
          setStatus(initStatus.status)
          if (initStatus.exitCode !== undefined) {
            setExitCode(initStatus.exitCode)
          }
        }
      } catch (error) {
        console.error('Error polling logs:', error)
      }
    }, 2000)

    return () => {
      socketService.unsubscribeFromInit(initId)
      cleanupLog()
      cleanupComplete()
      cleanupError()
      clearInterval(pollInterval)
    }
  }, [initId, backupHostId, lastLogLength])

  return { logs, status, exitCode }
}
