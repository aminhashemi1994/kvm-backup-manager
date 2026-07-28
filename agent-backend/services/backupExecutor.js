const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const controllerAuthService = require('./controllerAuthService');
const concurrencyConfigSyncService = require('./concurrencyConfigSyncService');
const { sanitizeLog, stripAnsi } = require('../utils/logSanitizer');

class BackupExecutor {
  constructor() {
    this.io = null;
    this.config = null;
    this.activeJobs = new Map();
    this.activeProcesses = new Map(); // Store child processes
    this.vmLocks = new Map(); // Track which VMs are currently being backed up
    this.jobQueue = [];
    // The concurrency limit comes from the controller (synced by
    // concurrencyConfigSyncService). The local field is no longer the
    // source of truth — getMaxConcurrent() always defers to the sync
    // service so a panel-side change takes effect on the next 60-second
    // refresh, no agent restart needed.
    this.jobStateDir = null;
    this.recoveryCheckInterval = null;
    this._concurrencyUnsubscribe = null;

    // Start mutex: serializes the STARTUP of backups (the fork/exec-heavy tmux
    // setup + process spawn) even when concurrency is unlimited and N schedules
    // fire in the same instant. Backups still run fully in parallel once
    // started — only their launch is staggered, which removes the thundering
    // herd (fork/exec spikes, tmux-server contention) and closes the same-VM
    // start race window. It self-paces: the next start begins a small gap after
    // the previous one's setup finishes, so 2 backups cost ~1-2s, not 5s each.
    this._startMutex = Promise.resolve();
    // Gap between consecutive startups. Overridable via env; capped so a
    // misconfiguration can't stall a large burst for minutes.
    const rawGap = parseInt(process.env.BACKUP_START_GAP_MS || '', 10);
    this._startGapMs = Number.isFinite(rawGap)
      ? Math.min(Math.max(rawGap, 0), 5000)
      : 1000;
  }

  /**
   * Serialize the startup of backups through a single shared chain. `fn` runs
   * the fork/exec-heavy setup; the caller receives its result as soon as `fn`
   * resolves, while the chain is held for an extra `_startGapMs` before the
   * next queued startup begins. A failing `fn` never breaks the chain.
   */
  _serializeStart(fn) {
    const prev = this._startMutex;
    let resolveResult, rejectResult;
    const resultP = new Promise((res, rej) => { resolveResult = res; rejectResult = rej; });
    this._startMutex = prev.then(async () => {
      try {
        resolveResult(await fn());
      } catch (e) {
        rejectResult(e);
      }
      // Enforce the gap AFTER this startup, before the next one begins —
      // regardless of success/failure — so spawns never stack up.
      if (this._startGapMs > 0) {
        await new Promise(res => setTimeout(res, this._startGapMs));
      }
    });
    return resultP;
  }

  /**
   * Resolve the current concurrency limit. Reads from the sync service
   * which itself caches the controller-supplied value.
   */
  getMaxConcurrent() {
    const v = concurrencyConfigSyncService.getMaxConcurrent();
    // 0 = unlimited (no concurrency cap). Pass it through so processQueue
    // can start every queued job immediately. Any other finite, non-negative
    // value is used as-is; fall back to 15 only when the value is invalid.
    if (Number.isFinite(v) && v >= 0) return v;
    return 15;
  }

  /** True when concurrency is unlimited (limit configured as 0). */
  isUnlimitedConcurrency() {
    return this.getMaxConcurrent() === 0;
  }

  /**
   * Initialize backup executor
   */
  initialize(io, config) {
    this.io = io;
    this.config = config;
    this.jobStateDir = path.join(this.config.logDir, 'job-state');

    // When the controller bumps maxConcurrentBackups, drain any queued
    // jobs that can now run. Going down doesn't interrupt active jobs;
    // they finish naturally, then processQueue won't dequeue more until
    // active count drops below the new limit.
    this._concurrencyUnsubscribe = concurrencyConfigSyncService.onChange((prev, next) => {
      if (next > prev) {
        console.log(`[BackupExecutor] Concurrency raised ${prev} → ${next}; processing queue`);
        this.processQueue();
      } else {
        console.log(`[BackupExecutor] Concurrency lowered ${prev} → ${next}; in-flight jobs will finish first`);
      }
    });

    // Ensure job state directory exists
    if (!fs.existsSync(this.jobStateDir)) {
      fs.mkdirSync(this.jobStateDir, { recursive: true });
      console.log(`Created job state directory: ${this.jobStateDir}`);
    }
    
    console.log('✓ Backup executor initialized');
    console.log(`  Job state directory: ${this.jobStateDir}`);
    
    // Recover any running jobs from previous session
    this.recoverRunningJobs();
    
    // Start periodic recovery check (every 10 seconds)
    this.recoveryCheckInterval = setInterval(() => {
      this.checkAndRecoverJobs();
    }, 10000);
  }

  /**
   * Save job state to disk
   */
  saveJobState(jobId, jobData) {
    const statePath = path.join(this.jobStateDir, `${jobId}.json`);
    try {
      fs.writeFileSync(statePath, JSON.stringify({
        ...jobData,
        lastUpdate: new Date().toISOString()
      }, null, 2));
    } catch (error) {
      console.error(`Failed to save job state for ${jobId}:`, error.message);
    }
  }

  /**
   * Load job state from disk
   */
  loadJobState(jobId) {
    const statePath = path.join(this.jobStateDir, `${jobId}.json`);
    try {
      if (fs.existsSync(statePath)) {
        const data = fs.readFileSync(statePath, 'utf8');
        return JSON.parse(data);
      }
    } catch (error) {
      console.error(`Failed to load job state for ${jobId}:`, error.message);
    }
    return null;
  }

  /**
   * Delete job state from disk
   */
  deleteJobState(jobId) {
    const statePath = path.join(this.jobStateDir, `${jobId}.json`);
    try {
      if (fs.existsSync(statePath)) {
        fs.unlinkSync(statePath);
      }
    } catch (error) {
      console.error(`Failed to delete job state for ${jobId}:`, error.message);
    }
  }

  /**
   * Get all saved job states
   */
  getAllJobStates() {
    try {
      // Ensure directory exists
      if (!fs.existsSync(this.jobStateDir)) {
        fs.mkdirSync(this.jobStateDir, { recursive: true });
        return [];
      }
      
      const files = fs.readdirSync(this.jobStateDir);
      return files
        .filter(f => f.endsWith('.json'))
        .map(f => {
          const jobId = f.replace('.json', '');
          return this.loadJobState(jobId);
        })
        .filter(state => state !== null);
    } catch (error) {
      console.error('Failed to read job states:', error.message);
      return [];
    }
  }

  /**
   * Find running backup tmux session by name
   */
  async findRunningTmuxSession(tmuxSessionName) {
    try {
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      
      // Check if tmux session exists
      try {
        await execAsync(`tmux has-session -t ${tmuxSessionName} 2>/dev/null`);
        return tmuxSessionName;
      } catch (error) {
        return null;
      }
    } catch (error) {
      console.error(`Error finding tmux session ${tmuxSessionName}:`, error.message);
      return null;
    }
  }

  /**
   * Find any tmux session for a VM (when we don't have the exact session name)
   */
  async findTmuxSessionForVM(vmName, scheduleType) {
    try {
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      
      // List all tmux sessions
      const { stdout } = await execAsync(`tmux list-sessions -F "#{session_name}" 2>/dev/null || true`);
      
      if (!stdout.trim()) {
        return null;
      }
      
      // Sanitize VM name the same way we do when creating sessions
      const sanitizedVmName = vmName.replace(/[^a-zA-Z0-9-]/g, '_');
      
      // Look for sessions matching our pattern: sanitizedVmName_scheduleType_*
      const sessions = stdout.trim().split('\n');
      for (const session of sessions) {
        if (session.startsWith(`${sanitizedVmName}_${scheduleType}_`)) {
          console.log(`Found matching tmux session: ${session}`);
          return session;
        }
      }
      
      return null;
    } catch (error) {
      console.error(`Error finding tmux session for VM ${vmName}:`, error.message);
      return null;
    }
  }

