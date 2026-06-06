const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const execAsync = promisify(exec);

class RestoreExecutor {
  constructor() {
    this.io = null;
    this.config = null;
    this.activeJobs = new Map();
    this.activeProcesses = new Map();
  }

  setSocketIO(io) {
    this.io = io;
  }

  setConfig(config) {
    this.config = config;
  }

  /**
   * Trigger a restore operation
   */
  async triggerRestore(restoreData) {
    const {
      vmName,
      method,
      backupPath,
      restorePath,
      depth,
      disk,
      backupHostId,
      restoreStoragePoolId,
      restoreId: providedRestoreId,
      progressFile: providedProgressFile,
      eventsFile: providedEventsFile
    } = restoreData;

    // Generate restore ID (or use provided one from controller)
    const restoreId = providedRestoreId || uuidv4();
    const timestamp = new Date().toISOString();

    console.log(`[Restore] Triggering restore for ${vmName}`);
    console.log(`[Restore] Restore ID: ${restoreId}`);
    console.log(`[Restore] Backup path: ${backupPath}`);
    console.log(`[Restore] Restore path: ${restorePath}`);

    // Get backup host info (if available)
    let agentName = 'Unknown';
    if (this.config && backupHostId && backupHostId !== 'direct') {
      const backupHost = this.config.backupHosts.find(h => h.id === backupHostId);
      if (backupHost) {
        agentName = backupHost.name;
      }
    }

    // Create job data
    const jobData = {
      id: restoreId,
      jobId: restoreId,
      vmName,
      method,
      backupPath,
      restorePath,
      depth,
      disk,
      agentName,
      status: 'running',
      progress: 0,
      progressText: 'Initializing restore...',
      startTime: timestamp,
      endTime: null,
      error: null,
      logFile: null, // Will be set after validation
      progressFile: providedProgressFile || null // Store provided progress file
    };

    // Build Restore_Manager.sh command
    const scriptPath = path.join(__dirname, '../scripts/Restore_Manager.sh');
    
    // Calculate storage pool base from backup path (needed for both log and progress files)
    const cleanBackupPath = backupPath.replace(/\/$/, ''); // Remove trailing slash
    let storagePoolBase;
    
    if (cleanBackupPath.includes('/archived/')) {
      // Archived backup: go up 3 levels from ARCHIVE_NAME -> archived -> vmname -> storage pool base
      storagePoolBase = path.dirname(path.dirname(path.dirname(cleanBackupPath)));
    } else {
      // Regular backup: go up 2 levels from method -> vmname -> storage pool base
      storagePoolBase = path.dirname(path.dirname(cleanBackupPath));
    }
    
    // Setup log file path - always at storage pool base
    const logsDir = path.join(storagePoolBase, '.logs');
    await fs.mkdir(logsDir, { recursive: true }).catch(err => 
      console.error(`[Restore] Failed to create logs directory:`, err)
    );
    const logFile = path.join(logsDir, `restore_${vmName}_${restoreId}.log`);
    
    jobData.logFile = logFile;
    console.log(`[Restore] Log file will be: ${logFile}`);
    
    let command = `bash "${scriptPath}"`;
    command += ` --domain "${vmName}"`;
    command += ` --method "${method}"`;
    command += ` --backup-path "${backupPath}"`;
    command += ` --restore-path "${restorePath}"`;
    command += ` --restore-id "${restoreId}"`;
    command += ` --log-file "${logFile}"`;
    
    // Use provided progress/events files if available (from controller)
    if (providedProgressFile) {
      command += ` --progress-file "${providedProgressFile}"`;
      console.log(`[Restore] Using provided progress file: ${providedProgressFile}`);
    } else {
      // If not provided, construct it at storage pool base level
      const progressFile = path.join(storagePoolBase, '.progress', `restore_${vmName}_${method}_${restoreId}.progress`);
      command += ` --progress-file "${progressFile}"`;
      jobData.progressFile = progressFile;
      console.log(`[Restore] Constructed progress file: ${progressFile}`);
    }
    if (providedEventsFile) {
      command += ` --events-file "${providedEventsFile}"`;
    }
    
    if (depth !== null && depth !== undefined) {
      command += ` --until "virtnbdbackup.${depth}"`;
    }
    
    if (disk) {
      command += ` --disk "${disk}"`;
    }

    // Create tmux session
    const sanitizedVmName = vmName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const shortRestoreId = restoreId.substring(0, 8);
    const tmuxSession = `restore_${sanitizedVmName}_${shortRestoreId}`;

    jobData.tmuxSession = tmuxSession;

    // Add to active jobs
    this.activeJobs.set(restoreId, jobData);

    // Save job state
    await this.saveJobState(restoreId, jobData);

    // Emit socket event
    if (this.io) {
      console.log(`[Restore] Emitting restore-started event for ${restoreId}`);
      this.io.emit('restore-started', {
        jobId: restoreId,
        vmName,
        method,
        status: 'running'
      });
    } else {
      console.warn(`[Restore] Socket.io not initialized, cannot emit restore-started event`);
    }

    // Start tmux session
    const tmuxCommand = `tmux new-session -d -s "${tmuxSession}" "${command}; tmux wait-for -S ${tmuxSession}_done; tmux kill-session -t ${tmuxSession}"`;

    try {
      await execAsync(tmuxCommand);
      console.log(`[Restore] Tmux session started: ${tmuxSession}`);

      // Start monitoring
      this.monitorRestore(restoreId, tmuxSession, jobData);

      return { restoreId, tmuxSession, status: 'started' };
    } catch (error) {
      console.error(`[Restore] Failed to start tmux session:`, error);
      this.activeJobs.delete(restoreId);
      await this.deleteJobState(restoreId);
      throw error;
    }
  }

