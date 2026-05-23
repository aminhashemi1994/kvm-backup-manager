const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

/**
 * CleanupService (Item 3)
 *
 * Ensures stale lock files, orphaned tmux sessions, and leftover progress
 * files don't block future operations. Runs in three modes:
 *   (a) On every agent startup
 *   (b) On a periodic timer (every 10 minutes)
 *   (d) Lazily — called before starting a new job if a stale lock blocks it
 *
 * "Stale" = lock file older than STALE_THRESHOLD_MINUTES with no matching
 * tmux session or process alive.
 */
class CleanupService {
  constructor() {
    this.config = null;
    this.backupExecutor = null;
    this.timer = null;
    this.STALE_THRESHOLD_MINUTES = 60; // 1 hour
    this.PERIODIC_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
  }

  initialize({ config, backupExecutor }) {
    this.config = config;
    this.backupExecutor = backupExecutor;
    
    // (a) Run on startup
    this.runCleanup('startup').catch(err => {
      console.error('[Cleanup] Startup cleanup failed:', err.message);
    });
    
    // (b) Periodic timer
    this.timer = setInterval(() => {
      this.runCleanup('periodic').catch(err => {
        console.error('[Cleanup] Periodic cleanup failed:', err.message);
      });
    }, this.PERIODIC_INTERVAL_MS);
    this.timer.unref?.();
    
    console.log(`✓ Cleanup service initialized (stale threshold: ${this.STALE_THRESHOLD_MINUTES}min, periodic: ${this.PERIODIC_INTERVAL_MS / 60000}min)`);
  }

  /**
   * (d) Lazy cleanup — called before a new job starts if a lock blocks it.
   * Only cleans the specific VM/schedule combination.
   */
  async cleanupForVm(vmName, scheduleType, storagePoolPath) {
    if (!storagePoolPath || !vmName || !scheduleType) return { cleaned: false };
    
    const lockDir = path.join(storagePoolPath, 'in_progress_backups');
    const lockFile = path.join(lockDir, `${vmName}_${scheduleType}_backup`);
    const progressFile = path.join(storagePoolPath, '.progress', `${vmName}_${scheduleType}.progress`);
    
    if (!fs.existsSync(lockFile)) return { cleaned: false, reason: 'no_lock' };
    
    // Check if there's actually a process running for this VM
    const hasProcess = await this._hasActiveProcess(vmName);
    if (hasProcess) return { cleaned: false, reason: 'process_alive' };
    
    // Check if there's a tmux session
    const hasTmux = await this._hasTmuxForVm(vmName, scheduleType);
    if (hasTmux) return { cleaned: false, reason: 'tmux_alive' };
    
    // Safe to clean
    const cleaned = [];
    try {
      fs.unlinkSync(lockFile);
      cleaned.push(lockFile);
      console.log(`[Cleanup:lazy] Removed stale lock: ${lockFile}`);
    } catch (e) {
      if (e.code !== 'ENOENT') console.error(`[Cleanup:lazy] Failed to remove lock: ${e.message}`);
    }
    
    if (fs.existsSync(progressFile)) {
      try {
        fs.unlinkSync(progressFile);
        cleaned.push(progressFile);
        console.log(`[Cleanup:lazy] Removed orphaned progress: ${progressFile}`);
      } catch (e) {
        if (e.code !== 'ENOENT') console.error(`[Cleanup:lazy] Failed to remove progress: ${e.message}`);
      }
    }
    
    return { cleaned: true, files: cleaned };
  }

