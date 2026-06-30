# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-06-29

### Added

#### Reports & Analytics
- **Missed Backups (Schedule Adherence)**: New `GET /api/missed-backups` endpoint and Reports panel that detects expected scheduled runs which produced no successful backup (timeline gaps from power loss, network failure, or agent offline). Reuses the schedule occurrence generator to enumerate expected runs and compares against completed jobs. Window start is clamped to `schedule.createdAt`; a 2-hour grace prevents flagging just-due/in-progress runs. Each gap is annotated with a reason (`no_run`, `failed`, `skipped`). Tracks daily/weekly/monthly/interval/cron/custom-days; `once` is intentionally excluded.
- **Report View Modes**: Reports can be viewed as Card, Table, Chart, or Compact, with the preference persisted per user.
- **Per-VM Charts & Tables**: Each VM exposes its own charts (schedule size comparison, status distribution, full/inc chain composition per disk, virtual-vs-actual disk size, recent backup history timeline) and detailed tables (schedules, disks, recent runs).

#### Security
- **Idle Session Timeout**: User sessions use a sliding 30-minute window (`JWT_EXPIRES_IN` default changed `24h` → `30m`). The controller re-issues a fresh token via an `X-Refresh-Token` response header on requests made during real user activity; the frontend swaps it in. After 30 minutes of inactivity the token expires and the frontend auto-logs-out. A frontend activity tracker (`lib/activity.ts`) gates the refresh so background polling alone does not keep an unattended session alive. Agent↔controller and controller↔agent communication are unaffected.

#### UI & UX
- **Browser Favicon**: Added a backup-themed SVG favicon.
- **Bulk edit start time**: the bulk schedule editor can now change the start time (HH:MM) across selected schedules; it applies to time-based types (daily/weekly/monthly/once) and regenerates each cron expression. Bulk retention/keep-archive editing now applies to all chain types (daily/weekly/interval/cron), not just daily.
- **Schedule List Pagination**: Selectable page sizes (10/20/50/100), persisted per user, with first/last + ellipsis navigation.
- **Readable VM Names in Tables**: Long `<id>_<name>` VM names show the readable name prominently with the id muted, a Short/Full toggle (shared across Active Jobs, Schedules, History tabs), and hover tooltips — action buttons stay visible without horizontal scrolling.

### Changed
- **True concurrency queue**: when a host is at its concurrent-backup limit, additional scheduled backups now enter a real `queued` (waiting) state instead of being marked `skipped`. Waiting jobs do not occupy a slot and are promoted to `running` in place (same job id) as soon as a slot frees — driven both by job-completion events and the 2-minute reconciler. They appear in Active Jobs as queued and start automatically in FIFO order. Legacy `skipped (concurrent_limit)` records are still auto-released for backward compatibility. Slot decisions are serialized per host with an in-process lock, so a burst of schedules firing at the same instant (e.g. 20 at 02:00 with a limit of 10) reliably starts exactly the limit and queues the rest — no race that over-subscribes the host. Schedules are never double-run: a schedule that already produced a job for an occurrence is not re-fired.
- **Unlimited concurrency option**: `Max Concurrent Backups` can now be set to **0 = unlimited** (system default, per-host add/edit, and settings). When unlimited, every scheduled backup starts at its scheduled time with no concurrency gate, on both the controller and the agent. Values 1–200 still cap concurrency as before. The UI shows "Unlimited" and warns that it may heavily load the backup host.
- **Weekly schedules now use full/inc chains like daily**: replaced the "full backup day" picker with an `incrementalCount` field. Method selection is driven by `backupCycleService`, and after `incrementalCount` incrementals the chain is archived and a new full begins.
- **One chain-based schedule per VM**: daily/weekly/interval/cron/custom-days are mutually exclusive per VM (copy-based once/monthly can coexist). Enforced controller-side on create/update in addition to the existing agent-side file check.
- **Controller JSON storage hardened**: removed `proper-lockfile` cross-process locking (the controller is a single fork-mode process) in favor of an in-process serialization queue plus atomic temp-file + rename writes with `.bak` recovery.

