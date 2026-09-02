import { useState, useEffect } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { Settings, Users, Shield, Bell, MessageSquare, Sun, Moon, Save, Send, Loader2, ChevronDown, ChevronRight, Plus, Trash2, Server, ArrowRightLeft } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTheme } from '@/contexts/ThemeContext'
import { notificationsApi, settingsApi } from '@/services/api'
import { toast } from 'sonner'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { useBackupHosts } from '@/hooks/useBackupHosts'
import { useVersion } from '@/hooks/useVersion'
import { NOTIFICATION_TYPES, NOTIFICATION_TYPE_GROUPS } from '@/types'
import { getErrorMessage } from '@/lib/errors'

/**
 * Turn the comma-separated text of a mentions field into clean usernames.
 * A leading @ is accepted and stripped — people type it out of habit and the
 * formatter adds exactly one when it builds the message.
 */
function splitMentions(text: string): string[] {
  return text
    .split(',')
    .map(v => v.trim().replace(/^@+/, ''))
    .filter(Boolean)
}

const settingsTabs = [
  { name: 'General', to: '/settings', icon: Settings, end: true },
  { name: 'Users & Access', to: '/settings/users', icon: Users },
  { name: 'Audit Log', to: '/settings/audit', icon: Shield },
  { name: 'Notifications', to: '/settings/notifications', icon: Bell },
]

export default function SettingsPage() {
  const location = useLocation()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Settings</h1>
        <p className="text-gray-600 dark:text-gray-400 mt-2">
          Manage system configuration, users, and notifications
        </p>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 p-1 bg-gray-100/80 dark:bg-gray-800/60 rounded-xl w-fit">
        {settingsTabs.map(tab => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) => cn(
              'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all',
              isActive
                ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
                : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
            )}
          >
            <tab.icon className="h-4 w-4" />
            {tab.name}
          </NavLink>
        ))}
      </div>

      {/* Content */}
      <div className="glass-card rounded-2xl p-6">
        <SettingsContent />
      </div>
    </div>
  )
}

function SettingsContent() {
  const location = useLocation()
  
  if (location.pathname === '/settings') {
    return <GeneralSettings />
  }
  if (location.pathname === '/settings/users') {
    return <UsersSettings />
  }
  if (location.pathname === '/settings/audit') {
    return <AuditSettings />
  }
  if (location.pathname === '/settings/notifications') {
    return <NotificationSettings />
  }
  return <GeneralSettings />
}

