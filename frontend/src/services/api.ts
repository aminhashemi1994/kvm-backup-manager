import axios from 'axios'
import { isUserActive } from '@/lib/activity'

// Simple backend URL configuration
// Just set VITE_BACKEND_URL to the full API base URL
// Example: https://you-domain.com/api-backup
const baseURL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000/api'

const api = axios.create({
  baseURL: baseURL,
  headers: { 'Content-Type': 'application/json' },
})

// Request interceptor to add JWT token to all requests
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('authToken')
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    // Tell the controller whether this request follows real user activity.
    // The controller only extends (refreshes) the session token when the
    // user is actually active, so background polling alone won't keep an
    // unattended session alive forever.
    if (isUserActive()) {
      config.headers['X-Session-Active'] = '1'
    }
    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

// Response interceptor to handle errors
api.interceptors.response.use(
  (response) => {
    // Sliding-session refresh: the controller returns a fresh token on every
    // authenticated user request. Swap our stored token for it so an active
    // session keeps extending. After ~30 min idle no requests are made, the
    // token expires, and the next call 401s → auto-logout below.
    const refreshed = response.headers?.['x-refresh-token']
    if (refreshed) {
      localStorage.setItem('authToken', refreshed)
    }
    return response
  },
  (error) => {
    // If we get a 401 Unauthorized, clear auth state
    // Do NOT do window.location.href — let React Router handle the redirect
    // to avoid infinite reload loops
    if (error.response?.status === 401) {
      const currentPath = window.location.pathname
      // Only clear + redirect if we're NOT already on the login page
      if (currentPath !== '/login') {
        localStorage.removeItem('authToken')
        localStorage.removeItem('user')
        // Use soft navigation instead of hard reload
        window.location.replace('/login')
      }
    }
    
    return Promise.reject(error)
  }
)

// Backup Hosts
export const backupHostsApi = {
  getAll: () => api.get('/backup-hosts'),
  getOne: (id: string) => api.get(`/backup-hosts/${id}`),
  create: (data: any) => api.post('/backup-hosts', data),
  update: (id: string, data: any) => api.put(`/backup-hosts/${id}`, data),
  delete: (id: string) => api.delete(`/backup-hosts/${id}`),
  healthCheck: (id: string) => api.post(`/backup-hosts/${id}/health-check`),
  syncStoragePools: (backupHostUrl: string) => 
    axios.post(`${backupHostUrl}/api/storage-pool-sync/sync`, {}, {
      headers: { 'Content-Type': 'application/json' }
    }),
  getStoragePoolSyncStatus: (backupHostUrl: string) =>
    axios.get(`${backupHostUrl}/api/storage-pool-sync/status`, {
      headers: { 'Content-Type': 'application/json' }
    }),
}

// Hypervisors
export const hypervisorsApi = {
  getAll: () => api.get('/hypervisors'),
  getByBackupHost: (backupHostId: string) => api.get(`/hypervisors/backup-host/${backupHostId}`),
  getOne: (id: string) => api.get(`/hypervisors/${id}`),
  create: (data: any) => api.post('/hypervisors', data),
  update: (id: string, data: any) => api.put(`/hypervisors/${id}`, data),
  delete: (id: string) => api.delete(`/hypervisors/${id}`),
  refreshVMs: (id: string) => api.post(`/hypervisors/${id}/refresh-vms`),
}

// Virtual Machines
export const vmsApi = {
  getAll: () => api.get('/vms'),
  getByHypervisor: (hypervisorId: string) => api.get(`/vms/hypervisor/${hypervisorId}`),
  getByBackupHost: (backupHostId: string) => api.get(`/vms/backup-host/${backupHostId}`),
  getSelected: () => api.get('/vms/selected'),
  getOne: (id: string) => api.get(`/vms/${id}`),
  update: (id: string, data: any) => api.put(`/vms/${id}`, data),
  selectMultiple: (vmIds: string[], selected: boolean) =>
    api.post('/vms/select-multiple', { vmIds, selected }),
}