### Fixed
- **Schedule retention/keep-archive were never persisted**: the create and update routes silently dropped `retention` and `keepArchive`, so chain backups always used the 7/2 defaults regardless of what was configured in the form or bulk editor. Both are now stored on create and updated on edit, and take effect at backup time.
- **Concurrency starvation / mass missed backups**: Jobs stuck in `running`/`queued` (lost completion callback, controller restart, agent blip) previously occupied concurrency slots forever, so over time only a few VMs backed up each night and the rest silently missed their schedule. Now: (a) stale running/queued jobs no longer count toward the per-host concurrent limit, (b) a periodic reconciler (every 2 min) reconciles unfinished jobs against the agent's real state, fails genuinely-stuck jobs to release leaked slots, and drains the concurrent-limit queue — guaranteeing scheduled backups make progress regardless of lost events. Legitimately long-running large-VM backups confirmed alive by the agent are protected from being killed.
- **Missed cron fires now caught up automatically**: An active catch-up tick (every 2 min) fires any recurring schedule whose most recent expected run (within the last 2 hours) produced no job record — covering node-cron ticks missed because the controller was briefly down or busy at the scheduled time. It guards on existing job records so it never double-fires a run that already happened, and complements the startup missed-run replay for longer outages.
- **"Lock file is already being held" phantom backup failures**: Bursts of simultaneously-scheduled backups no longer exhaust file-lock retries on the controller's `backupJobs.json`, which previously failed jobs before the agent was ever contacted (no tmux session / no VM lock created).
- **Octal parse errors in the agent backup script**: count values like `08`/`09` from `grep -c`/`wc -l` are now coerced to decimal via `awk`, fixing `syntax error in expression` failures at backup start.
- **Self-healing scheduler validation**: the agent script validates and repairs its `scheduler` tracking file against actual backup state, runs once per execution, and no longer overrides the global exit trap.
- **Duplicate scheduler entries on retry**: a failed-then-retried backup no longer appends a second entry for the same day.
- **Archived-backup restore lock/log paths**: lock files and logs for archived backups are now computed at the correct storage-pool base (`in_progress_backups` / `.logs`), so rollback on cancel removes the lock and logs remain available after completion/cancellation.
- **Archived restore directory naming**: restore directories use a concise `vmname_archived_{schedule}_{archiveDate}_{restoreTimestamp}` format instead of a long, duplicated name.
- **Schedule list page-size dropdown**: no longer disappears when the chosen page size exceeds the number of available items.

## [1.1.0] - 2026-05-20

### Added

#### Reliability & Recovery
- **Missed Schedule Recovery** (Item 1): Controller heartbeat service writes every 15s. On restart, missed scheduled backups are automatically replayed based on per-schedule policy (`immediate`, `most-recent`, or `skip`) with configurable grace period.
- **Active Job Recovery** (Item 2): New agent endpoint `GET /api/jobs/:id/live-status` inspects tmux sessions, processes, lock files, and progress files. Controller syncs job states when agents reconnect.
- **Exit Code Handling** (Item 3): Backup scripts now write exit codes to files. Killed tmux sessions correctly report as failed (not success). `killJob()` writes cancel code to prevent race conditions.
- **Cleanup Service** (Item 3): Runs on agent startup, every 10 minutes, and lazily before new jobs. Removes stale locks, orphaned tmux sessions, and leftover progress files.
- **Health-Check Debounce** (Item 4): Requires 2 consecutive failures before marking hosts/hypervisors/offsite as offline. Prevents false-offline from transient network issues.
- **Fresh-on-Open** (Item 4): Frontend triggers a health check when the panel is opened, ensuring users see current status immediately.
- **Once Schedule Auto-Disable** (Item 5): One-time schedules automatically disable after first execution.

#### Reports & Analytics
- **Report Enrichment Service** (Item 7): Enriches raw agent reports with per-VM rollups (success rates, avg duration, last success/failure, creation dates, chain depths).
- **Global Rollup** (Item 7): Cross-host statistics (total VMs, success rates, failed/skipped counts for 7/30 days).
- **Daily Trending Snapshots** (Item 7): One snapshot per day stored for 90 days, enabling historical charts.
- **Download Endpoints** (Item 7): `GET /api/reports/download/:format` supports JSON, CSV, and PDF-data at global, per-host, per-VM, and per-hypervisor scopes.

#### Security & Access Control
- **RBAC System** (Item 9): Three roles — `admin` (full access), `user` (read all, write on granted hosts), `viewer` (read-only).
- **Per-Host Access Grants** (Item 9): Admins grant users access to specific backup hosts. Users can only trigger actions on granted hosts.
- **User Management API** (Item 9): Full CRUD for users with role assignment, access grants, and disable/enable.
- **Audit Trail** (Item 9): JSON-line audit logs recording all significant actions (backup trigger, schedule CRUD, user management, login/logout). Rotated at 5MB, pruned at 90 days.
- **RBAC Middleware** (Item 8): `requireAdmin`, `requireUser`, `requireHostAccess` applied to all write routes.
- **Disabled User Rejection** (Item 8): Disabled accounts rejected at login and in JWT verification.
- **Login Auditing** (Item 8): Successful and failed login attempts recorded with IP.

