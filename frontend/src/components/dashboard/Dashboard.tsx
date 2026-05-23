import { Server, HardDrive, CheckCircle, XCircle, Clock, Activity, AlertTriangle } from 'lucide-react'
import StatsCard from './StatsCard'
import RecentActivity from './RecentActivity'
import { useBackupHosts, useAllVMs } from '@/hooks/useBackupHosts'
import { useBackupStats, useActiveBackups, useBackupHistory } from '@/hooks/useBackups'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useNavigate } from 'react-router-dom'

export default function Dashboard() {
  const { data: backupHosts } = useBackupHosts()
  const { data: vms } = useAllVMs()
  const { data: stats } = useBackupStats()
  const { data: activeBackups } = useActiveBackups()
  const { data: recentHistory } = useBackupHistory({ limit: 100 })
  const navigate = useNavigate()

  const onlineHosts = backupHosts?.filter(h => h.status === 'online').length || 0
  const totalHosts = backupHosts?.length || 0
  const totalVMs = vms?.length || 0
  const selectedVMs = vms?.filter(vm => vm.selected).length || 0
  const activeJobs = activeBackups?.length || 0

  // Get skipped backups from last 24 hours
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const recentSkipped = recentHistory?.filter(
    job => job.status === 'skipped' && new Date(job.startTime) > oneDayAgo
  ) || []

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-gray-600 mt-2">
          Overview of your KVM backup infrastructure
        </p>
      </div>

      {/* Skipped Backups Alert */}
      {recentSkipped.length > 0 && (
        <Card className="border-orange-200 bg-orange-50">
          <CardContent className="pt-6">
            <div className="flex items-start space-x-4">
              <div className="flex-shrink-0">
                <AlertTriangle className="h-6 w-6 text-orange-600" />
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-semibold text-orange-900">
                  {recentSkipped.length} Backup{recentSkipped.length > 1 ? 's' : ''} Skipped (Last 24h)
                </h3>
                <p className="text-sm text-orange-700 mt-1">
                  Some scheduled backups were skipped because the backup host was offline or unreachable.
                </p>
                <div className="mt-3 space-y-1">
                  {recentSkipped.slice(0, 3).map(job => (
                    <div key={job.id} className="text-sm text-orange-800">
                      • <span className="font-medium">{job.vmName}</span> - {job.error}
                    </div>
                  ))}
                  {recentSkipped.length > 3 && (
                    <div className="text-sm text-orange-700">
                      ... and {recentSkipped.length - 3} more
                    </div>
                  )}
                </div>
                <div className="mt-4">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => navigate('/history?status=skipped')}
                    className="border-orange-300 text-orange-700 hover:bg-orange-100"
                  >
                    View All Skipped Backups
                  </Button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <StatsCard
          title="Backup Hosts"
          value={`${onlineHosts}/${totalHosts}`}
          description="Online hosts"
          icon={Server}
          colorClass="bg-blue-500"
        />

        <StatsCard
          title="Virtual Machines"
          value={totalVMs}
          description={`${selectedVMs} selected for backup`}
          icon={HardDrive}
          colorClass="bg-purple-500"
        />

        <StatsCard
          title="Active Backups"
          value={activeJobs}
          description="Currently running"
          icon={Activity}
          colorClass="bg-orange-500"
        />

        <StatsCard
          title="Completed"
          value={stats?.completed || 0}
          description="Total successful backups"
          icon={CheckCircle}
          colorClass="bg-green-500"
        />

        <StatsCard
          title="Failed"
          value={stats?.failed || 0}
          description="Total failed backups"
          icon={XCircle}
          colorClass="bg-red-500"
        />

        <StatsCard
          title="Last 24h"
          value={stats?.last24h?.total || 0}
          description={`${stats?.last24h?.completed || 0} completed, ${stats?.last24h?.failed || 0} failed`}
          icon={Clock}
          colorClass="bg-indigo-500"
        />
      </div>

      {/* Recent Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <RecentActivity />
      </div>
    </div>
  )
}
