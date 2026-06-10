import { useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts'
import { CheckCircle, XCircle, AlertTriangle, HardDrive, ChevronDown, ChevronRight, BarChart3 } from 'lucide-react'
import VMCharts from '@/components/reports/VMCharts'
import { cn } from '@/lib/utils'

interface VMChartViewProps {
  vms: any[]
}

const HEALTH_COLORS: Record<string, string> = {
  healthy: '#22c55e',
  in_progress: '#3b82f6',
  partially_corrupted: '#f59e0b',
  all_corrupted: '#ef4444',
  no_backups: '#6b7280',
}

const HEALTH_LABELS: Record<string, string> = {
  healthy: 'Healthy',
  in_progress: 'In Progress',
  partially_corrupted: 'Partially Corrupted',
  all_corrupted: 'All Corrupted',
  no_backups: 'No Backups',
}

const formatBytes = (bytes: number): string => {
  if (!bytes || bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`
}

const getHealthIcon = (health: string) => {
  switch (health) {
    case 'healthy':
      return <CheckCircle className="h-4 w-4 text-green-600" />
    case 'in_progress':
      return <HardDrive className="h-4 w-4 text-blue-600 animate-pulse" />
    case 'partially_corrupted':
      return <AlertTriangle className="h-4 w-4 text-yellow-600" />
    case 'all_corrupted':
    case 'no_backups':
      return <XCircle className="h-4 w-4 text-red-600" />
    default:
      return <HardDrive className="h-4 w-4 text-gray-600" />
  }
}

export default function VMChartView({ vms }: VMChartViewProps) {
  const [showOverview, setShowOverview] = useState(true)
  const [expandedVMs, setExpandedVMs] = useState<Set<string>>(new Set())
  const [allExpanded, setAllExpanded] = useState(false)

  const toggleVM = (vmName: string) => {
    setExpandedVMs((prev) => {
      const next = new Set(prev)
      if (next.has(vmName)) next.delete(vmName)
      else next.add(vmName)
      return next
    })
  }

  const toggleAllVMs = () => {
    if (allExpanded) {
      setExpandedVMs(new Set())
      setAllExpanded(false)
    } else {
      setExpandedVMs(new Set(vms.map((vm: any) => vm.vm_name)))
      setAllExpanded(true)
    }
  }

  // Aggregate health distribution
  const healthData = useMemo(() => {
    const counts: Record<string, number> = {}
    vms.forEach((vm) => {
      const health = vm.health || 'unknown'
      counts[health] = (counts[health] || 0) + 1
    })
    return Object.entries(counts).map(([health, count]) => ({
      name: HEALTH_LABELS[health] || health,
      value: count,
      health,
      color: HEALTH_COLORS[health] || '#9ca3af',
    }))
  }, [vms])

  // Top VMs by size
  const topVMsBySize = useMemo(() => {
    return [...vms]
      .filter((vm) => vm.total_disk_usage_bytes > 0)
      .sort((a, b) => (b.total_disk_usage_bytes || 0) - (a.total_disk_usage_bytes || 0))
      .slice(0, 10)
      .map((vm) => ({
        name: vm.vm_name.length > 25 ? vm.vm_name.slice(0, 22) + '...' : vm.vm_name,
        fullName: vm.vm_name,
        sizeGB: parseFloat(((vm.total_disk_usage_bytes || 0) / (1024 * 1024 * 1024)).toFixed(2)),
        health: vm.health,
      }))
  }, [vms])

  // Summary statistics
  const stats = useMemo(() => {
    const totalSize = vms.reduce((sum, vm) => sum + (vm.total_disk_usage_bytes || 0), 0)
    const healthyCount = vms.filter((vm) => vm.health === 'healthy').length
    const issueCount = vms.filter(
      (vm) => vm.health === 'all_corrupted' || vm.health === 'partially_corrupted' || vm.health === 'no_backups'
    ).length
    const inProgressCount = vms.filter((vm) => vm.health === 'in_progress').length
    const avgSizePerVm = vms.length > 0 ? totalSize / vms.length : 0
    
    return {
      totalSize: formatBytes(totalSize),
      avgSize: formatBytes(avgSizePerVm),
      healthyCount,
      issueCount,
      inProgressCount,
      healthPercentage: vms.length > 0 ? Math.round((healthyCount / vms.length) * 100) : 0,
    }
  }, [vms])

  const CustomPieTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload
      return (
        <div className="bg-white border border-gray-200 rounded-lg shadow-lg p-3">
          <p className="font-medium text-gray-900">{data.name}</p>
          <p className="text-sm text-gray-600">
            <span className="font-semibold" style={{ color: data.color }}>{data.value}</span> VMs
          </p>
        </div>
      )
    }
    return null
  }

  const CustomBarTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload
      return (
        <div className="bg-white border border-gray-200 rounded-lg shadow-lg p-3">
          <p className="font-medium text-gray-900 max-w-md break-words">
            {data.fullName || data.name}
          </p>
          {payload.map((entry: any, idx: number) => (
            <p key={idx} className="text-sm" style={{ color: entry.color }}>
              {entry.name}: <span className="font-semibold">{entry.value}{entry.dataKey === 'sizeGB' ? ' GB' : ''}</span>
            </p>
          ))}
        </div>
      )
    }
    return null
  }

  if (vms.length === 0) {
    return (
      <Card>
        <CardContent className="py-12">
          <div className="text-center text-gray-500">
            <HardDrive className="h-12 w-12 mx-auto mb-2 text-gray-400" />
            <p>No data to visualize</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {/* Toggle Aggregate Overview */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowOverview(!showOverview)}
        >
          {showOverview ? <ChevronDown className="h-4 w-4 mr-1" /> : <ChevronRight className="h-4 w-4 mr-1" />}
          {showOverview ? 'Hide' : 'Show'} Overall Statistics
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={toggleAllVMs}
        >
          {allExpanded ? 'Collapse' : 'Expand'} All VM Charts
        </Button>
      </div>

      {/* Aggregate Overview Section */}
      {showOverview && (
        <div className="space-y-4 pb-4 border-b border-gray-200">
          {/* Quick Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-gray-600">Health Score</p>
                <p className="text-3xl font-bold text-green-600">{stats.healthPercentage}%</p>
                <p className="text-xs text-gray-500 mt-1">{stats.healthyCount}/{vms.length} healthy</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-gray-600">Total Storage</p>
                <p className="text-2xl font-bold text-purple-600">{stats.totalSize}</p>
                <p className="text-xs text-gray-500 mt-1">across all VMs</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-gray-600">Avg per VM</p>
                <p className="text-2xl font-bold text-blue-600">{stats.avgSize}</p>
                <p className="text-xs text-gray-500 mt-1">average size</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-gray-600">Issues</p>
                <p className="text-3xl font-bold text-red-600">{stats.issueCount}</p>
                <p className="text-xs text-gray-500 mt-1">need attention</p>
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Health Distribution Pie */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Overall Health Distribution</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={250}>
                  <PieChart>
                    <Pie
                      data={healthData}
                      cx="50%"
                      cy="50%"
                      labelLine={false}
                      label={({ name, percent }: any) => `${name}: ${(percent * 100).toFixed(0)}%`}
                      outerRadius={85}
                      dataKey="value"
                    >
                      {healthData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip content={<CustomPieTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            {/* Top VMs by Size */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Top 10 VMs by Size</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={250}>
                  <BarChart data={topVMsBySize} layout="vertical" margin={{ left: 10, right: 20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis type="number" tick={{ fontSize: 11 }} />
                    <YAxis dataKey="name" type="category" width={140} tick={{ fontSize: 10 }} />
                    <Tooltip content={<CustomBarTooltip />} />
                    <Bar dataKey="sizeGB" name="Size (GB)">
                      {topVMsBySize.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={HEALTH_COLORS[entry.health] || '#3b82f6'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {/* Per-VM Charts Section */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-blue-600" />
            Individual VM Charts
            <span className="text-xs font-normal text-gray-500">(click any VM to expand)</span>
          </h3>
        </div>

        <div className="space-y-2">
          {vms.map((vm: any) => {
            const isExpanded = expandedVMs.has(vm.vm_name)
            return (
              <Card key={vm.vm_name} className={cn(isExpanded && 'shadow-md')}>
                <CardContent className="p-3">
                  <button
                    onClick={() => toggleVM(vm.vm_name)}
                    className="w-full flex items-center justify-between gap-3 text-left hover:bg-gray-50 -m-3 p-3 rounded transition-colors"
                  >
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      {isExpanded ? <ChevronDown className="h-4 w-4 flex-shrink-0" /> : <ChevronRight className="h-4 w-4 flex-shrink-0" />}
                      {getHealthIcon(vm.health)}
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm truncate" title={vm.vm_name}>{vm.vm_name}</p>
                        <p className="text-xs text-gray-500 truncate">{vm.storage_pool_path}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      <Badge variant="outline" className="text-xs hidden sm:inline-flex">
                        {vm.available_schedule_count} schedules
                      </Badge>
                      <span className="text-sm font-mono text-gray-700">{vm.total_disk_usage_gb}</span>
                    </div>
                  </button>

                  {isExpanded && (
                    <div className="mt-4 pt-4 border-t">
                      <VMCharts vm={vm} />
                    </div>
                  )}
                </CardContent>
              </Card>
            )
          })}
        </div>
      </div>
    </div>
  )
}
