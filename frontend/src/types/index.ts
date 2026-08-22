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
/**
 * Per-event notification toggles. A key that is absent (or undefined) means
 * "inherit the global setting" — that is how every pre-existing schedule
 * behaves, so opting in is always explicit.
 */
export interface NotificationEventToggles {
  backupSuccess?: boolean
  backupFailure?: boolean
  offsiteSuccess?: boolean
  offsitePartial?: boolean
  offsiteFailure?: boolean
  retry?: boolean
  missed?: boolean
  certificateExpiry?: boolean
}

/**
 * Every notification the platform can send, as shown in
 * Settings → Notifications. Keys must match TYPE_DEFAULTS in
 * controller-backend/services/rocketChatService.js.
 */
export interface NotificationTypeMeta {
  key: string
  label: string
  group: string
  hint?: string
}

export const NOTIFICATION_TYPE_GROUPS = [
  'Backups',
  'Offsite',
  'Restore',
  'Infrastructure',
  'TLS certificates',
  'Summaries',
] as const

export const NOTIFICATION_TYPES: NotificationTypeMeta[] = [
  { key: 'backupFailed', group: 'Backups', label: 'Backup failed', hint: 'A backup did not complete' },
  { key: 'backupCompleted', group: 'Backups', label: 'Backup succeeded', hint: 'Every successful backup — high volume' },
  { key: 'scheduledBackupFailed', group: 'Backups', label: 'Scheduled run could not start', hint: 'The scheduler could not launch the run at all' },
  { key: 'backupSkipped', group: 'Backups', label: 'Backup skipped', hint: 'Run skipped because the VM or host was unavailable' },
  { key: 'backupRetry', group: 'Backups', label: 'Retry started', hint: 'A failed run is being retried' },
  { key: 'multipleBackupFailures', group: 'Backups', label: 'Repeated failures', hint: 'The same VM has failed several times in a row' },
  { key: 'backupStuck', group: 'Backups', label: 'Backup stuck', hint: 'No progress reported for an hour' },
  { key: 'backupVerificationFailed', group: 'Backups', label: 'Verification failed', hint: 'The backup was written but failed its check' },

  { key: 'offsiteSyncFailed', group: 'Offsite', label: 'Offsite sync failed', hint: 'Replication to an offsite destination failed' },

  { key: 'restoreStarted', group: 'Restore', label: 'Restore started' },
  { key: 'restoreCompleted', group: 'Restore', label: 'Restore completed' },
  { key: 'restoreFailed', group: 'Restore', label: 'Restore failed' },
  { key: 'restoreStuck', group: 'Restore', label: 'Restore stuck', hint: 'No progress reported for an hour' },

  { key: 'agentDisconnected', group: 'Infrastructure', label: 'Backup host went offline' },
  { key: 'agentConnected', group: 'Infrastructure', label: 'Backup host came back online' },
  { key: 'agentDownExtended', group: 'Infrastructure', label: 'Backup host down 6h+' },
  { key: 'hypervisorConnectionFailed', group: 'Infrastructure', label: 'Hypervisor unreachable' },
  { key: 'sshConnectionFailed', group: 'Infrastructure', label: 'SSH connection failed' },
  { key: 'storagePoolIssue', group: 'Infrastructure', label: 'Storage pool problem' },
  { key: 'lowDiskSpace', group: 'Infrastructure', label: 'Low disk space' },
  { key: 'criticalError', group: 'Infrastructure', label: 'Critical component error' },
  { key: 'missedRunsRecovered', group: 'Infrastructure', label: 'Missed runs recovered', hint: 'After controller downtime' },

  { key: 'certificateExpiring', group: 'TLS certificates', label: 'Certificate expiring soon', hint: '30/14/7/3/1 days before expiry' },
  { key: 'certificateExpired', group: 'TLS certificates', label: 'Certificate expired', hint: 'Repeats daily until renewed' },
  { key: 'agentTlsDegraded', group: 'TLS certificates', label: 'Agent link degraded' },

  { key: 'groupedSummary', group: 'Summaries', label: 'Grouped failure summary', hint: 'One message per root cause instead of one per VM' },
  { key: 'dailyDigest', group: 'Summaries', label: 'Daily digest', hint: 'Once a day: everything still open, or an all-clear. Turning this off while repeat-suppression is on makes long-running failures silent.' },
]

export const NOTIFICATION_EVENTS: Array<{ key: keyof NotificationEventToggles; label: string; hint: string }> = [
  { key: 'backupSuccess', label: 'Backup succeeded', hint: 'Every successful backup' },
  { key: 'backupFailure', label: 'Backup failed', hint: 'The backup itself did not complete' },
  { key: 'offsiteSuccess', label: 'Offsite sync succeeded', hint: 'Replication finished on every target' },
  { key: 'offsitePartial', label: 'Offsite sync partial', hint: 'Some targets synced, others did not' },
  { key: 'offsiteFailure', label: 'Offsite sync failed', hint: 'No target received the backup' },
  { key: 'retry', label: 'Retry started', hint: 'A failed run is being retried' },
  { key: 'missed', label: 'Missed run recovered', hint: 'A skipped schedule was replayed' },
  {
    key: 'certificateExpiry',
    label: 'TLS certificate problem',
    hint: 'Certificate expiring or expired on this schedule’s backup host. Backups keep running regardless.',
  },
]

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
  // Offsite rsync retry (script-level, per offsite host): attempts before
  // giving up on a host for the run, and the base backoff (seconds) for the
  // exponential delay between attempts.
  offsiteRetryAttempts?: number
  offsiteRetryBackoffSeconds?: number
  // Controller-level offsite-only resync. null/undefined = inherit the backup
  // retry settings (retryCount / retryDelayMinutes).
  offsiteResyncAttempts?: number | null
  offsiteResyncDelayMinutes?: number | null
  // RocketChat usernames @-mentioned when this schedule's backups fail.
  // Empty = inherit the global list from Settings → Notifications.
  notifyMentions?: string[]
  // Per-event notification toggles. An absent key means "inherit the global
  // setting" — see controller notificationPolicyService.
  notifications?: NotificationEventToggles
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
  // Which stage failed. `failureReason` says WHY (interrupted, script_error);
  // this says WHERE — a backup that succeeded but failed to replicate is
  // 'offsite', not a failed backup.
  failureStage?: 'backup' | 'offsite' | null
  offsiteSyncStatus?: 'running' | 'retrying' | 'completed' | 'partial' | 'failed' | 'unknown' // Offsite replication outcome
  offsiteResults?: Array<{ ip: string; poolPath?: string; status: string; reason?: string }>
  // Offsite-only resync (retry of a failed/partial sync, no VM re-backup)
  offsiteRetryAttempt?: number
  offsiteRetryAt?: string | null       // When the queued resync will run (ISO)
  offsiteRetryNextAttempt?: number     // Which attempt the queued run will be
  offsiteRetryMaxAttempts?: number     // Budget it is counting against
  offsiteRetryInFlight?: boolean
  offsiteRetryProgress?: number
  offsiteRetryProgressText?: string
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
