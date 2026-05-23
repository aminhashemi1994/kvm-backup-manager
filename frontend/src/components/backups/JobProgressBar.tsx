interface JobProgressBarProps {
  progress: number
  phase?: string
  progressText?: string
  jobType?: 'backup' | 'restore'
  status?: string
}

/**
 * JobProgressBar (Item 6)
 *
 * Phase-aware progress bar with:
 * - Color changes based on phase (blue=backup, purple=rsync, green=restore)
 * - Animated gradient for running jobs
 * - Progress text with monospace font
 * - Striped pattern for queued/initializing
 */
export default function JobProgressBar({
  progress = 0,
  phase,
  progressText,
  jobType = 'backup',
  status = 'running',
}: JobProgressBarProps) {
  const getBarColor = () => {
    if (status === 'completed') return 'bg-green-500'
    if (status === 'failed') return 'bg-red-500'
    if (status === 'skipped') return 'bg-orange-400'

    switch (phase) {
      case 'rsync':
        return 'bg-gradient-to-r from-purple-500 to-purple-600'
      case 'restore':
        return 'bg-gradient-to-r from-green-500 to-emerald-600'
      case 'backup':
        return 'bg-gradient-to-r from-blue-500 to-blue-600'
      case 'starting':
      case 'queued':
        return 'bg-gray-400'
      default:
        return jobType === 'restore'
          ? 'bg-gradient-to-r from-green-500 to-emerald-600'
          : 'bg-gradient-to-r from-blue-500 to-blue-600'
    }
  }

  const isIndeterminate = status === 'queued' || (status === 'running' && progress === 0 && phase === 'starting')

  return (
    <div className="w-full min-w-[220px]">
      <div className="flex items-center space-x-2 mb-1">
        <div className="flex-1 bg-gray-200 rounded-full h-3 overflow-hidden relative">
          {isIndeterminate ? (
            <div className="h-full w-full bg-gray-300 animate-pulse rounded-full">
              <div
                className="h-full bg-gradient-to-r from-transparent via-gray-400 to-transparent animate-[shimmer_1.5s_infinite]"
                style={{ width: '50%' }}
              />
            </div>
          ) : (
            <div
              className={`h-full rounded-full transition-all duration-500 ease-out ${getBarColor()} ${
                status === 'running' ? 'shadow-sm' : ''
              }`}
              style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
            >
              {status === 'running' && progress > 5 && (
                <div className="h-full w-full bg-gradient-to-r from-transparent via-white/20 to-transparent animate-[shimmer_2s_infinite] rounded-full" />
              )}
            </div>
          )}
        </div>
        <span className="text-sm font-semibold text-gray-700 min-w-[3.5rem] text-right tabular-nums">
          {isIndeterminate ? '...' : `${progress}%`}
        </span>
      </div>
      {progressText && (
        <div
          className="text-xs text-gray-500 font-mono truncate max-w-[300px]"
          title={progressText}
        >
          {progressText}
        </div>
      )}
    </div>
  )
}
