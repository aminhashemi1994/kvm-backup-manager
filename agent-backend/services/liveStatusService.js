const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

/**
 * LiveStatusService
 *
 * Computes the *real* state of a backup or restore job by inspecting the
 * primary sources of truth on the agent:
 *   1. The job-state file (what the agent thinks it knows)
 *   2. tmux session existence (sanitized name match)
 *   3. virtnbdbackup / virtnbdrestore / rsync / Backup_Manager.sh process state
 *   4. Lock file existence under <pool>/in_progress_backups/
 *   5. Progress file contents under <pool>/.progress/
 *
 * Returns a single object the controller can rely on to reconcile its view.
 */
class LiveStatusService {
  constructor() {
    this.config = null;
    this.backupExecutor = null;
    this.restoreExecutor = null;
  }

  initialize({ config, backupExecutor, restoreExecutor }) {
    this.config = config;
    this.backupExecutor = backupExecutor;
    this.restoreExecutor = restoreExecutor;
  }

  /**
   * Top-level lookup: caller doesn't need to know if jobId is a backup or
   * restore — we try both.
   */
  async getJobLiveStatus(jobId) {
    if (!jobId) {
      return this._unknown(jobId, 'no jobId provided');
    }

    // Try backup first (most common case)
    const backupState = this.backupExecutor?.loadJobState?.(jobId);
    if (backupState) {
      return await this._inspectBackup(jobId, backupState);
    }

    // Then try restore
    if (this.restoreExecutor && typeof this.restoreExecutor.getJob === 'function') {
      try {
        const restoreJob = await this.restoreExecutor.getJob(jobId);
        if (restoreJob) {
          return await this._inspectRestore(jobId, restoreJob);
        }
      } catch (e) {
        // not a restore either
      }
    }

    return this._unknown(jobId, 'job not found in agent state');
  }

  // -------------------------------------------------------------------
  // Backup inspection
  // -------------------------------------------------------------------
  async _inspectBackup(jobId, jobState) {
    const out = {
      jobId,
      kind: 'backup',
      vmName: jobState.vmName || null,
      hypervisorIp: jobState.hypervisorIp || null,
      scheduleType: jobState.scheduleType || null,
      // Authoritative fields
      phase: 'unknown',         // 'queued' | 'starting' | 'backup' | 'rsync' | 'completed' | 'failed' | 'orphaned' | 'unknown'
      status: 'unknown',        // 'running' | 'completed' | 'failed' | 'unknown'
      progress: typeof jobState.progress === 'number' ? jobState.progress : null,
      progressText: jobState.progressText || null,
      // Evidence
      evidence: {
        jobStateFound: true,
        tmuxSessionName: jobState.tmuxSession || null,
        tmuxAlive: false,
        lockFileExists: false,
        lockFilePath: null,
        progressFileExists: false,
        progressFilePath: null,
        progressFileSnapshot: null,
        backupProcessAlive: false,
        rsyncProcessAlive: false,
        backupManagerProcessAlive: false,
      },
      lastUpdate: jobState.lastUpdate || null,
      checkedAt: new Date().toISOString(),
    };

    // Tmux check
    if (jobState.tmuxSession) {
      out.evidence.tmuxAlive = await this._tmuxHasSession(jobState.tmuxSession);
    } else if (jobState.vmName && jobState.scheduleType) {
      // Fall back to pattern search
      const found = await this._findTmuxByVm(jobState.vmName, jobState.scheduleType);
      if (found) {
        out.evidence.tmuxSessionName = found;
        out.evidence.tmuxAlive = true;
      }
    }

    // Lock file
    if (jobState.storagePoolPath && jobState.vmName && jobState.scheduleType) {
      const lockPath = path.join(
        jobState.storagePoolPath,
        'in_progress_backups',
        `${jobState.vmName}_${jobState.scheduleType}_backup`
      );
      out.evidence.lockFilePath = lockPath;
      out.evidence.lockFileExists = await this._fileExists(lockPath);
    }

    // Progress file
    if (jobState.storagePoolPath && jobState.vmName && jobState.scheduleType) {
      const progressPath = path.join(
        jobState.storagePoolPath,
        '.progress',
        `${jobState.vmName}_${jobState.scheduleType}.progress`
      );
      out.evidence.progressFilePath = progressPath;
      const exists = await this._fileExists(progressPath);
      out.evidence.progressFileExists = exists;
      if (exists) {
        out.evidence.progressFileSnapshot = await this._readJsonSafe(progressPath);
      }
    }

    // Process checks
    out.evidence.backupProcessAlive = await this._processAlive(
      `virtnbdbackup.*${this._escape(jobState.vmName || '')}`
    );
    out.evidence.rsyncProcessAlive = await this._processAlive(
      `rsync.*${this._escape(jobState.vmName || '')}`
    );
    out.evidence.backupManagerProcessAlive = await this._processAlive(
      `Backup_Manager.sh.*--domain ${this._escape(jobState.vmName || '')}`
    );

    // Decide phase + status
    this._decideBackupPhase(out);
    return out;
  }

