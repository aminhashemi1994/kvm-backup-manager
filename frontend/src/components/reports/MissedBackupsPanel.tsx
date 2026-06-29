import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Select } from '@/components/ui/select'
import {
  CalendarX, ChevronDown, ChevronRight, RefreshCw, CheckCircle,
  AlertTriangle, PowerOff, XCircle, Clock,
} from 'lucide-react'
import { reportsApi } from '@/services/api'
import { parseVmName } from '@/lib/utils'

interface MissedBackupsPanelProps {
  /** Limit to a single backup host. Omit for all hosts. */
  backupHostId?: string
}

const REASON_META: Record<string, { label: string; color: string; icon: React.ComponentType<{ className?: string }> }> = {
  no_run: {
    label: 'No run',
    color: 'bg-gray-100 text-gray-700 border-gray-200',
    icon: PowerOff,
  },
  failed: {
    label: 'Failed',
    color: 'bg-red-100 text-red-700 border-red-200',
    icon: XCircle,
  },
  skipped: {
    label: 'Skipped',
    color: 'bg-yellow-100 text-yellow-800 border-yellow-200',
    icon: AlertTriangle,
  },
}

const formatDateTime = (iso: string) => {
  const d = new Date(iso)
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

export default function MissedBackupsPanel({ backupHostId }: MissedBackupsPanelProps) {
  const [days, setDays] = useState<number>(30)
  const [expandedVMs, setExpandedVMs] = useState<Set<string>>(new Set())

  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ['missed-backups', backupHostId, days],
    queryFn: async () => {
      const res = await reportsApi.getMissedBackups({
        days,
        backupHostId: backupHostId || undefined,
      })
      return res.data.data as {
        window: { days: number; from: string; to: string }
        summary: {
          schedulesChecked: number
          vmsWithMissed: number
          totalExpected: number
          totalMissed: number
          overallAdherencePct: number
        }
        vms: Array<{
          vmId: string
          vmName: string
          backupHostName: string | null
          totalExpected: number
          totalMissed: number
          schedules: Array<{
            scheduleId: string
            scheduleName: string
            scheduleType: string
            expectedCount: number
            missedCount: number
            adherencePct: number
            missed: Array<{ scheduledAt: string; reason: string; detail: string }>
          }>
        }>
      }
    },
  })

  const toggleVM = (vmId: string) => {
    setExpandedVMs(prev => {
      const next = new Set(prev)
      if (next.has(vmId)) next.delete(vmId)
      else next.add(vmId)
      return next
    })
  }

  const summary = data?.summary
  const vms = data?.vms || []

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <CardTitle className="flex items-center gap-2">
            <CalendarX className="h-5 w-5 text-orange-600" />
            Missed Backups
          </CardTitle>
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-600">Window:</span>
            <Select
              value={days.toString()}
              onChange={(e) => setDays(Number(e.target.value))}
              className="w-28"
            >
              <option value="7">Last 7 days</option>
              <option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option>
              <option value="180">Last 180 days</option>
              <option value="365">Last year</option>
            </Select>
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              disabled={isFetching}
            >
              <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <RefreshCw className="h-8 w-8 animate-spin text-gray-400" />
          </div>
        ) : error ? (
          <div className="text-center py-8 text-red-600">
            <XCircle className="h-10 w-10 mx-auto mb-2" />
            <p>Failed to load missed backups</p>
          </div>
        ) : (
          <>
            {/* Summary */}
            {summary && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
                <div className="bg-orange-50 rounded-lg p-3 border border-orange-100">
                  <p className="text-xs text-gray-600">Total Missed</p>
                  <p className="text-2xl font-bold text-orange-700">{summary.totalMissed}</p>
                </div>
                <div className="bg-blue-50 rounded-lg p-3 border border-blue-100">
                  <p className="text-xs text-gray-600">Expected Runs</p>
                  <p className="text-2xl font-bold text-blue-700">{summary.totalExpected}</p>
                </div>
                <div className="bg-green-50 rounded-lg p-3 border border-green-100">
                  <p className="text-xs text-gray-600">Adherence</p>
                  <p className="text-2xl font-bold text-green-700">{summary.overallAdherencePct}%</p>
                </div>
                <div className="bg-gray-50 rounded-lg p-3 border border-gray-100">
                  <p className="text-xs text-gray-600">VMs Affected</p>
                  <p className="text-2xl font-bold text-gray-700">{summary.vmsWithMissed}</p>
                </div>
              </div>
            )}

            {vms.length === 0 ? (
              <div className="text-center py-10 text-gray-500">
                <CheckCircle className="h-12 w-12 mx-auto mb-2 text-green-500" />
                <p className="font-medium text-gray-700">No missed backups</p>
                <p className="text-sm">Every scheduled run in this window produced a successful backup.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {vms.map((vm) => {
                  const isExpanded = expandedVMs.has(vm.vmId)
                  const { title } = parseVmName(vm.vmName)
                  return (
                    <div key={vm.vmId} className="border border-gray-200 rounded-lg">
                      <button
                        onClick={() => toggleVM(vm.vmId)}
                        className="w-full flex items-center justify-between gap-3 p-3 text-left hover:bg-gray-50 rounded-lg transition-colors"
                      >
                        <div className="flex items-center gap-3 flex-1 min-w-0">
                          {isExpanded ? <ChevronDown className="h-4 w-4 flex-shrink-0" /> : <ChevronRight className="h-4 w-4 flex-shrink-0" />}
                          <CalendarX className="h-4 w-4 text-orange-500 flex-shrink-0" />
                          <div className="min-w-0">
                            <p className="font-medium text-sm truncate" title={vm.vmName}>{title}</p>
                            {vm.backupHostName && (
                              <p className="text-xs text-gray-400 truncate">{vm.backupHostName}</p>
                            )}
                          </div>
                        </div>
                        <Badge variant="outline" className="bg-orange-50 text-orange-700 border-orange-200 flex-shrink-0">
                          {vm.totalMissed} missed
                        </Badge>
                      </button>

                      {isExpanded && (
                        <div className="px-3 pb-3 space-y-3">
                          {vm.schedules.map((sch) => (
                            <div key={sch.scheduleId} className="border-t pt-3">
                              <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                                <div className="flex items-center gap-2">
                                  <Badge variant="outline" className="text-xs capitalize">{sch.scheduleType}</Badge>
                                  <span className="text-sm font-medium">{sch.scheduleName}</span>
                                </div>
                                <span className="text-xs text-gray-500">
                                  {sch.missedCount} of {sch.expectedCount} runs missed · {sch.adherencePct}% adherence
                                </span>
                              </div>
                              <div className="space-y-1">
                                {sch.missed.map((m, idx) => {
                                  const meta = REASON_META[m.reason] || REASON_META.no_run
                                  const Icon = meta.icon
                                  return (
                                    <div
                                      key={idx}
                                      className="flex items-center gap-2 text-sm py-1.5 px-2 rounded hover:bg-gray-50"
                                      title={m.detail}
                                    >
                                      <Clock className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
                                      <span className="font-mono text-xs text-gray-700 w-40 flex-shrink-0">
                                        {formatDateTime(m.scheduledAt)}
                                      </span>
                                      <Badge variant="outline" className={`text-xs flex items-center gap-1 ${meta.color}`}>
                                        <Icon className="h-3 w-3" />
                                        {meta.label}
                                      </Badge>
                                      <span className="text-xs text-gray-500 truncate">{m.detail}</span>
                                    </div>
                                  )
                                })}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