  /**
   * Clean up temporary files for a restore job
   */
  async cleanupJobFiles(restoreId, jobData) {
    console.log(`[Restore] Cleaning up files for job ${restoreId}`);
    
    const filesToClean = [];
    
    // Add progress file - ONLY if it matches this specific restore ID
    if (jobData.progressFile && jobData.progressFile.includes(restoreId)) {
      filesToClean.push(jobData.progressFile);
    } else if (jobData.progressFile) {
      console.log(`[Restore] Skipping progress file cleanup - doesn't match restore ID: ${jobData.progressFile}`);
    }
    
    // DO NOT delete log file - keep it for debugging even after job completes/fails
    // Users need to see logs after cancellation or failure
    if (jobData.logFile) {
      console.log(`[Restore] Keeping log file for history: ${jobData.logFile}`);
    }
    
    // Add events file - ONLY if it matches this specific restore ID
    if (jobData.eventsFile && jobData.eventsFile.includes(restoreId)) {
      filesToClean.push(jobData.eventsFile);
    } else if (jobData.eventsFile) {
      console.log(`[Restore] Skipping events file cleanup - doesn't match restore ID: ${jobData.eventsFile}`);
    }
    
    // Delete files
    for (const file of filesToClean) {
      try {
        await fs.unlink(file);
        console.log(`[Restore] Deleted: ${file}`);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          console.error(`[Restore] Failed to delete ${file}:`, error.message);
        }
      }
    }
    
