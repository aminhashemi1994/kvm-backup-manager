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

// Storage pool owned by an offsite host (independent of backup-host pools)
export interface OffsiteStoragePool {
  id: string
  name: string
  path: string
  totalGB?: number
  usedGB?: number
  availableGB?: number
  usagePercent?: number
  diskUsageThreshold?: number
  mounted?: boolean
  status: 'active' | 'error'
  lastError?: string | null
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
  /** This offsite host's own storage pools. Replaces the single legacy `backupPath`. */
  storagePools: OffsiteStoragePool[]
  /** LEGACY: optional custom destination base path. Migration source only. */
  backupPath?: string
  status: 'connected' | 'disconnected' | 'pending'
  createdAt: string
  updatedAt: string
}

// A schedule/job's chosen offsite destination: one pool per offsite host
export interface OffsiteTarget {
  offsiteHostId: string
  offsitePoolId: string
}

// A runtime warning recorded when an offsite sync is skipped/failed
export interface OffsiteWarning {
  offsiteHostId: string
  offsitePoolId: string
  reason: string
  at: string
}

// Backup Schedule
export interface BackupSchedule {
  id: string
  vmId: string
  vmName?: string
  backupHostId?: string
  backupHostName?: string
  hypervisorId?: string
  hypervisorName?: string
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
  // Offsite replication targets: one destination pool per selected offsite host
  offsiteTargets?: OffsiteTarget[]
  /** Derived from offsiteTargets; kept for enrichment/backward-compat. */
  offsiteHostIds?: string[]
  offsiteHostNames?: string[]
  storagePoolId?: string
  storagePoolName?: string
  time?: string
  incrementalCount?: number
  retention?: number
  keepArchive?: number
  daysOfWeek?: number[]
  customDates?: Array<{ date: string; time: string; method: 'full' | 'inc' }>
  retentionCount?: number
  intervalValue?: number
  intervalUnit?: 'hours' | 'days'
  retryCount?: number
  retryDelayMinutes?: number
  // Migration/validation flags: set when a schedule is disabled for a missing offsite pool selection
  invalid?: boolean
  invalidReason?: string | null
  // Runtime offsite sync warnings (skipped/failed syncs while primary succeeded)
  offsiteWarnings?: OffsiteWarning[]
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
  // 'rejected' = the run was declined because the VM was already backing up
  // (the agent holds one lock per VM). Nothing was attempted; not a failure.
  status: 'queued' | 'running' | 'completed' | 'failed' | 'skipped' | 'rejected' | 'retrying'
  phase?: 'queued' | 'starting' | 'backup' | 'rsync' | 'completed' | 'failed' | 'orphaned' | 'restore' | 'unknown'
  startTime: string
  endTime?: string
  exitCode?: number
  error?: string
  scheduled: boolean
  progress?: number
  progressText?: string
  skippedReason?: string // Reason for skipping (e.g., 'agent_offline')
  rejectedReason?: string // Why the run was declined (e.g., 'already_running')
  coveredBy?: string // ID of the backup that was already running when this run was rejected
  collidedWithSession?: string // tmux session of that running backup
  storagePoolPath?: string // Pool a tmux-adopted run is writing into (for log lookup)
  canRetry?: boolean // Whether this job can be retried
  retryOf?: string // ID of the original job if this is a retry
  supersededBy?: string // ID of the retry job that superseded this skipped record
  progressType?: string // Current progress phase reported by the agent ('backup' | 'rsync')
  offsiteSyncStatus?: 'running' | 'completed' | 'partial' | 'failed' | 'unknown' // Offsite replication outcome
  offsiteResults?: Array<{ ip: string; poolPath?: string; status: string; reason?: string }>
  verified?: boolean // True when the terminal status came from the agent's own exit-code detection
  unverified?: boolean // True when completion was inferred by the reconciler without a confirmed exit code
  failureReason?: string // Why it failed: 'script_error' | 'orphaned' | 'interrupted' | 'indeterminate' (outcome unprovable — shown as failed, may have succeeded) | ...
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
