import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

interface AgentHealthStatusProps {
  status: 'online' | 'offline'
  lastCheck?: string
}

export default function AgentHealthStatus({ status, lastCheck }: AgentHealthStatusProps) {
  return (
    <div className="flex items-center space-x-2">
      <div className={cn(
        'h-2 w-2 rounded-full',
        status === 'online' ? 'bg-green-500' : 'bg-red-500'
      )} />
      <Badge className={status === 'online' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}>
        {status}
      </Badge>
      {lastCheck && (
        <span className="text-xs text-gray-500">
          Last check: {new Date(lastCheck).toLocaleTimeString()}
        </span>
      )}
    </div>
  )
}
