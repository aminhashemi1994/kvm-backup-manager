import { useEffect, useState } from 'react'
import socketService from '@/services/socket'

export function useSocket() {
  const [isConnected, setIsConnected] = useState(false)

  useEffect(() => {
    const socket = socketService.connect()

    const handleConnect = () => setIsConnected(true)
    const handleDisconnect = () => setIsConnected(false)

    socket.on('connect', handleConnect)
    socket.on('disconnect', handleDisconnect)

    setIsConnected(socket.connected)

    return () => {
      socket.off('connect', handleConnect)
      socket.off('disconnect', handleDisconnect)
    }
  }, [])

  return { isConnected, socket: socketService }
}

export function useSocketEvent<T = any>(
  event: string,
  callback: (data: T) => void
) {
  useEffect(() => {
    const cleanup = socketService.on(event, callback)
    return cleanup
  }, [event, callback])
}

export function useJobSubscription(jobId: string | null) {
  const [logs, setLogs] = useState<Array<{ timestamp: string; message: string }>>([])
  const [status, setStatus] = useState<string>('unknown')

  useEffect(() => {
    if (!jobId) return

    // Subscribe to job
    socketService.subscribeToJob(jobId)

    // Listen for logs
    const cleanupLog = socketService.on('backup-log', (data: any) => {
      if (data.jobId === jobId) {
        setLogs((prev) => [...prev, { timestamp: data.timestamp, message: data.message }])
      }
    })

    // Listen for progress
    const cleanupProgress = socketService.on('backup-progress', (data: any) => {
      if (data.jobId === jobId) {
        setStatus(data.status)
        if (data.message) {
          setLogs((prev) => [...prev, { timestamp: new Date().toISOString(), message: data.message }])
        }
      }
    })

    // Listen for completion
    const cleanupComplete = socketService.on('backup-complete', (data: any) => {
      if (data.id === jobId) {
        setStatus('completed')
      }
    })

    // Listen for errors
    const cleanupError = socketService.on('backup-error', (data: any) => {
      if (data.id === jobId) {
        setStatus('failed')
      }
    })

    return () => {
      socketService.unsubscribeFromJob(jobId)
      cleanupLog()
      cleanupProgress()
      cleanupComplete()
      cleanupError()
    }
  }, [jobId])

  return { logs, status }
}