  _decideBackupPhase(out) {
    const e = out.evidence;
    const anyAlive = e.tmuxAlive || e.backupProcessAlive || e.rsyncProcessAlive || e.backupManagerProcessAlive;

    if (e.rsyncProcessAlive) {
      out.phase = 'rsync';
      out.status = 'running';
      return;
    }
    if (e.backupProcessAlive) {
      out.phase = 'backup';
      out.status = 'running';
      return;
    }
    if (e.backupManagerProcessAlive || e.tmuxAlive) {
      // Manager process is alive but neither virtnbdbackup nor rsync are —
      // probably setup/finalize. Still running.
      out.phase = 'backup';
      out.status = 'running';
      return;
    }

    // No alive process. Look at the artifacts.
    if (e.lockFileExists && !anyAlive) {
      // Lock left behind without any worker — orphaned/stale.
      out.phase = 'orphaned';
      out.status = 'failed';
      return;
    }
    if (e.progressFileExists && e.progressFileSnapshot && e.progressFileSnapshot.percent === 100) {
      out.phase = 'completed';
      out.status = 'completed';
      out.progress = 100;
      return;
    }
    if (!e.progressFileExists && !e.lockFileExists) {
      // Job state still on disk but no artifacts and no processes — done or
      // never started. Caller should reconcile against the job log.
      out.phase = 'unknown';
      out.status = 'unknown';
      return;
    }

    out.phase = 'unknown';
    out.status = 'unknown';
  }

  // -------------------------------------------------------------------
  // Restore inspection
  // -------------------------------------------------------------------
  async _inspectRestore(jobId, restoreJob) {
    const out = {
      jobId,
      kind: 'restore',
      vmName: restoreJob.vmName || null,
      method: restoreJob.method || null,
      // Authoritative fields
      phase: 'unknown',
      status: 'unknown',
      progress: typeof restoreJob.progress === 'number' ? restoreJob.progress : null,
      progressText: restoreJob.progressText || null,
      evidence: {
        jobStateFound: true,
        tmuxSessionName: restoreJob.tmuxSession || null,
        tmuxAlive: false,
        progressFileExists: false,
        progressFilePath: restoreJob.progressFile || null,
        progressFileSnapshot: null,
        restoreProcessAlive: false,
        restoreManagerProcessAlive: false,
      },
      lastUpdate: restoreJob.lastUpdate || restoreJob.updatedAt || null,
      checkedAt: new Date().toISOString(),
    };

    if (restoreJob.tmuxSession) {
      out.evidence.tmuxAlive = await this._tmuxHasSession(restoreJob.tmuxSession);
    }

    if (restoreJob.progressFile) {
      const exists = await this._fileExists(restoreJob.progressFile);
      out.evidence.progressFileExists = exists;
      if (exists) {
        // Restore progress file is plain text, not JSON; capture last 1KB
        out.evidence.progressFileSnapshot = await this._readTailSafe(restoreJob.progressFile, 1024);
      }
    }

    out.evidence.restoreProcessAlive = await this._processAlive(
      `virtnbdrestore.*${this._escape(restoreJob.vmName || '')}`
    );
    out.evidence.restoreManagerProcessAlive = await this._processAlive(
      `Restore_Manager.sh.*--domain ${this._escape(restoreJob.vmName || '')}`
    );

    const e = out.evidence;
    if (e.restoreProcessAlive || e.restoreManagerProcessAlive || e.tmuxAlive) {
      out.phase = 'restore';
      out.status = 'running';
    } else if (e.progressFileExists) {
      out.phase = 'unknown';
      out.status = 'unknown';
    } else {
      // No progress file, no process — finished. Caller decides
      // success/failure from log + restoreExecutor history.
      out.phase = 'unknown';
      out.status = 'unknown';
    }
    return out;
  }

  // -------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------
  _unknown(jobId, reason) {
    return {
      jobId,
      kind: 'unknown',
      phase: 'unknown',
      status: 'unknown',
      reason,
      evidence: { jobStateFound: false },
      checkedAt: new Date().toISOString(),
    };
  }

  async _tmuxHasSession(name) {
    try {
      await execAsync(`tmux has-session -t ${this._shellEscape(name)} 2>/dev/null`);
      return true;
    } catch {
      return false;
    }
  }

  async _findTmuxByVm(vmName, scheduleType) {
    try {
      const { stdout } = await execAsync(
        `tmux list-sessions -F "#{session_name}" 2>/dev/null || true`
      );
      if (!stdout.trim()) return null;
      const sanitized = vmName.replace(/[^a-zA-Z0-9-]/g, '_');
      const prefix = `${sanitized}_${scheduleType}_`;
      const sessions = stdout.trim().split('\n');
      return sessions.find(s => s.startsWith(prefix)) || null;
    } catch {
      return null;
    }
  }

  async _processAlive(pattern) {
    if (!pattern) return false;
    try {
      // pgrep -f returns 0 if found, 1 if not. We use stdout to confirm.
      const { stdout } = await execAsync(
        `pgrep -af ${this._shellEscape(pattern)} 2>/dev/null || true`
      );
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  async _fileExists(p) {
    if (!p) return false;
    try {
      await fs.promises.access(p, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async _readJsonSafe(p) {
    try {
      const data = await fs.promises.readFile(p, 'utf8');
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  async _readTailSafe(p, bytes) {
    try {
      const stat = await fs.promises.stat(p);
      const start = Math.max(0, stat.size - bytes);
      const fd = await fs.promises.open(p, 'r');
      try {
        const buf = Buffer.alloc(stat.size - start);
        await fd.read(buf, 0, buf.length, start);
        return buf.toString('utf8');
      } finally {
        await fd.close();
      }
    } catch {
      return null;
    }
  }

  _escape(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  _shellEscape(s) {
    return `"${String(s).replace(/(["$`\\])/g, '\\$1')}"`;
  }
}

const liveStatusService = new LiveStatusService();
module.exports = liveStatusService;
