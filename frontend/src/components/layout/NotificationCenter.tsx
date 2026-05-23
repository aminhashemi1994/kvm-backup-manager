import { useState, useEffect, useRef } from 'react'
import { Bell, X, CheckCircle, AlertTriangle, Info, RefreshCw } from 'lucide-react'
import socketService from '@/services/socket'

interface Notification {
  id: string
  type: 'success' | 'error' | 'warning' | 'info'
  title: string
  message: string
  timestamp: string
  read: boolean
}

/**
 * NotificationCenter (Item 10)
 *
 * Bell icon with dropdown showing recent backup events, alerts, and system
 * messages. Persists in-app history (session-level).
 */
export default function NotificationCenter() {
  const [open, setOpen] = useState(false)
  const [notifications, setNotifications] = useState<Notification[]>([])
  const dropdownRef = useRef<HTMLDivElement>(null)

  const unreadCount = notifications.filter(n => !n.read).length

  useEffect(() => {
    // Listen for real-time events and convert to notifications
    const handlers = [
      socketService.on('backup-complete', (data: any) => {
        addNotification('success', 'Backup Completed', `${data.vmName || 'VM'} backup finished successfully`)
      }),
      socketService.on('backup-error', (data: any) => {
        addNotification('error', 'Backup Failed', `${data.vmName || 'VM'}: ${data.error || 'Unknown error'}`)
      }),
      socketService.on('backup-started', (data: any) => {
        addNotification('info', 'Backup Started', `${data.vmName || 'VM'} backup initiated`)
      }),
      socketService.on('backup-skipped', (data: any) => {
        addNotification('warning', 'Backup Skipped', `${data.vmName || 'VM'}: ${data.error || 'Agent offline'}`)
      }),
      socketService.on('restore-complete', (data: any) => {
        addNotification('success', 'Restore Completed', `${data.vmName || 'VM'} restore finished`)
      }),
      socketService.on('restore-error', (data: any) => {
        addNotification('error', 'Restore Failed', `${data.vmName || 'VM'}: ${data.error || 'Unknown error'}`)
      }),
      socketService.on('hosts-status-update', (hosts: any[]) => {
        const offline = hosts?.filter(h => h.status === 'offline') || []
        if (offline.length > 0) {
          addNotification('warning', 'Host Offline', `${offline.map(h => h.name).join(', ')} went offline`)
        }
      }),
      socketService.on('jobs-synced', (data: any) => {
        if (data.finalized > 0) {
          addNotification('info', 'Jobs Synced', `${data.finalized} job(s) finalized on ${data.backupHostName}`)
        }
      }),
    ]

    return () => {
      handlers.forEach(cleanup => cleanup())
    }
  }, [])

  // Close on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    if (open) document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  const addNotification = (type: Notification['type'], title: string, message: string) => {
    const n: Notification = {
      id: Date.now().toString() + Math.random().toString(36).slice(2),
      type,
      title,
      message,
      timestamp: new Date().toISOString(),
      read: false,
    }
    setNotifications(prev => [n, ...prev].slice(0, 100)) // Keep last 100
  }

  const markAllRead = () => {
    setNotifications(prev => prev.map(n => ({ ...n, read: true })))
  }

  const clearAll = () => {
    setNotifications([])
  }

  const getIcon = (type: Notification['type']) => {
    switch (type) {
      case 'success': return <CheckCircle className="h-4 w-4 text-green-500" />
      case 'error': return <AlertTriangle className="h-4 w-4 text-red-500" />
      case 'warning': return <AlertTriangle className="h-4 w-4 text-amber-500" />
      case 'info': return <Info className="h-4 w-4 text-blue-500" />
    }
  }

  const formatTime = (ts: string) => {
    const diff = Date.now() - new Date(ts).getTime()
    if (diff < 60000) return 'Just now'
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
    return new Date(ts).toLocaleDateString()
  }

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Bell button */}
      <button
        onClick={() => setOpen(!open)}
        className="relative p-2 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
        title="Notifications"
      >
        <Bell className="h-5 w-5 text-gray-600 dark:text-gray-300" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 h-5 w-5 flex items-center justify-center text-[10px] font-bold text-white bg-red-500 rounded-full animate-pulse">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute right-0 top-full mt-2 w-96 max-h-[480px] glass-panel rounded-2xl overflow-hidden z-[9999] shadow-2xl">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200/50 dark:border-gray-700/50">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              Notifications
              {unreadCount > 0 && (
                <span className="ml-2 text-xs font-normal text-gray-500">
                  ({unreadCount} unread)
                </span>
              )}
            </h3>
            <div className="flex items-center gap-1">
              {unreadCount > 0 && (
                <button
                  onClick={markAllRead}
                  className="text-xs text-primary hover:underline px-2 py-1"
                >
                  Mark all read
                </button>
              )}
              {notifications.length > 0 && (
                <button
                  onClick={clearAll}
                  className="text-xs text-gray-400 hover:text-gray-600 px-2 py-1"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* List */}
          <div className="overflow-y-auto max-h-[380px]">
            {notifications.length === 0 ? (
              <div className="px-4 py-12 text-center">
                <Bell className="h-8 w-8 text-gray-300 mx-auto mb-2" />
                <p className="text-sm text-gray-500">No notifications yet</p>
                <p className="text-xs text-gray-400 mt-1">Events will appear here in real-time</p>
              </div>
            ) : (
              notifications.map(n => (
                <div
                  key={n.id}
                  className={`flex items-start gap-3 px-4 py-3 border-b border-gray-100/50 dark:border-gray-800/50 transition-colors ${
                    !n.read ? 'bg-blue-50/30 dark:bg-blue-900/10' : ''
                  }`}
                >
                  <div className="flex-shrink-0 mt-0.5">{getIcon(n.type)}</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      {n.title}
                    </div>
                    <div className="text-xs text-gray-500 truncate mt-0.5">
                      {n.message}
                    </div>
                  </div>
                  <div className="text-[10px] text-gray-400 flex-shrink-0 mt-0.5">
                    {formatTime(n.timestamp)}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