  /**
   * Full cleanup pass across all storage pools.
   */
  async runCleanup(trigger = 'manual') {
    console.log(`[Cleanup:${trigger}] Starting cleanup pass...`);
    let totalCleaned = 0;
    
    // Get storage pools from config or scan known paths
    const pools = await this._getStoragePools();
    
    for (const poolPath of pools) {
      const lockDir = path.join(poolPath, 'in_progress_backups');
      if (!fs.existsSync(lockDir)) continue;
      
      let files;
      try {
        files = fs.readdirSync(lockDir);
      } catch (e) {
        continue;
      }
      
      for (const file of files) {
        const lockPath = path.join(lockDir, file);
        try {
          const stat = fs.statSync(lockPath);
          const ageMinutes = (Date.now() - stat.mtimeMs) / 60000;
          
          if (ageMinutes < this.STALE_THRESHOLD_MINUTES) continue;
          
          // Parse VM name and schedule from filename: <vmName>_<schedule>_backup
          const match = file.match(/^(.+)_(daily|weekly|monthly|once|custom|interval|cron|full|inc|copy)_backup$/);
          if (!match) continue;
          
          const vmName = match[1];
          const scheduleType = match[2];
          
          // Verify no active process
          const hasProcess = await this._hasActiveProcess(vmName);
          if (hasProcess) continue;
          
          const hasTmux = await this._hasTmuxForVm(vmName, scheduleType);
          if (hasTmux) continue;
          
          // Stale — remove
          fs.unlinkSync(lockPath);
          totalCleaned++;
          console.log(`[Cleanup:${trigger}] Removed stale lock (${Math.round(ageMinutes)}min old): ${lockPath}`);
          
          // Also clean matching progress file
          const progressFile = path.join(poolPath, '.progress', `${vmName}_${scheduleType}.progress`);
          if (fs.existsSync(progressFile)) {
            fs.unlinkSync(progressFile);
            totalCleaned++;
            console.log(`[Cleanup:${trigger}] Removed orphaned progress: ${progressFile}`);
          }
        } catch (e) {
          if (e.code !== 'ENOENT') {
            console.error(`[Cleanup:${trigger}] Error processing ${lockPath}: ${e.message}`);
          }
        }
      }
    }
    
    // Clean orphaned tmux sessions (sessions with no matching job state)
    const orphanedSessions = await this._findOrphanedTmuxSessions();
    for (const session of orphanedSessions) {
      try {
        await execAsync(`tmux kill-session -t "${session}" 2>/dev/null || true`);
        totalCleaned++;
        console.log(`[Cleanup:${trigger}] Killed orphaned tmux session: ${session}`);
      } catch (e) {
        // ignore
      }
    }
    
    // Clean stale exit-code files (older than 1 hour)
    if (this.config && this.config.logDir) {
      try {
        const logFiles = fs.readdirSync(this.config.logDir);
        for (const f of logFiles) {
          if (!f.endsWith('.exitcode')) continue;
          const fp = path.join(this.config.logDir, f);
          try {
            const stat = fs.statSync(fp);
            if ((Date.now() - stat.mtimeMs) > 3600000) {
              fs.unlinkSync(fp);
              totalCleaned++;
            }
          } catch (e) {}
        }
      } catch (e) {}
    }
    
    if (totalCleaned > 0) {
      console.log(`[Cleanup:${trigger}] Cleaned ${totalCleaned} stale artifact(s)`);
    } else {
      console.log(`[Cleanup:${trigger}] No stale artifacts found`);
    }
    
    return { cleaned: totalCleaned, trigger };
  }

  async _getStoragePools() {
    // Try to read from storage-pool-sync service or fall back to config
    const pools = [];
    
    // Primary: check if storagePoolSyncService has pools
    try {
      const syncService = require('./storagePoolSyncService');
      if (syncService.storagePools && syncService.storagePools.length > 0) {
        for (const pool of syncService.storagePools) {
          if (pool.path) pools.push(pool.path);
        }
      }
    } catch (e) {}
    
    // Fallback: use config backup path
    if (pools.length === 0 && this.config && this.config.backupPath) {
      pools.push(this.config.backupPath);
    }
    
    return pools;
  }

  async _hasActiveProcess(vmName) {
    try {
      const { stdout } = await execAsync(
        `pgrep -af "Backup_Manager.sh.*--domain ${vmName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" 2>/dev/null || true`
      );
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  async _hasTmuxForVm(vmName, scheduleType) {
    try {
      const sanitized = vmName.replace(/[^a-zA-Z0-9-]/g, '_');
      const { stdout } = await execAsync(
        `tmux list-sessions -F "#{session_name}" 2>/dev/null || true`
      );
      if (!stdout.trim()) return false;
      const prefix = `${sanitized}_${scheduleType}_`;
      return stdout.trim().split('\n').some(s => s.startsWith(prefix));
    } catch {
      return false;
    }
  }

  async _findOrphanedTmuxSessions() {
    try {
      const { stdout } = await execAsync(
        `tmux list-sessions -F "#{session_name}" 2>/dev/null || true`
      );
      if (!stdout.trim()) return [];
      
      const sessions = stdout.trim().split('\n');
      const orphaned = [];
      
      // Get all known job IDs from the executor
      const knownJobIds = new Set();
      if (this.backupExecutor) {
        for (const [jobId] of this.backupExecutor.activeJobs) {
          knownJobIds.add(jobId.substring(0, 8));
        }
      }
      
      for (const session of sessions) {
        // Our sessions end with _<8-char-jobId>
        const parts = session.split('_');
        if (parts.length < 3) continue;
        const shortId = parts[parts.length - 1];
        if (shortId.length === 8 && !knownJobIds.has(shortId)) {
          // Check if it's one of our backup/restore sessions
          if (session.includes('_daily_') || session.includes('_weekly_') ||
              session.includes('_monthly_') || session.includes('_once_') ||
              session.includes('_custom_') || session.includes('_interval_') ||
              session.includes('_cron_') || session.includes('_full_') ||
              session.includes('_inc_') || session.includes('_copy_') ||
              session.startsWith('restore_')) {
            orphaned.push(session);
          }
        }
      }
      
      return orphaned;
    } catch {
      return [];
    }
  }

  shutdown() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

const cleanupService = new CleanupService();
module.exports = cleanupService;
