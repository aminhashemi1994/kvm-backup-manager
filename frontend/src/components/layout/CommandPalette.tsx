import { useEffect, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import {
  LayoutDashboard, Server, HardDrive, Calendar, Activity,
  History, FileText, Cpu, Settings, Users, Shield, Search,
  Database, ArrowRightLeft, Trash2, Bell
} from 'lucide-react'

interface CommandItem {
  id: string
  label: string
  description?: string
  icon: React.ReactNode
  action: () => void
  keywords: string[]
}

/**
 * CommandPalette (Item 10)
 *
 * Cmd/Ctrl+K to open. Quick navigation + actions.
 * Uses a simple custom implementation (no cmdk dep needed for basic version).
 */
export default function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const navigate = useNavigate()

  const commands: CommandItem[] = [
    { id: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard className="h-4 w-4" />, action: () => navigate('/dashboard'), keywords: ['home', 'overview', 'stats'] },
    { id: 'backup-hosts', label: 'Backup Hosts', icon: <Server className="h-4 w-4" />, action: () => navigate('/backup-hosts'), keywords: ['agents', 'servers', 'infrastructure'] },
    { id: 'storage-pools', label: 'Storage Pools', icon: <HardDrive className="h-4 w-4" />, action: () => navigate('/storage-pools'), keywords: ['disk', 'space', 'storage'] },
    { id: 'schedules', label: 'Schedules', icon: <Calendar className="h-4 w-4" />, action: () => navigate('/schedules'), keywords: ['cron', 'automated', 'timer'] },
    { id: 'active-jobs', label: 'Active Jobs', icon: <Activity className="h-4 w-4" />, action: () => navigate('/backups/active'), keywords: ['running', 'progress', 'live'] },
    { id: 'history', label: 'Job History', icon: <History className="h-4 w-4" />, action: () => navigate('/backups/history'), keywords: ['past', 'completed', 'failed'] },
    { id: 'reports', label: 'Reports', icon: <FileText className="h-4 w-4" />, action: () => navigate('/reports'), keywords: ['analytics', 'download', 'pdf'] },
    { id: 'resources', label: 'Resources', icon: <Cpu className="h-4 w-4" />, action: () => navigate('/resources'), keywords: ['metrics', 'cpu', 'memory', 'disk'] },
    { id: 'backup-mgmt', label: 'Backup Management', icon: <Database className="h-4 w-4" />, action: () => navigate('/backup-management'), keywords: ['trigger', 'manual', 'restore'] },
    { id: 'cleanup', label: 'Cleanup', icon: <Trash2 className="h-4 w-4" />, action: () => navigate('/cleanup'), keywords: ['stale', 'locks', 'remove'] },
    { id: 'settings', label: 'Settings', icon: <Settings className="h-4 w-4" />, action: () => navigate('/settings'), keywords: ['config', 'preferences', 'notifications'] },
    { id: 'users', label: 'User Management', icon: <Users className="h-4 w-4" />, action: () => navigate('/settings/users'), keywords: ['rbac', 'roles', 'access'] },
    { id: 'audit', label: 'Audit Log', icon: <Shield className="h-4 w-4" />, action: () => navigate('/settings/audit'), keywords: ['trail', 'history', 'security'] },
  ]

  const filtered = query.trim()
    ? commands.filter(cmd => {
        const q = query.toLowerCase()
        return (
          cmd.label.toLowerCase().includes(q) ||
          cmd.keywords.some(k => k.includes(q))
        )
      })
    : commands

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault()
      setOpen(prev => !prev)
      setQuery('')
    }
    if (e.key === 'Escape' && open) {
      setOpen(false)
    }
  }, [open])

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  const runCommand = (cmd: CommandItem) => {
    cmd.action()
    setOpen(false)
    setQuery('')
  }

  if (!open) return null

  return createPortal(
    <div className="cmd-overlay" onClick={() => setOpen(false)}>
      <div className="cmd-dialog" onClick={e => e.stopPropagation()}>
        {/* Search input */}
        <div className="flex items-center border-b border-gray-200/50 dark:border-gray-700/50 px-4 py-3">
          <Search className="h-5 w-5 text-gray-400 mr-3 flex-shrink-0" />
          <input
            autoFocus
            type="text"
            placeholder="Search pages and actions..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && filtered.length > 0) {
                runCommand(filtered[0])
              }
            }}
            className="flex-1 bg-transparent border-none outline-none text-base text-gray-900 dark:text-gray-100 placeholder-gray-400"
          />
          <kbd className="hidden sm:inline-flex items-center px-2 py-0.5 text-xs font-mono text-gray-400 bg-gray-100 dark:bg-gray-800 rounded">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div className="max-h-[320px] overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-gray-500 text-sm">
              No results found for "{query}"
            </div>
          ) : (
            filtered.map(cmd => (
              <button
                key={cmd.id}
                onClick={() => runCommand(cmd)}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left hover:bg-gray-100/80 dark:hover:bg-gray-800/60 transition-colors group"
              >
                <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-gray-500 group-hover:text-primary group-hover:bg-primary/10 transition-colors">
                  {cmd.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {cmd.label}
                  </div>
                  {cmd.description && (
                    <div className="text-xs text-gray-500 truncate">{cmd.description}</div>
                  )}
                </div>
              </button>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-gray-200/50 dark:border-gray-700/50 px-4 py-2 flex items-center justify-between text-xs text-gray-400">
          <span>Navigate with ↑↓ • Enter to select</span>
          <span className="flex items-center gap-1">
            <kbd className="px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-[10px] font-mono">⌘K</kbd>
            to toggle
          </span>
        </div>
      </div>
    </div>,
    document.body
  )
}
