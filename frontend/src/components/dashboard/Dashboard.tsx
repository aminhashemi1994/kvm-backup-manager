import { Server, HardDrive, CheckCircle, XCircle, Clock, Activity, AlertTriangle } from 'lucide-react'
import StatsCard from './StatsCard'
import RecentActivity from './RecentActivity'
import { useBackupHosts, useAllVMs, useHypervisors } from '@/hooks/useBackupHosts'
import { useBackupStats, useActiveBackups, useBackupHistory, useSchedules } from '@/hooks/useBackups'
import { useActiveRestores } from '@/hooks/useRestores'
import { useActiveOffsiteJobs } from '@/hooks/useOffsiteJobs'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useNavigate } from 'react-router-dom'
import { useMemo } from 'react'

export default function Dashboard() {
  const { data: backupHosts } = useBackupHosts()
  const { data: vms } = useAllVMs()
  const { data: hypervisors } = useHypervisors()
  const { data: schedules } = useSchedules()
  const { data: stats } = useBackupStats()
  const { data: activeBackups } = useActiveBackups()
  // Restores and offsite replications are jobs too, and a replication routinely
  // outlives the backup that asked for it — a transfer can be the only thing
  // running for hours. Counting backups alone made the card read "Nothing
  // running" while rsync was busy on two VMs. This mirrors what the Active
  // Backups page lists, so the tile and the page can no longer disagree.
  const { data: activeRestores } = useActiveRestores()
  const { data: activeReplications } = useActiveOffsiteJobs()
  const { data: recentHistory } = useBackupHistory({ limit: 100 })
  const navigate = useNavigate()

  const onlineHosts = backupHosts?.filter(h => h.status === 'online').length || 0
  const totalHosts = backupHosts?.length || 0

  // Only VMs that still belong to a hypervisor we know about. Rows whose
  // hypervisor is gone linger in the store and used to be counted here, which
  // is why the VM total read higher than what the Hypervisors page lists.
  const liveVMs = useMemo(() => {
    if (!vms) return []
    if (!hypervisors) return vms
    const known = new Set(hypervisors.map(h => h.id))
    return vms.filter(vm => known.has(vm.hypervisorId))
  }, [vms, hypervisors])
  const totalVMs = liveVMs.length

  // "Selected for backup" was reading vm.selected — a flag from the old
  // select-then-backup flow that nothing sets any more. What actually decides
  // whether a VM is backed up is having an enabled schedule, so count that.
  const scheduledVMs = useMemo(() => {
    if (!schedules) return 0
    const scheduled = new Set(
      schedules.filter(s => s.enabled && s.vmId).map(s => s.vmId)
    )
    return liveVMs.filter(vm => scheduled.has(vm.id)).length
  }, [schedules, liveVMs])

  const allActiveJobs = useMemo(() => [
    ...(activeBackups || []),
    ...(activeRestores || []),
    ...(activeReplications || []),
  ], [activeBackups, activeRestores, activeReplications])

  const activeJobs = allActiveJobs.length
  // Replications are broken out on their own rather than folded into
  // "running", so the parts still sum to the total and a transfer is never
  // mistaken for a backup that is not there.
  const backupAndRestoreJobs = useMemo(
    () => [...(activeBackups || []), ...(activeRestores || [])],
    [activeBackups, activeRestores]
  )
  const runningJobs = backupAndRestoreJobs.filter(j => j.status === 'running').length
  const queuedJobs = backupAndRestoreJobs.filter(j => j.status === 'queued').length
  const retryingJobs = backupAndRestoreJobs.filter(j => j.status === 'retrying').length
  const replicationJobs = activeReplications?.length || 0
  const activeBreakdown = [
    runningJobs ? `${runningJobs} running` : null,
    queuedJobs ? `${queuedJobs} queued` : null,
    retryingJobs ? `${retryingJobs} retrying` : null,
    replicationJobs ? `${replicationJobs} replicating` : null,
  ].filter(Boolean).join(', ')

  // Everything in the window that is neither completed nor failed — skipped,
  // cancelled, rejected, still running. Without this the three numbers on the
  // card did not add up to the total printed above them.
  const last24hOther = stats
    ? stats.last24h.total - stats.last24h.completed - stats.last24h.failed
    : 0

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
                    onClick={() => navigate('/backups/history?status=skipped')}
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
          description={`${scheduledVMs} on a backup schedule`}
          icon={HardDrive}
          colorClass="bg-purple-500"
        />

        <StatsCard
          title="Active Jobs"
          value={activeJobs}
          description={activeBreakdown || 'Nothing running or queued'}
          icon={Activity}
          colorClass="bg-orange-500"
        />

        <StatsCard
          title="Completed"
          value={stats?.completed || 0}
          description={`Successful runs, all time${stats?.skipped ? ` · ${stats.skipped} skipped` : ''}`}
          icon={CheckCircle}
          colorClass="bg-green-500"
        />

        <StatsCard
          title="Failed"
          value={stats?.failed || 0}
          description={
            stats
              ? `Failed runs, all time · ${stats.vmsFailingNow} VM${stats.vmsFailingNow === 1 ? '' : 's'} failing now`
              : 'Failed runs, all time'
          }
          icon={XCircle}
          colorClass="bg-red-500"
        />

        <StatsCard
          title="Last 24h"
          value={stats?.last24h?.total || 0}
          description={[
            `${stats?.last24h?.completed || 0} completed`,
            `${stats?.last24h?.failed || 0} failed`,
            last24hOther > 0 ? `${last24hOther} other` : null,
          ].filter(Boolean).join(', ')}
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
