// Backup Host = Agent (server running agent-backend where backups are stored)
export interface BackupHost {
  id: string
  name: string
  url: string
  description?: string
  maxConcurrentBackups?: number
  status: 'online' | 'offline'
  lastHealthCheck: string
  backupPath: string
  restorePath: string
  hypervisorCount: number
  vmCount: number
  createdAt: string
  updatedAt: string
}

// Hypervisor = KVM server with VMs (Agent connects via SSH)
export interface Hypervisor {
  id: string
  backupHostId: string
  name: string
  ip: string
  port: number
  username: string
  status: 'connected' | 'error' | 'pending'
  vmCount: number
  lastError?: string
  createdAt: string
  updatedAt: string
}

// Virtual Machine on a hypervisor
export interface VirtualMachine {
  id: string
  hypervisorId: string
  backupHostId: string
  name: string
  state: string
  selected: boolean
  createdAt: string
  updatedAt: string
}

// Offsite Host for backup replication
export interface OffsiteHost {
  id: string
  backupHostId: string
  name: string
  ip: string
  port: number
  username: string
  path: string
  status: 'connected' | 'disconnected' | 'pending'
  createdAt: string
  updatedAt: string
}

// Backup Schedule
export interface BackupSchedule {
  id: string
  vmId: string
  vmName?: string
  backupHostId?: string
  backupHostName?: string
  name: string
  scheduleType: 'daily' | 'weekly' | 'custom-days' | 'interval' | 'cron' | 'once' | 'monthly'
  cronExpression: string
  cronHuman?: string
  method: 'full' | 'inc' | 'copy'
  compression: number
  noCompression: boolean
  noVerify: boolean
  enabled: boolean
  // Missed-run policy (Item 1)
  missedRunPolicy?: 'immediate' | 'most-recent' | 'skip'
  missedRunGracePeriodMinutes?: number
  lastFiredAt?: string
  createdAt: string
  updatedAt: string
}

// Backup Job
export interface BackupJob {
  id: string
  jobType?: 'backup' | 'restore' // Type of job
  scheduleId?: string
  vmId: string
  vmName: string
  hypervisorId: string
  hypervisorIp: string
  backupHostId: string
  backupHostName: string
  method: 'full' | 'inc' | 'copy'
  scheduleType?: string // For display purposes (daily, weekly, etc.)
  compression: number
  noCompression: boolean
  noVerify: boolean
  status: 'queued' | 'running' | 'completed' | 'failed' | 'skipped'
  phase?: 'queued' | 'starting' | 'backup' | 'rsync' | 'completed' | 'failed' | 'orphaned' | 'restore' | 'unknown'
  startTime: string
  endTime?: string
  exitCode?: number
  error?: string
  scheduled: boolean
  progress?: number
  progressText?: string
  skippedReason?: string // Reason for skipping (e.g., 'agent_offline')
  canRetry?: boolean // Whether this job can be retried
  retryOf?: string // ID of the original job if this is a retry
  replay?: boolean // Whether this is a missed-run replay
  originallyScheduledAt?: string // Original scheduled time for replays
  replayReason?: string
  actor?: string // Who triggered this (user id, 'system:scheduler', 'system:missed-run')
  triggeredBy?: string
  lastSyncedAt?: string
  syncSource?: string
}

// Backup Directory Structure
export interface BackupDirectory {
  vmName: string
  basePath: string
  exists: boolean
  current: {
    exists: boolean
    path: string
    size: number | null
    lastModified: string | null
  }
  archived: {
    exists: boolean
    path: string
    items: Array<{
      name: string
      path: string
      size: number
      lastModified: string
    }>
  }
  monthly: {
    exists: boolean
    path: string
    size: number | null
    lastModified: string | null
  }
}

// Backup Stats
export interface BackupStats {
  total: number
  completed: number
  failed: number
  running: number
  queued: number
  last24h: {
    total: number
    completed: number
    failed: number
  }
}

// API Response wrapper
export interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
  errors?: string[]
}
