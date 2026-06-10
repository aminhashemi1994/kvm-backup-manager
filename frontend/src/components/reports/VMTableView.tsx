import { useState } from 'react'
import { ChevronUp, ChevronDown, CheckCircle, XCircle, AlertTriangle, HardDrive } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

interface VMTableViewProps {
  vms: any[]
}

type SortField = 'vm_name' | 'health' | 'total_disk_usage_bytes' | 'last_backup_at' | 'storage_pool_path'
type SortDirection = 'asc' | 'desc'

const formatBytes = (bytes: number): string => {
  if (!bytes || bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`
}

const formatDate = (dateString: string | null): string => {
  if (!dateString) return 'Never'
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return `${diffDays} days ago`
  return date.toLocaleDateString()
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
    let aVal = a[sortField]
    let bVal = b[sortField]
    
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
            <SortableHeader field="last_backup_at">Last Backup</SortableHeader>
            <SortableHeader field="storage_pool_path">Storage Pool</SortableHeader>
            <th className="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
              Schedules
            </th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {sortedVMs.map((vm) => {
            const scheduleCount = vm.schedules ? Object.keys(vm.schedules).length : 0
            const activeSchedules = vm.schedules 
              ? Object.entries(vm.schedules)
                  .filter(([_, s]: any) => s.backup_count > 0)
                  .map(([name]: any) => name)
              : []
            
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
                  {formatBytes(vm.total_disk_usage_bytes || 0)}
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-700">
                  {formatDate(vm.last_backup_at)}
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-600 font-mono text-xs">
                  <div className="truncate max-w-xs" title={vm.storage_pool_path}>
                    {vm.storage_pool_path || '-'}
                  </div>
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-700">
                  <div className="flex flex-wrap gap-1">
                    {activeSchedules.length > 0 ? (
                      activeSchedules.map((schedule: string) => (
                        <Badge key={schedule} variant="outline" className="text-xs">
                          {schedule}
                        </Badge>
                      ))
                    ) : (
                      <span className="text-gray-400 text-xs">No active</span>
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