    // Also delete job state file after a delay (keep for history)
    setTimeout(async () => {
      try {
        await this.deleteJobState(restoreId);
        console.log(`[Restore] Deleted job state for ${restoreId}`);
      } catch (error) {
        console.error(`[Restore] Failed to delete job state:`, error.message);
      }
    }, 300000); // Delete after 5 minutes
  }

  /**
   * Monitor restore progress
   */
  async monitorRestore(restoreId, tmuxSession, jobData) {
    const { vmName, backupPath, method, progressFile: providedProgressFile } = jobData;

    console.log(`[Restore] Starting monitor for ${restoreId}`);

    // Use provided progress file path (from controller) or construct it
    let progressFile;
    if (providedProgressFile) {
      progressFile = providedProgressFile;
      console.log(`[Restore] Using provided progress file: ${progressFile}`);
    } else {
      // Construct progress file path: base_backup_path/.progress/restore_{vmName}_{method}_{restoreId}.progress
      const baseBackupPath = path.dirname(path.dirname(backupPath));
      progressFile = path.join(baseBackupPath, '.progress', `restore_${vmName}_${method}_${restoreId}.progress`);
      console.log(`[Restore] Constructed progress file: ${progressFile}`);
    }

    console.log(`[Restore] Monitoring progress file: ${progressFile}`);

    // Monitor progress file
    const progressInterval = setInterval(async () => {
      try {
        const content = await fs.readFile(progressFile, 'utf8');
        const progressData = JSON.parse(content);

        const job = this.activeJobs.get(restoreId);
        if (job && progressData.percentage !== undefined) {
          const oldProgress = job.progress;
          job.progress = progressData.percentage;
          job.progressText = progressData.text || 'Restoring...';

          // Update job state
          await this.saveJobState(restoreId, job);

          // Emit progress update if changed
          if (oldProgress !== job.progress && this.io) {
            console.log(`[Restore] Emitting progress update: ${job.progress}% - ${job.progressText}`);
            this.io.emit('restore-progress', {
              jobId: restoreId,
              progress: job.progress,
              progressText: job.progressText,
              status: job.status
            });
          }
          
          // Update controller with progress
          await this.updateController(restoreId, 'running', null, job.progress, job.progressText);
        }
      } catch (error) {
        // Progress file might not exist yet or be temporarily unavailable
        if (error.code !== 'ENOENT') {
          console.error(`[Restore] Error reading progress file:`, error.message);
        }
      }
    }, 2000);

    // Monitor tmux session
    const sessionInterval = setInterval(async () => {
      try {
        // Check if tmux session still exists
        await execAsync(`tmux has-session -t ${tmuxSession} 2>/dev/null`);
      } catch (error) {
        // Session ended
        console.log(`[Restore] Tmux session ${tmuxSession} ended`);
        clearInterval(progressInterval);
        clearInterval(sessionInterval);

        const job = this.activeJobs.get(restoreId);
        if (job) {
          // Check final status from progress file
          try {
            const content = await fs.readFile(progressFile, 'utf8');
            const progressData = JSON.parse(content);

            if (progressData.percentage >= 100 || progressData.status === 'completed') {
              job.status = 'completed';
              job.progress = 100;
              job.progressText = 'Restore completed successfully';
            } else {
              job.status = 'failed';
              job.error = progressData.text || 'Restore failed';
            }
          } catch (err) {
            // If we can't read progress file, assume failure
            job.status = 'failed';
            job.error = 'Restore process ended unexpectedly';
          }

          job.endTime = new Date().toISOString();

          // Update job state
          await this.saveJobState(restoreId, job);

          // Update controller with final status
          if (job.status === 'completed') {
            await this.updateController(restoreId, 'completed', 0, 100, 'Restore completed successfully');
          } else {
            await this.updateController(restoreId, 'failed', 1, job.progress, job.error);
          }

          // Emit completion event
          if (this.io) {
            if (job.status === 'completed') {
              console.log(`[Restore] Emitting restore-complete event for ${restoreId}`);
              this.io.emit('restore-complete', {
                jobId: restoreId,
                vmName: job.vmName,
                status: 'completed'
              });
            } else {
              console.log(`[Restore] Emitting restore-error event for ${restoreId}: ${job.error}`);
              this.io.emit('restore-error', {
                jobId: restoreId,
                vmName: job.vmName,
                error: job.error,
                status: 'failed'
              });
            }
          }

          // Clean up temporary files
          await this.cleanupJobFiles(restoreId, job);

          // Remove from active jobs after a delay
          setTimeout(() => {
            this.activeJobs.delete(restoreId);
          }, 5000);
        }
      }
    }, 3000);
  }

  /**
   * Get active restore jobs
   */
  getActiveJobs() {
    return Array.from(this.activeJobs.values()).map(job => ({
      ...job,
      canKill: true
    }));
  }

  /**
   * Get all restore jobs (active + history)
   */
  async getAllJobs() {
    const active = this.getActiveJobs();
    const history = await this.getHistory();
    return [...active, ...history];
  }

  /**
   * Get restore history
   */
  async getHistory() {
    try {
      const jobStatesDir = path.join(__dirname, '../data/restore_job_states');
      const files = await fs.readdir(jobStatesDir);
      
      const jobs = [];
      for (const file of files) {
        if (file.endsWith('.json')) {
          try {
            const content = await fs.readFile(path.join(jobStatesDir, file), 'utf8');
            const job = JSON.parse(content);
            
            // Only include completed or failed jobs in history
            if (job.status === 'completed' || job.status === 'failed') {
              jobs.push(job);
            }
          } catch (error) {
            console.error(`Error reading job state file ${file}:`, error);
          }
        }
      }

      // Sort by start time (newest first)
      return jobs.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
    } catch (error) {
      if (error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  /**
   * Get single restore job
   */
  async getJob(restoreId) {
    // Check active jobs first
    const activeJob = this.activeJobs.get(restoreId);
    if (activeJob) {
      return activeJob;
    }

    // Check saved state
    try {
      const jobStatesDir = path.join(__dirname, '../data/restore_job_states');
      const filePath = path.join(jobStatesDir, `${restoreId}.json`);
      const content = await fs.readFile(filePath, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      return null;
    }
  }

  /**
   * Get restore logs
   */
  async getJobLogs(restoreId) {
    const job = await this.getJob(restoreId);
    if (!job) {
      throw new Error('Restore job not found');
    }

    console.log(`[Restore] Getting logs for ${restoreId}, logFile: ${job.logFile}, tmuxSession: ${job.tmuxSession}, isActive: ${this.activeJobs.has(restoreId)}`);

    // Try to get logs from tmux session if still active
    if (job.tmuxSession && this.activeJobs.has(restoreId)) {
      try {
        const { stdout } = await execAsync(`tmux capture-pane -t ${job.tmuxSession} -p -S -`);
        console.log(`[Restore] Got logs from tmux session, length: ${stdout.length}`);
        return stdout;
      } catch (error) {
        console.error(`Error capturing tmux logs:`, error);
      }
    }

    // Try to read from log file
    if (job.logFile) {
      try {
        console.log(`[Restore] Attempting to read log file: ${job.logFile}`);
        const content = await fs.readFile(job.logFile, 'utf8');
        console.log(`[Restore] Successfully read log file, length: ${content.length}`);
        return content;
      } catch (error) {
        if (error.code !== 'ENOENT') {
          console.error(`Error reading log file ${job.logFile}:`, error);
        } else {
          console.error(`Log file not found: ${job.logFile}`);
        }
      }
    } else {
      console.error(`[Restore] No logFile in job data for ${restoreId}`);
    }

    return 'Logs not available';
  }

  /**
   * Kill restore job
   */
  async killJob(restoreId) {
    const job = this.activeJobs.get(restoreId);
    
    if (!job) {
      console.log(`[Restore] Job ${restoreId} not found in active jobs`);
      
      // Check if job exists in saved state
      const savedJob = await this.getJob(restoreId);
      if (!savedJob) {
        console.log(`[Restore] Job ${restoreId} not found in saved state either`);
        return { 
          success: false, 
          message: 'Restore job not found. It may have already completed or been removed.',
          notFound: true
        };
      }
      
      // Job exists in saved state but not active - it may have already completed
      if (savedJob.status === 'completed' || savedJob.status === 'failed') {
        console.log(`[Restore] Job ${restoreId} already ${savedJob.status}`);
        return { 
          success: false, 
          message: `Restore job already ${savedJob.status}`,
          alreadyCompleted: true
        };
      }
      
      // Job is in saved state but not active - try to clean it up anyway
      console.log(`[Restore] Job ${restoreId} found in saved state but not active, cleaning up`);
      
      // Try to kill any tmux session
      if (savedJob.tmuxSession) {
        try {
          await execAsync(`tmux kill-session -t ${savedJob.tmuxSession} 2>/dev/null || true`);
          console.log(`[Restore] Attempted to kill tmux session: ${savedJob.tmuxSession}`);
        } catch (error) {
          console.log(`[Restore] Tmux session may not exist: ${error.message}`);
        }
      }
      
      // Clean up files
      await this.cleanupJobFiles(restoreId, savedJob);
      
      // Update status
      savedJob.status = 'failed';
      savedJob.error = 'Cancelled by user';
      savedJob.endTime = new Date().toISOString();
      await this.saveJobState(restoreId, savedJob);
      
      // Update controller
      await this.updateController(restoreId, 'failed', 1, savedJob.progress, 'Cancelled by user');
      
      return { success: true, message: 'Restore job cleaned up' };
    }

    console.log(`[Restore] Killing active job ${restoreId}`);

    try {
      // Kill tmux session
      if (job.tmuxSession) {
        await execAsync(`tmux kill-session -t ${job.tmuxSession}`);
        console.log(`[Restore] Killed tmux session: ${job.tmuxSession}`);
      }

      // Manually remove lock file (in case trap didn't execute)
      try {
        // Calculate storage pool base path correctly for all backup types
        const cleanBackupPath = job.backupPath.replace(/\/$/, ''); // Remove trailing slash
        let storagePoolBase;
        
        if (cleanBackupPath.includes('/archived/')) {
          // Archived backup: go up 3 levels
          storagePoolBase = path.dirname(path.dirname(path.dirname(cleanBackupPath)));
        } else {
          // Regular backup: go up 2 levels
          storagePoolBase = path.dirname(path.dirname(cleanBackupPath));
        }
        
        const lockDir = path.join(storagePoolBase, 'in_progress_backups');
        const lockFile = path.join(lockDir, `${job.vmName}_${job.method}_backup`);
        
        console.log(`[Restore] Attempting to remove lock file: ${lockFile}`);
        await fs.unlink(lockFile);
        console.log(`[Restore] Successfully removed lock file: ${lockFile}`);
      } catch (lockError) {
        if (lockError.code !== 'ENOENT') {
          console.error(`[Restore] Failed to remove lock file:`, lockError.message);
        } else {
          console.log(`[Restore] Lock file already removed`);
        }
      }
      
      // Manually remove progress file
      if (job.progressFile) {
        try {
          await fs.unlink(job.progressFile);
          console.log(`[Restore] Removed progress file: ${job.progressFile}`);
        } catch (progressError) {
          if (progressError.code !== 'ENOENT') {
            console.error(`[Restore] Failed to remove progress file:`, progressError.message);
          }
        }
      }

      // Update job status
      job.status = 'failed';
      job.error = 'Cancelled by user';
      job.endTime = new Date().toISOString();

      await this.saveJobState(restoreId, job);

      // Update controller
      await this.updateController(restoreId, 'failed', 1, job.progress, 'Cancelled by user');

      // Emit event
      if (this.io) {
        this.io.emit('restore-error', {
          jobId: restoreId,
          vmName: job.vmName,
          error: 'Cancelled by user',
          status: 'failed'
        });
      }

      // Clean up temporary files
      await this.cleanupJobFiles(restoreId, job);

      // Remove from active jobs
      this.activeJobs.delete(restoreId);

      return { success: true, message: 'Restore job cancelled' };
    } catch (error) {
      console.error(`[Restore] Error killing job:`, error);
      
      // Clean up anyway
      this.activeJobs.delete(restoreId);
      
      throw error;
    }
  }

  /**
   * Update controller with restore status
   */
  async updateController(restoreId, status, exitCode = null, progress = null, progressText = null) {
    if (!this.config || !this.config.controllerUrl) {
      console.log(`[Restore] No controller URL configured, skipping status update for ${restoreId}`);
      return;
    }

    try {
      const controllerAuthService = require('./controllerAuthService');
      
      const payload = {
        status,
        exitCode,
      };
      
      if (progress !== null) {
        payload.progress = progress;
      }
      
      if (progressText !== null) {
        payload.progressText = progressText;
      }
      
      if (status === 'completed' || status === 'failed') {
        payload.endTime = new Date().toISOString();
      }
      
      console.log(`[Restore] Updating controller for ${restoreId}: ${status} (${progress}%)`);
      
      // Use controllerAuthService for authenticated requests
      await controllerAuthService.post(
        this.config.controllerUrl,
        `/restore/jobs/${restoreId}/update`,
        payload,
        { timeout: 5000 }
      );
      
      console.log(`[Restore] Controller updated successfully for ${restoreId}`);
    } catch (err) {
      // Don't log every progress update failure to avoid spam
      if (status !== 'running' || !progress) {
        console.error(`[Restore] Failed to update controller for ${restoreId}:`, err.message);
        if (err.response) {
          console.error(`[Restore] Response status: ${err.response.status}`);
          console.error(`[Restore] Response data:`, err.response.data);
        }
      }
    }
  }

  /**
   * Save job state to disk
   */
  async saveJobState(restoreId, jobData) {
    try {
      const jobStatesDir = path.join(__dirname, '../data/restore_job_states');
      await fs.mkdir(jobStatesDir, { recursive: true });
      
      const filePath = path.join(jobStatesDir, `${restoreId}.json`);
      await fs.writeFile(filePath, JSON.stringify(jobData, null, 2));
    } catch (error) {
      console.error(`Error saving job state for ${restoreId}:`, error);
    }
  }

  /**
   * Delete job state from disk
   */
  async deleteJobState(restoreId) {
    try {
      const jobStatesDir = path.join(__dirname, '../data/restore_job_states');
      const filePath = path.join(jobStatesDir, `${restoreId}.json`);
      await fs.unlink(filePath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error(`Error deleting job state for ${restoreId}:`, error);
      }
    }
  }
}

// Singleton instance
const restoreExecutor = new RestoreExecutor();

module.exports = restoreExecutor;