#### UI & UX
- **Glass Morphism Design** (Item 10): Backdrop-blur cards, gradient borders, hover-shine effects, modern scrollbars.
- **Command Palette** (Item 10): Cmd/Ctrl+K for instant navigation across all pages with fuzzy search.
- **Notification Center** (Item 10): Bell icon with real-time WebSocket notifications, unread badge, mark-all-read.
- **Restructured Navigation** (Item 10): Sidebar grouped into Overview / Infrastructure / Jobs / Operations / Settings.
- **Settings Hub** (Item 10): General config, Users & Access, Audit Log, Notifications (RocketChat + SMS).
- **Phase-Aware Job Visualization** (Item 6): `JobStatusBadge` shows backup/rsync/restore/interrupted states. `JobProgressBar` with phase-colored gradients and shimmer animation.
- **Replay Indicator** (Item 6): Jobs replayed from missed schedules show a "Replay" badge.

### Changed
- `BackupJob` type extended with `phase`, `failureReason`, `replay`, `actor`, `triggeredBy`, `lastSyncedAt`, `syncSource`, `originallyScheduledAt`, `replayReason` fields.
- `BackupSchedule` type extended with `missedRunPolicy`, `missedRunGracePeriodMinutes`, `lastFiredAt` fields.
- Schedule form now includes "Missed Run Handling" section.
- JWT token now includes `accessGrants` for frontend RBAC.
- Login response includes `accessGrants` and `role`.
- Health check service uses debounce counters instead of immediate offline marking.
- Scheduler's `checkHostsHealth` uses debounce.
- `fileStorage.js` now exports `getRestoreJobs` and `saveRestoreJobs`.

### Fixed
- **False-offline bug**: Hosts no longer marked offline from a single failed health check.
- **Killed job = success bug**: Externally killed tmux sessions now correctly report as failed with `failureReason: 'interrupted'`.
- **Missing `getRestoreJobs`**: Pre-existing bug where `startupRecoveryService` imported a non-existent function from `fileStorage`.
- **Once schedules firing daily**: Now auto-disabled after first execution.

### New Files (Controller Backend)
- `services/heartbeatService.js` — Controller heartbeat persistence
- `services/missedRunService.js` — Missed schedule replay engine
- `services/agentSyncService.js` — Job state reconciliation with agents
- `services/reportEnrichmentService.js` — Report rollups and trending
- `services/auditService.js` — Audit trail logging and querying
- `middleware/rbac.js` — Role-based access control middleware
- `routes/users.js` — User management CRUD
- `routes/audit.js` — Audit log query API
- `routes/reportDownload.js` — Report download endpoints

### New Files (Agent Backend)
- `services/liveStatusService.js` — Job live-status inspection
- `services/cleanupService.js` — Stale artifact cleanup
- `routes/liveStatus.js` — Live-status API endpoints

### New Files (Frontend)
- `components/layout/CommandPalette.tsx` — Cmd+K command palette
- `components/layout/NotificationCenter.tsx` — Real-time notification dropdown
- `components/backups/JobStatusBadge.tsx` — Phase-aware status badge
- `components/backups/JobProgressBar.tsx` — Animated progress bar
- `hooks/useHealthCheck.ts` — Health check trigger on mount
- `pages/SettingsPage.tsx` — Settings hub with tabs

### Dependencies Added (Frontend)
- `framer-motion` ^10.16.16
- `cmdk` ^0.2.0
- `jspdf` ^2.5.1
- `jspdf-autotable` ^3.8.1
- `papaparse` ^5.4.1

## [1.0.0] - 2024-01-01

### Added
- Initial release
- Backup and restore management for KVM/QEMU VMs
- Web-based dashboard with React frontend
- Multi-agent architecture (controller + agents)
- Incremental backups via virtnbdbackup
- Offsite backup replication via rsync
- Schedule management (daily, weekly, monthly, custom, interval, cron, once)
- Real-time progress monitoring via WebSocket
- RocketChat notifications
- Storage pool management
- Health monitoring
