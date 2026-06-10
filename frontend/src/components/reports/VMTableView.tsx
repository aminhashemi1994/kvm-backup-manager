import { useState } from 'react'
import { ChevronUp, ChevronDown, CheckCircle, XCircle, AlertTriangle, HardDrive } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

interface VMTableViewProps {
  vms: any[]
}

type SortField = 'vm_name' | 'health' | 'total_disk_usage_bytes' | 'last_backup_date' | 'storage_pool_path' | 'schedule_count'
type SortDirection = 'asc' | 'desc'

const formatBytes = (bytes: number): string => {
  if (!bytes || bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`
}

const getLastBackupDate = (vm: any): { date: Date | null; display: string } => {
  if (!Array.isArray(vm.schedules)) return { date: null, display: 'Never' }
  
  let latest: Date | null = null
  vm.schedules.forEach((schedule: any) => {
    const dateStr = schedule.dump_analysis?.last_backup_date
    if (dateStr) {
      const d = new Date(dateStr)
      if (!latest || d > latest) {
        latest = d
      }
    }
  })
  
  if (!latest) return { date: null, display: 'Never' }
  
  const now = new Date()
  const diffMs = now.getTime() - (latest as Date).getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  
  let display: string
  if (diffDays === 0) display = 'Today'
  else if (diffDays === 1) display = 'Yesterday'
  else if (diffDays < 7) display = `${diffDays} days ago`
  else display = (latest as Date).toLocaleDateString()
  
  return { date: latest, display }
}

const getHealthBadge = (health: string) => {
  const healthConfig: Record<string, { color: string; label: string; icon: React.ComponentType<{ className?: string }> }> = {
    healthy: { color: 'bg-green-100 text-green-800 border-green-200', label: 'Healthy', icon: CheckCircle },
    in_progress: { color: 'bg-blue-100 text-blue-800 border-blue-200', label: 'In Progress', icon: HardDrive },
    partially_corrupted: { color: 'bg-yellow-100 text-yellow-800 border-yellow-200', label: 'Partial', icon: AlertTriangle },
    all_corrupted: { color: 'bg-red-100 text-red-800 border-red-200', label: 'Corrupted', icon: XCircle },
    no_backups: { color: 'bg-gray-100 text-gray-800 border-gray-200', label: 'No Backups', icon: XCircle },
  }
  
  const config = healthConfig[health] || { color: 'bg-gray-100 text-gray-800 border-gray-200', label: health, icon: HardDrive }
  const Icon = config.icon
  
  return (
    <Badge variant="outline" className={cn('flex items-center space-x-1 w-fit', config.color)}>
      <Icon className="h-3 w-3" />
      <span>{config.label}</span>
    </Badge>
  )
}

export default function VMTableView({ vms }: VMTableViewProps) {
  const [sortField, setSortField] = useState<SortField>('vm_name')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDirection('asc')
    }
  }

  const sortedVMs = [...vms].sort((a, b) => {
    let aVal: any
    let bVal: any
    
    if (sortField === 'last_backup_date') {
      aVal = getLastBackupDate(a).date?.getTime() || 0
      bVal = getLastBackupDate(b).date?.getTime() || 0
    } else if (sortField === 'schedule_count') {
      aVal = a.available_schedule_count || 0
      bVal = b.available_schedule_count || 0
    } else {
      aVal = a[sortField]
      bVal = b[sortField]
    }
    
    if (aVal === null || aVal === undefined) aVal = ''
    if (bVal === null || bVal === undefined) bVal = ''
    
    if (typeof aVal === 'string') aVal = aVal.toLowerCase()
    if (typeof bVal === 'string') bVal = bVal.toLowerCase()
    
    if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1
    if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1
    return 0
  })

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <ChevronDown className="h-3 w-3 opacity-30" />
    return sortDirection === 'asc' 
      ? <ChevronUp className="h-3 w-3" />
      : <ChevronDown className="h-3 w-3" />
  }

  const SortableHeader = ({ field, children }: { field: SortField; children: React.ReactNode }) => (
    <th 
      onClick={() => handleSort(field)}
      className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider cursor-pointer hover:bg-gray-100 select-none"
    >
      <div className="flex items-center space-x-1">
        <span>{children}</span>
        <SortIcon field={field} />
      </div>
    </th>
  )

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <SortableHeader field="vm_name">VM Name</SortableHeader>
            <SortableHeader field="health">Health</SortableHeader>
            <SortableHeader field="total_disk_usage_bytes">Total Size</SortableHeader>
            <SortableHeader field="last_backup_date">Last Backup</SortableHeader>
            <SortableHeader field="storage_pool_path">Storage Pool</SortableHeader>
            <SortableHeader field="schedule_count">Schedules</SortableHeader>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {sortedVMs.map((vm) => {
            const activeSchedules = Array.isArray(vm.schedules)
              ? vm.schedules
                  .filter((s: any) => s.available && !s.corrupted)
                  .map((s: any) => s.schedule)
              : []
            const lastBackup = getLastBackupDate(vm)
            
            return (
              <tr key={vm.vm_name} className="hover:bg-gray-50 transition-colors">
                <td className="px-4 py-3 whitespace-nowrap">
                  <div className="text-sm font-medium text-gray-900 truncate max-w-xs" title={vm.vm_name}>
                    {vm.vm_name}
                  </div>
                </td>
                <td className="px-4 py-3 whitespace-nowrap">
                  {getHealthBadge(vm.health)}
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-700 font-mono">
                  {vm.total_disk_usage_gb || formatBytes(vm.total_disk_usage_bytes || 0)}
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-700">
                  {lastBackup.display}
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-600 font-mono text-xs">
                  <div className="truncate max-w-xs" title={vm.storage_pool_path}>
                    {vm.storage_pool_path || '-'}
                  </div>
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-700">
                  <div className="flex flex-wrap gap-1">
                    {activeSchedules.length > 0 ? (
                      activeSchedules.slice(0, 4).map((schedule: string) => (
                        <Badge key={schedule} variant="outline" className="text-xs">
                          {schedule}
                        </Badge>
                      ))
                    ) : (
                      <span className="text-gray-400 text-xs">No active</span>
                    )}
                    {activeSchedules.length > 4 && (
                      <span className="text-xs text-gray-500">+{activeSchedules.length - 4}</span>
                    )}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {sortedVMs.length === 0 && (
        <div className="text-center py-12 text-gray-500">
          <HardDrive className="h-12 w-12 mx-auto mb-2 text-gray-400" />
          <p>No VMs to display</p>
        </div>
      )}
    </div>
  )
}