  /**
   * Find running backup process by checking for backup_manager.sh processes
   */
  async findRunningBackupProcess(vmName, hypervisorIp) {
    try {
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      
      // Find backup_manager.sh processes with matching VM name and hypervisor IP.
      // `auxww` (not plain `aux`) keeps the COMMAND column unlimited-width —
      // `ps aux` truncates long command lines, which can make a live process
      // silently fail to match once --domain/--ip are past the cutoff.
      const { stdout } = await execAsync(
        `ps auxww | grep -E "Backup_Manager.sh.*--domain ${vmName}.*--ip ${hypervisorIp}" | grep -v grep || true`
      );
      
      if (stdout.trim()) {
        const lines = stdout.trim().split('\n');
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length > 1) {
            const pid = parseInt(parts[1]);
            if (pid && !isNaN(pid)) {
              return pid;
            }
          }
        }
      }
    } catch (error) {
      console.error(`Error finding backup process for ${vmName}:`, error.message);
    }
    return null;
  }

  /**
   * Recover running jobs from previous session
   */
  async recoverRunningJobs() {
    console.log('Checking for running backup jobs to recover...');
    
    const jobStates = this.getAllJobStates();
    
    for (const jobState of jobStates) {
      const { jobId, vmName, hypervisorIp, tmuxSession, scheduleType } = jobState;

      // A job still carrying the `queued` marker never reached executeBackup
      // (which overwrites the state without that flag). The in-memory queue it
      // was waiting in is gone after a restart, so it will never start on its
      // own. Before this branch such jobs vanished with no trace and the
      // controller filed them as indeterminate failures. Give it a real,
      // logged failure — unless a worker is somehow already alive for it
      // (defensive: an unexpected early start), in which case fall through to
      // the normal reattach logic below.
      if (jobState.queued === true) {
        const aliveSession = (tmuxSession && await this.findRunningTmuxSession(tmuxSession))
          || (vmName && scheduleType && await this.findTmuxSessionForVM(vmName, scheduleType));
        if (!aliveSession) {
          console.warn(`[BackupExecutor] Recovering dropped queued job ${jobId} (${vmName}) — agent restarted before it started`);
          await this.failJobEarly(
            jobState,
            new Error('Agent restarted while this backup was still queued; it never started and was not run.')
          );
          continue;
        }
        // A live worker exists despite the queued marker — treat it as running.
        console.log(`[BackupExecutor] Queued job ${jobId} has a live session ${aliveSession}; reattaching`);
        await this.reattachToTmuxSession(jobId, jobState, aliveSession);
        continue;
      }

      // First check if we have a stored tmux session name
      let session = null;
      if (tmuxSession) {
        session = await this.findRunningTmuxSession(tmuxSession);
      }
      
      // If not found by stored name, try to find by VM name pattern
      if (!session && vmName && scheduleType) {
        console.log(`Stored tmux session not found, searching for VM ${vmName} with schedule ${scheduleType}...`);
        session = await this.findTmuxSessionForVM(vmName, scheduleType);
      }
      
      if (session) {
        console.log(`Found running tmux session for job ${jobId}: ${session}`);
        await this.reattachToTmuxSession(jobId, jobState, session);
      } else {
        // Fallback: check if process is still running (for backwards compatibility)
        const pid = await this.findRunningBackupProcess(vmName, hypervisorIp);
        
        if (pid) {
          console.log(`Found running backup process for job ${jobId} (PID: ${pid}) without tmux`);
          await this.reattachToJob(jobId, jobState, pid);
        } else {
          // No tmux session, no process by PID. handleCompletedJobWhileDown
          // makes the final call — it checks the exit-code file first, then
          // falls back to progress/lock file freshness before ever declaring
          // the job dead, so we must NOT delete any evidence here first.
          console.log(`No running process found for job ${jobId}, checking completion status...`);
          await this.handleCompletedJobWhileDown(jobId, jobState);
        }
      }
    }
  }

  /**
   * Reattach to a running tmux session
   */
  async reattachToTmuxSession(jobId, jobState, tmuxSession) {
    console.log(`Reattaching to tmux session ${tmuxSession} for job ${jobId}`);
    
    // Restore job to active jobs with initial state
    this.activeJobs.set(jobId, {
      ...jobState,
      progress: jobState.progress || 0,
      progressText: 'Recovering...',
      recovered: true,
      tmuxSession
    });
    
    // Restore VM lock
    this.vmLocks.set(jobState.vmName, jobId);
    
    console.log(`Job ${jobId} restored to active jobs, starting monitoring...`);
    
    // Monitor the tmux session (this will read log and update progress)
    const logFile = path.join(this.config.logDir, `${jobId}.log`);
    this.monitorTmuxSession(jobId, tmuxSession, jobState, logFile, null);
    
    // Initial update to controller - will be overwritten by log parsing
    await this.updateController(jobId, 'running', null, null, jobState.progress || 0, 'Recovering...');
    
    console.log(`Job ${jobId} recovery complete, monitoring active`);
  }

  /**
   * Best-effort human-readable failure detail from a job's log. Used only to
   * describe a failure we have ALREADY established from the exit code — never
   * to decide whether the job failed.
   */
  _extractErrorFromLog(jobId) {
    try {
      const logFile = path.join(this.config.logDir, `${jobId}.log`);
      if (!fs.existsSync(logFile)) return null;
      const lines = fs.readFileSync(logFile, 'utf8').split('\n');
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 50); i--) {
        const clean = stripAnsi(lines[i], { singleLine: true });
        if (/error|failed|exception/i.test(clean)) return clean.slice(0, 300);
      }
    } catch (e) {
      // best effort only
    }
    return null;
  }

  /**
   * True if the given file was modified within the last `maxAgeMs`. Used to
   * tell an actively-updated progress/lock file (job still running — rsync
   * and the offsite writers rewrite it every few seconds) apart from one
   * left behind by a process that already died.
   */
  _isFileRecentlyModified(filePath, maxAgeMs) {
    try {
      const stat = fs.statSync(filePath);
      return (Date.now() - stat.mtimeMs) < maxAgeMs;
    } catch (e) {
      return false;
    }
  }

  /**
   * Handle jobs that completed while agent was down
   */
  async handleCompletedJobWhileDown(jobId, jobState) {
    const { vmName, scheduleType } = jobState;

    // The shell wrote `echo $? > <jobId>.exitcode` when the script ended, so if
    // that file is here it is the script's own verdict — hard evidence, and it
    // outranks everything below. Everything after this point only *infers* an
    // outcome by pattern-matching log prose, which is how a run that ended
    // "✗ Backup FAILED ... (exit code: 1)" could still be filed as completed.
    const exitCodeFile = path.join(this.config.logDir, `${jobId}.exitcode`);
    if (fs.existsSync(exitCodeFile)) {
      let recorded = null;
      try {
        const raw = fs.readFileSync(exitCodeFile, 'utf8').trim();
        if (/^-?\d+$/.test(raw)) recorded = parseInt(raw, 10);
      } catch (err) {
        console.error(`Failed to read exit code file for ${jobId}: ${err.message}`);
      }

      if (recorded !== null) {
        try { fs.unlinkSync(exitCodeFile); } catch (e) { /* best effort */ }
        this.deleteJobState(jobId);

        if (recorded === 0) {
          console.log(`Job ${jobId} finished while agent was down — exit code 0 (success)`);
          await this.updateController(jobId, 'completed', 0);
        } else {
          console.log(`Job ${jobId} finished while agent was down — exit code ${recorded} (failure)`);
          const detail = this._extractErrorFromLog(jobId) || `Backup script exited with code ${recorded}`;
          await this.updateController(jobId, 'failed', recorded, detail);
        }
        return;
      }
    }

    // Double-check: if progress file or lock file still exists AND is being
    // actively written to, the backup is almost certainly still running (the
    // shell rewrites both every few seconds during rsync/offsite sync) — we
    // just lost track of the tmux session/process. Do NOT delete evidence or
    // mark failed in that case: leave the job-state file in place so the next
    // recovery pass (every 10s) re-checks, and don't touch controller status.
    const basePath = jobState.storagePoolPath || this.config.backupPath;
    const progressFile = path.join(basePath, '.progress', `${vmName}_${scheduleType}.progress`);
    const lockFile = path.join(basePath, 'in_progress_backups', `${vmName}_${scheduleType}_backup`);
    const PROGRESS_FRESH_MS = 5 * 60 * 1000; // 5 minutes

    const progressExists = fs.existsSync(progressFile);
    const lockExists = fs.existsSync(lockFile);

    if (progressExists || lockExists) {
      const progressFresh = progressExists && this._isFileRecentlyModified(progressFile, PROGRESS_FRESH_MS);
      const lockFresh = lockExists && this._isFileRecentlyModified(lockFile, PROGRESS_FRESH_MS);

      if (progressFresh || lockFresh) {
        console.log(`Job ${jobId}: tmux/process not found, but progress/lock file was modified within the last ${PROGRESS_FRESH_MS / 1000}s — treating as still running, not marking failed. Will re-check on next pass.`);
        return;
      }

      console.log(`WARNING: Progress/lock file exists for job ${jobId} but is stale (no tmux session, no process, no recent writes).`);
      console.log(`Marking as failed and cleaning up.`);

      if (progressExists) {
        try {
          fs.unlinkSync(progressFile);
        } catch (err) {
          console.error(`Failed to delete orphaned progress file: ${err.message}`);
        }
      }
      if (lockExists) {
        try {
          fs.unlinkSync(lockFile);
        } catch (err) {
          console.error(`Failed to delete orphaned lock file: ${err.message}`);
        }
      }

      this.deleteJobState(jobId);
      await this.updateController(jobId, 'failed', 1, 'Lost tracking of backup process - please check manually');
      return;
    }
    
    const logFile = path.join(this.config.logDir, `${jobId}.log`);
    
    if (!fs.existsSync(logFile)) {
      console.log(`No log file found for job ${jobId}, marking as failed`);
      this.deleteJobState(jobId);
      await this.updateController(jobId, 'failed', 1, 'Log file not found - job may have been interrupted');
      return;
    }
    
    try {
      const logContent = fs.readFileSync(logFile, 'utf8');
      const lines = logContent.split('\n');
      
      let exitCode = null;
      let hasError = false;
      let errorMessage = null;
      let completedSuccessfully = false;
      let rsyncStarted = false;
      let rsyncCompleted = false;
      let backupCompleted = false;
      
      // Analyze log to determine status
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].toLowerCase();
        
        // Check for exit code
        if (line.includes('exit code')) {
          const match = lines[i].match(/exit code[:\s]+(\d+)/i);
          if (match) {
            exitCode = parseInt(match[1]);
          }
        }
        
        // Check for completion messages
        if (line.includes('completed successfully') || line.includes('backup completed')) {
          completedSuccessfully = true;
        }
        
        if (line.includes('backup created') || line.includes('virtnbdbackup') && line.includes('100%')) {
          backupCompleted = true;
        }
        
        // Check for rsync
        if (line.includes('rsync') || line.includes('offsite')) {
          rsyncStarted = true;
          if (line.includes('100%') || line.includes('sent') && line.includes('received')) {
            rsyncCompleted = true;
          }
        }
        
        // Check for errors
        if (line.includes('error') || line.includes('failed') || line.includes('exception')) {
          hasError = true;
          errorMessage = lines[i].trim();
        }
      }
      
      // Determine final status based on analysis
      let finalStatus = 'failed';
      let finalExitCode = exitCode !== null ? exitCode : 1;
      let finalMessage = null;
      
      if (exitCode === 0 || completedSuccessfully) {
        finalStatus = 'completed';
        finalExitCode = 0;
        console.log(`Job ${jobId} completed successfully while agent was down`);
      } else if (backupCompleted && !rsyncStarted) {
        // Backup completed but no offsite sync attempted
        finalStatus = 'completed';
        finalExitCode = 0;
        console.log(`Job ${jobId} completed (no offsite sync) while agent was down`);
      } else if (backupCompleted && rsyncStarted && !rsyncCompleted) {
        // Backup completed but rsync failed
        finalStatus = 'failed';
        finalExitCode = 1;
        finalMessage = 'Backup created but offsite sync failed';
        console.log(`Job ${jobId} failed during offsite sync while agent was down`);
      } else if (backupCompleted && rsyncCompleted) {
        // Both completed
        finalStatus = 'completed';
        finalExitCode = 0;
        console.log(`Job ${jobId} completed with offsite sync while agent was down`);
      } else if (hasError) {
        finalStatus = 'failed';
        finalMessage = errorMessage || 'Backup failed with errors';
        console.log(`Job ${jobId} failed with errors while agent was down`);
      } else {
        // Unknown state - check exit code
        if (exitCode === 0) {
          finalStatus = 'completed';
          finalExitCode = 0;
        } else {
          finalStatus = 'failed';
          finalMessage = `Backup process exited with code ${exitCode || 'unknown'}`;
        }
        console.log(`Job ${jobId} finished with uncertain status (exit code: ${exitCode})`);
      }
      
      // Clean up state
      this.deleteJobState(jobId);
      
      // Update controller with final status
      if (finalStatus === 'completed') {
        await this.updateController(jobId, 'completed', finalExitCode);
      } else {
        await this.updateController(jobId, 'failed', finalExitCode, finalMessage);
      }
      
    } catch (error) {
      console.error(`Error analyzing log for job ${jobId}:`, error.message);
      this.deleteJobState(jobId);
      await this.updateController(jobId, 'failed', 1, 'Failed to determine job status after agent restart');
    }
  }

  /**
   * Periodically check and recover jobs
   */
  async checkAndRecoverJobs() {
    const jobStates = this.getAllJobStates();

    for (const jobState of jobStates) {
      const { jobId, vmName, hypervisorIp, scheduleType } = jobState;

      // Skip if already attached
      if (this.activeJobs.has(jobId)) {
        continue;
      }
      // Skip if monitors for this job are still wired (mid-teardown race)
      if (this.activeProcesses.has(jobId)) {
        continue;
      }
      // Skip jobs still waiting in the in-memory queue. Their `queued` marker is
      // a durable breadcrumb for STARTUP recovery only — while the process is
      // alive the in-memory jobQueue is the authority, and the job will start
      // (and overwrite this marker) when a slot frees. Treating it as an
      // orphan here would hand a genuinely-waiting job to
      // handleCompletedJobWhileDown and wrongly finalize it within seconds.
      if (jobState.queued === true) {
        continue;
      }

      // FIRST check the tmux session — by its exact recorded name, then by
      // VM+schedule pattern if the exact name lookup misses (e.g. the stored
      // name was slightly off, or a transient tmux error). During setup
      // phases (retry cleanup, checksumming) no virtnbdbackup process matches
      // yet, so the process check below would wrongly conclude the job died
      // and mark it completed/failed while it is in fact running. Re-adopt
      // and resume full monitoring.
      let liveSession = null;
      if (jobState.tmuxSession) {
        liveSession = await this.findRunningTmuxSession(jobState.tmuxSession);
      }
      if (!liveSession && vmName && scheduleType) {
        liveSession = await this.findTmuxSessionForVM(vmName, scheduleType);
      }
      if (liveSession) {
        console.log(`Re-adopting job ${jobId} — tmux session ${liveSession} is alive but was untracked`);
        this.activeJobs.set(jobId, {
          ...jobState,
          progress: jobState.progress || 0,
          progressText: jobState.progressText || 'Re-attached...',
          recovered: true,
        });
        this.vmLocks.set(vmName, jobId);
        const logFile = path.join(this.config.logDir, `${jobId}.log`);
        const logStream = fs.createWriteStream(logFile, { flags: 'a' });
        this.monitorTmuxSession(jobId, liveSession, jobState, logFile, logStream);
        await this.updateController(jobId, 'running', null, null, jobState.progress || 0, 'Re-attached to running backup session');
        continue;
      }

      // Check if process is still running
      const pid = await this.findRunningBackupProcess(vmName, hypervisorIp);

      if (pid) {
        console.log(`Recovering orphaned job ${jobId} (PID: ${pid})`);
        await this.reattachToJob(jobId, jobState, pid);
      } else {
        // Process finished - check completion status
        console.log(`Job ${jobId} process not found, checking completion status`);
        await this.handleCompletedJobWhileDown(jobId, jobState);
      }
    }
  }

  /**
   * Reattach to a running backup job
   */
  async reattachToJob(jobId, jobState, pid) {
    console.log(`Reattaching to job ${jobId} (PID: ${pid})`);
    
    // Restore job to active jobs
    this.activeJobs.set(jobId, {
      ...jobState,
      progress: jobState.progress || 0,
      progressText: jobState.progressText || 'Recovering...',
      recovered: true
    });
    
    // Restore VM lock
    this.vmLocks.set(jobState.vmName, jobId);
    
    // Monitor the process by tailing the log file
    const logFile = path.join(this.config.logDir, `${jobId}.log`);
    
    // Watch log file for progress updates
    this.watchLogForProgress(jobId, logFile);
    
    // Monitor process completion
    this.monitorProcessCompletion(jobId, pid, jobState);
    
    // Update controller
    await this.updateController(jobId, 'running', null, null, jobState.progress || 0, 'Recovered after agent restart');
  }

  /**
   * Watch log file for progress updates
   */
  watchLogForProgress(jobId, logFile) {
    if (!fs.existsSync(logFile)) {
      console.log(`Log file not found for job ${jobId}: ${logFile}`);
      return;
    }

    let lastSize = 0;
    
    // Read existing content first (for recovery scenarios)
    try {
      const stats = fs.statSync(logFile);
      lastSize = stats.size;
      
      if (lastSize > 0) {
        console.log(`Reading existing log content for job ${jobId} (${lastSize} bytes)`);
        const existingContent = fs.readFileSync(logFile, 'utf8');
        const lines = existingContent.split('\n');
        
        // Parse existing lines for progress - process in order to get latest progress
        let foundProgress = false;
        lines.forEach(line => {
          const job = this.activeJobs.get(jobId);
          if (job) {
            const oldProgress = job.progress;
            this.parseLogLineForProgress(jobId, line);
            if (job.progress !== oldProgress) {
              foundProgress = true;
            }
          }
        });
        
        if (foundProgress) {
          const job = this.activeJobs.get(jobId);
          console.log(`[${jobId}] Recovered progress from log: ${job.progress}% - ${job.progressText}`);
        } else {
          console.log(`[${jobId}] No progress information found in existing log`);
        }
      }
    } catch (error) {
      console.error(`Error reading existing log for job ${jobId}:`, error.message);
    }
    
    // Watch for new content
    const watcher = fs.watch(logFile, (eventType) => {
      if (eventType === 'change') {
        try {
          const stats = fs.statSync(logFile);
          const newSize = stats.size;
          
          if (newSize > lastSize) {
            const stream = fs.createReadStream(logFile, {
              encoding: 'utf8',
              start: lastSize,
              end: newSize
            });
            
            let buffer = '';
            stream.on('data', (chunk) => {
              buffer += chunk;
              const lines = buffer.split('\n');
              buffer = lines.pop() || ''; // Keep incomplete line in buffer
              
              lines.forEach(line => {
                this.parseLogLineForProgress(jobId, line);
              });
            });
            
            lastSize = newSize;
          }
        } catch (error) {
          console.error(`Error watching log for job ${jobId}:`, error.message);
        }
      }
    });
    
    // Store watcher for cleanup
    const processInfo = this.activeProcesses.get(jobId) || {};
    processInfo.watcher = watcher;
    this.activeProcesses.set(jobId, processInfo);
  }

  /**
   * Parse log line for progress information
   */
  parseLogLineForProgress(jobId, line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    
    const job = this.activeJobs.get(jobId);
    if (!job) return;
    
    // Detect rsync progress - look for patterns like "1.2GB/5.4GB 23% 45MB/s"
    if (trimmed.toLowerCase().includes('rsync') || trimmed.includes('sending incremental') || /\d+%.*\/s/.test(trimmed)) {
      const percentMatch = trimmed.match(/(\d+)%/);
      if (percentMatch) {
        const progress = parseInt(percentMatch[1]);
        
        let cleanText = trimmed
          .replace(/\x1b\[[0-9;]*m/g, '')
          .replace(/▐[█░]*▌/g, '')
          .replace(/\r/g, '')
          .trim();
        
        const sizeMatch = cleanText.match(/[\d.]+[KMGT]B?\/[\d.]+[KMGT]B?/);
        const speedMatch = cleanText.match(/[\d.]+[KMGT]B?\/s/);
        
        if (sizeMatch && speedMatch) {
          cleanText = `Offsite sync: ${sizeMatch[0]} @ ${speedMatch[0]}`;
        } else if (sizeMatch) {
          cleanText = `Offsite sync: ${sizeMatch[0]}`;
        } else {
          cleanText = `Offsite sync: ${progress}%`;
        }
        
        console.log(`[${jobId}] Rsync progress: ${progress}% - ${cleanText}`);
        
        job.progress = progress;
        job.progressText = cleanText;
        job.progressType = 'rsync';
        
        this.saveJobState(jobId, job);
        this.updateController(jobId, 'running', null, null, progress, cleanText);
        
        this.io.to(`job-${jobId}`).emit('backup-progress-bar', {
          jobId,
          progress: trimmed,
          percentage: progress,
          type: 'rsync'
        });
        return;
      }
    }
    
    // Detect virtnbdbackup progress - look for progress bars or percentage
    // Patterns: "▐████░░░▌ 45%" or "45%" or "1.2G/5.4G"
    const percentMatch = trimmed.match(/(\d+)%/);
    if (percentMatch && !trimmed.toLowerCase().includes('rsync')) {
      const progress = parseInt(percentMatch[1]);
      
      // Skip if this looks like a completion message (100% complete, etc)
      if (trimmed.toLowerCase().includes('complete') && progress === 100) {
        return;
      }
      
      let cleanText = trimmed
        .replace(/\x1b\[[0-9;]*m/g, '')
        .replace(/▐[█░]*▌/g, '')
        .replace(/\r/g, '')
        .replace(/\d+%/g, '')
        .trim();
      
      const sizeMatch = cleanText.match(/[\d.]+[KMGT]B?\/[\d.]+[KMGT]B?/);
      if (sizeMatch) {
        cleanText = `Backup: ${sizeMatch[0]}`;
      } else if (cleanText.length > 50) {
        // Truncate long messages
        cleanText = `Backup: ${progress}%`;
      } else if (cleanText.length > 0) {
        cleanText = `Backup: ${cleanText}`;
      } else {
        cleanText = `Backup: ${progress}%`;
      }
      
      console.log(`[${jobId}] Backup progress: ${progress}% - ${cleanText}`);
      
      job.progress = progress;
      job.progressText = cleanText;
      job.progressType = 'backup';
      
      this.saveJobState(jobId, job);
      this.updateController(jobId, 'running', null, null, progress, cleanText);
      
      this.io.to(`job-${jobId}`).emit('backup-progress-bar', {
        jobId,
        progress: trimmed,
        percentage: progress,
        type: 'backup'
      });
    }
  }

  /**
   * Monitor process completion by checking if PID exists
   */
  monitorProcessCompletion(jobId, pid, jobState) {
    const checkInterval = setInterval(async () => {
      try {
        // Check if process is still running
        process.kill(pid, 0); // Signal 0 just checks if process exists
      } catch (error) {
        // Process no longer exists
        clearInterval(checkInterval);
        
        console.log(`Job ${jobId} (PID: ${pid}) has completed`);
        
        // Read final log to determine success/failure
        const logFile = path.join(this.config.logDir, `${jobId}.log`);
        let exitCode = 0;
        let errorMessage = null;
        
        if (fs.existsSync(logFile)) {
          const logContent = fs.readFileSync(logFile, 'utf8');
          const lines = logContent.split('\n');
          
          // Check last few lines for exit code
          for (let i = lines.length - 1; i >= Math.max(0, lines.length - 10); i--) {
            const line = lines[i];
            if (line.includes('exit code')) {
              const match = line.match(/exit code[:\s]+(\d+)/i);
              if (match) {
                exitCode = parseInt(match[1]);
              }
            }
            if (line.toLowerCase().includes('error') || line.toLowerCase().includes('failed')) {
              errorMessage = line.trim();
            }
          }
        }
        
        // Cleanup
        const processInfo = this.activeProcesses.get(jobId);
        if (processInfo && processInfo.watcher) {
          processInfo.watcher.close();
        }
        this.activeProcesses.delete(jobId);
        this.activeJobs.delete(jobId);
        this.vmLocks.delete(jobState.vmName);
        this.deleteJobState(jobId);
        
        // Update controller
        if (exitCode === 0) {
          await this.updateController(jobId, 'completed', exitCode);
        } else {
          await this.updateController(jobId, 'failed', exitCode, errorMessage || `Backup failed with exit code ${exitCode}`);
        }
        
        // Process next in queue
        this.processQueue();
      }
    }, 5000); // Check every 5 seconds
    
    // Store interval for cleanup
    const processInfo = this.activeProcesses.get(jobId) || {};
    processInfo.checkInterval = checkInterval;
    this.activeProcesses.set(jobId, processInfo);
  }

  /**
   * Add backup to queue
   */
  async queueBackup(jobData) {
    const { vmName } = jobData;

    // Check if VM is already being backed up.
    //
    // The reservation must be ATOMIC to prevent a same-VM double-start: the
    // lock used to be checked here but only SET later, inside executeBackup(),
    // with an `await` in between — so two triggers/retries for the same VM
    // arriving close together both passed the check and both started. We close
    // that window by distinguishing two cases with NO await before we reserve:
    //
    //   • The lock is held by a job THIS process already knows (running in
    //     activeJobs, or waiting in jobQueue). That is a genuine in-flight
    //     reservation — reject immediately, no host probe needed.
    //   • The lock is held by a jobId with no in-memory job (a stale lock left
    //     by a crashed/SIGKILLed run, or one recovered without a live worker).
    //     Only then do the async host liveness probe before clearing it.
    if (this.vmLocks.has(vmName)) {
      const existingJobId = this.vmLocks.get(vmName);
      const knownInMemory = this.activeJobs.has(existingJobId)
        || this.jobQueue.some(j => j && j.jobId === existingJobId);
      if (knownInMemory) {
        console.log(`VM ${vmName} is already reserved by job ${existingJobId}; rejecting duplicate`);
        return {
          queued: false,
          error: `Another backup is already in progress for VM: ${vmName}`,
          existingJobId,
        };
      }
      const stillRunning = await this._isVmBackupAlive(vmName, jobData.scheduleType);
      if (stillRunning) {
        console.log(`VM ${vmName} is already being backed up (job: ${existingJobId})`);
        return {
          queued: false,
          error: `Another backup is already in progress for VM: ${vmName}`,
          existingJobId,
        };
      }
      console.warn(`[BackupExecutor] Stale vmLock for ${vmName} (job ${existingJobId}) — no live worker found, clearing and proceeding`);
      this.vmLocks.delete(vmName);
      this.deleteJobState(existingJobId);
    }

    // Reserve the VM synchronously NOW — before pushing to the queue and before
    // any further await — so a concurrent same-VM trigger observes the lock and
    // is rejected by the knownInMemory branch above. executeBackup re-sets this
    // to the same value when it starts; failJobEarly / the inner catch release
    // it if the job never runs.
    this.vmLocks.set(vmName, jobData.jobId);

    this.jobQueue.push(jobData);
    // Persist a durable queued marker BEFORE the job runs. The in-memory queue
    // is otherwise the only record of a waiting job — an agent restart wiped it
    // silently, leaving no log, no job-state and no exit code, so the controller
    // could only file it as an indeterminate failure. With this marker on disk,
    // startup recovery (recoverRunningJobs) can give every dropped queued job a
    // real, logged failure instead of a traceless disappearance. executeBackup
    // overwrites this state (without the `queued` flag) the moment it starts.
    this.saveJobState(jobData.jobId, {
      ...jobData,
      queued: true,
      queuedAt: new Date().toISOString(),
      progressText: 'Queued...',
    });
    this.processQueue();
    return { queued: true, position: this.jobQueue.length };
  }

  /**
   * Is there a genuinely live backup worker for this VM? Checks a matching
   * tmux session and the backup processes. Used to distinguish a real
   * in-progress backup from a stale in-memory lock.
   */
  async _isVmBackupAlive(vmName, scheduleType = null) {
    try {
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      // Live backup process for this VM. `Backup_Manager.sh --domain <vm>` is
      // the parent and stays up for every phase (including the offsite rsync,
      // whose own command line carries the pool path, not the VM name), so
      // this is the strongest signal — check it FIRST.
      const { stdout: procs } = await execAsync(
        `pgrep -af "(virtnbdbackup|Backup_Manager.sh).*${esc(vmName)}" 2>/dev/null || true`
      );
      if (procs.trim().length > 0) return true;

      // A tmux session on its own is NOT proof of life: the session outlives
      // the command it ran, so a script that died (or was killed) leaves one
      // behind forever. Treating that as "alive" is what made a VM with
      // nothing running refuse every new backup. Require corroboration —
      // either the session is too young to have finished starting up, or the
      // progress file is still being written.
      const sanitized = vmName.replace(/[^a-zA-Z0-9-]/g, '_');
      try {
        const { stdout } = await execAsync(
          `tmux list-sessions -F "#{session_name}|#{session_created}" 2>/dev/null || true`
        );
        const prefix = scheduleType ? `${sanitized}_${scheduleType}_` : `${sanitized}_`;
        const row = stdout.split('\n').find(s => s.split('|')[0].startsWith(prefix));
        if (row) {
          const createdEpoch = row.split('|')[1];
          const createdMs = /^\d+$/.test((createdEpoch || '').trim())
            ? parseInt(createdEpoch, 10) * 1000
            : null;
          // Still starting up — the worker may not have spawned yet.
          if (createdMs && (Date.now() - createdMs) < 2 * 60 * 1000) return true;
          if (this._isProgressFileFresh(vmName, scheduleType)) return true;
          console.warn(`[BackupExecutor] tmux session ${row.split('|')[0]} for ${vmName} has no live worker and no fresh progress — treating as stale`);
          return false;
        }
      } catch (_) { /* no tmux server */ }

      return false;
    } catch (err) {
      // On any error, be conservative and assume it IS alive (don't clear a
      // lock we can't verify — better a false block than a double-start).
      console.error(`[BackupExecutor] _isVmBackupAlive check failed for ${vmName}: ${err.message}`);
      return true;
    }
  }

  /**
   * Is the VM's progress file still being written? The backup script rewrites
   * it every few seconds for the whole run, so a recent mtime proves a worker
   * is alive even when no process name matches. Searches every configured pool
   * because the caller does not know which one this run is using.
   */
  _isProgressFileFresh(vmName, scheduleType, maxAgeMs = 5 * 60 * 1000) {
    const sanitized = String(vmName).replace(/[^a-zA-Z0-9-]/g, '_');
    const roots = new Set();
    if (this.config && this.config.backupPath) roots.add(this.config.backupPath);
    for (const job of this.activeJobs.values()) {
      if (job && job.storagePoolPath) roots.add(job.storagePoolPath);
    }
    for (const root of roots) {
      let dir;
      try {
        dir = require('path').join(root, '.progress');
        for (const file of fs.readdirSync(dir)) {
          if (scheduleType && !file.endsWith(`_${scheduleType}.progress`)) continue;
          if (!file.replace(/[^a-zA-Z0-9-]/g, '_').startsWith(sanitized)) continue;
          const stats = fs.statSync(require('path').join(dir, file));
          if (Date.now() - stats.mtimeMs < maxAgeMs) return true;
        }
      } catch (_) { /* pool has no .progress dir — try the next */ }
    }
    return false;
  }

  /**
   * Process backup queue
   */
  async processQueue() {
    // 0 = unlimited: never gate on active count.
    if (!this.isUnlimitedConcurrency() && this.activeJobs.size >= this.getMaxConcurrent()) {
      return;
    }

    if (this.jobQueue.length === 0) {
      return;
    }

    const jobData = this.jobQueue.shift();
    try {
      await this.executeBackup(jobData);
    } catch (err) {
      // A job that throws BEFORE it sets up its own logging/cleanup (e.g. a
      // missing storagePoolPath, a failed saveJobState, a synchronous bug)
      // must never take the whole queue down with it. Historically this
      // rejection escaped here, the trailing processQueue() never ran, and
      // every job behind it silently froze — while the failed job itself left
      // no log, no job-state and no exit code, so the controller could only
      // file it as an indeterminate failure with "no logs". Record a real,
      // durable failure for it, then keep draining.
      await this.failJobEarly(jobData, err);
    }

    // Continue processing regardless of how the job above resolved.
    this.processQueue();
  }

  /**
   * Guarantee that a job which failed before executeBackup could establish its
   * own log always leaves a trace: a populated <jobId>.log, a <jobId>.exitcode,
   * released locks, and a best-effort controller notification. This is what
   * makes "the log always exists and has data" true even on the earliest
   * failures — a dropped job must never be indistinguishable from a lost one.
   */
  async failJobEarly(jobData, err) {
    const jobId = jobData && jobData.jobId;
    const vmName = jobData && jobData.vmName;
    const message = (err && err.message) ? err.message : String(err);
    console.error(`[BackupExecutor] Job ${jobId || '(unknown)'} failed before execution: ${message}`);

    if (jobId) {
      // Durable, local evidence first — this survives even if the controller
      // is unreachable (the exact situation catch-up replays run in).
      try {
        const logFile = path.join(this.config.logDir, `${jobId}.log`);
        const ts = new Date().toISOString();
        const lines = [
          `[${ts}] Backup failed before it could start.`,
          `[${ts}] VM: ${vmName || 'unknown'}`,
          `[${ts}] Error: ${message}`,
          err && err.stack ? `[${ts}] ${err.stack}` : null,
        ].filter(Boolean).join('\n') + '\n';
        fs.appendFileSync(logFile, lines);
      } catch (e) {
        console.error(`[BackupExecutor] Could not write early-failure log for ${jobId}: ${e.message}`);
      }
      // A recorded exit code lets live-status report a definitive FAILED
      // (script_error) instead of the ambiguous "indeterminate" verdict.
      try {
        fs.writeFileSync(path.join(this.config.logDir, `${jobId}.exitcode`), '1');
      } catch (_) { /* best effort */ }
    }

    // Release whatever executeBackup may have half-acquired before throwing.
    if (vmName && this.vmLocks.get(vmName) === jobId) this.vmLocks.delete(vmName);
    if (jobId) {
      this.activeJobs.delete(jobId);
      this.deleteJobState(jobId);
      try {
        await this.updateController(jobId, 'failed', 1, message);
      } catch (_) { /* controller may be down; local evidence already written */ }
    }
  }

  /**
   * Execute backup command using backup_manager.sh
   */
  async executeBackup(jobData) {
    const { 
      jobId, 
      vmName, 
      hypervisorIp, 
      scheduleType = 'once',
      method = null,
      retention = 7,
      keepArchive = 2,
      compression = 2,
      noCompression = false,
      noVerify = false,
      offsiteHosts = [],
      verbose = false,
      storagePoolPath = null,
      diskUsageThreshold = null,  // Per-pool disk-usage guard (percent)
      isRetry = false  // NEW: Flag to indicate this is a retry attempt
    } = jobData;

    console.log(`[BackupExecutor] Starting backup for ${vmName}, jobId: ${jobId}, isRetry: ${isRetry}`);

    // Create the log file and log() helper FIRST — before any validation that
    // could throw. Guaranteeing the log stream exists this early means every
    // failure path from here on leaves a populated <jobId>.log to debug from,
    // instead of the traceless "no log file at all" that made failed jobs
    // impossible to diagnose.
    const logFile = path.join(this.config.logDir, `${jobId}.log`);
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });

    const log = (message) => {
      const timestamp = new Date().toISOString();
      const entry = `[${timestamp}] ${message}\n`;
      logStream.write(entry);

      // Emit to socket
      this.io.to(`job-${jobId}`).emit('backup-log', { jobId, timestamp, message });
      this.io.emit('backup-progress', { jobId, message });
    };

    // Validate storage pool path is provided. Log the reason before throwing so
    // the failure is visible in the job's own log (processQueue's catch will
    // also record it and release resources).
    if (!storagePoolPath) {
      log('ERROR: Storage pool path is required for backup execution');
      logStream.end();
      throw new Error('Storage pool path is required for backup execution');
    }

    // Acquire VM lock
    this.vmLocks.set(vmName, jobId);
    console.log(`Acquired lock for VM: ${vmName} (job: ${jobId})`);

    // Create meaningful tmux session name: sanitize VM name for tmux
    // Replace dots, spaces, and special chars with underscores, keep only alphanumeric and dashes
    const sanitizedVmName = vmName.replace(/[^a-zA-Z0-9-]/g, '_');
    const shortJobId = jobId.substring(0, 8);
    const tmuxSession = `${sanitizedVmName}_${scheduleType}_${shortJobId}`;
    
    this.activeJobs.set(jobId, { ...jobData, progress: 0, progressText: 'Starting...', tmuxSession });

    // Save initial job state
    this.saveJobState(jobId, { ...jobData, progress: 0, progressText: 'Starting...', tmuxSession });

    // Tell the controller execution has begun RIGHT AWAY — before any retry
    // cleanup or command setup. Otherwise the UI sits on "queued/starting"
    // for minutes while pre-backup work (e.g. Cleanup_Backup.sh on retries)
    // runs, even though the job is genuinely executing. Fire-and-forget so a
    // slow controller can't delay the backup itself.
    this.updateController(jobId, 'running', null, null, 0, 'Starting backup process...').catch(() => {});

    log(`Starting backup for VM: ${vmName}`);
    log(`Hypervisor: ${hypervisorIp}`);
    log(`Schedule Type: ${scheduleType}`);
    log(`Retention: ${retention}`);
    log(`Keep Archive: ${keepArchive}`);

    // Map any legacy "method-style" scheduleType values (full / inc / copy)
    // onto a script-recognized schedule. The Backup_Manager.sh script only
    // accepts: once, monthly, daily, weekly, custom. The legacy values
    // existed in older controller payloads where method and scheduleType
    // were conflated; we keep accepting them here so older flows don't
    // break, while the underlying script gets a value it understands.
    const SCRIPT_SCHEDULES = ['once', 'monthly', 'daily', 'weekly', 'custom'];
    let scriptSchedule = scheduleType;
    if (!SCRIPT_SCHEDULES.includes(scriptSchedule)) {
      const fallback = scriptSchedule === 'inc' ? 'daily' : 'once';
      log(`Note: scheduleType "${scriptSchedule}" is not a valid script schedule; mapping to "${fallback}".`);
      scriptSchedule = fallback;
    }

    // Build command for backup_manager.sh
    const scriptPath = path.join(__dirname, '../scripts/Backup_Manager.sh');
    const args = [
      '--domain', vmName,
      '--ip', hypervisorIp,
      '--schedule', scriptSchedule,
      '--backup-path', storagePoolPath
    ];

    // Per-pool disk-usage threshold. Applies to both the local pool pre-flight
    // check and the offsite destination check inside Backup_Manager.sh. When
    // unset the script falls back to its built-in default (80%).
    if (diskUsageThreshold !== null && diskUsageThreshold !== undefined && diskUsageThreshold !== '') {
      const t = parseInt(diskUsageThreshold, 10);
      if (Number.isFinite(t) && t >= 1 && t <= 100) {
        args.push('--disk-threshold', String(t));
        log(`Disk usage threshold: ${t}%`);
      }
    }

    // Pass through the user-selected method when one was chosen. The
    // Backup_Manager.sh script accepts --method full | inc | copy. For
    // daily/weekly chains, omitting --method lets the script auto-detect
    // full vs inc based on existing checkpoints — that's intentional and
    // matches what the form provides (no top-level method picker for
    // daily/weekly). For custom-days schedules the form collects a method
    // per date and the controller forwards it here.
    if (method && ['full', 'inc', 'copy'].includes(method)) {
      args.push('--method', method);
      log(`Method: ${method}`);
    }

    // Add retention for daily/weekly chains
    if (['daily', 'weekly'].includes(scriptSchedule)) {
      args.push('--retention', String(retention));
      args.push('--keep-archive', String(keepArchive));
    }

    // Compression
    if (noCompression) {
      args.push('--no-compression');
      log('Compression: disabled');
    } else {
      args.push('--compress', String(compression));
      log(`Compression level: ${compression}`);
    }

    // Verification
    if (noVerify) {
      args.push('--no-verify');
      log('Verification: disabled');
    }

    // Offsite hosts. Each entry may be a bare IP string (legacy) or an
    // object { ip, backupPath }. We encode them for the script as "ip:path"
    // (path optional) joined by commas — a colon is used as the ip/path
    // delimiter because the script command is run through a shell and a
    // colon is shell-safe (unlike '|'). IPv4 addresses and normal paths
    // contain no colons. The script replicates to <path>/<vm> on that host,
    // or mirrors the source pool path when the path is empty.
    if (offsiteHosts && offsiteHosts.length > 0) {
      const encoded = offsiteHosts
        .map(h => {
          if (typeof h === 'string') return h.trim();
          if (h && h.ip) {
            const p = (h.backupPath || '').trim();
            return p ? `${h.ip}:${p}` : `${h.ip}`;
          }
          return null;
        })
        .filter(Boolean)
        .join(',');
      if (encoded) {
        args.push('--offsite-ip', encoded);
        log(`Offsite hosts: ${encoded}`);
      }
    }

    // Verbose
    if (verbose) {
      args.push('--verbose');
    }

    // Retry: clean partial files from the failed attempt before backing up again.
    //
    // This delegates to Backup_Manager.sh's own --retry handling rather than
    // running scripts/Cleanup_Backup.sh, which is NOT safe here: that script
    // deletes the newest checkpoint's data files whenever it finds a .partial.
    // A run that dies mid-transfer leaves .partial debris WITHOUT having written
    // its own checkpoint, so "newest checkpoint" is the last GOOD backup — and
    // retrying would destroy it and break the chain. It also sweeps every
    // schedule for the VM, not just the one being retried.
    //
    // --retry runs cleanup_retry_partial_files instead: scoped to this schedule's
    // directory, removes *.partial only, never touches checkpoints, and aborts
    // if a tmux session or lock shows a backup is genuinely running. It also runs
    // inside the script, after method resolution and before the backup lock —
    // the correct point in the sequence.
    //
    // (Cleanup_Backup.sh remains in place for the manual cleanup endpoint, where
    // an operator explicitly asks to reclaim a broken chain.)
    if (isRetry) {
      log('');
      log('='.repeat(70));
      log('RETRY MODE: Backup_Manager.sh will clear *.partial files for this');
      log(`schedule (${scheduleType}) before starting the backup.`);
      log('='.repeat(70));
      log('');
      args.push('--retry');
    }

    const command = `bash ${scriptPath} ${args.join(' ')}`;
    
    log(`Creating tmux session: ${tmuxSession}`);
    log(`Executing: ${command}`);
    log(`VM Name: ${vmName}`);
    log(`Schedule Type: ${scheduleType}`);
    log(`Progress file will be at: ${storagePoolPath}/.progress/${vmName}_${scheduleType}.progress`);

    // Update controller
    await this.updateController(jobId, 'running');

    try {
      // Serialize the fork/exec-heavy startup across ALL concurrent backups so
      // a burst of simultaneous scheduled fires doesn't spawn every tmux
      // session + backup process in the same instant. Runs through the shared
      // start mutex; other jobs' setups wait their turn (staggered by
      // _startGapMs), but once started every backup runs fully in parallel.
      await this._serializeStart(async () => {
        const { exec } = require('child_process');
        const { promisify } = require('util');
        const execAsync = promisify(exec);

        // Kill existing session if it exists
        await execAsync(`tmux kill-session -t ${tmuxSession} 2>/dev/null || true`);

        // Create tmux session
        await execAsync(`tmux new-session -d -s ${tmuxSession}`);
        log(`Tmux session ${tmuxSession} created`);

        // Start the backup process inside tmux using tmux send-keys
        // Write exit code to a file so we can detect kills vs normal exits
        const exitCodeFile = path.join(this.config.logDir, `${jobId}.exitcode`);
        // Clear any stale exit code from a prior attempt. Scheduled retries reuse
        // the same jobId, and an early-failure/inner-catch may have recorded a `1`
        // here; leaving it would let this fresh run be judged by the previous
        // attempt's verdict (a running retry wrongly reconciled as failed) before
        // the shell writes its own code below.
        try { if (fs.existsSync(exitCodeFile)) fs.unlinkSync(exitCodeFile); } catch (_) { /* best effort */ }
        await execAsync(`tmux send-keys -t ${tmuxSession} "cd '${storagePoolPath}' && ${command}; echo \\$? > '${exitCodeFile}'; exit" C-m`);

        // Capture tmux output to log file
        await execAsync(`tmux pipe-pane -t ${tmuxSession} -o "cat >> '${logFile}'"`);
      });

      log(`Backup started in tmux session: ${tmuxSession}`);
      log(`You can attach with: tmux attach -t ${tmuxSession}`);

      // Monitor the tmux session and parse log file for progress
      this.monitorTmuxSession(jobId, tmuxSession, jobData, logFile, logStream);

      return { success: true, tmuxSession };

    } catch (error) {
      log(`Failed to start backup: ${error.message}`);
      logStream.end();

      // Record a definitive exit code so live-status reports a real FAILED
      // (script_error) rather than an ambiguous "indeterminate" verdict.
      try {
        fs.writeFileSync(path.join(this.config.logDir, `${jobId}.exitcode`), '1');
      } catch (_) { /* best effort */ }

      // Cleanup
      this.vmLocks.delete(vmName);
      this.activeJobs.delete(jobId);
      this.deleteJobState(jobId);

      await this.updateController(jobId, 'failed', 1, error.message);
      // Note: do NOT call processQueue() here — the caller (processQueue)
      // always continues the queue after executeBackup resolves. Draining
      // twice could start two jobs into a single freed slot.

      return { success: false, error: error.message };
    }
  }

  /**
   * Monitor tmux session for completion and progress
   */
  monitorTmuxSession(jobId, tmuxSession, jobData, logFile, logStream) {
    const { vmName, scheduleType, storagePoolPath } = jobData;
    const monitorStartMs = Date.now();

    console.log(`Starting monitoring for job ${jobId} in tmux session ${tmuxSession}`);
    
    // Progress file path (matches the backup script - uses storage pool path or falls back to config)
    const basePath = storagePoolPath || this.config.backupPath;
    const progressFile = path.join(basePath, '.progress', `${vmName}_${scheduleType}.progress`);
    console.log(`Progress file: ${progressFile}`);
    
    let progressCheckCount = 0;
    
    // Read progress file periodically
    const progressInterval = setInterval(() => {
      progressCheckCount++;
      try {
        if (fs.existsSync(progressFile)) {
          const content = fs.readFileSync(progressFile, 'utf8').trim();
          if (!content) {
            if (progressCheckCount % 10 === 0) {
              console.log(`[${jobId}] Progress file exists but is empty`);
            }
            return;
          }
          
          const progressData = JSON.parse(content);
          
          const job = this.activeJobs.get(jobId);
          if (job && progressData.percentage !== undefined) {
            const oldProgress = job.progress;
            job.progress = progressData.percentage;
            job.progressText = progressData.text || `${progressData.type}: ${progressData.percentage}%`;
            job.progressType = progressData.type || 'backup';
            
            // Always update controller and save state
            if (oldProgress !== job.progress || progressCheckCount === 1) {
              console.log(`[${jobId}] Progress: ${job.progress}% - ${job.progressText}`);
              this.saveJobState(jobId, job);
              this.updateController(jobId, 'running', null, null, job.progress, job.progressText);
              
              this.io.to(`job-${jobId}`).emit('backup-progress-bar', {
                jobId,
                percentage: job.progress,
                progressText: job.progressText,
                type: job.progressType
              });
            }
          }
        } else {
          if (progressCheckCount % 10 === 0) {
            console.log(`[${jobId}] Progress file not found yet: ${progressFile}`);
          }
        }
      } catch (error) {
        // Ignore parse errors - file might be being written
        if (error.code !== 'ENOENT' && progressCheckCount % 10 === 0) {
          console.error(`[${jobId}] Error reading progress file: ${error.message}`);
        }
      }
    }, 1000); // Check every second
    
    // Check tmux session status periodically
    const checkInterval = setInterval(async () => {
      try {
        const { exec } = require('child_process');
        const { promisify } = require('util');
        const execAsync = promisify(exec);
        
        // Check if tmux session still exists
        try {
          await execAsync(`tmux has-session -t ${tmuxSession} 2>/dev/null`);
          // Session still exists, continue monitoring
        } catch (error) {
          // Session no longer exists - backup completed or was killed
          clearInterval(checkInterval);
          clearInterval(progressInterval);
          
          console.log(`Tmux session ${tmuxSession} ended, job ${jobId} checking exit status...`);
          
          if (logStream) {
            logStream.end();
          }
          
          // Clean up progress file
          if (fs.existsSync(progressFile)) {
            try {
              fs.unlinkSync(progressFile);
              console.log(`Cleaned up progress file: ${progressFile}`);
            } catch (err) {
              console.error(`Failed to delete progress file: ${err.message}`);
            }
          }
          
          // Read exit code from dedicated exit-code file (written by tmux command)
          let exitCode = null;
          let errorMessage = null;
          let failureReason = null;
          const exitCodeFile = path.join(this.config.logDir, `${jobId}.exitcode`);
          
          if (fs.existsSync(exitCodeFile)) {
            try {
              const raw = fs.readFileSync(exitCodeFile, 'utf8').trim();
              exitCode = parseInt(raw, 10);
              if (isNaN(exitCode)) exitCode = null;
              // Clean up exit code file
              fs.unlinkSync(exitCodeFile);
            } catch (err) {
              console.error(`Failed to read exit code file: ${err.message}`);
            }
          }
          
          if (exitCode === null) {
            // No exit-code file means the tmux session was killed externally
            // (kill-session, SIGKILL, etc.) — the shell never got to write $?
            exitCode = 137; // Conventional "killed" code
            failureReason = 'interrupted';
            errorMessage = 'Backup process was interrupted (tmux session killed externally)';
            console.log(`[${jobId}] No exit code file found — session was killed externally`);
          } else if (exitCode !== 0) {
            // Non-zero exit from the script itself
            failureReason = 'script_error';
            // Try to find error details in log
            if (fs.existsSync(logFile)) {
              const logContent = fs.readFileSync(logFile, 'utf8');
              const lines = logContent.split('\n');
              for (let i = lines.length - 1; i >= Math.max(0, lines.length - 30); i--) {
                // The script colourises its output, so strip escapes before the
                // line becomes an error message — otherwise it reaches the UI and
                // RocketChat as "[0;31m✗ Backup FAILED[0m". Match on the cleaned
                // text too: escapes can sit between the keyword and the line start.
                const clean = stripAnsi(lines[i], { singleLine: true });
                if (/error|failed|exception/i.test(clean)) {
                  errorMessage = clean;
                  break;
                }
              }
              if (!errorMessage) {
                errorMessage = `Backup script exited with code ${exitCode}`;
              }
            } else {
              errorMessage = `Backup script exited with code ${exitCode}`;
            }
          }
          // exitCode === 0 means success
          
          // Clean up lock file
          if (vmName && scheduleType && storagePoolPath) {
            const lockDir = path.join(storagePoolPath, 'in_progress_backups');
            const lockFile = path.join(lockDir, `${vmName}_${scheduleType}_backup`);
            try {
              if (fs.existsSync(lockFile)) {
                fs.unlinkSync(lockFile);
                console.log(`Cleaned up lock file: ${lockFile}`);
              }
            } catch (err) {
              console.error(`Failed to clean lock file: ${err.message}`);
            }
          }
          
          // CRITICAL: Clean up tmux session on failure to ensure retry logic works
          // If backup failed (exitCode !== 0), kill the tmux session to prevent
          // retry logic from failing with "tmux session exists" error
          if (exitCode !== 0 && tmuxSession) {
            try {
              const { exec } = require('child_process');
              const { promisify } = require('util');
              const execAsync = promisify(exec);
              
              // Check if session still exists and kill it
              try {
                await execAsync(`tmux has-session -t ${tmuxSession} 2>/dev/null`);
                // Session exists, kill it
                await execAsync(`tmux kill-session -t ${tmuxSession} 2>/dev/null`);
                console.log(`[${jobId}] Killed tmux session ${tmuxSession} after failure`);
              } catch (err) {
                // Session doesn't exist or already killed, that's fine
                console.log(`[${jobId}] Tmux session ${tmuxSession} already cleaned up`);
              }
            } catch (err) {
              console.error(`[${jobId}] Failed to cleanup tmux session: ${err.message}`);
            }
          }
          
          // Cleanup internal state
          this.activeProcesses.delete(jobId);
          this.activeJobs.delete(jobId);
          this.vmLocks.delete(vmName);
          this.deleteJobState(jobId);
          
          // Collect per-offsite-host outcomes from the script's events file
          // so the controller can persist an offsite sync status on the job.
          // This works for failed backups too — the script now runs the
          // offsite sync even on failure.
          const offsiteResults = this.collectOffsiteResults(vmName, scheduleType, storagePoolPath, monitorStartMs);

          // Update controller with accurate status
          if (exitCode === 0) {
            await this.updateController(jobId, 'completed', 0, null, null, null, null, offsiteResults);
          } else {
            await this.updateController(jobId, 'failed', exitCode, errorMessage, null, null, failureReason, offsiteResults);
          }
          
          // Process next in queue
          this.processQueue();
        }
      } catch (error) {
        console.error(`Error monitoring tmux session ${tmuxSession}:`, error.message);
      }
    }, 5000); // Check every 5 seconds
    
    // Store intervals for cleanup
    this.activeProcesses.set(jobId, { checkInterval, progressInterval, tmuxSession });
  }

  /**
   * Shutdown - cleanup intervals but don't kill processes
   */
  shutdown() {
    console.log('Shutting down backup executor...');
    
    // Stop recovery check interval
    if (this.recoveryCheckInterval) {
      clearInterval(this.recoveryCheckInterval);
      this.recoveryCheckInterval = null;
    }

    // Unsubscribe from concurrency config changes
    if (this._concurrencyUnsubscribe) {
      try { this._concurrencyUnsubscribe(); } catch (_) {}
      this._concurrencyUnsubscribe = null;
    }
    
    // Close all log watchers but don't kill processes
    for (const [jobId, processInfo] of this.activeProcesses.entries()) {
      if (processInfo.watcher) {
        processInfo.watcher.close();
      }
      if (processInfo.checkInterval) {
        clearInterval(processInfo.checkInterval);
      }
    }
    
    console.log('✓ Backup executor shutdown (processes continue running)');
  }

  /**
   * Update controller with job status
   */
  /**
   * Parse the backup script's events file for per-offsite-host outcomes.
   * Backup_Manager.sh emits offsite_host_complete / offsite_host_fail /
   * offsite_fail (SSH skip) events with offsite_ip + offsite_path into
   * <pool>/<vm>/<schedule>/logs/<ts>_<schedule>_<method>.events.jsonl.
   * Returns [{ ip, poolPath, status, reason }] or null.
   */
  collectOffsiteResults(vmName, scheduleType, storagePoolPath, sinceMs) {
    try {
      if (!vmName || !scheduleType || !storagePoolPath) return null;
      const logsDir = path.join(storagePoolPath, vmName, scheduleType, 'logs');
      if (!fs.existsSync(logsDir)) return null;

      // Newest events file written since (shortly before) the job started —
      // the script names it by its own start timestamp.
      const candidates = fs.readdirSync(logsDir)
        .filter(f => f.endsWith('.events.jsonl') && !f.includes('_offsite_'))
        .map(f => {
          const full = path.join(logsDir, f);
          try { return { full, mtime: fs.statSync(full).mtimeMs }; } catch { return null; }
        })
        .filter(Boolean)
        .filter(x => x.mtime >= sinceMs - 60000)
        .sort((a, b) => b.mtime - a.mtime);
      if (candidates.length === 0) return null;

      const results = [];
      const lines = fs.readFileSync(candidates[0].full, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.event === 'offsite_host_complete') {
          results.push({ ip: ev.offsite_ip, poolPath: ev.offsite_path, status: 'success' });
        } else if (ev.event === 'offsite_host_fail') {
          results.push({ ip: ev.offsite_ip, poolPath: ev.offsite_path, status: 'failed', reason: ev.reason || ev.message });
        } else if (ev.event === 'offsite_fail') {
          results.push({ ip: ev.offsite_ip, poolPath: ev.offsite_path, status: 'skipped', reason: ev.reason || ev.message });
        }
      }
      return results.length > 0 ? results : null;
    } catch (err) {
      console.error(`[BackupExecutor] Failed to collect offsite results: ${err.message}`);
      return null;
    }
  }

  async updateController(jobId, status, exitCode = null, error = null, progress = null, progressText = null, failureReason = null, offsiteResults = null) {
    if (!this.config.controllerUrl) {
      console.log(`No controller URL configured, skipping status update for job ${jobId}`);
      return;
    }

    try {
      const payload = {
        status,
        exitCode,
        error,
      };

      if (progress !== null) {
        payload.progress = progress;
      }

      if (progressText !== null) {
        payload.progressText = progressText;
      }

      if (failureReason) {
        payload.failureReason = failureReason;
      }

      // Forward the current progress phase (backup vs rsync/offsite) so the
      // controller can show "Syncing offsite" instead of a generic running
      // state. Read from the tracked job state — set by the progress-file
      // monitor and the log parser.
      const trackedJob = this.activeJobs.get(jobId);
      if (trackedJob && trackedJob.progressType) {
        payload.progressType = trackedJob.progressType;
      }

      // Per-offsite-host outcomes parsed from the script's events file,
      // sent with the terminal update so the controller can persist an
      // offsite sync status on the job (visible in Active + History).
      if (Array.isArray(offsiteResults) && offsiteResults.length > 0) {
        payload.offsiteResults = offsiteResults;
      }
      
      // Terminal status updates (completed/failed/cancelled) are critical:
      // if one is lost to a transient blip, the controller keeps the job
      // "running" until a much later reconcile, producing a wrong status and
      // a hugely inflated duration. So we retry terminal updates with backoff.
      // Progress/running updates are frequent and self-correcting, so they
      // stay single-shot to avoid backpressure.
      const isTerminal = status === 'completed' || status === 'failed' || status === 'cancelled';
      const attempts = isTerminal ? 6 : 1;
      const baseTimeout = isTerminal ? 10000 : 5000;

      let lastErr = null;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          await controllerAuthService.post(
            this.config.controllerUrl,
            `/backups/jobs/${jobId}/update`,
            payload,
            { timeout: baseTimeout }
          );
          if (attempt > 1) {
            console.log(`[BackupExecutor] Controller update for ${jobId} (${status}) succeeded on attempt ${attempt}`);
          }
          return; // success
        } catch (err) {
          lastErr = err;
          if (!isTerminal) throw err; // handled by outer catch (progress: quiet)
          if (attempt < attempts) {
            const delay = Math.min(1000 * 2 ** (attempt - 1), 30000); // 1s,2s,4s,8s,16s(cap 30s)
            console.warn(`[BackupExecutor] Controller update for ${jobId} (${status}) failed (attempt ${attempt}/${attempts}): ${err.message}. Retrying in ${delay}ms`);
            await new Promise(r => setTimeout(r, delay));
          }
        }
      }
      // All terminal retries exhausted — log loudly. The controller-side
      // periodic reconciler is the final safety net that will still finalize
      // this job by inspecting the agent's real state.
      console.error(`[BackupExecutor] CRITICAL: could not report terminal status '${status}' for job ${jobId} after ${attempts} attempts: ${lastErr && lastErr.message}. Controller will reconcile it on its next sync.`);
    } catch (err) {
      // Don't log every progress update failure to avoid spam
      if (status !== 'running' || !progress) {
        console.error(`Failed to update controller for job ${jobId}:`, err.message);
        if (err.response) {
          console.error(`  Status: ${err.response.status}, Data:`, err.response.data);
        }
      }
    }
  }

  /**
   * Get active jobs
   */
  getActiveJobs() {
    return Array.from(this.activeJobs.values()).map(job => ({
      ...job,
      canKill: this.activeProcesses.has(job.jobId),
      progress: job.progress || 0,
      progressText: job.progressText || ''
    }));
  }

  /**
   * Get queued jobs
   */
  getQueuedJobs() {
    return this.jobQueue;
  }

  /**
   * Kill/cancel a running backup job
   */
  async killJob(jobId) {
    const job = this.activeJobs.get(jobId);
    const processInfo = this.activeProcesses.get(jobId);
    
    if (!job && !processInfo) {
      // Check if it's in the queue
      const queueIndex = this.jobQueue.findIndex(job => job.jobId === jobId);
      if (queueIndex !== -1) {
        this.jobQueue.splice(queueIndex, 1);
        await this.updateController(jobId, 'failed', 1, 'Cancelled by user before execution');
        return { success: true, message: 'Job removed from queue' };
      }
      
      return { success: false, message: 'Job not found or already completed' };
    }

    try {
      console.log(`Killing job ${jobId}`);
      
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      
      // Get job details for cleanup
      const vmName = job ? job.vmName : null;
      const scheduleType = job ? job.scheduleType : null;
      const storagePoolPath = job ? (job.storagePoolPath || this.config.backupPath) : this.config.backupPath;
      
      // Release VM lock
      if (job) {
        this.vmLocks.delete(job.vmName);
        console.log(`Released lock for VM: ${job.vmName} (force kill)`);
      }
      
      // Kill the tmux session
      if (processInfo && processInfo.tmuxSession) {
        try {
          // Write a cancel exit-code file so the monitor doesn't double-report
          const exitCodeFile = path.join(this.config.logDir, `${jobId}.exitcode`);
          fs.writeFileSync(exitCodeFile, '130'); // 130 = user cancel (SIGINT convention)
          
          await execAsync(`tmux kill-session -t ${processInfo.tmuxSession}`);
          console.log(`Killed tmux session: ${processInfo.tmuxSession}`);
        } catch (error) {
          console.error(`Failed to kill tmux session: ${error.message}`);
        }
      }
      
      // Manual cleanup: Remove lock file if it exists
      if (vmName && scheduleType && storagePoolPath) {
        const lockDir = path.join(storagePoolPath, 'in_progress_backups');
        const lockFile = path.join(lockDir, `${vmName}_${scheduleType}_backup`);
        
        try {
          if (fs.existsSync(lockFile)) {
            fs.unlinkSync(lockFile);
            console.log(`Manually removed lock file: ${lockFile}`);
          }
        } catch (error) {
          console.error(`Failed to remove lock file ${lockFile}:`, error.message);
        }
        
        // Also clean up progress file
        const progressFile = path.join(storagePoolPath, '.progress', `${vmName}_${scheduleType}.progress`);
        try {
          if (fs.existsSync(progressFile)) {
            fs.unlinkSync(progressFile);
            console.log(`Manually removed progress file: ${progressFile}`);
          }
        } catch (error) {
          console.error(`Failed to remove progress file ${progressFile}:`, error.message);
        }
      }
      
      // Clear intervals
      if (processInfo && processInfo.checkInterval) {
        clearInterval(processInfo.checkInterval);
      }
      if (processInfo && processInfo.progressInterval) {
        clearInterval(processInfo.progressInterval);
      }
      
      // Clean up immediately
      this.activeJobs.delete(jobId);
      this.activeProcesses.delete(jobId);
      this.deleteJobState(jobId);
      
      // Update controller with failed status and user interruption error
      await this.updateController(jobId, 'failed', 1, 'Cancelled by user');
      
      // Process next in queue
      this.processQueue();
      
      return { success: true, message: 'Job cancelled successfully' };
    } catch (error) {
      console.error(`Error killing job ${jobId}:`, error);
      
      // Even if kill fails, clean up our tracking
      this.activeJobs.delete(jobId);
      this.activeProcesses.delete(jobId);
      this.deleteJobState(jobId);
      
      if (job) {
        this.vmLocks.delete(job.vmName);
      }
      
      return { success: true, message: 'Job removed from tracking (kill may have failed)' };
    }
  }

  /**
   * Get tmux session name for a job (for manual attachment/debugging)
   */
  getTmuxSession(jobId) {
    const job = this.activeJobs.get(jobId);
    if (job && job.tmuxSession) {
      return {
        success: true,
        tmuxSession: job.tmuxSession,
        attachCommand: `tmux attach-session -t ${job.tmuxSession}`,
        message: `To attach to this backup session, run: tmux attach-session -t ${job.tmuxSession}`
      };
    }
    
    const processInfo = this.activeProcesses.get(jobId);
    if (processInfo && processInfo.tmuxSession) {
      return {
        success: true,
        tmuxSession: processInfo.tmuxSession,
        attachCommand: `tmux attach-session -t ${processInfo.tmuxSession}`,
        message: `To attach to this backup session, run: tmux attach-session -t ${processInfo.tmuxSession}`
      };
    }
    
    return {
      success: false,
      message: 'Job not found or not running in tmux'
    };
  }

  /**
   * Read log file
   */
  async readLog(jobId, tailLines = null, meta = null) {
    const logFile = path.join(this.config.logDir, `${jobId}.log`);
    let content = '';
    try {
      // pipe-pane captures every \r progress redraw, so a long-running
      // backup's log can reach tens/hundreds of MB. A tail request (the
      // common case — history/log-viewer default to the last 2000 lines)
      // has no business reading the whole file into memory and running the
      // sanitizer regexes over all of it first. Bound the disk read itself:
      // seek to a generous tail window and only sanitize that. Full-log
      // requests (tailLines falsy) still read everything, as intended.
      const tail = Number(tailLines);
      if (Number.isFinite(tail) && tail > 0) {
        content = this._readTailBytes(logFile, 4 * 1024 * 1024); // 4MB, generous vs. 2000 lines
      } else {
        content = fs.readFileSync(logFile, 'utf8');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // fall through to the durable script log
    }

    // The flat per-job log (./logs/<jobId>.log) is written by the agent while
    // it is tracking the job. If the agent lost the job (restart mid-backup
    // with no re-adoption, or the tmux pipe-pane died) that file can be empty
    // or missing — the exact case where the job also ends up "completed /
    // exit -" with nothing to show. The backup script ALSO writes a complete
    // log onto the backup pool itself (<pool>/<vm>/<schedule>/logs/<ts>...log),
    // which survives agent restarts. Fall back to it so logs are never lost.
    if (!content.trim() && meta && meta.vmName && meta.scheduleType && meta.storagePoolPath) {
      const scriptLog = this._findLatestScriptLog(meta.vmName, meta.scheduleType, meta.storagePoolPath);
      if (scriptLog) {
        try {
          content = fs.readFileSync(scriptLog, 'utf8');
          content = `[logs recovered from backup-pool log: ${scriptLog}]\n\n${content}`;
        } catch (_) { /* ignore, return whatever we have */ }
      }
    }

    if (!content) return '';
    // Collapse in-place progress renders and optionally tail — see
    // utils/logSanitizer.js for the full rationale.
    return sanitizeLog(content, tailLines);
  }

  /**
   * Read at most the last `maxBytes` of a file synchronously, without ever
   * loading the full file into memory. Used to bound tail-log reads on
   * large pipe-pane captures. Throws ENOENT like readFileSync when the file
   * doesn't exist, so callers' existing error handling still applies.
   */
  _readTailBytes(filePath, maxBytes) {
    const stat = fs.statSync(filePath); // throws ENOENT if missing
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    if (length <= 0) return '';
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, start);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Newest script log for a VM/schedule on the backup pool. The script writes
   * to <pool>/<vm>/<schedule>/logs/<ts>_<schedule>_<trigger>.log (offsite
   * per-host logs, which contain '_offsite_', are excluded).
   */
  _findLatestScriptLog(vmName, scheduleType, storagePoolPath) {
    try {
      const logsDir = path.join(storagePoolPath, vmName, scheduleType, 'logs');
      if (!fs.existsSync(logsDir)) return null;
      const candidates = fs.readdirSync(logsDir)
        .filter(f => f.endsWith('.log') && !f.includes('_offsite_'))
        .map(f => {
          const full = path.join(logsDir, f);
          try { return { full, mtime: fs.statSync(full).mtimeMs }; } catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtime - a.mtime);
      return candidates.length ? candidates[0].full : null;
    } catch (err) {
      console.error(`[BackupExecutor] _findLatestScriptLog failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Stream log file (for real-time updates)
   */
  streamLog(jobId, callback) {
    const logFile = path.join(this.config.logDir, `${jobId}.log`);
    
    // Check if file exists
    if (!fs.existsSync(logFile)) {
      return null;
    }

    // Create read stream from current position
    const stream = fs.createReadStream(logFile, {
      encoding: 'utf8',
      start: 0
    });

    stream.on('data', (chunk) => {
      callback(chunk);
    });

    stream.on('error', (error) => {
      console.error(`Error streaming log ${jobId}:`, error.message);
    });

    return stream;
  }

  /**
   * Watch log file for changes (for live updates)
   */
  watchLog(jobId, callback) {
    const logFile = path.join(this.config.logDir, `${jobId}.log`);
    
    if (!fs.existsSync(logFile)) {
      return null;
    }

    let lastSize = 0;
    
    const watcher = fs.watch(logFile, (eventType) => {
      if (eventType === 'change') {
        const stats = fs.statSync(logFile);
        const newSize = stats.size;
        
        if (newSize > lastSize) {
          const stream = fs.createReadStream(logFile, {
            encoding: 'utf8',
            start: lastSize,
            end: newSize
          });
          
          stream.on('data', (chunk) => {
            callback(chunk);
          });
          
          lastSize = newSize;
        }
      }
    });

    return watcher;
  }
}

// Export singleton instance
const backupExecutor = new BackupExecutor();

module.exports = backupExecutor;
