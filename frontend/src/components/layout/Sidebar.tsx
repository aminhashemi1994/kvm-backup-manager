import { NavLink } from 'react-router-dom'
import { 
  LayoutDashboard, 
  Server,
  Calendar,
  Activity,
  History,
  Database,
  FileText,
  Gauge,
  FolderCog,
  HardDrive,
  Trash2,
  Settings,
  Users,
  Shield,
  Bell,
  ChevronDown
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useState } from 'react'
import { useSidebar } from '@/contexts/SidebarContext'

interface NavGroup {
  label: string
  items: NavItem[]
  defaultOpen?: boolean
}

interface NavItem {
  name: string
  to: string
  icon: any
}

const navGroups: NavGroup[] = [
  {
    label: 'Overview',
    defaultOpen: true,
    items: [
      { name: 'Dashboard', to: '/dashboard', icon: LayoutDashboard },
    ],
  },
  {
    label: 'Infrastructure',
    defaultOpen: true,
    items: [
      { name: 'Backup Hosts', to: '/backup-hosts', icon: Server },
      { name: 'Storage Pools', to: '/storage-pools', icon: HardDrive },
      { name: 'Resources', to: '/resources', icon: Gauge },
    ],
  },
  {
    label: 'Jobs',
    defaultOpen: true,
    items: [
      { name: 'Active Jobs', to: '/backups/active', icon: Activity },
      { name: 'Schedules', to: '/schedules', icon: Calendar },
      { name: 'History', to: '/backups/history', icon: History },
    ],
  },
  {
    label: 'Operations',
    defaultOpen: true,
    items: [
      { name: 'Backup Management', to: '/backup-management', icon: FolderCog },
      { name: 'Reports', to: '/reports', icon: FileText },
      { name: 'Cleanup', to: '/cleanup', icon: Trash2 },
    ],
  },
  {
    label: 'Settings',
    defaultOpen: false,
    items: [
      { name: 'General', to: '/settings', icon: Settings },
      { name: 'Users & Access', to: '/settings/users', icon: Users },
      { name: 'Audit Log', to: '/settings/audit', icon: Shield },
      { name: 'Notifications', to: '/settings/notifications', icon: Bell },
    ],
  },
]

export default function Sidebar() {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const { collapsed: sidebarCollapsed, toggle: toggleSidebar } = useSidebar()

  const toggleGroup = (label: string) => {
    setCollapsed(prev => ({ ...prev, [label]: !prev[label] }))
  }

  const isGroupOpen = (group: NavGroup) => {
    if (collapsed[group.label] !== undefined) return !collapsed[group.label]
    return group.defaultOpen !== false
  }

  // When the sidebar is collapsed, we render nothing. The toggle button in the
  // header is the only way to bring it back. The CSS variable --sidebar-width
  // is updated to 0rem so dialogs/overlays automatically center on the full panel.
  if (sidebarCollapsed) return null

  return (
    <>
      {/* Mobile backdrop — clicking outside closes the sidebar */}
      <div
        className="lg:hidden fixed inset-0 z-30 bg-black/40 backdrop-blur-sm"
        onClick={toggleSidebar}
        aria-hidden="true"
      />
      <aside className="w-64 glass-panel flex flex-col border-r border-white/10 dark:border-gray-800/50 fixed lg:relative inset-y-0 left-0 z-40 lg:z-auto">
      {/* Logo */}
      <div className="h-16 flex items-center px-5 border-b border-gray-200/30 dark:border-gray-700/30">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl gradient-accent flex items-center justify-center shadow-lg shadow-blue-500/20">
            <Database className="h-5 w-5 text-white" />
          </div>
          <div>
            <span className="text-sm font-bold text-gray-900 dark:text-white">KVM Backup</span>
            <span className="block text-[10px] text-gray-500 dark:text-gray-400 -mt-0.5">Manager</span>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {navGroups.map((group) => (
          <div key={group.label} className="mb-2">
            {/* Group header */}
            <button
              onClick={() => toggleGroup(group.label)}
              className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
            >
              {group.label}
              <ChevronDown
                className={cn(
                  'h-3 w-3 transition-transform duration-200',
                  !isGroupOpen(group) && '-rotate-90'
                )}
              />
            </button>

            {/* Group items */}
            {isGroupOpen(group) && (
              <div className="mt-1 space-y-0.5">
                {group.items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={({ isActive }) =>
                      cn(
                        'nav-item flex items-center gap-3 hover-shine',
                        isActive && 'active'
                      )
                    }
                  >
                    <item.icon className="h-4 w-4 flex-shrink-0" />
                    <span>{item.name}</span>
                  </NavLink>
                ))}
              </div>
            )}
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="p-3 border-t border-gray-200/30 dark:border-gray-700/30">
        <div className="rounded-xl bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-800 dark:to-gray-900 p-3">
          <p className="text-[10px] font-medium text-gray-500 dark:text-gray-400">KVM Backup Manager</p>
          <p className="text-[10px] text-gray-400 dark:text-gray-500">v1.0.0 • Open Source</p>
          <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-1.5 pt-1.5 border-t border-gray-200/40 dark:border-gray-700/40">
            Built by{' '}
            <a
              href="https://www.linkedin.com/in/amin-hashemi-2955061bb"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-500 hover:text-blue-600 hover:underline transition-colors"
            >
              Mohammad Amin Hashemi
            </a>
          </p>
        </div>
      </div>
    </aside>
    </>
  )
}
