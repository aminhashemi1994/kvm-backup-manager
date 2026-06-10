import { LayoutGrid, Table, BarChart3, List } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export type ViewMode = 'card' | 'table' | 'chart' | 'compact'

interface ViewModeSelectorProps {
  currentMode: ViewMode
  onChange: (mode: ViewMode) => void
}

const modes: { id: ViewMode; label: string; icon: React.ComponentType<{ className?: string }>; description: string }[] = [
  {
    id: 'card',
    label: 'Cards',
    icon: LayoutGrid,
    description: 'Detailed card view (default)',
  },
  {
    id: 'table',
    label: 'Table',
    icon: Table,
    description: 'Compact tabular view',
  },
  {
    id: 'chart',
    label: 'Charts',
    icon: BarChart3,
    description: 'Graphical analytics view',
  },
  {
    id: 'compact',
    label: 'Compact',
    icon: List,
    description: 'Dense list view',
  },
]

export default function ViewModeSelector({ currentMode, onChange }: ViewModeSelectorProps) {
  return (
    <div className="inline-flex items-center rounded-lg border border-gray-200 bg-gray-50 p-1">
      {modes.map((mode) => {
        const Icon = mode.icon
        const isActive = currentMode === mode.id
        return (
          <Button
            key={mode.id}
            variant="ghost"
            size="sm"
            onClick={() => onChange(mode.id)}
            title={mode.description}
            className={cn(
              'flex items-center space-x-1.5 px-3 py-1.5 h-auto text-xs font-medium transition-all',
              isActive
                ? 'bg-white text-blue-600 shadow-sm hover:bg-white hover:text-blue-600'
                : 'text-gray-600 hover:bg-white/50 hover:text-gray-900'
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            <span>{mode.label}</span>
          </Button>
        )
      })}
    </div>
  )
}
