import { Badge } from '@/components/ui/badge'
import { Upload, Download, RefreshCw, AlertTriangle, CheckCircle, Clock, Zap, ArrowRightLeft } from 'lucide-react'

interface JobStatusBadgeProps {
  status: string
  phase?: string
  jobType?: 'backup' | 'restore'
  failureReason?: string
  replay?: boolean
  className?: string
}

/**
 * JobStatusBadge (Item 6)
 *
 * Rich status visualization for backup/restore jobs showing:
 * - Phase-aware status (backup, rsync, restore, queued, completed, failed)
 * - Failure reason tooltip
 * - Replay indicator for missed-run replays
 */
export default function JobStatusBadge({
  status,
  phase,
  jobType = 'backup',
  failureReason,
  replay,
  className = '',
}: JobStatusBadgeProps) {
  const getPhaseConfig = () => {
    // Running states with phase
    if (status === 'running' || (status === 'queued' && phase)) {
      switch (phase) {
        case 'backup':
          return {
            label: 'Backing up',
            icon: Upload,
            color: 'bg-blue-100 text-blue-800 border-blue-200',
            pulse: true,
          }
        case 'rsync':
          return {
            label: 'Syncing offsite',
            icon: ArrowRightLeft,
            color: 'bg-purple-100 text-purple-800 border-purple-200',
            pulse: true,
          }
        case 'restore':
          return {
            label: 'Restoring',
            icon: Download,
            color: 'bg-green-100 text-green-800 border-green-200',
            pulse: true,
          }
        case 'starting':
          return {
            label: 'Starting',
            icon: Zap,
            color: 'bg-yellow-100 text-yellow-800 border-yellow-200',
            pulse: true,
          }
        default:
          return {
            label: 'Running',
            icon: RefreshCw,
            color: 'bg-blue-100 text-blue-800 border-blue-200',
            pulse: true,
          }
      }
    }

    // Retrying state
    if (status === 'retrying') {
      return {
        label: 'Retrying',
        icon: RefreshCw,
        color: 'bg-purple-100 text-purple-800 border-purple-200',
        pulse: true,
      }
    }

    // Terminal states
    switch (status) {
      case 'completed':
        return {
          label: 'Completed',
          icon: CheckCircle,
          color: 'bg-green-100 text-green-800 border-green-200',
          pulse: false,
        }
      case 'failed':
        return {
          label: failureReason === 'interrupted' ? 'Interrupted' : 'Failed',
          icon: AlertTriangle,
          color: 'bg-red-100 text-red-800 border-red-200',
          pulse: false,
        }
      case 'skipped':
        return {
          label: 'Skipped',
          icon: Clock,
          color: 'bg-orange-100 text-orange-800 border-orange-200',
          pulse: false,
        }
      case 'queued':
        return {
          label: 'Queued',
          icon: Clock,
          color: 'bg-gray-100 text-gray-800 border-gray-200',
          pulse: false,
        }
      default:
        return {
          label: status || 'Unknown',
          icon: Clock,
          color: 'bg-gray-100 text-gray-600 border-gray-200',
          pulse: false,
        }
    }
  }

  const config = getPhaseConfig()
  const Icon = config.icon

  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      <Badge
        variant="outline"
        className={`${config.color} flex items-center gap-1 text-xs font-medium ${
          config.pulse ? 'animate-pulse' : ''
        }`}
        title={failureReason ? `Reason: ${failureReason}` : undefined}
      >
        <Icon className="h-3 w-3" />
        {config.label}
      </Badge>
      {replay && (
        <Badge
          variant="outline"
          className="bg-amber-50 text-amber-700 border-amber-200 text-xs"
          title="This job was replayed from a missed schedule"
        >
          <RefreshCw className="h-3 w-3 mr-0.5" />
          Replay
        </Badge>
      )}
    </div>
  )
}
