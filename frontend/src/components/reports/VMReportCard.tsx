import { useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ChevronDown, ChevronRight, HardDrive, CheckCircle, XCircle, AlertTriangle } from 'lucide-react'
import ScheduleDetails from '@/components/reports/ScheduleDetails'
import ReportDownloadMenu from '@/components/reports/ReportDownloadMenu'
import { useAllVMs } from '@/hooks/useBackupHosts'

interface VMReportCardProps {
  vm: any
}

export default function VMReportCard({ vm }: VMReportCardProps) {
  const [expanded, setExpanded] = useState(false)
  const { data: allVMs } = useAllVMs()
  // The report record only has vm_name. Look up the controller-side VM id
  // so the download endpoint (which keys on id) can find the right entry.
  const vmId = allVMs?.find(v => v.name === vm.vm_name)?.id

  const getHealthColor = (health: string) => {
    switch (health) {
      case 'healthy':
        return 'bg-green-100 text-green-800'
      case 'in_progress':
        return 'bg-blue-100 text-blue-800'
      case 'partially_corrupted':
        return 'bg-yellow-100 text-yellow-800'
      case 'all_corrupted':
        return 'bg-red-100 text-red-800'
      case 'no_backups':
        return 'bg-gray-100 text-gray-800'
      default:
        return 'bg-gray-100 text-gray-800'
    }
  }

  const getHealthIcon = (health: string) => {
    switch (health) {
      case 'healthy':
        return <CheckCircle className="h-5 w-5 text-green-600" />
      case 'in_progress':
        return <HardDrive className="h-5 w-5 text-blue-600 animate-pulse" />
      case 'partially_corrupted':
        return <AlertTriangle className="h-5 w-5 text-yellow-600" />
      case 'all_corrupted':
      case 'no_backups':
        return <XCircle className="h-5 w-5 text-red-600" />
      default:
        return <HardDrive className="h-5 w-5 text-gray-600" />
    }
  }

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-4 flex-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </Button>

            {getHealthIcon(vm.health)}

            <div className="flex-1">
              <div className="flex items-center space-x-2">
                <h4 className="font-medium">{vm.vm_name}</h4>
                <Badge className={getHealthColor(vm.health)}>
                  {vm.health.replace('_', ' ')}
                </Badge>
              </div>
              <p className="text-sm text-gray-500 font-mono">{vm.vm_path}</p>
            </div>

            <div className="text-right">
              <p className="text-sm font-medium">{vm.total_disk_usage_gb}</p>
              <p className="text-xs text-gray-500">
                {vm.available_schedule_count} schedules
                {vm.archived_backup_count > 0 && ` • ${vm.archived_backup_count} archived`}
              </p>
            </div>
            {/* Per-VM report download. Always rendered so it's visible even
                while the VM lookup is loading; the menu component itself
                disables the trigger if scopeId is missing. */}
            <div onClick={(e) => e.stopPropagation()} className="ml-2">
              <ReportDownloadMenu
                scope="vm"
                scopeId={vmId || ''}
                label="Download"
                size="sm"
                variant="outline"
              />
            </div>
          </div>
        </div>

        {expanded && (
          <div className="mt-4 pt-4 border-t space-y-4">
            {/* Summary Stats */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <p className="text-gray-600">Available Schedules</p>
                <p className="font-medium">{vm.available_schedule_count}</p>
              </div>
              <div>
                <p className="text-gray-600">Corrupted</p>
                <p className="font-medium text-red-600">{vm.corrupted_schedule_count}</p>
              </div>
              <div>
                <p className="text-gray-600">Archived</p>
                <p className="font-medium">{vm.archived_backup_count}</p>
              </div>
              <div>
                <p className="text-gray-600">Total Size</p>
                <p className="font-medium">{vm.total_disk_usage_gb}</p>
              </div>
            </div>

            {/* Schedules */}
            <div className="space-y-2">
              <h5 className="font-medium text-sm">Backup Schedules</h5>
              {vm.schedules.map((schedule: any, index: number) => (
                <ScheduleDetails key={index} schedule={schedule} />
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
