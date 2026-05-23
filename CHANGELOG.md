# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
