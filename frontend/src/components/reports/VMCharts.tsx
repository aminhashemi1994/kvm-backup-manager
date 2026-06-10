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
  LineChart,
  Line,
} from 'recharts'
import { HardDrive, Calendar, Layers, Activity } from 'lucide-react'

interface VMChartsProps {
  vm: any
}

const SCHEDULE_COLORS: Record<string, string> = {
  daily: '#3b82f6',
  weekly: '#8b5cf6',
  monthly: '#ec4899',
  custom: '#f59e0b',
  once: '#10b981',
  archived: '#6b7280',
}

const METHOD_COLORS: Record<string, string> = {
  full: '#22c55e',
  inc: '#3b82f6',
  copy: '#f59e0b',
}

const DISK_COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#ef4444']

const parseGbValue = (gbString: string | number | undefined): number => {
  if (typeof gbString === 'number') return gbString
  if (!gbString) return 0
  const match = String(gbString).match(/[\d.]+/)
  return match ? parseFloat(match[0]) : 0
}

export default function VMCharts({ vm }: VMChartsProps) {
  // Disk size breakdown across all schedules
  const diskSizeData = useMemo(() => {
    const diskMap: Record<string, { virtual: number; data: number; format: string }> = {}
    
    if (vm.schedules && Array.isArray(vm.schedules)) {
      vm.schedules.forEach((schedule: any) => {
        if (schedule.dump_analysis?.disks) {
          Object.entries(schedule.dump_analysis.disks).forEach(([diskName, disk]: any) => {
            const key = `${schedule.schedule}/${diskName}`
            diskMap[key] = {
              virtual: parseGbValue(disk.virtual_size_gb),
              data: parseGbValue(disk.total_data_gb),
              format: disk.disk_format || 'unknown',
            }
          })
        }
      })
    }
    
    return Object.entries(diskMap).map(([name, info]) => ({
      name,
      virtual: parseFloat(info.virtual.toFixed(2)),
      data: parseFloat(info.data.toFixed(2)),
      format: info.format,
    }))
  }, [vm])

  // Schedule size comparison
  const scheduleSizeData = useMemo(() => {
    if (!vm.schedules || !Array.isArray(vm.schedules)) return []
    
    return vm.schedules
      .filter((s: any) => s.available && !s.corrupted)
      .map((schedule: any) => ({
        name: schedule.schedule === 'archived' && schedule.archive_name
          ? `archive: ${schedule.archive_name.slice(0, 20)}...`
          : schedule.schedule,
        size: parseGbValue(schedule.disk_usage_gb),
        runs: schedule.recorded_run_count || 0,
        color: SCHEDULE_COLORS[schedule.schedule] || '#9ca3af',
      }))
      .filter((s: any) => s.size > 0)
  }, [vm])

  // Backup chain composition (full vs inc per disk per schedule)
  const chainCompositionData = useMemo(() => {
    const data: Array<{ name: string; full: number; inc: number }> = []
    
    if (vm.schedules && Array.isArray(vm.schedules)) {
      vm.schedules.forEach((schedule: any) => {
        if (schedule.dump_analysis?.disks) {
          Object.entries(schedule.dump_analysis.disks).forEach(([diskName, disk]: any) => {
            data.push({
              name: `${schedule.schedule}/${diskName}`,
              full: disk.full_checkpoint_count || 0,
              inc: disk.inc_checkpoint_count || 0,
            })
          })
        }
      })
    }
    
    return data
  }, [vm])

  // Backup history timeline from scheduler_log across all schedules
  const historyData = useMemo(() => {
    const allLogs: Array<{ date: string; method: string; schedule: string; sortKey: number }> = []
    
    if (vm.schedules && Array.isArray(vm.schedules)) {
      vm.schedules.forEach((schedule: any) => {
        if (schedule.scheduler_log && Array.isArray(schedule.scheduler_log)) {
          schedule.scheduler_log.forEach((log: any) => {
            // Parse date in DD/MM/YYYY format
            const dateParts = (log.date || '').split('/')
            let sortKey = 0
            if (dateParts.length === 3) {
              const [day, month, year] = dateParts
              sortKey = new Date(parseInt(year), parseInt(month) - 1, parseInt(day)).getTime()
            }
            allLogs.push({
              date: log.date || '',
              method: log.method || 'unknown',
              schedule: schedule.schedule,
              sortKey,
            })
          })
        }
      })
    }
    
    // Sort by date and aggregate by date
    allLogs.sort((a, b) => a.sortKey - b.sortKey)
    
    // Take the last 30 entries for the timeline
    const recent = allLogs.slice(-30)
    
    // Aggregate by date
    const byDate: Record<string, { date: string; full: number; inc: number; copy: number; total: number }> = {}
    recent.forEach((log) => {
      if (!byDate[log.date]) {
        byDate[log.date] = { date: log.date, full: 0, inc: 0, copy: 0, total: 0 }
      }
      const method = log.method.toLowerCase()
      if (method === 'full') byDate[log.date].full += 1
      else if (method === 'inc') byDate[log.date].inc += 1
      else if (method === 'copy') byDate[log.date].copy += 1
      byDate[log.date].total += 1
    })
    
    return Object.values(byDate).slice(-15) // Last 15 unique dates
  }, [vm])

  // Health/status overview pie
  const statusData = useMemo(() => {
    if (!vm.schedules || !Array.isArray(vm.schedules)) return []
    
    let healthy = 0
    let corrupted = 0
    let inProgress = 0
    let notAvailable = 0
    
    vm.schedules.forEach((schedule: any) => {
      if (!schedule.available) notAvailable += 1
      else if (schedule.corrupted) corrupted += 1
      else if (schedule.in_progress) inProgress += 1
      else healthy += 1
    })
    
    return [
      { name: 'Healthy', value: healthy, color: '#22c55e' },
      { name: 'Corrupted', value: corrupted, color: '#ef4444' },
      { name: 'In Progress', value: inProgress, color: '#3b82f6' },
      { name: 'Not Available', value: notAvailable, color: '#9ca3af' },
    ].filter((d) => d.value > 0)
  }, [vm])

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-white border border-gray-200 rounded-lg shadow-lg p-3">
          <p className="font-medium text-gray-900 text-sm mb-1">{label || payload[0].name}</p>
          {payload.map((entry: any, idx: number) => (
            <p key={idx} className="text-xs" style={{ color: entry.color || entry.fill }}>
              {entry.name}: <span className="font-semibold">{entry.value}{entry.dataKey?.includes('virtual') || entry.dataKey?.includes('data') || entry.dataKey === 'size' ? ' GB' : ''}</span>
            </p>
          ))}
        </div>
      )
    }
    return null
  }

  const hasAnyData = 
    diskSizeData.length > 0 || 
    scheduleSizeData.length > 0 || 
    chainCompositionData.length > 0 || 
    historyData.length > 0

  if (!hasAnyData) {
    return (
      <div className="text-center py-8 text-gray-500 text-sm">
        <HardDrive className="h-8 w-8 mx-auto mb-2 text-gray-400" />
        <p>No chart data available for this VM</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Quick Summary Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-blue-50 rounded-lg p-3 border border-blue-100">
          <div className="flex items-center gap-2 mb-1">
            <Layers className="h-3.5 w-3.5 text-blue-600" />
            <p className="text-xs text-gray-600">Schedules</p>
          </div>
          <p className="text-xl font-bold text-blue-700">{vm.available_schedule_count || 0}</p>
        </div>
        <div className="bg-purple-50 rounded-lg p-3 border border-purple-100">
          <div className="flex items-center gap-2 mb-1">
            <HardDrive className="h-3.5 w-3.5 text-purple-600" />
            <p className="text-xs text-gray-600">Total Size</p>
          </div>
          <p className="text-xl font-bold text-purple-700">{vm.total_disk_usage_gb || '0 GB'}</p>
        </div>
        <div className="bg-amber-50 rounded-lg p-3 border border-amber-100">
          <div className="flex items-center gap-2 mb-1">
            <Activity className="h-3.5 w-3.5 text-amber-600" />
            <p className="text-xs text-gray-600">Archived</p>
          </div>
          <p className="text-xl font-bold text-amber-700">{vm.archived_backup_count || 0}</p>
        </div>
        <div className="bg-red-50 rounded-lg p-3 border border-red-100">
          <div className="flex items-center gap-2 mb-1">
            <Activity className="h-3.5 w-3.5 text-red-600" />
            <p className="text-xs text-gray-600">Corrupted</p>
          </div>
          <p className="text-xl font-bold text-red-700">{vm.corrupted_schedule_count || 0}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Schedule Size Comparison */}
        {scheduleSizeData.length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <Layers className="h-4 w-4 text-blue-600" />
                Schedule Size Comparison
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={scheduleSizeData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} label={{ value: 'GB', angle: -90, position: 'insideLeft', style: { fontSize: 11 } }} />
                  <Tooltip content={<CustomTooltip />} />
                  <Bar dataKey="size" name="Size">
                    {scheduleSizeData.map((entry: any, index: number) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        )}

        {/* Status Distribution Pie */}
        {statusData.length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <Activity className="h-4 w-4 text-green-600" />
                Schedule Status Distribution
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie
                    data={statusData}
                    cx="50%"
                    cy="50%"
                    labelLine={false}
                    label={({ name, percent }: any) => `${name}: ${(percent * 100).toFixed(0)}%`}
                    outerRadius={80}
                    dataKey="value"
                  >
                    {statusData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip content={<CustomTooltip />} />
                </PieChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Backup Chain Composition (Full vs Inc per disk) */}
      {chainCompositionData.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Layers className="h-4 w-4 text-purple-600" />
              Backup Chain Composition (per disk)
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chainCompositionData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} angle={-15} textAnchor="end" height={60} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip content={<CustomTooltip />} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="full" name="Full Backups" stackId="a" fill={METHOD_COLORS.full} />
                <Bar dataKey="inc" name="Incremental" stackId="a" fill={METHOD_COLORS.inc} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Disk Size Breakdown (Virtual vs Data) */}
      {diskSizeData.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <HardDrive className="h-4 w-4 text-cyan-600" />
              Disk Size: Virtual vs Actual Data
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={diskSizeData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} angle={-15} textAnchor="end" height={60} />
                <YAxis tick={{ fontSize: 11 }} label={{ value: 'GB', angle: -90, position: 'insideLeft', style: { fontSize: 11 } }} />
                <Tooltip content={<CustomTooltip />} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="virtual" name="Virtual Size" fill="#06b6d4" />
                <Bar dataKey="data" name="Actual Data" fill="#8b5cf6" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Backup History Timeline */}
      {historyData.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Calendar className="h-4 w-4 text-orange-600" />
              Recent Backup History
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={historyData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="date" tick={{ fontSize: 10 }} angle={-15} textAnchor="end" height={50} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip content={<CustomTooltip />} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="full" name="Full" stroke={METHOD_COLORS.full} strokeWidth={2} />
                <Line type="monotone" dataKey="inc" name="Incremental" stroke={METHOD_COLORS.inc} strokeWidth={2} />
                {historyData.some((d) => d.copy > 0) && (
                  <Line type="monotone" dataKey="copy" name="Copy" stroke={METHOD_COLORS.copy} strokeWidth={2} />
                )}
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
