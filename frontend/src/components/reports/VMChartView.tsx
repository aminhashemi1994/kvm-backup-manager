import { useMemo } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import { CheckCircle, XCircle, AlertTriangle, HardDrive } from 'lucide-react'

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

const SCHEDULE_COLORS: Record<string, string> = {
  daily: '#3b82f6',
  weekly: '#8b5cf6',
  monthly: '#ec4899',
  custom: '#f59e0b',
  once: '#10b981',
}

const formatBytes = (bytes: number): string => {
  if (!bytes || bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`
}

export default function VMChartView({ vms }: VMChartViewProps) {
  // Health distribution data
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

  // Storage pool distribution data
  const storagePoolData = useMemo(() => {
    const pools: Record<string, { count: number; size: number }> = {}
    vms.forEach((vm) => {
      const pool = vm.storage_pool_path || 'Unknown'
      if (!pools[pool]) {
        pools[pool] = { count: 0, size: 0 }
      }
      pools[pool].count += 1
      pools[pool].size += vm.total_disk_usage_bytes || 0
    })
    return Object.entries(pools)
      .map(([pool, data]) => ({
        name: pool.length > 30 ? '...' + pool.slice(-27) : pool,
        fullName: pool,
        count: data.count,
        sizeGB: parseFloat((data.size / (1024 * 1024 * 1024)).toFixed(2)),
      }))
      .sort((a, b) => b.sizeGB - a.sizeGB)
      .slice(0, 10) // Top 10 storage pools
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

  // Schedule type distribution
  const scheduleData = useMemo(() => {
    const schedules: Record<string, number> = {}
    vms.forEach((vm) => {
      if (vm.schedules) {
        Object.entries(vm.schedules).forEach(([scheduleName, scheduleData]: any) => {
          if (scheduleData.backup_count > 0) {
            schedules[scheduleName] = (schedules[scheduleName] || 0) + 1
          }
        })
      }
    })
    return Object.entries(schedules).map(([name, count]) => ({
      name,
      count,
      color: SCHEDULE_COLORS[name] || '#9ca3af',
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
    <div className="space-y-6">
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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Health Distribution Pie Chart */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Health Distribution</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={healthData}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  label={({ name, percent }: any) => `${name}: ${(percent * 100).toFixed(0)}%`}
                  outerRadius={100}
                  fill="#8884d8"
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

        {/* Schedule Type Distribution */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Active Backup Schedules</CardTitle>
          </CardHeader>
          <CardContent>
            {scheduleData.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={scheduleData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="name" />
                  <YAxis allowDecimals={false} />
                  <Tooltip content={<CustomBarTooltip />} />
                  <Bar dataKey="count" name="VMs with this schedule">
                    {scheduleData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-[300px] text-gray-500">
                <p>No active schedules</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Storage Pool Distribution */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Storage Pool Usage (Top 10)</CardTitle>
        </CardHeader>
        <CardContent>
          {storagePoolData.length > 0 ? (
            <ResponsiveContainer width="100%" height={350}>
              <BarChart data={storagePoolData} layout="vertical" margin={{ left: 20, right: 30 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis type="number" />
                <YAxis dataKey="name" type="category" width={150} tick={{ fontSize: 12 }} />
                <Tooltip content={<CustomBarTooltip />} />
                <Legend />
                <Bar dataKey="sizeGB" name="Size (GB)" fill="#8b5cf6" />
                <Bar dataKey="count" name="VM Count" fill="#3b82f6" />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-[350px] text-gray-500">
              <p>No storage pool data</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Top VMs by Size */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Top 10 VMs by Backup Size</CardTitle>
        </CardHeader>
        <CardContent>
          {topVMsBySize.length > 0 ? (
            <ResponsiveContainer width="100%" height={400}>
              <BarChart data={topVMsBySize} layout="vertical" margin={{ left: 20, right: 30 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis type="number" />
                <YAxis dataKey="name" type="category" width={180} tick={{ fontSize: 11 }} />
                <Tooltip content={<CustomBarTooltip />} />
                <Bar dataKey="sizeGB" name="Size (GB)">
                  {topVMsBySize.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={HEALTH_COLORS[entry.health] || '#3b82f6'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-[400px] text-gray-500">
              <p>No VM size data</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Health Legend */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Health Status Legend</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {Object.entries(HEALTH_LABELS).map(([key, label]) => {
              const Icon = key === 'healthy' ? CheckCircle 
                : key === 'in_progress' ? HardDrive
                : key === 'partially_corrupted' ? AlertTriangle
                : XCircle
              return (
                <div key={key} className="flex items-center space-x-2">
                  <div 
                    className="w-3 h-3 rounded-sm"
                    style={{ backgroundColor: HEALTH_COLORS[key] }}
                  />
                  <Icon className="h-4 w-4" style={{ color: HEALTH_COLORS[key] }} />
                  <span className="text-sm text-gray-700">{label}</span>
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
