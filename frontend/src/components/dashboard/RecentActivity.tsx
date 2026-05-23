import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { formatRelativeTime, getStatusColor } from '@/lib/utils'
import { useBackupHistory } from '@/hooks/useBackups'
import { Loader2 } from 'lucide-react'

export default function RecentActivity() {
  const { data: history, isLoading } = useBackupHistory({ limit: 10 })

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Recent Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent Activity</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {history && history.length > 0 ? (
            history.map((job) => (
              <div
                key={job.id}
                className="flex items-center justify-between py-3 border-b last:border-0"
              >
                <div className="flex-1 mr-4">
                  <p className="font-medium text-sm">{job.vmName}</p>
                  <p className="text-xs text-gray-500">
                    {(job.scheduleType || job.method || 'backup').toUpperCase()} • {formatRelativeTime(job.startTime)}
                  </p>
                  {(job.status === 'running' || job.status === 'queued') && (
                    <div className="flex items-center space-x-2 mt-2">
                      <div className="flex-1 bg-gray-200 rounded-full h-1.5 max-w-[200px]">
                        <div 
                          className="bg-blue-600 h-full transition-all duration-300"
                          style={{ width: `${job.progress || 0}%` }}
                        />
                      </div>
                      <span className="text-xs text-gray-600">{job.progress || 0}%</span>
                    </div>
                  )}
                </div>
                <Badge className={getStatusColor(job.status === 'queued' && (job.progress || 0) > 0 ? 'running' : job.status)}>
                  {job.status === 'queued' && (job.progress || 0) > 0 ? 'running' : job.status}
                </Badge>
              </div>
            ))
          ) : (
            <p className="text-center text-gray-500 py-8">No recent activity</p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
