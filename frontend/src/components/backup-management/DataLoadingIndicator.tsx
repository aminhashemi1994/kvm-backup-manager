import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'

interface DataLoadingIndicatorProps {
  /** Headline, e.g. "Loading backup details". */
  title: string
  /**
   * Status lines that rotate while loading. Cycling them proves the app is
   * actively working rather than frozen. Defaults to a generic set.
   */
  messages?: string[]
  /**
   * Extra reassurance shown once loading crosses `slowAfterSeconds`, telling the
   * user a longer wait is still normal (these fetches scan backups on the host).
   */
  slowNote?: string
  slowAfterSeconds?: number
  className?: string
}

const DEFAULT_MESSAGES = [
  'Connecting to the backup host…',
  'Scanning backup directories…',
  'Analyzing backup chains…',
  'Calculating sizes and health…',
]

function formatElapsed(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}m ${s.toString().padStart(2, '0')}s`
}

/**
 * A loading state that visibly makes progress: a live elapsed-time counter, a
 * rotating status line, and an indeterminate progress bar. The moving numbers
 * and changing text tell the user the request is working and that the wait is
 * normal — replacing a static spinner that reads as "stuck".
 */
export default function DataLoadingIndicator({
  title,
  messages = DEFAULT_MESSAGES,
  slowNote = 'Large hosts with many backups can take a couple of minutes — this is normal.',
  slowAfterSeconds = 15,
  className = '',
}: DataLoadingIndicatorProps) {
  const [elapsed, setElapsed] = useState(0)
  const [msgIndex, setMsgIndex] = useState(0)

  // Live elapsed timer — a number that keeps moving is the clearest signal the
  // app is not frozen.
  useEffect(() => {
    const t = setInterval(() => setElapsed((e) => e + 1), 1000)
    return () => clearInterval(t)
  }, [])

  // Rotate the status line so the message visibly changes over time.
  useEffect(() => {
    if (messages.length <= 1) return
    const t = setInterval(() => {
      setMsgIndex((i) => (i + 1) % messages.length)
    }, 3500)
    return () => clearInterval(t)
  }, [messages.length])

  const showSlowNote = elapsed >= slowAfterSeconds

  return (
    <div
      className={`flex flex-col items-center justify-center py-12 px-4 text-center ${className}`}
      role="status"
      aria-live="polite"
    >
      <Loader2 className="h-10 w-10 animate-spin text-blue-500 mb-4" />

      <p className="text-gray-800 font-medium">{title}</p>

      {/* Rotating status line + live elapsed timer */}
      <p className="text-sm text-gray-500 mt-1 min-h-[1.25rem] transition-opacity">
        {messages[msgIndex]}
      </p>
      <p className="text-xs text-gray-400 mt-1 tabular-nums">
        {formatElapsed(elapsed)} elapsed
      </p>

      {/* Indeterminate progress bar — a moving band that never "completes",
          reinforcing that work is ongoing without faking a percentage. */}
      <div className="mt-4 w-full max-w-xs h-1.5 bg-gray-200 rounded-full overflow-hidden">
        <div className="h-full w-1/3 bg-blue-500 rounded-full animate-shimmer" />
      </div>

      {showSlowNote && (
        <p className="text-xs text-gray-500 mt-4 max-w-sm animate-slide-up">
          {slowNote}
        </p>
      )}
    </div>
  )
}
