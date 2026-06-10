import { Badge } from '@/components/ui/badge'
import { CheckCircle, XCircle, AlertTriangle, HardDrive, Clock } from 'lucide-react'
import { cn } from '@/lib/utils'

interface VMScheduleTableProps {
  vm: any
}

const getStatusBadge = (schedule: any) => {
  if (!schedule.available) {
    return <Badge variant="outline" className="text-xs bg-gray-100 text-gray-600">Not Available</Badge>
  }
  if (schedule.corrupted) {
    return <Badge variant="destructive" className="text-xs">Corrupted</Badge>
  }
  if (schedule.in_progress) {
    return <Badge className="text-xs bg-blue-100 text-blue-800 border-blue-200">In Progress</Badge>
  }
  return <Badge className="text-xs bg-green-100 text-green-800 border-green-200">Healthy</Badge>
}

const getStatusIcon = (schedule: any) => {
  if (!schedule.available) return <XCircle className="h-4 w-4 text-gray-400" />
  if (schedule.corrupted) return <XCircle className="h-4 w-4 text-red-600" />
  if (schedule.in_progress) return <HardDrive className="h-4 w-4 text-blue-600 animate-pulse" />
  return <CheckCircle className="h-4 w-4 text-green-600" />
}

export default function VMScheduleTable({ vm }: VMScheduleTableProps) {
  const schedules = vm.schedules || []

  if (schedules.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500">
        <HardDrive className="h-8 w-8 mx-auto mb-2 text-gray-400" />
        <p className="text-sm">No schedules to display</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Schedules Table */}
      <div>
        <h5 className="text-sm font-medium mb-2 text-gray-700">Schedules Overview</h5>
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Status</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Schedule</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Size</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Disks</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Chain Depth</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Recorded Runs</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Methods</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Last Backup</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {schedules.map((schedule: any, index: number) => {
                const analysis = schedule.dump_analysis
                const lastBackup = analysis?.last_backup_date 
                  ? new Date(analysis.last_backup_date).toLocaleDateString()
                  : '-'
                return (
                  <tr key={index} className={cn(
                    'hover:bg-gray-50',
                    schedule.corrupted && 'bg-red-50',
                    schedule.in_progress && 'bg-blue-50'
                  )}>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        {getStatusIcon(schedule)}
                        {getStatusBadge(schedule)}
                      </div>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-sm font-medium text-gray-900">
                      <div className="capitalize">
                        {schedule.schedule === 'archived' && schedule.archive_name ? (
                          <span title={schedule.archive_name}>archive</span>
                        ) : (
                          schedule.schedule
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-700 font-mono">
                      {schedule.disk_usage_gb || '-'}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-700">
                      {analysis?.disk_count ?? '-'}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-700">
                      {analysis?.chain_depth ?? '-'}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-700">
                      {schedule.recorded_run_count ?? 0}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-700">
                      <div className="flex gap-1 flex-wrap">
                        {schedule.inferred_methods?.length > 0 ? (
                          schedule.inferred_methods.map((m: string) => (
                            <Badge key={m} variant="outline" className="text-xs">{m}</Badge>
                          ))
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-700">
                      {lastBackup}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Disks Table - Aggregated across all schedules */}
      {(() => {
        const allDisks: Array<{ schedule: string; diskName: string; disk: any }> = []
        schedules.forEach((schedule: any) => {
          if (schedule.dump_analysis?.disks) {
            Object.entries(schedule.dump_analysis.disks).forEach(([diskName, disk]: any) => {
              allDisks.push({ schedule: schedule.schedule, diskName, disk })
            })
          }
        })

        if (allDisks.length === 0) return null

        return (
          <div>
            <h5 className="text-sm font-medium mb-2 text-gray-700">Disks Detail</h5>
            <div className="overflow-x-auto rounded-lg border border-gray-200">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Schedule</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Disk</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Format</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Virtual Size</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Data Size</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Full</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Inc</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {allDisks.map(({ schedule, diskName, disk }, index) => (
                    <tr key={`${schedule}-${diskName}-${index}`} className="hover:bg-gray-50">
                      <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-700 capitalize">
                        {schedule}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-sm font-medium text-gray-900 font-mono">
                        {disk.disk_name || diskName}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-700">
                        <Badge variant="outline" className="text-xs">{disk.disk_format || 'unknown'}</Badge>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-700 font-mono">
                        {disk.virtual_size_gb || '-'}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-700 font-mono">
                        {disk.total_data_gb || '-'}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-sm text-green-700 font-medium">
                        {disk.full_checkpoint_count ?? 0}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-sm text-blue-700 font-medium">
                        {disk.inc_checkpoint_count ?? 0}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      })()}

      {/* Recent Runs Table - Aggregated across all schedules */}
      {(() => {
        const allLogs: Array<{ schedule: string; day: string; date: string; method: string }> = []
        schedules.forEach((schedule: any) => {
          if (schedule.scheduler_log?.length > 0) {
            schedule.scheduler_log.slice(0, 10).forEach((log: any) => {
              allLogs.push({
                schedule: schedule.schedule,
                day: log.day,
                date: log.date,
                method: log.method,
              })
            })
          }
        })

        if (allLogs.length === 0) return null

        return (
          <div>
            <h5 className="text-sm font-medium mb-2 text-gray-700 flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Recent Backup Runs
            </h5>
            <div className="overflow-x-auto rounded-lg border border-gray-200">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Schedule</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Day</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Date</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">Method</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {allLogs.slice(0, 20).map((log, index) => (
                    <tr key={index} className="hover:bg-gray-50">
                      <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-700 capitalize">{log.schedule}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-700">{log.day}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-700">{log.date}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-sm">
                        <Badge variant="outline" className={cn(
                          'text-xs',
                          log.method?.toLowerCase() === 'full' && 'bg-green-50 text-green-700 border-green-200',
                          log.method?.toLowerCase() === 'inc' && 'bg-blue-50 text-blue-700 border-blue-200',
                        )}>
                          {log.method}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
