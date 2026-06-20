import { Button } from '@/components/ui/button'
import { Type } from 'lucide-react'
import { cn } from '@/lib/utils'

interface VmNameToggleProps {
  showFull: boolean
  onToggle: (showFull: boolean) => void
}

/**
 * Small toggle to switch VM name columns between the readable short name
 * and the full raw name (uuid + name). State is owned by the parent so it
 * can be persisted (e.g. in localStorage).
 */
export default function VmNameToggle({ showFull, onToggle }: VmNameToggleProps) {
  return (
    <div className="inline-flex items-center rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 p-0.5">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onToggle(false)}
        title="Show readable VM names"
        className={cn(
          'h-7 px-2.5 text-xs',
          !showFull
            ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm hover:bg-white hover:text-blue-600'
            : 'text-gray-600 hover:bg-white/50'
        )}
      >
        <Type className="h-3.5 w-3.5 mr-1" />
        Short
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onToggle(true)}
        title="Show full VM names (with id)"
        className={cn(
          'h-7 px-2.5 text-xs',
          showFull
            ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm hover:bg-white hover:text-blue-600'
            : 'text-gray-600 hover:bg-white/50'
        )}
      >
        Full
      </Button>
    </div>
  )
}