function GeneralSettings() {
  const { theme, toggleTheme } = useTheme()
  // Reported by the controller so this can never drift from the sidebar again.
  const { data: version } = useVersion()
  type Settings = {
    defaultMaxConcurrentBackups: number
    healthCheckIntervalSeconds: number
    defaultMissedRunPolicy: 'immediate' | 'most-recent' | 'skip'
    jobLogRetentionDays: number
    replicationCheckIntervalHours: number
    replicationCheckAutoSync: boolean
  }
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [settings, setSettings] = useState<Settings>({
    defaultMaxConcurrentBackups: 20,
    healthCheckIntervalSeconds: 60,
    defaultMissedRunPolicy: 'immediate',
    jobLogRetentionDays: 90,
    replicationCheckIntervalHours: 24,
    replicationCheckAutoSync: true,
  })
  const [applyConcurrencyToAllHosts, setApplyConcurrencyToAllHosts] = useState(false)

  useEffect(() => {
    let mounted = true
    settingsApi.get()
      .then(res => {
        if (!mounted) return
        const data = res.data?.data
        if (data) {
          setSettings({
            defaultMaxConcurrentBackups: data.defaultMaxConcurrentBackups != null
              ? Number(data.defaultMaxConcurrentBackups)
              : 20,
            healthCheckIntervalSeconds: Number(data.healthCheckIntervalSeconds) || 60,
            defaultMissedRunPolicy: data.defaultMissedRunPolicy || 'immediate',
            jobLogRetentionDays: data.jobLogRetentionDays != null
              ? Number(data.jobLogRetentionDays)
              : 90,
            replicationCheckIntervalHours: data.replicationCheckIntervalHours != null
              ? Number(data.replicationCheckIntervalHours)
              : 24,
            replicationCheckAutoSync: data.replicationCheckAutoSync !== false,
          })
        }
      })
      .catch(err => toast.error(`Failed to load settings: ${err.message}`))
      .finally(() => mounted && setLoading(false))
    return () => { mounted = false }
  }, [])

  const updateField = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setSettings(prev => ({ ...prev, [key]: value }))

  const handleSave = async () => {
    setSaving(true)
    try {
      const res = await settingsApi.save({
        ...settings,
        applyConcurrencyToAllHosts,
      })
      const propagated = res.data?.propagated
      if (propagated && propagated.hostsUpdated > 0) {
        toast.success(
          `Settings saved · ${propagated.hostsUpdated} host(s) updated · ${propagated.agentsRefreshed}/${propagated.agentsTotal} agents refreshed`
        )
      } else {
        toast.success('Settings saved')
      }
      // Reset the propagate checkbox after a successful apply
      if (applyConcurrencyToAllHosts) setApplyConcurrencyToAllHosts(false)
    } catch (err: any) {
      toast.error(getErrorMessage(err, 'Save failed'))
    } finally {
      setSaving(false)
    }
  }

  const inputCls = 'w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500'

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500 p-4">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading settings...
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold">General Settings</h2>
      <p className="text-sm text-gray-500">
        System-wide configuration options. Changes here affect all users.
      </p>

      {/* Appearance */}
      <div className="space-y-3 p-4 border border-gray-200 dark:border-gray-700 rounded-xl">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          {theme === 'dark' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
          Appearance
        </h3>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Dark Mode</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Toggle between light and dark themes for the entire panel
            </p>
          </div>
          <button
            onClick={toggleTheme}
            role="switch"
            aria-checked={theme === 'dark'}
            className={cn(
              'relative inline-flex h-7 w-12 items-center rounded-full transition-colors duration-200',
              theme === 'dark' ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'
            )}
          >
            <span
              className={cn(
                'inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition-transform duration-200 flex items-center justify-center',
                theme === 'dark' ? 'translate-x-6' : 'translate-x-1'
              )}
            >
              {theme === 'dark' ? (
                <Moon className="h-3 w-3 text-primary" />
              ) : (
                <Sun className="h-3 w-3 text-amber-500" />
              )}
            </span>
          </button>
        </div>
      </div>

      {/* System config — all fields persist when you click Save Settings */}
      <div className="space-y-4 p-4 border border-gray-200 dark:border-gray-700 rounded-xl max-w-lg">
        <h3 className="text-sm font-semibold">System defaults</h3>

        <div className="space-y-2">
          <label className="text-sm font-medium">Max Concurrent Backups (per host)</label>
          <input
            type="number"
            value={settings.defaultMaxConcurrentBackups}
            onChange={(e) => {
              const n = Number(e.target.value)
              updateField('defaultMaxConcurrentBackups', Number.isFinite(n) && n >= 0 ? n : 0)
            }}
            min={0}
            max={200}
            className={inputCls}
          />
          <p className="text-xs text-gray-500">
            Default value applied to newly-created backup hosts. Existing hosts keep their current
            value unless you tick "Apply to all existing backup hosts" below.{' '}
            <strong>Set to 0 for unlimited</strong> — every scheduled backup starts at its scheduled
            time with no concurrency cap (may heavily load the backup host).
          </p>
          <label className="flex items-center gap-2 text-xs cursor-pointer pt-1">
            <input
              type="checkbox"
              checked={applyConcurrencyToAllHosts}
              onChange={(e) => setApplyConcurrencyToAllHosts(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            <span>Apply to all existing backup hosts (and push refresh to their agents)</span>
          </label>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Health Check Interval (seconds)</label>
          <input
            type="number"
            value={settings.healthCheckIntervalSeconds}
            onChange={(e) => updateField('healthCheckIntervalSeconds', Number(e.target.value) || 60)}
            min={15}
            max={3600}
            className={inputCls}
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Default Missed-Run Policy</label>
          <select
            value={settings.defaultMissedRunPolicy}
            onChange={(e) => updateField('defaultMissedRunPolicy', e.target.value as Settings['defaultMissedRunPolicy'])}
            className={inputCls}
          >
            <option value="immediate">Run immediately when back online</option>
            <option value="most-recent">Run only most recent missed</option>
            <option value="skip">Skip (log only)</option>
          </select>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Backup Job Log Retention (days)</label>
          <input
            type="number"
            value={settings.jobLogRetentionDays}
            onChange={(e) => {
              const n = Number(e.target.value)
              updateField('jobLogRetentionDays', Number.isFinite(n) && n >= 0 ? n : 0)
            }}
            min={0}
            max={3650}
            className={inputCls}
          />
          <p className="text-xs text-gray-500">
            Agents automatically delete a backup job's log file once it's older than this many days.
            Logs are never deleted while a job is still running. <strong>Set to 0 to disable</strong> —
            logs are then kept indefinitely until manually removed from the Cleanup page.
          </p>
        </div>

      </div>

      {/* Offsite replication — the periodic audit comparing each VM's backup
          directory against its offsite copies. Saved by the same button as the
          block above. */}
      <div className="space-y-4 p-4 border border-gray-200 dark:border-gray-700 rounded-xl max-w-lg">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <ArrowRightLeft className="h-4 w-4" />
          Offsite replication check
        </h3>
        <p className="text-xs text-gray-500">
          Replication runs on its own — a backup finishing only asks for a sync, it never waits for
          one. This check is the safety net: it walks every VM that has an offsite destination and
          compares both ends, so replication that has quietly fallen behind gets noticed.
        </p>

        <div className="space-y-2">
          <label className="text-sm font-medium">Check Interval (hours)</label>
          <input
            type="number"
            value={settings.replicationCheckIntervalHours}
            onChange={(e) => {
              const n = Number(e.target.value)
              updateField('replicationCheckIntervalHours', Number.isFinite(n) && n >= 0 ? n : 0)
            }}
            min={0}
            max={168}
            className={inputCls}
          />
          <p className="text-xs text-gray-500">
            How often every VM's backup directory is compared against its offsite copies. The check
            stats the whole tree at both ends, so it is a periodic audit rather than something to
            watch — replication falling behind is a state measured in days, not minutes.{' '}
            <strong>Set to 0 to disable</strong> the periodic check; it can still be run on demand
            from the Offsite Replication page. Maximum 168 (one week).
          </p>
        </div>

        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <p className="text-sm font-medium">Sync automatically when a VM is found behind</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Queues a replication job for each VM the check finds out of sync. A VM that already has
              a sync queued or running is left alone. Turn this off to have the check report only and
              start the syncs yourself.
            </p>
            <p className="text-xs text-gray-500 mt-1">
              A VM whose backup pool is not mounted is never auto-synced either way — syncing from an
              empty mount point would delete its offsite copies.
            </p>
          </div>
          <button
            type="button"
            onClick={() => updateField('replicationCheckAutoSync', !settings.replicationCheckAutoSync)}
            role="switch"
            aria-checked={settings.replicationCheckAutoSync}
            aria-label="Sync automatically when a VM is found behind"
            className={cn(
              'relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors duration-200 mt-0.5',
              settings.replicationCheckAutoSync ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'
            )}
          >
            <span
              className={cn(
                'inline-block h-5 w-5 transform rounded-full bg-white shadow-md transition-transform duration-200',
                settings.replicationCheckAutoSync ? 'translate-x-6' : 'translate-x-1'
              )}
            />
          </button>
        </div>

        <div className="pt-1">
          <NavLink
            to="/offsite"
            className="text-xs text-primary hover:underline inline-flex items-center gap-1"
          >
            <ArrowRightLeft className="h-3 w-3" />
            Open Offsite Replication to run a check now or review the results
          </NavLink>
        </div>
      </div>

      <div className="max-w-lg">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
        <p className="text-xs text-gray-500 mt-2">
          Saves every field above, including the replication settings.
        </p>
      </div>

      {/* About section */}
      <div className="space-y-3 p-4 border border-gray-200 dark:border-gray-700 rounded-xl">
        <h3 className="text-sm font-semibold">About</h3>
        <div className="grid gap-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-gray-500">Version</span>
            <span className="font-mono">{version ? version.version : '…'}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-gray-500">License</span>
            <span>{version ? `${version.license} (Open Source)` : 'Open Source'}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-gray-500">Built by</span>
            <a
              href="https://www.linkedin.com/in/amin-hashemi-2955061bb"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              Mohammad Amin Hashemi
            </a>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-gray-500">Contact</span>
            <a
              href="mailto:aminhashemiwin10@gmail.com"
              className="text-primary hover:underline"
            >
              aminhashemiwin10@gmail.com
            </a>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-gray-500">Powered by</span>
            <a
              href="https://github.com/abbbi/virtnbdbackup"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              virtnbdbackup (@abbbi)
            </a>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-gray-500">GitHub</span>
            <a
              href="https://github.com/aminhashemi1994/kvm-backup-manager"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              aminhashemi1994/kvm-backup-manager
            </a>
          </div>
        </div>
      </div>
    </div>
  )
}

function UsersSettings() {
  const [users, setUsers] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [editingUser, setEditingUser] = useState<any>(null)
  const [formData, setFormData] = useState({ username: '', password: '', role: 'user', email: '', fullName: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const confirm = useConfirm()

  const apiBase = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000/api'
  const headers = { Authorization: `Bearer ${localStorage.getItem('authToken')}`, 'Content-Type': 'application/json' }

  const fetchUsers = async () => {
    setLoading(true)
    try {
      const res = await fetch(`${apiBase}/users`, { headers })
      const data = await res.json()
      if (data.success) setUsers(data.data || [])
    } catch (e) {
      console.error('Failed to fetch users:', e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchUsers() }, [])

  const handleCreate = async () => {
    if (!formData.username || !formData.password) {
      setError('Username and password are required')
      return
    }
    if (formData.password.length < 6) {
      setError('Password must be at least 6 characters')
      return
    }
    setSaving(true)
    setError('')
    try {
      const res = await fetch(`${apiBase}/users`, {
        method: 'POST',
        headers,
        body: JSON.stringify(formData)
      })
      const data = await res.json()
      if (data.success) {
        setShowCreateForm(false)
        setFormData({ username: '', password: '', role: 'user', email: '', fullName: '' })
        fetchUsers()
      } else {
        setError(data.error || 'Failed to create user')
      }
    } catch (e: any) {
      setError(e.message || 'Network error')
    } finally {
      setSaving(false)
    }
  }

  const handleUpdate = async () => {
    if (!editingUser) return
    setSaving(true)
    setError('')
    try {
      const updateData: any = { role: formData.role, email: formData.email, fullName: formData.fullName }
      if (formData.password) updateData.password = formData.password
      const res = await fetch(`${apiBase}/users/${editingUser.id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(updateData)
      })
      const data = await res.json()
      if (data.success) {
        setEditingUser(null)
        setFormData({ username: '', password: '', role: 'user', email: '', fullName: '' })
        fetchUsers()
      } else {
        setError(data.error || 'Failed to update user')
      }
    } catch (e: any) {
      setError(e.message || 'Network error')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (userId: string, username: string) => {
    const ok = await confirm({
      title: 'Delete user?',
      description: `Are you sure you want to delete the user "${username}"? This cannot be undone.`,
      confirmText: 'Delete',
      cancelText: 'Cancel',
      variant: 'danger',
    })
    if (!ok) return
    try {
      const res = await fetch(`${apiBase}/users/${userId}`, { method: 'DELETE', headers })
      const data = await res.json()
      if (data.success) {
        fetchUsers()
      } else {
        alert(data.error || 'Failed to delete user')
      }
    } catch (e: any) {
      alert(e.message || 'Network error')
    }
  }

  const handleToggleDisable = async (userId: string, currentDisabled: boolean) => {
    try {
      const res = await fetch(`${apiBase}/users/${userId}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ disabled: !currentDisabled })
      })
      const data = await res.json()
      if (data.success) fetchUsers()
    } catch (e) {
      console.error('Failed to toggle user:', e)
    }
  }

  const startEdit = (user: any) => {
    setEditingUser(user)
    setFormData({ username: user.username, password: '', role: user.role, email: user.email || '', fullName: user.fullName || '' })
    setError('')
  }

  const cancelForm = () => {
    setShowCreateForm(false)
    setEditingUser(null)
    setFormData({ username: '', password: '', role: 'user', email: '', fullName: '' })
    setError('')
  }

  const getRoleBadge = (role: string) => {
    switch (role) {
      case 'admin': return 'bg-blue-100 text-blue-700'
      case 'user': return 'bg-green-100 text-green-700'
      case 'viewer': return 'bg-gray-100 text-gray-700'
      default: return 'bg-gray-100 text-gray-600'
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Users & Access Control</h2>
          <p className="text-sm text-gray-500">Manage users, roles, and backup host access grants.</p>
        </div>
        {!showCreateForm && !editingUser && (
          <button
            onClick={() => { setShowCreateForm(true); setError('') }}
            className="px-4 py-2 bg-primary text-white rounded-xl text-sm font-medium hover:bg-primary/90 transition-colors shadow-sm"
          >
            + Add User
          </button>
        )}
      </div>

      {/* Create / Edit Form */}
      {(showCreateForm || editingUser) && (
        <div className="border border-gray-200 dark:border-gray-700 rounded-xl p-5 bg-gray-50/50 dark:bg-gray-800/30 space-y-4">
          <h3 className="font-medium text-sm">{editingUser ? `Edit User: ${editingUser.username}` : 'Create New User'}</h3>
          
          {error && (
            <div className="px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {!editingUser && (
              <div className="space-y-1">
                <label className="text-xs font-medium text-gray-600">Username *</label>
                <input
                  type="text"
                  value={formData.username}
                  onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                  placeholder="johndoe"
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm"
                />
              </div>
            )}
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-600">
                {editingUser ? 'New Password (leave empty to keep current)' : 'Password *'}
              </label>
              <input
                type="password"
                value={formData.password}
                onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                placeholder={editingUser ? '••••••••' : 'Min 6 characters'}
                className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-600">Role *</label>
              <select
                value={formData.role}
                onChange={(e) => setFormData({ ...formData, role: e.target.value })}
                className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm"
              >
                <option value="admin">Admin — Full access</option>
                <option value="user">User — Read all, write on granted hosts</option>
                <option value="viewer">Viewer — Read-only</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-600">Full Name</label>
              <input
                type="text"
                value={formData.fullName}
                onChange={(e) => setFormData({ ...formData, fullName: e.target.value })}
                placeholder="John Doe"
                className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-600">Email</label>
              <input
                type="email"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                placeholder="john@example.com"
                className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm"
              />
            </div>
          </div>

          <div className="flex items-center gap-2 pt-2">
            <button
              onClick={editingUser ? handleUpdate : handleCreate}
              disabled={saving}
              className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {saving ? 'Saving...' : editingUser ? 'Update User' : 'Create User'}
            </button>
            <button
              onClick={cancelForm}
              className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-200 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Users Table */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full" />
        </div>
      ) : (
        <div className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-xs uppercase text-gray-500">Username</th>
                <th className="text-left px-4 py-3 font-medium text-xs uppercase text-gray-500">Full Name</th>
                <th className="text-left px-4 py-3 font-medium text-xs uppercase text-gray-500">Role</th>
                <th className="text-left px-4 py-3 font-medium text-xs uppercase text-gray-500">Status</th>
                <th className="text-left px-4 py-3 font-medium text-xs uppercase text-gray-500">Created</th>
                <th className="text-left px-4 py-3 font-medium text-xs uppercase text-gray-500">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {users.map((user) => (
                <tr key={user.id} className="hover:bg-gray-50/50 dark:hover:bg-gray-800/30">
                  <td className="px-4 py-3 font-medium">{user.username}</td>
                  <td className="px-4 py-3 text-gray-600">{user.fullName || '—'}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${getRoleBadge(user.role)}`}>
                      {user.role}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {user.disabled ? (
                      <span className="px-2 py-0.5 bg-red-100 text-red-700 rounded text-xs">Disabled</span>
                    ) : (
                      <span className="px-2 py-0.5 bg-green-100 text-green-700 rounded text-xs">Active</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">
                    {user.createdAt ? new Date(user.createdAt).toLocaleDateString() : '—'}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => startEdit(user)}
                        className="px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 rounded transition-colors"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleToggleDisable(user.id, user.disabled)}
                        className="px-2 py-1 text-xs text-amber-600 hover:bg-amber-50 rounded transition-colors"
                      >
                        {user.disabled ? 'Enable' : 'Disable'}
                      </button>
                      <button
                        onClick={() => handleDelete(user.id, user.username)}
                        className="px-2 py-1 text-xs text-red-600 hover:bg-red-50 rounded transition-colors"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-gray-400">
        Roles: <strong>Admin</strong> (full access) • <strong>User</strong> (read all, write on granted hosts) • <strong>Viewer</strong> (read-only)
      </p>
    </div>
  )
}

function AuditSettings() {
  const [logs, setLogs] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [filterAction, setFilterAction] = useState('')

  const fetchLogs = async (pageNum: number, action?: string) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: String(pageNum), limit: '30' })
      if (action) params.set('action', action)
      const res = await fetch(`${import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000/api'}/audit?${params}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('authToken')}` }
      })
      const data = await res.json()
      if (data.success) {
        setLogs(data.data || [])
        setHasMore(data.pagination?.hasMore || false)
      }
    } catch (e) {
      console.error('Failed to fetch audit logs:', e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchLogs(page, filterAction)
  }, [page, filterAction])

  const formatTime = (ts: string) => {
    try {
      return new Date(ts).toLocaleString()
    } catch {
      return ts
    }
  }

  const getActionColor = (action: string) => {
    if (action.includes('create') || action.includes('grant')) return 'bg-green-100 text-green-700'
    if (action.includes('delete') || action.includes('revoke')) return 'bg-red-100 text-red-700'
    if (action.includes('update')) return 'bg-blue-100 text-blue-700'
    if (action.includes('login')) return 'bg-purple-100 text-purple-700'
    return 'bg-gray-100 text-gray-700'
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Audit Log</h2>
          <p className="text-sm text-gray-500">All system actions with actor, timestamp, and details. Retained for 90 days.</p>
        </div>
        <button
          onClick={() => fetchLogs(page, filterAction)}
          className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <select
          value={filterAction}
          onChange={(e) => { setFilterAction(e.target.value); setPage(1) }}
          className="border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-1.5 text-sm bg-white dark:bg-gray-800"
        >
          <option value="">All Actions</option>
          <option value="auth">Authentication</option>
          <option value="user">User Management</option>
          <option value="backup">Backup</option>
          <option value="restore">Restore</option>
          <option value="schedule">Schedules</option>
        </select>
        <span className="text-xs text-gray-400">Page {page}</span>
      </div>

      {/* Log entries */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full" />
        </div>
      ) : logs.length === 0 ? (
        <div className="border border-gray-200 dark:border-gray-700 rounded-xl p-8 text-center">
          <Shield className="h-10 w-10 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500">No audit entries found</p>
          <p className="text-xs text-gray-400 mt-1">Actions will be recorded as users interact with the system</p>
        </div>
      ) : (
        <div className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium text-xs uppercase text-gray-500">Time</th>
                <th className="text-left px-4 py-2.5 font-medium text-xs uppercase text-gray-500">Action</th>
                <th className="text-left px-4 py-2.5 font-medium text-xs uppercase text-gray-500">Actor</th>
                <th className="text-left px-4 py-2.5 font-medium text-xs uppercase text-gray-500">Target</th>
                <th className="text-left px-4 py-2.5 font-medium text-xs uppercase text-gray-500">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
              {logs.map((log) => (
                <tr key={log.id} className="hover:bg-gray-50/50 dark:hover:bg-gray-800/30">
                  <td className="px-4 py-2.5 text-xs text-gray-500 whitespace-nowrap">{formatTime(log.timestamp)}</td>
                  <td className="px-4 py-2.5">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${getActionColor(log.action)}`}>
                      {log.action}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-sm font-medium">{log.actor || '—'}</td>
                  <td className="px-4 py-2.5 text-sm text-gray-600">{log.targetName || log.targetType || '—'}</td>
                  <td className="px-4 py-2.5 text-xs text-gray-400 max-w-[200px] truncate">
                    {log.details ? JSON.stringify(log.details) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <button
          onClick={() => setPage(p => Math.max(1, p - 1))}
          disabled={page === 1}
          className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          Previous
        </button>
        <button
          onClick={() => setPage(p => p + 1)}
          disabled={!hasMore}
          className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          Next
        </button>
      </div>
    </div>
  )
}

function NotificationSettings() {
  type RcSettings = {
    enabled: boolean
    // 'webhook' = Incoming Webhook, fire-only — no support for editing a
    // message once sent. 'api' = REST API (chat.postMessage/chat.update)
    // against a personal access token — required for anything that edits a
    // message in place, e.g. the daily incident board.
    mode: 'webhook' | 'api'
    webhookUrl: string
    url: string
    authToken: string
    // True when a token is already saved server-side. GET redacts the real
    // value, so the form can show "leave blank to keep the current token"
    // instead of treating blank as "no token".
    authTokenSet: boolean
    userId: string
    channel: string
    entity: string
    version: string
  }

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [rc, setRc] = useState<RcSettings>({
    enabled: false,
    mode: 'webhook',
    webhookUrl: '',
    url: '',
    authToken: '',
    authTokenSet: false,
    userId: '',
    channel: '',
    entity: 'Backup Manager',
    version: '',
  })
  // Master on/off per notification, and who gets @-mentioned on each.
  // Mentions are held as the raw comma-separated text the user typed and only
  // split on save, so typing a comma doesn't fight the input.
  const [types, setTypes] = useState<Record<string, boolean>>({})
  // People are assigned per section, not per notification: every notification in
  // a section shares one list. The API still stores mentions per type, so the
  // section value is fanned out on save and read back from the section's types.
  const [mentionsByGroup, setMentionsByGroup] = useState<Record<string, string>>({})
  const [defaultMentions, setDefaultMentions] = useState('')
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})
  // Who to @-mention on the daily incident board (backup failed/offsite sync
  // failed/backup skipped — those always send now, no on/off switch), keyed
  // by backup host rather than by type or schedule. A host not in this list
  // still gets its entries on the board, just without a mention.
  const [hostMentions, setHostMentions] = useState<Array<{ backupHostId: string; mentions: string }>>([])
  const { data: backupHosts } = useBackupHosts()

  useEffect(() => {
    let mounted = true
    notificationsApi.getSettings()
      .then(res => {
        if (!mounted) return
        const data = res.data?.data?.rocketChat
        if (data) {
          setRc(prev => ({
            ...prev,
            enabled: !!data.enabled,
            mode: data.mode === 'api' ? 'api' : 'webhook',
            webhookUrl: data.webhookUrl || '',
            url: data.url || '',
            authToken: '', // never sent back by the API — redacted on GET
            authTokenSet: !!data.authTokenSet,
            userId: data.userId || '',
            channel: data.channel || '',
            entity: data.entity || prev.entity,
            version: data.version || prev.version,
          }))
        }
        const incomingTypes = res.data?.data?.types
        if (incomingTypes) setTypes(incomingTypes)
        const m = res.data?.data?.mentions
        if (m) {
          setDefaultMentions((m.default || []).join(', '))
          const byType: Record<string, string> = {}
          Object.entries(m.byType || {}).forEach(([k, v]) => {
            byType[k] = (Array.isArray(v) ? v : []).join(', ')
          })
          // Collapse the stored per-type lists into one value per section:
          // the first type in the section that actually has people wins.
          const byGroup: Record<string, string> = {}
          NOTIFICATION_TYPE_GROUPS.forEach(group => {
            const hit = NOTIFICATION_TYPES
              .filter(t => t.group === group)
              .map(t => byType[t.key])
              .find(v => v && v.trim())
            byGroup[group] = hit || ''
          })
          setMentionsByGroup(byGroup)
        }
        const hm = res.data?.data?.hostMentions
        if (Array.isArray(hm)) {
          setHostMentions(hm.map((h: any) => ({
            backupHostId: h?.backupHostId || '',
            mentions: (Array.isArray(h?.mentions) ? h.mentions : []).join(', '),
          })))
        }
      })
      .catch(err => toast.error(`Failed to load settings: ${err.message}`))
      .finally(() => mounted && setLoading(false))
    return () => { mounted = false }
  }, [])

  const updateField = <K extends keyof RcSettings>(key: K, value: RcSettings[K]) =>
    setRc(prev => ({ ...prev, [key]: value }))

  const buildPayload = (override?: Partial<RcSettings>) => ({
    rocketChat: {
      mode: rc.mode,
      enabled: rc.enabled,
      webhookUrl: rc.webhookUrl,
      url: rc.url,
      // Blank means "unchanged" — the backend keeps the stored token unless
      // this carries a real value, so an untouched field never wipes it.
      authToken: rc.authToken,
      userId: rc.userId,
      channel: rc.channel,
      entity: rc.entity,
      version: rc.version,
      ...override,
    },
    types,
    mentions: {
      default: splitMentions(defaultMentions),
      byType: Object.fromEntries(
        NOTIFICATION_TYPES.map(t => [t.key, splitMentions(mentionsByGroup[t.group] || '')])
      ),
    },
    hostMentions: hostMentions
      .filter(h => h.backupHostId)
      .map(h => ({ backupHostId: h.backupHostId, mentions: splitMentions(h.mentions) })),
  })

  const handleSave = async () => {
    setSaving(true)
    try {
      const res = await notificationsApi.saveSettings(buildPayload())
      const fresh = res.data?.data?.rocketChat
      if (res.data?.data?.types) setTypes(res.data.data.types)
      if (Array.isArray(res.data?.data?.hostMentions)) {
        setHostMentions(res.data.data.hostMentions.map((h: any) => ({
          backupHostId: h?.backupHostId || '',
          mentions: (Array.isArray(h?.mentions) ? h.mentions : []).join(', '),
        })))
      }
      if (fresh) {
        setRc(prev => ({
          ...prev,
          enabled: !!fresh.enabled,
          mode: fresh.mode === 'api' ? 'api' : 'webhook',
          webhookUrl: fresh.webhookUrl || prev.webhookUrl,
          url: fresh.url || prev.url,
          authToken: '',
          authTokenSet: !!fresh.authTokenSet,
          userId: fresh.userId || prev.userId,
          channel: fresh.channel || prev.channel,
          entity: fresh.entity ?? prev.entity,
          version: fresh.version ?? prev.version,
        }))
      }
      toast.success('Notification settings saved')
    } catch (err: any) {
      toast.error(getErrorMessage(err, 'Save failed'))
    } finally {
      setSaving(false)
    }
  }

  const canTest = rc.mode === 'api'
    ? !!(rc.url && rc.userId && (rc.authToken || rc.authTokenSet))
    : !!rc.webhookUrl

  const handleTest = async () => {
    if (!canTest) {
      toast.error(rc.mode === 'api'
        ? 'Enter the server URL, access token, and user ID first'
        : 'Enter the webhook URL first')
      return
    }
    setTesting(true)
    try {
      // Save first so the backend test endpoint reads the values the user
      // is looking at right now. Force enabled=true for the test even if
      // the user hasn't ticked the toggle yet, then restore the choice
      // afterwards.
      await notificationsApi.saveSettings(buildPayload({ enabled: true }))
      const res = await notificationsApi.sendTest()
      if (!rc.enabled) {
        await notificationsApi.saveSettings(buildPayload({ enabled: false }))
      }
      if (res.data?.success) {
        toast.success('Test message sent — check your RocketChat channel')
      } else {
        toast.error(res.data?.error || 'Test failed (no error returned)')
      }
    } catch (err: any) {
      toast.error(getErrorMessage(err, 'Test failed'))
    } finally {
      setTesting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500 p-4">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading settings...
      </div>
    )
  }

  const inputCls = 'w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500'

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Notification Settings</h2>
        <p className="text-sm text-gray-500">Configure RocketChat, SMS, and in-app notification preferences.</p>
      </div>

      {/* RocketChat */}
      <div className="space-y-4 p-4 border border-gray-200 dark:border-gray-700 rounded-xl">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <MessageSquare className="h-4 w-4" /> RocketChat
        </h3>

        {/* Enable toggle: prominent so it's never missed */}
        <label className="flex items-start gap-3 p-3 rounded-lg bg-gray-50 dark:bg-gray-800/40 cursor-pointer">
          <input
            type="checkbox"
            checked={rc.enabled}
            onChange={(e) => updateField('enabled', e.target.checked)}
            className="h-4 w-4 mt-0.5"
          />
          <div className="flex-1">
            <div className="text-sm font-medium">Enable RocketChat notifications</div>
            <div className="text-xs text-gray-500">
              {rc.enabled
                ? 'On — backup events will be posted to RocketChat.'
                : 'Off — settings can be saved but no messages will be sent.'}
            </div>
          </div>
          <span
            className={cn(
              'text-xs font-medium px-2 py-0.5 rounded-full',
              rc.enabled
                ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                : 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
            )}
          >
            {rc.enabled ? 'Enabled' : 'Disabled'}
          </span>
        </label>

        <div className="grid gap-3 max-w-lg">
          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Connection mode</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => updateField('mode', 'webhook')}
                className={cn(
                  'flex-1 px-3 py-2 rounded-lg border text-sm text-left',
                  rc.mode === 'webhook'
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400'
                    : 'border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800/40'
                )}
              >
                <div className="font-medium">Incoming Webhook</div>
                <div className="text-xs text-gray-500 mt-0.5">Simple, but can't edit a message once sent</div>
              </button>
              <button
                type="button"
                onClick={() => updateField('mode', 'api')}
                className={cn(
                  'flex-1 px-3 py-2 rounded-lg border text-sm text-left',
                  rc.mode === 'api'
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400'
                    : 'border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800/40'
                )}
              >
                <div className="font-medium">REST API</div>
                <div className="text-xs text-gray-500 mt-0.5">Needed for the daily incident board to edit in place</div>
              </button>
            </div>
          </div>

          {rc.mode === 'webhook' ? (
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Webhook URL</label>
              <input
                type="url"
                placeholder="https://chat.example.com/hooks/<hookId>/<secret>"
                value={rc.webhookUrl}
                onChange={(e) => updateField('webhookUrl', e.target.value)}
                className={inputCls}
                spellCheck={false}
                autoComplete="off"
              />
              <p className="text-xs text-gray-500">
                In RocketChat: <em>Administration → Workspace → Integrations → New → Incoming</em>.
                Create the integration, then copy the URL labeled <strong>Webhook URL</strong> from
                that page (it looks like <code>https://your-chat.example/hooks/&lt;id&gt;/&lt;secret&gt;</code>)
                and paste it here.
              </p>
              <p className="text-xs text-amber-600 dark:text-amber-500">
                Webhooks can only post new messages — the daily incident board needs to edit a
                message in place, so switch to REST API for that to work.
              </p>
            </div>
          ) : (
            <>
              <div className="space-y-1">
                <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Server URL</label>
                <input
                  type="url"
                  placeholder="https://chat.example.com"
                  value={rc.url}
                  onChange={(e) => updateField('url', e.target.value)}
                  className={inputCls}
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Personal Access Token</label>
                <input
                  type="password"
                  placeholder={rc.authTokenSet ? '•••••••• (leave blank to keep the current token)' : 'Personal access token'}
                  value={rc.authToken}
                  onChange={(e) => updateField('authToken', e.target.value)}
                  className={inputCls}
                  spellCheck={false}
                  autoComplete="off"
                />
                <p className="text-xs text-gray-500">
                  RocketChat: <em>My Account → Personal Access Tokens</em>. Stored on the
                  controller and never shown again after saving.
                </p>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-gray-600 dark:text-gray-400">User ID</label>
                <input
                  type="text"
                  placeholder="The user id the token above belongs to"
                  value={rc.userId}
                  onChange={(e) => updateField('userId', e.target.value)}
                  className={inputCls}
                  spellCheck={false}
                  autoComplete="off"
                />
                <p className="text-xs text-gray-500">
                  Shown next to the token when you create it on that same page.
                </p>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Channel</label>
                <input
                  type="text"
                  placeholder="backup-notifications"
                  value={rc.channel}
                  onChange={(e) => updateField('channel', e.target.value)}
                  className={inputCls}
                  spellCheck={false}
                  autoComplete="off"
                />
                <p className="text-xs text-gray-500">Channel name to post into, without the leading #.</p>
              </div>
            </>
          )}
        </div>

        <div className="grid gap-3 max-w-lg pt-2 border-t border-gray-200 dark:border-gray-700">
          <p className="text-xs text-gray-500">
            Message template fields. Used for the headline and the
            <code className="mx-1">🏷️ Version</code> line of every notification.
          </p>
          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Default Entity</label>
            <input
              type="text"
              placeholder="Backup Manager"
              value={rc.entity}
              onChange={(e) => updateField('entity', e.target.value)}
              className={inputCls}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-600 dark:text-gray-400">Version</label>
            <input
              type="text"
              placeholder="1.0.0"
              value={rc.version}
              onChange={(e) => updateField('version', e.target.value)}
              className={inputCls}
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-2 pt-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
          <button
            type="button"
            onClick={handleTest}
            disabled={testing || !canTest}
            title={!canTest
              ? (rc.mode === 'api' ? 'Enter the server URL, access token, and user ID first' : 'Enter the webhook URL first')
              : 'Sends a test message using the values currently in the form'}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50"
          >
            {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {testing ? 'Sending...' : 'Send Test Message'}
          </button>
        </div>
      </div>

      {/* Every notification the platform can send: whether it is sent at all,
          and who is @-mentioned when it is. */}
      <div className="space-y-4 p-4 border border-gray-200 dark:border-gray-700 rounded-xl">
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Bell className="h-4 w-4" /> Notifications
          </h3>
          <p className="text-xs text-gray-500 mt-1">
            Switch each section on or off, and name the people responsible for it.
            People are assigned per section — everyone listed is{' '}
            <span className="font-medium">@-mentioned</span> at the top of every message that
            section sends, so it lands as someone's job rather than as general chatter. Expand a
            section to see exactly which notifications it covers.
          </p>
          <p className="text-xs text-gray-500 mt-1">
            <span className="font-medium">Backups are the exception.</span> Every per-VM backup
            problem reports on the daily incident board instead of as its own message, and the
            people mentioned there come from{' '}
            <span className="font-medium">Notify by backup host</span> below — not from the
            Backups section's list. A successful backup never sends anything; it just takes the
            VM's line off the board.
          </p>
          <p className="text-xs text-gray-500 mt-1">
            Usernames are comma-separated. The <code className="px-1">@</code> is optional — type
            <code className="mx-1">alice, bob</code> or <code className="mx-1">@alice, @bob</code>,
            both work.
          </p>
        </div>

        <div className="space-y-2 max-w-3xl">
          <label className="text-xs font-medium text-gray-600 dark:text-gray-400">
            Default people (used when a notification has nobody of its own)
          </label>
          <input
            type="text"
            placeholder="alice, bob"
            value={defaultMentions}
            onChange={(e) => setDefaultMentions(e.target.value)}
            className={inputCls}
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        {NOTIFICATION_TYPE_GROUPS.map(group => {
          const items = NOTIFICATION_TYPES.filter(t => t.group === group)
          if (items.length === 0) return null
          const onCount = items.filter(t => types[t.key] !== false).length
          const groupOn = onCount > 0
          const expanded = !!openGroups[group]
          return (
            <div key={group} className="pt-3 border-t border-gray-200 dark:border-gray-700">
              <div className="flex flex-wrap items-center gap-3 py-2 px-3 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800/40">
                <label className="flex items-center gap-3 cursor-pointer min-w-0 flex-1">
                  <input
                    type="checkbox"
                    checked={groupOn}
                    /* Partially-on sections read as on, but show as indeterminate. */
                    ref={el => { if (el) el.indeterminate = onCount > 0 && onCount < items.length }}
                    onChange={(e) => {
                      const checked = e.target.checked
                      setTypes(prev => {
                        const next = { ...prev }
                        items.forEach(t => { next[t.key] = checked })
                        return next
                      })
                    }}
                    className="h-4 w-4 shrink-0"
                  />
                  <div className="min-w-0">
                    <div className="text-sm font-semibold">{group}</div>
                    <div className="text-xs text-gray-500">
                      {items.length} notification{items.length === 1 ? '' : 's'}
                      {onCount < items.length && ` · ${onCount} on`}
                    </div>
                  </div>
                </label>
                <input
                  type="text"
                  placeholder="Mention… e.g. alice, bob"
                  value={mentionsByGroup[group] || ''}
                  onChange={(e) => {
                    const value = e.target.value
                    setMentionsByGroup(prev => ({ ...prev, [group]: value }))
                  }}
                  disabled={!groupOn}
                  title={groupOn ? `RocketChat usernames to @-mention for every ${group} notification` : 'Switch this section on to assign people'}
                  className={cn(
                    'w-full sm:w-64 shrink-0 px-3 py-1.5 rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500',
                    'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900',
                    'text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500',
                    !groupOn && 'opacity-50 cursor-not-allowed bg-gray-50 dark:bg-gray-800'
                  )}
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>

              {/* Each notification in the section can still be switched on or
                  off individually; only the people are section-wide. */}
              <button
                type="button"
                onClick={() => setOpenGroups(prev => ({ ...prev, [group]: !prev[group] }))}
                className="ml-3 inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
              >
                {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                {expanded ? 'Hide' : 'Show'} what this covers
              </button>
              {expanded && (
                <div className="mt-1 mb-2 ml-9 space-y-1">
                  <p className="text-[11px] text-gray-500">
                    Click a notification to switch it on or off. People come from the section above.
                  </p>
                  {items.map(t => {
                    const on = types[t.key] !== false
                    return (
                      <label
                        key={t.key}
                        className={cn(
                          'flex items-start gap-2 py-1.5 px-2 rounded-md cursor-pointer border border-transparent',
                          'hover:bg-gray-50 dark:hover:bg-gray-800/60 hover:border-gray-200 dark:hover:border-gray-700'
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) => {
                            const checked = e.target.checked
                            setTypes(prev => ({ ...prev, [t.key]: checked }))
                          }}
                          className="h-3.5 w-3.5 mt-0.5 shrink-0"
                        />
                        <span className="text-xs min-w-0">
                          <span className={cn('font-medium', !on && 'text-gray-400')}>{t.label}</span>
                          {t.hint && (
                            <span className={cn(on ? 'text-gray-500' : 'text-gray-400')}> — {t.hint}</span>
                          )}
                        </span>
                      </label>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}

        <div className="pt-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </div>

      {/* Backup failed / offsite sync failed / backup skipped always send now,
          via the daily incident board — no toggle for them above. This is the
          one thing still configurable for those three: who gets @-mentioned,
          scoped by which backup host the event happened on rather than by
          type or schedule. A host left off this list still gets its entries
          on the board, just without a mention. */}
      <div className="space-y-4 p-4 border border-gray-200 dark:border-gray-700 rounded-xl">
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Server className="h-4 w-4" /> Notify by backup host
          </h3>
          <p className="text-xs text-gray-500 mt-1">
            Backup failed, offsite sync failed, and backup skipped always post to the daily
            incident board — there's no switch to turn those off. Add a backup host here to
            @-mention people whenever one of those happens on it; a host not listed still gets
            its entry on the board, just silently.
          </p>
        </div>

        <div className="space-y-2 max-w-2xl">
          {hostMentions.map((row, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <select
                value={row.backupHostId}
                onChange={(e) => {
                  const value = e.target.value
                  setHostMentions(prev => prev.map((r, i) => i === idx ? { ...r, backupHostId: value } : r))
                }}
                className={cn(inputCls, 'sm:w-56 shrink-0')}
              >
                <option value="">Select a backup host…</option>
                {(backupHosts || []).map(h => (
                  <option key={h.id} value={h.id}>{h.name}</option>
                ))}
              </select>
              <input
                type="text"
                placeholder="Mention… e.g. alice, bob"
                value={row.mentions}
                onChange={(e) => {
                  const value = e.target.value
                  setHostMentions(prev => prev.map((r, i) => i === idx ? { ...r, mentions: value } : r))
                }}
                className={cn(inputCls, 'flex-1')}
                spellCheck={false}
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => setHostMentions(prev => prev.filter((_, i) => i !== idx))}
                className="shrink-0 p-2 text-gray-400 hover:text-red-600 dark:hover:text-red-400"
                title="Remove"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}

          <button
            type="button"
            onClick={() => setHostMentions(prev => [...prev, { backupHostId: '', mentions: '' }])}
            className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
          >
            <Plus className="h-4 w-4" /> Add backup host
          </button>
        </div>

        <div className="pt-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </div>

      {/* SMS — placeholder, kept as-is until a provider is wired up */}
      <div className="space-y-3 p-4 border border-gray-200 dark:border-gray-700 rounded-xl opacity-70">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Bell className="h-4 w-4" /> SMS Notifications
        </h3>
        <p className="text-xs text-gray-500">SMS gateway integration is not enabled in this build.</p>
      </div>
    </div>
  )
}
