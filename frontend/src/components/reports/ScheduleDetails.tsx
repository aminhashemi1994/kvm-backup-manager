import { useState } from 'react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ChevronDown, ChevronRight, Calendar, HardDrive, AlertCircle, CheckCircle } from 'lucide-react'

interface ScheduleDetailsProps {
  schedule: any
}

// Utility function to remove ANSI color codes
const stripAnsiCodes = (text: string): string => {
  if (!text) return ''
  return text
    .replace(/\x1b\[[0-9;]*m/g, '') // Remove ANSI color codes
    .replace(/\x1b\[K/g, '')         // Remove clear line
    .replace(/\\u001b\[[0-9;]*m/g, '') // Remove escaped ANSI codes
    .replace(/\r/g, '')              // Remove carriage returns
    .replace(/\|/g, ' ')             // Replace pipe separators with spaces
    .trim()
}

export default function ScheduleDetails({ schedule }: ScheduleDetailsProps) {
  const [expanded, setExpanded] = useState(false)

  const isInProgress = schedule.in_progress === true || schedule.in_progress === 'true'
  const isLegacyFormat = schedule.is_legacy_format === true || schedule.is_legacy_format === 'true'
  const backupLocation = schedule.backup_location || null

  if (!schedule.available) {
    const reason = schedule.reason ? schedule.reason.replace(/_/g, ' ') : 'Not available'
    return (
      <Card className="p-3 bg-gray-50">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <AlertCircle className="h-4 w-4 text-gray-400" />
            <span className="text-sm font-medium capitalize">{schedule.schedule}</span>
            <Badge variant="outline" className="text-xs capitalize">{reason}</Badge>
          </div>
        </div>
      </Card>
    )
  }

  const analysis = schedule.dump_analysis

  return (
    <Card className={`p-3 ${
      schedule.corrupted 
        ? 'bg-red-50 border-red-200' 
        : isInProgress
        ? 'bg-blue-50 border-blue-200'
        : 'bg-white'
    }`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-3 flex-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </Button>

          {schedule.corrupted ? (
            <AlertCircle className="h-4 w-4 text-red-600" />
          ) : isInProgress ? (
            <HardDrive className="h-4 w-4 text-blue-600 animate-pulse" />
          ) : (
            <CheckCircle className="h-4 w-4 text-green-600" />
          )}

          <div className="flex-1">
            <div className="flex items-center space-x-2 flex-wrap">
              <span className="text-sm font-medium capitalize">
                {schedule.schedule === 'archived' ? (
                  <>Archive: {schedule.archive_name}</>
                ) : (
                  schedule.schedule
                )}
              </span>
              {isLegacyFormat && (
                <Badge className="text-xs bg-amber-100 text-amber-800 border-amber-200">
                  Legacy Format{backupLocation ? ` (${backupLocation})` : ''}
                </Badge>
              )}
              {isInProgress && (
                <Badge className="text-xs bg-blue-100 text-blue-800 border-blue-200">
                  In Progress
                </Badge>
              )}
              {schedule.corrupted && (
                <Badge variant="destructive" className="text-xs">Corrupted</Badge>
              )}
              {schedule.inferred_methods && (
                <div className="flex space-x-1">
                  {schedule.inferred_methods.map((method: string) => (
                    <Badge key={method} variant="outline" className="text-xs">
                      {method}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="text-right text-sm">
            <p className="font-medium">{schedule.disk_usage_gb}</p>
            {analysis && (
              <p className="text-xs text-gray-500">
                {analysis.disk_count} disk{analysis.disk_count !== 1 ? 's' : ''}
              </p>
            )}
          </div>
        </div>
      </div>

      {expanded && (
        <div className="mt-3 pt-3 border-t space-y-3">
          {/* Error Info */}
          {schedule.corrupted && schedule.dump_error && (
            <div className="bg-red-100 border border-red-200 rounded p-2">
              <p className="text-sm text-red-800 font-medium">
                Error: {stripAnsiCodes(typeof schedule.dump_error === 'string' ? schedule.dump_error : JSON.stringify(schedule.dump_error))}
              </p>
              {schedule.dump_exit_code && (
                <p className="text-xs text-red-600 mt-1">Exit code: {schedule.dump_exit_code}</p>
              )}
              {schedule.dump_stderr && (
                <details className="mt-2">
                  <summary className="text-xs text-red-700 cursor-pointer hover:underline">
                    Show detailed error output
                  </summary>
                  <pre className="text-xs text-red-700 mt-1 whitespace-pre-wrap break-words bg-red-50 p-2 rounded">
                    {stripAnsiCodes(schedule.dump_stderr)}
                  </pre>
                </details>
              )}
            </div>
          )}

          {/* Basic Info */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
            <div>
              <p className="text-gray-600">Path</p>
              <p className="font-mono text-xs break-all">{schedule.path}</p>
            </div>
            <div>
              <p className="text-gray-600">Recorded Runs</p>
              <p className="font-medium">{schedule.recorded_run_count}</p>
            </div>
            {schedule.file_count !== undefined && (
              <div>
                <p className="text-gray-600">Files</p>
                <p className="font-medium">{schedule.file_count}</p>
              </div>
            )}
          </div>

          {/* Analysis */}
          {analysis && (
            <div className="space-y-2">
              <h6 className="text-sm font-medium">Backup Analysis</h6>
              
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                <div>
                  <p className="text-gray-600">Total Virtual Size</p>
                  <p className="font-medium">{analysis.total_virtual_gb}</p>
                </div>
                <div>
                  <p className="text-gray-600">Total Data Size</p>
                  <p className="font-medium">{analysis.total_data_gb}</p>
                </div>
                <div>
                  <p className="text-gray-600">Chain Depth</p>
                  <p className="font-medium">{analysis.chain_depth}</p>
                </div>
                <div>
                  <p className="text-gray-600">Has Incremental</p>
                  <p className="font-medium">{analysis.has_incremental ? 'Yes' : 'No'}</p>
                </div>
              </div>

              {analysis.first_backup_date && (
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <p className="text-gray-600">First Backup</p>
                    <p className="font-medium">{new Date(analysis.first_backup_date).toLocaleString()}</p>
                  </div>
                  <div>
                    <p className="text-gray-600">Last Backup</p>
                    <p className="font-medium">{new Date(analysis.last_backup_date).toLocaleString()}</p>
                  </div>
                </div>
              )}

              {/* Disks */}
              {analysis.disks && Object.keys(analysis.disks).length > 0 && (
                <div className="space-y-2">
                  <h6 className="text-xs font-medium">Disks</h6>
                  {Object.entries(analysis.disks).map(([diskName, disk]: [string, any]) => (
                    <Card key={diskName} className="p-2 bg-gray-50">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center space-x-2">
                          <HardDrive className="h-3 w-3" />
                          <span className="text-xs font-medium">{disk.disk_name}</span>
                          <Badge variant="outline" className="text-xs">{disk.disk_format}</Badge>
                        </div>
                        <span className="text-xs font-medium">{disk.virtual_size_gb}</span>
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-xs">
                        <div>
                          <p className="text-gray-600">Data Size</p>
                          <p className="font-medium">{disk.total_data_gb}</p>
                        </div>
                        <div>
                          <p className="text-gray-600">Full Backups</p>
                          <p className="font-medium">{disk.full_checkpoint_count}</p>
                        </div>
                        <div>
                          <p className="text-gray-600">Incremental</p>
                          <p className="font-medium">{disk.inc_checkpoint_count}</p>
                        </div>
                      </div>
                    </Card>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Scheduler Log */}
          {schedule.scheduler_log && schedule.scheduler_log.length > 0 && (
            <div className="space-y-1">
              <h6 className="text-xs font-medium">Recent Runs</h6>
              <div className="space-y-1">
                {schedule.scheduler_log.slice(0, 5).map((log: any, index: number) => (
                  <div key={index} className="flex items-center space-x-2 text-xs">
                    <Calendar className="h-3 w-3 text-gray-400" />
                    <span className="font-medium">{log.day}</span>
                    <span className="text-gray-600">{log.date}</span>
                    <Badge variant="outline" className="text-xs">{log.method}</Badge>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  )
}
