import { useState } from 'react'
import { Settings, User, LogOut, Search, Command, PanelLeftClose, PanelLeft, Sun, Moon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useSocket } from '@/hooks/useSocket'
import { useAuth } from '@/contexts/AuthContext'
import { useSidebar } from '@/contexts/SidebarContext'
import { useTheme } from '@/contexts/ThemeContext'
import NotificationCenter from './NotificationCenter'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useNavigate } from 'react-router-dom'

export default function Header() {
  const { isConnected } = useSocket()
  const { user, logout } = useAuth()
  const { collapsed, toggle } = useSidebar()
  const { theme, toggleTheme } = useTheme()
  const navigate = useNavigate()

  return (
    <header className="h-14 border-b border-gray-200/50 dark:border-gray-700/30 glass-panel flex items-center justify-between px-3 sm:px-5 relative z-[100]">
      {/* Left: Sidebar toggle + Connection status + search hint */}
      <div className="flex items-center gap-2 sm:gap-4 min-w-0">
        {/* Sidebar toggle button */}
        <button
          onClick={toggle}
          className="p-2 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors flex-shrink-0"
          title={collapsed ? 'Show sidebar' : 'Hide sidebar'}
        >
          {collapsed ? (
            <PanelLeft className="h-5 w-5 text-gray-600 dark:text-gray-300" />
          ) : (
            <PanelLeftClose className="h-5 w-5 text-gray-600 dark:text-gray-300" />
          )}
        </button>

        <div className="hidden sm:flex items-center gap-2">
          <div className={`h-2 w-2 rounded-full ${isConnected ? 'bg-green-500 shadow-sm shadow-green-500/50' : 'bg-red-500 shadow-sm shadow-red-500/50'}`} />
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {isConnected ? 'Live' : 'Offline'}
          </span>
        </div>

        {/* Command palette trigger */}
        <button
          onClick={() => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, ctrlKey: true }))
          }}
          className="hidden lg:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-100/80 dark:bg-gray-800/60 border border-gray-200/50 dark:border-gray-700/30 hover:bg-gray-200/80 dark:hover:bg-gray-700/60 transition-colors"
        >
          <Search className="h-3.5 w-3.5 text-gray-400" />
          <span className="text-xs text-gray-500">Search...</span>
          <kbd className="ml-4 flex items-center gap-0.5 text-[10px] text-gray-400 font-mono">
            <Command className="h-3 w-3" />K
          </kbd>
        </button>
      </div>

      {/* Right: Actions */}
      <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          className="p-2 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-800 transition-all duration-200 hover:rotate-12"
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? (
            <Sun className="h-5 w-5 text-amber-500" />
          ) : (
            <Moon className="h-5 w-5 text-gray-600" />
          )}
        </button>

        {/* Notification Center */}
        <NotificationCenter />

        {/* Settings */}
        <button
          onClick={() => navigate('/settings')}
          className="hidden sm:block p-2 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          title="Settings"
        >
          <Settings className="h-5 w-5 text-gray-600 dark:text-gray-300" />
        </button>

        {/* User menu */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-2 px-2 sm:px-3 py-1.5 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
              <div className="w-7 h-7 rounded-lg gradient-accent flex items-center justify-center flex-shrink-0">
                <User className="h-4 w-4 text-white" />
              </div>
              <div className="hidden md:block text-left">
                <p className="text-xs font-medium text-gray-900 dark:text-gray-100">{user?.username}</p>
                <p className="text-[10px] text-gray-500 capitalize">{user?.role || 'admin'}</p>
              </div>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48 z-[9999]">
            <DropdownMenuLabel>
              <div className="flex flex-col">
                <p className="text-sm font-medium">{user?.username}</p>
                <p className="text-xs text-gray-500 capitalize">{user?.role || 'Administrator'}</p>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => navigate('/settings')}>
              <Settings className="mr-2 h-4 w-4" />
              Settings
            </DropdownMenuItem>
            <DropdownMenuItem onClick={logout} className="text-red-600">
              <LogOut className="mr-2 h-4 w-4" />
              Logout
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
