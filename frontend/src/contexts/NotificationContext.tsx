import { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { useSocket } from '@/hooks/useSocket'

export interface Notification {
  id: string
  type: 'agent' | 'backup' | 'system'
  severity: 'info' | 'success' | 'warning' | 'error'
  title: string
  message: string
  timestamp: string
  read: boolean
}

interface NotificationContextType {
  notifications: Notification[]
  unreadCount: number
  addNotification: (notification: Omit<Notification, 'id' | 'timestamp' | 'read'>) => void
  markAsRead: (id: string) => void
  markAllAsRead: () => void
  clearAll: () => void
}

const NotificationContext = createContext<NotificationContextType | undefined>(undefined)

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<Notification[]>([])
  const { socket } = useSocket()

  useEffect(() => {
    // Load notifications from localStorage
    const stored = localStorage.getItem('notifications')
    if (stored) {
      setNotifications(JSON.parse(stored))
    }
  }, [])

  useEffect(() => {
    // Save notifications to localStorage
    localStorage.setItem('notifications', JSON.stringify(notifications))
  }, [notifications])

  useEffect(() => {
    if (!socket) return

    // Listen for agent status changes
    socket.on('hosts-status-update', (hosts: any[]) => {
      hosts.forEach(host => {
        const wasOnline = notifications.some(
          n => n.type === 'agent' && n.message.includes(host.name) && n.severity === 'success'
        )
        
        if (host.status === 'offline' && wasOnline) {
          addNotification({
            type: 'agent',
            severity: 'error',
            title: 'Agent Disconnected',
            message: `Backup agent "${host.name}" has disconnected`,
          })
        } else if (host.status === 'online' && !wasOnline) {
          addNotification({
            type: 'agent',
            severity: 'success',
            title: 'Agent Connected',
            message: `Backup agent "${host.name}" is now online`,
          })
        }
      })
    })

    // Listen for backup events
    socket.on('backup-started', (job: any) => {
      addNotification({
        type: 'backup',
        severity: 'info',
        title: 'Backup Started',
        message: `Backup started for VM "${job.vmName}" (${job.method})`,
      })
    })

    socket.on('backup-complete', (job: any) => {
      addNotification({
        type: 'backup',
        severity: 'success',
        title: 'Backup Completed',
        message: `Backup completed successfully for VM "${job.vmName}"`,
      })
    })

    socket.on('backup-error', (job: any) => {
      addNotification({
        type: 'backup',
        severity: 'error',
        title: 'Backup Failed',
        message: `Backup failed for VM "${job.vmName}": ${job.error || 'Unknown error'}`,
      })
    })

    return () => {
      socket.off('hosts-status-update')
      socket.off('backup-started')
      socket.off('backup-complete')
      socket.off('backup-error')
    }
  }, [socket])

  const addNotification = (notification: Omit<Notification, 'id' | 'timestamp' | 'read'>) => {
    const newNotification: Notification = {
      ...notification,
      id: Date.now().toString() + Math.random().toString(36),
      timestamp: new Date().toISOString(),
      read: false,
    }
    setNotifications(prev => [newNotification, ...prev].slice(0, 100)) // Keep last 100
  }

  const markAsRead = (id: string) => {
    setNotifications(prev =>
      prev.map(n => (n.id === id ? { ...n, read: true } : n))
    )
  }

  const markAllAsRead = () => {
    setNotifications(prev => prev.map(n => ({ ...n, read: true })))
  }

  const clearAll = () => {
    setNotifications([])
  }

  const unreadCount = notifications.filter(n => !n.read).length

  return (
    <NotificationContext.Provider
      value={{
        notifications,
        unreadCount,
        addNotification,
        markAsRead,
        markAllAsRead,
        clearAll,
      }}
    >
      {children}
    </NotificationContext.Provider>
  )
}

export function useNotifications() {
  const context = useContext(NotificationContext)
  if (context === undefined) {
    throw new Error('useNotifications must be used within a NotificationProvider')
  }
  return context
}