// Offsite Hosts
export const offsiteHostsApi = {
  getAll: () => api.get('/offsite-hosts'),
  getByBackupHost: (backupHostId: string) => api.get(`/offsite-hosts/backup-host/${backupHostId}`),
  create: (data: any) => api.post('/offsite-hosts', data),
  update: (id: string, data: any) => api.put(`/offsite-hosts/${id}`, data),
  delete: (id: string) => api.delete(`/offsite-hosts/${id}`),
  test: (id: string) => api.post(`/offsite-hosts/${id}/test`),
  sync: (id: string, vmName: string) => api.post(`/offsite-hosts/${id}/sync/${vmName}`),
}

// Schedules
export const schedulesApi = {
  getAll: () => api.get('/schedules'),
  getByVM: (vmId: string) => api.get(`/schedules/vm/${vmId}`),
  getOne: (id: string) => api.get(`/schedules/${id}`),
  create: (data: any) => api.post('/schedules', data),
  update: (id: string, data: any) => api.put(`/schedules/${id}`, data),
  delete: (id: string) => api.delete(`/schedules/${id}`),
  toggle: (id: string) => api.post(`/schedules/${id}/toggle`),
  runNow: (id: string) => api.post(`/schedules/${id}/run`),
}

// Backups
export const backupsApi = {
  getActive: () => api.get('/backups/active'),
  getHistory: (params?: any) => api.get('/backups/history', { params }),
  getJob: (id: string) => api.get(`/backups/jobs/${id}`),
  getJobLogs: (id: string) => api.get(`/backups/jobs/${id}/logs`),
  trigger: (data: any) => api.post('/backups/trigger', data),
  killJob: (jobId: string) => api.post(`/backups/kill/${jobId}`),
  forceRemoveJob: (jobId: string) => api.delete(`/backups/jobs/${jobId}/force`),
  retryJob: (jobId: string) => api.post(`/backups/jobs/${jobId}/retry`),
  getStats: () => api.get('/backups/stats'),
}

// Init Host
export const initApi = {
  initHost: (data: any) => api.post('/init/host', data),
  getLogs: (initId: string, backupHostId: string) => 
    api.get(`/init/${initId}/logs`, { params: { backupHostId } }),
  getStatus: (initId: string, backupHostId: string) =>
    api.get(`/init/${initId}/status`, { params: { backupHostId } }),
}

// Reports
export const reportsApi = {
  getReport: (backupHostId: string) => api.get(`/reports/${backupHostId}`),
  getStatus: (backupHostId: string) => api.get(`/reports/${backupHostId}/status`),
  generate: (backupHostId: string) => api.post(`/reports/${backupHostId}/generate`),
  getEnriched: (backupHostId: string) => api.get(`/reports/enriched/${backupHostId}`),
  getGlobal: () => api.get('/reports/global'),
  // Force fresh generation across the relevant agents (bypasses per-agent
  // 2-minute manual cooldown). Returns when all targeted agents have
  // finished or errored.
  regenerate: (scope: 'global' | 'host' | 'vm' | 'hypervisor', scopeId?: string) =>
    api.post('/reports/regenerate', { scope, scopeId }),
  // Download a report. For json/csv/txt/md the server returns the file
  // body directly; for xlsx and pdf it returns a JSON envelope that the
  // frontend uses to assemble the binary.
  download: (
    format: 'json' | 'csv' | 'txt' | 'md' | 'xlsx' | 'pdf',
    scope: 'global' | 'host' | 'vm' | 'hypervisor',
    scopeId?: string,
  ) =>
    api.get(`/reports/download/${format}`, {
      params: { scope, scopeId },
      responseType: format === 'xlsx' || format === 'pdf' ? 'json' : 'blob',
    }),
}

// Metrics
export const metricsApi = {
  getMetrics: (backupHostId: string) => api.get(`/metrics/${backupHostId}?t=${Date.now()}`),
  getAllHypervisorMetrics: () => api.get(`/metrics/hypervisors/all?t=${Date.now()}`),
  getHypervisorMetrics: (hypervisorId: string) => api.get(`/metrics/hypervisors/${hypervisorId}?t=${Date.now()}`),
  getAllOffsiteMetrics: () => api.get(`/metrics/offsite/all?t=${Date.now()}`),
  getOffsiteMetrics: (offsiteId: string) => api.get(`/metrics/offsite/${offsiteId}?t=${Date.now()}`),
  triggerCollection: () => api.post('/metrics/collect'),
}

