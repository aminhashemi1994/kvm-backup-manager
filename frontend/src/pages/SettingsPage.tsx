import { useState, useEffect } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { Settings, Users, Shield, Bell, MessageSquare, Sun, Moon, Save, Send, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTheme } from '@/contexts/ThemeContext'
import { notificationsApi, settingsApi } from '@/services/api'
import { toast } from 'sonner'
import { useConfirm } from '@/components/ui/confirm-dialog'

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
  type Settings = {
    defaultMaxConcurrentBackups: number
    healthCheckIntervalSeconds: number
    defaultMissedRunPolicy: 'immediate' | 'most-recent' | 'skip'
  }
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [settings, setSettings] = useState<Settings>({
    defaultMaxConcurrentBackups: 20,
    healthCheckIntervalSeconds: 60,
    defaultMissedRunPolicy: 'immediate',
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
      toast.error(err.response?.data?.error || err.message || 'Save failed')
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

      {/* About section */}
      <div className="space-y-3 p-4 border border-gray-200 dark:border-gray-700 rounded-xl">
        <h3 className="text-sm font-semibold">About</h3>
        <div className="grid gap-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-gray-500">Version</span>
            <span className="font-mono">1.1.0</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-gray-500">License</span>
            <span>MIT (Open Source)</span>
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
    webhookUrl: string
    entity: string
    version: string
  }

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [rc, setRc] = useState<RcSettings>({
    enabled: false,
    webhookUrl: '',
    entity: 'Backup Manager',
    version: '',
  })

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
            webhookUrl: data.webhookUrl || '',
            entity: data.entity || prev.entity,
            version: data.version || prev.version,
          }))
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
      // Webhook is the only supported mode now. The API mode was removed
      // because the simple webhook covers every use case here and avoids
      // the extra configuration burden (auth token, user id, channel).
      mode: 'webhook' as const,
      enabled: rc.enabled,
      webhookUrl: rc.webhookUrl,
      entity: rc.entity,
      version: rc.version,
      ...override,
    },
  })

  const handleSave = async () => {
    setSaving(true)
    try {
      const res = await notificationsApi.saveSettings(buildPayload())
      const fresh = res.data?.data?.rocketChat
      if (fresh) {
        setRc(prev => ({
          ...prev,
          enabled: !!fresh.enabled,
          webhookUrl: fresh.webhookUrl || prev.webhookUrl,
          entity: fresh.entity ?? prev.entity,
          version: fresh.version ?? prev.version,
        }))
      }
      toast.success('Notification settings saved')
    } catch (err: any) {
      toast.error(err.response?.data?.error || err.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    if (!rc.webhookUrl) {
      toast.error('Enter the webhook URL first')
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
      toast.error(err.response?.data?.error || err.message || 'Test failed')
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

  const inputCls = 'w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'

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
          </div>
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
            disabled={testing || !rc.webhookUrl}
            title={!rc.webhookUrl ? 'Enter the webhook URL first' : 'Sends a test message using the values currently in the form'}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50"
          >
            {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {testing ? 'Sending...' : 'Send Test Message'}
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
