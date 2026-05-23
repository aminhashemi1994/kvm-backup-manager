import { useNotifications } from '@/contexts/NotificationContext'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { CheckCheck, Trash2, AlertCircle, CheckCircle, Info, AlertTriangle } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'

export default function NotificationPanel() {
  const { notifications, markAsRead, markAllAsRead, clearAll } = useNotifications()

  const getIcon = (severity: string) => {
    switch (severity) {
      case 'error':
        return <AlertCircle className="h-4 w-4 text-red-500" />
      case 'warning':
        return <AlertTriangle className="h-4 w-4 text-yellow-500" />
      case 'success':
        return <CheckCircle className="h-4 w-4 text-green-500" />
      default:
        return <Info className="h-4 w-4 text-blue-500" />
    }
  }

  const getTypeColor = (type: string) => {
    switch (type) {
      case 'agent':
        return 'bg-purple-100 text-purple-800'
      case 'backup':
        return 'bg-blue-100 text-blue-800'
      default:
        return 'bg-gray-100 text-gray-800'
    }
  }

  return (
    <div className="w-96 bg-white dark:bg-gray-800 border-l shadow-lg flex flex-col h-full">
      <div className="p-4 border-b flex items-center justify-between">
        <h2 className="font-semibold text-lg">Notifications</h2>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={markAllAsRead}
            disabled={notifications.length === 0}
          >
            <CheckCheck className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={clearAll}
            disabled={notifications.length === 0}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1">
        {notifications.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            <Info className="h-12 w-12 mx-auto mb-2 opacity-50" />
            <p>No notifications</p>
          </div>
        ) : (
          <div className="divide-y">
            {notifications.map((notification) => (
              <div
                key={notification.id}
                className={`p-4 hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer transition-colors ${
                  !notification.read ? 'bg-blue-50 dark:bg-blue-900/20' : ''
                }`}
                onClick={() => markAsRead(notification.id)}
              >
                <div className="flex items-start gap-3">
                  <div className="mt-1">{getIcon(notification.severity)}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <p className="font-medium text-sm">{notification.title}</p>
                      <Badge variant="outline" className={`text-xs ${getTypeColor(notification.type)}`}>
                        {notification.type}
                      </Badge>
                    </div>
                    <p className="text-sm text-gray-600 dark:text-gray-400">
                      {notification.message}
                    </p>
                    <p className="text-xs text-gray-500 mt-1">
                      {formatDistanceToNow(new Date(notification.timestamp), { addSuffix: true })}
                    </p>
                  </div>
                  {!notification.read && (
                    <div className="h-2 w-2 rounded-full bg-blue-500 mt-2" />
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