// Health Check (Item 4)
export const healthCheckApi = {
  getStatus: () => api.get('/health-check/status'),
  trigger: () => api.post('/health-check/trigger'),
}

// Storage Pools
export const storagePoolsApi = {
  getAll: () => api.get(`/storage-pools?t=${Date.now()}`),
  getByBackupHost: (backupHostId: string) => api.get(`/storage-pools/backup-host/${backupHostId}?t=${Date.now()}`),
  getOne: (id: string) => api.get(`/storage-pools/${id}?t=${Date.now()}`),
  create: (data: any) => api.post('/storage-pools', data),
  update: (id: string, data: any) => api.put(`/storage-pools/${id}`, data),
  delete: (id: string) => api.delete(`/storage-pools/${id}`),
  refresh: (id: string) => api.post(`/storage-pools/${id}/refresh`),
}

// Restore Storage Pools
export const restoreStoragePoolsApi = {
  getAll: () => api.get(`/restore-storage-pools?t=${Date.now()}`),
  getByBackupHost: (backupHostId: string) => api.get(`/restore-storage-pools/backup-host/${backupHostId}?t=${Date.now()}`),
  getOne: (id: string) => api.get(`/restore-storage-pools/${id}?t=${Date.now()}`),
  create: (data: any) => api.post('/restore-storage-pools', data),
  update: (id: string, data: any) => api.put(`/restore-storage-pools/${id}`, data),
  delete: (id: string) => api.delete(`/restore-storage-pools/${id}`),
  refresh: (id: string) => api.post(`/restore-storage-pools/${id}/refresh`),
}

// Fix Backup
export const fixBackupApi = {
  fixBackup: (data: any) => api.post('/fix-backup', data),
}

// Cleanup Backup (cleanup only, no backup start)
export const cleanupBackupApi = {
  cleanupBackup: (data: any) => api.post('/cleanup-backup', data),
}

// Backup Removal
export const backupRemovalApi = {
  listVMs: (backupHostId: string) => api.get(`/backup-removal/${backupHostId}/vms`),
  getVMDetails: (backupHostId: string, vmName: string) =>
    api.get(`/backup-removal/${backupHostId}/vm/${encodeURIComponent(vmName)}/details`),
  removeSchedule: (backupHostId: string, vmName: string, scheduleType: string) =>
    api.delete(`/backup-removal/${backupHostId}/schedule`, { data: { vmName, scheduleType } }),
  removeVM: (backupHostId: string, vmName: string) =>
    api.delete(`/backup-removal/${backupHostId}/vm`, { data: { vmName } }),
}

// Restore
export const restoreApi = {
  getOptions: (vmName: string, backupHostId: string) =>
    api.get(`/restore/options/${encodeURIComponent(vmName)}/${backupHostId}`),
  trigger: (data: {
    vmName: string
    backupHostId: string
    method: string
    restoreStoragePoolId: string
    depth?: number | null
    disk?: string | null
  }) => api.post('/restore/trigger', data),
  getStatus: (restoreId: string) => api.get(`/restore/status/${restoreId}`),
  getJobs: () => api.get('/restore/jobs'),
  getHistory: () => api.get('/restore/history'),
  getLogs: (restoreId: string) => api.get(`/restore/logs/${restoreId}`),
  killJob: (restoreId: string) => api.post(`/restore/kill/${restoreId}`),
}

// Cleanup
export const cleanupApi = {
  scan: (olderThanHours: number = 6) => api.get('/cleanup/scan', { params: { olderThanHours } }),
  execute: (agentId: string, files: string[]) => api.post('/cleanup/execute', { agentId, files }),
  cleanupControllerJobs: (olderThanHours: number = 24) => api.post('/cleanup/controller-jobs', { olderThanHours }),
  getStats: () => api.get('/cleanup/stats'),
}

// Notifications
export const notificationsApi = {
  getSettings: () => api.get('/notifications/settings'),
  saveSettings: (settings: any) => api.put('/notifications/settings', settings),
  sendTest: () => api.post('/notifications/test'),
}

// General system settings (panel-managed defaults)
export const settingsApi = {
  get: () => api.get('/settings'),
  save: (settings: any) => api.put('/settings', settings),
}

export default api
