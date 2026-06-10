import { CheckCircle, XCircle, AlertTriangle, HardDrive } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

interface VMCompactViewProps {
  vms: any[]
}

const getLastBackupDisplay = (vm: any): string => {
  if (!Array.isArray(vm.schedules)) return 'Never'
  
  let latest: Date | null = null
  vm.schedules.forEach((schedule: any) => {
    const dateStr = schedule.dump_analysis?.last_backup_date
    if (dateStr) {
      const d = new Date(dateStr)
      if (!latest || d > latest) latest = d
    }
  })
  
  if (!latest) return 'Never'
  
  const now = new Date()
  const diffMs = now.getTime() - (latest as Date).getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
  
  if (diffHours < 1) return 'Just now'
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays === 1) return '1d ago'
  if (diffDays < 30) return `${diffDays}d ago`
  return (latest as Date).toLocaleDateString()
}

const getHealthIcon = (health: string) => {
  switch (health) {
    case 'healthy':
      return <CheckCircle className="h-4 w-4 text-green-600 flex-shrink-0" />
    case 'in_progress':
      return <HardDrive className="h-4 w-4 text-blue-600 flex-shrink-0 animate-pulse" />
    case 'partially_corrupted':
      return <AlertTriangle className="h-4 w-4 text-yellow-600 flex-shrink-0" />
    case 'all_corrupted':
    case 'no_backups':
      return <XCircle className="h-4 w-4 text-red-600 flex-shrink-0" />
    default:
      return <HardDrive className="h-4 w-4 text-gray-600 flex-shrink-0" />
  }
}

const getHealthBorderColor = (health: string) => {
  switch (health) {
    case 'healthy':
      return 'border-l-green-500'
    case 'in_progress':
      return 'border-l-blue-500'
    case 'partially_corrupted':
      return 'border-l-yellow-500'
    case 'all_corrupted':
    case 'no_backups':
      return 'border-l-red-500'
    default:
      return 'border-l-gray-400'
  }
}

export default function VMCompactView({ vms }: VMCompactViewProps) {
  if (vms.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500">
        <HardDrive className="h-12 w-12 mx-auto mb-2 text-gray-400" />
        <p>No VMs to display</p>
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      {vms.map((vm) => {
        const activeSchedules = Array.isArray(vm.schedules)
          ? vm.schedules
              .filter((s: any) => s.available && !s.corrupted)
              .map((s: any) => s.schedule)
          : []

        return (
          <div
            key={vm.vm_name}
            className={cn(
              'flex items-center justify-between gap-3 px-4 py-2.5 bg-white border border-gray-200 border-l-4 rounded-md hover:bg-gray-50 transition-colors',
              getHealthBorderColor(vm.health)
            )}
          >
            <div className="flex items-center gap-3 flex-1 min-w-0">
              {getHealthIcon(vm.health)}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate" title={vm.vm_name}>
                  {vm.vm_name}
                </p>
                {vm.storage_pool_path && (
                  <p className="text-xs text-gray-500 font-mono truncate" title={vm.storage_pool_path}>
                    {vm.storage_pool_path}
                  </p>
                )}
              </div>
            </div>
            
            <div className="flex items-center gap-4 flex-shrink-0">
              {activeSchedules.length > 0 && (
                <div className="hidden md:flex items-center gap-1">
                  {activeSchedules.slice(0, 3).map((schedule: string) => (
                    <Badge key={schedule} variant="outline" className="text-xs px-1.5 py-0">
                      {schedule}
                    </Badge>
                  ))}
                  {activeSchedules.length > 3 && (
                    <span className="text-xs text-gray-500">+{activeSchedules.length - 3}</span>
                  )}
                </div>
              )}
              
              <div className="text-xs text-gray-500 hidden sm:block whitespace-nowrap">
                {getLastBackupDisplay(vm)}
              </div>
              
              <div className="text-sm font-mono text-gray-700 min-w-[80px] text-right">
                {vm.total_disk_usage_gb || '0 GB'}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
