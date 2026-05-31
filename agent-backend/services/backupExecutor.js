const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const controllerAuthService = require('./controllerAuthService');
const concurrencyConfigSyncService = require('./concurrencyConfigSyncService');

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
  }

  /**
   * Resolve the current concurrency limit. Reads from the sync service
   * which itself caches the controller-supplied value.
   */
  getMaxConcurrent() {
    const v = concurrencyConfigSyncService.getMaxConcurrent();
    if (Number.isFinite(v) && v >= 1) return v;
    return 15;
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
      
      // Find backup_manager.sh processes with matching VM name and hypervisor IP
      const { stdout } = await execAsync(
        `ps aux | grep -E "Backup_Manager.sh.*--domain ${vmName}.*--ip ${hypervisorIp}" | grep -v grep || true`
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
          // Check if progress file exists - if yes, backup might still be running
          const basePath = jobState.storagePoolPath || this.config.backupPath;
          const progressFile = path.join(basePath, '.progress', `${vmName}_${scheduleType}.progress`);
          if (fs.existsSync(progressFile)) {
            console.log(`Progress file exists for job ${jobId}, but no tmux session or process found.`);
            console.log(`This might indicate the backup is running but we lost tracking. Marking as failed.`);
            
            // Clean up progress file
            try {
              fs.unlinkSync(progressFile);
            } catch (err) {
              console.error(`Failed to delete orphaned progress file: ${err.message}`);
            }
          }
          
          // Process finished while agent was down - check log for final status
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
   * Handle jobs that completed while agent was down
   */
  async handleCompletedJobWhileDown(jobId, jobState) {
    const { vmName, scheduleType } = jobState;
    
    // Double-check: if progress file still exists, backup might still be running
    const basePath = jobState.storagePoolPath || this.config.backupPath;
    const progressFile = path.join(basePath, '.progress', `${vmName}_${scheduleType}.progress`);
    if (fs.existsSync(progressFile)) {
      console.log(`WARNING: Progress file exists for job ${jobId}, but no tmux session found.`);
      console.log(`This indicates the backup might still be running but we lost tracking.`);
      console.log(`Marking as failed and cleaning up progress file.`);
      
      try {
        fs.unlinkSync(progressFile);
      } catch (err) {
        console.error(`Failed to delete orphaned progress file: ${err.message}`);
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
      const { jobId, vmName, hypervisorIp } = jobState;
      
      // Skip if already attached
      if (this.activeJobs.has(jobId)) {
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
    
    // Check if VM is already being backed up
    if (this.vmLocks.has(vmName)) {
      const existingJobId = this.vmLocks.get(vmName);
      console.log(`VM ${vmName} is already being backed up (job: ${existingJobId})`);
      return { 
        queued: false, 
        error: `Another backup is already in progress for VM: ${vmName}`,
        existingJobId 
      };
    }
    
    this.jobQueue.push(jobData);
    this.processQueue();
    return { queued: true, position: this.jobQueue.length };
  }

  /**
   * Process backup queue
   */
  async processQueue() {
    if (this.activeJobs.size >= this.getMaxConcurrent()) {
      return;
    }

    if (this.jobQueue.length === 0) {
      return;
    }

    const jobData = this.jobQueue.shift();
    await this.executeBackup(jobData);
    
    // Continue processing
    this.processQueue();
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
      storagePoolPath = null
    } = jobData;

    // Validate storage pool path is provided
    if (!storagePoolPath) {
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

    // Create log file
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

    // Offsite hosts
    if (offsiteHosts && offsiteHosts.length > 0) {
      const offsiteIps = offsiteHosts.join(',');
      args.push('--offsite-ip', offsiteIps);
      log(`Offsite hosts: ${offsiteIps}`);
    }

    // Verbose
    if (verbose) {
      args.push('--verbose');
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
      await execAsync(`tmux send-keys -t ${tmuxSession} "cd '${storagePoolPath}' && ${command}; echo \\$? > '${exitCodeFile}'; exit" C-m`);
      
      // Capture tmux output to log file
      await execAsync(`tmux pipe-pane -t ${tmuxSession} -o "cat >> '${logFile}'"`);
      
      log(`Backup started in tmux session: ${tmuxSession}`);
      log(`You can attach with: tmux attach -t ${tmuxSession}`);
      
      // Monitor the tmux session and parse log file for progress
      this.monitorTmuxSession(jobId, tmuxSession, jobData, logFile, logStream);
      
      return { success: true, tmuxSession };
      
    } catch (error) {
      log(`Failed to start backup: ${error.message}`);
      logStream.end();
      
      // Cleanup
      this.vmLocks.delete(vmName);
      this.activeJobs.delete(jobId);
      this.deleteJobState(jobId);
      
      await this.updateController(jobId, 'failed', 1, error.message);
      this.processQueue();
      
      return { success: false, error: error.message };
    }
  }

  /**
   * Monitor tmux session for completion and progress
   */
  monitorTmuxSession(jobId, tmuxSession, jobData, logFile, logStream) {
    const { vmName, scheduleType, storagePoolPath } = jobData;
    
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
                const line = lines[i].toLowerCase();
                if (line.includes('error') || line.includes('failed') || line.includes('exception')) {
                  errorMessage = lines[i].trim();
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
          
          // Cleanup internal state
          this.activeProcesses.delete(jobId);
          this.activeJobs.delete(jobId);
          this.vmLocks.delete(vmName);
          this.deleteJobState(jobId);
          
          // Update controller with accurate status
          if (exitCode === 0) {
            await this.updateController(jobId, 'completed', 0);
          } else {
            await this.updateController(jobId, 'failed', exitCode, errorMessage, null, null, failureReason);
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
  async updateController(jobId, status, exitCode = null, error = null, progress = null, progressText = null, failureReason = null) {
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
      
      // Use controllerAuthService for authenticated requests
      await controllerAuthService.post(
        this.config.controllerUrl,
        `/backups/jobs/${jobId}/update`,
        payload,
        { timeout: 5000 }
      );
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
  async readLog(jobId) {
    const logFile = path.join(this.config.logDir, `${jobId}.log`);
    try {
      return fs.readFileSync(logFile, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        return '';
      }
      throw error;
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
