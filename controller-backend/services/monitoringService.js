const { getBackupJobs, getBackupHosts } = require('./fileStorage');
const rocketChatService = require('./rocketChatService');
const fs = require('fs').promises;
const path = require('path');

class MonitoringService {
  constructor() {
    this.monitoringInterval = null;
    this.stuckJobThreshold = 4 * 60 * 60 * 1000; // 4 hours
    this.extendedDowntimeThreshold = 6 * 60 * 60 * 1000; // 6 hours
    this.notifiedStuckJobs = new Set();
    this.notifiedDownAgents = new Set();
    this.consecutiveFailures = new Map(); // Track consecutive failures per VM
  }

  async initialize() {
    console.log('[Monitoring] Starting monitoring service...');
    
    // Run monitoring checks every 15 minutes
    this.monitoringInterval = setInterval(async () => {
      await this.runMonitoringChecks();
    }, 15 * 60 * 1000);

    // Run initial check after 5 minutes
    setTimeout(async () => {
      await this.runMonitoringChecks();
    }, 5 * 60 * 1000);

    console.log('[Monitoring] ✓ Monitoring service started');
  }

  async runMonitoringChecks() {
    try {
      await this.checkStuckBackupJobs();
      await this.checkStuckRestoreJobs();
      await this.checkExtendedAgentDowntime();
      await this.checkConsecutiveFailures();
    } catch (error) {
      console.error('[Monitoring] Error running monitoring checks:', error);
      rocketChatService.notifyCriticalError(
        'Monitoring Service',
        error.message,
        'Failed to run monitoring checks'
      );
    }
  }

  /**
   * Check for backup jobs that have been running too long
   */
  async checkStuckBackupJobs() {
    try {
      const jobs = await getBackupJobs();
      const now = Date.now();

      for (const job of jobs) {
        if (job.status !== 'running') continue;

        const startTime = new Date(job.startTime).getTime();
        const duration = now - startTime;

        // If job has been running longer than threshold
        if (duration > this.stuckJobThreshold) {
          const jobKey = `backup-${job.id}`;
          
          // Only notify once per job
          if (!this.notifiedStuckJobs.has(jobKey)) {
            const durationHours = Math.round(duration / (60 * 60 * 1000));
            console.log(`[Monitoring] Stuck backup job detected: ${job.vmName} (${durationHours}h)`);
            
            rocketChatService.notifyBackupStuck(
              job.vmName,
              job.id,
              `${durationHours} hours`
            );
            
            this.notifiedStuckJobs.add(jobKey);
          }
        }
      }

      // Clean up notifications for completed jobs
      for (const jobKey of this.notifiedStuckJobs) {
        const jobId = jobKey.replace('backup-', '');
        const job = jobs.find(j => j.id === jobId);
        if (!job || job.status !== 'running') {
          this.notifiedStuckJobs.delete(jobKey);
        }
      }
    } catch (error) {
      console.error('[Monitoring] Error checking stuck backup jobs:', error);
    }
  }

  /**
   * Check for restore jobs that have been running too long
   */
  async checkStuckRestoreJobs() {
    try {
      const RESTORE_JOBS_FILE = path.join(__dirname, '../data/restore-jobs.json');
      const data = await fs.readFile(RESTORE_JOBS_FILE, 'utf8');
      const jobsData = JSON.parse(data);
      const jobs = jobsData.jobs || [];
      const now = Date.now();

      for (const job of jobs) {
        if (job.status !== 'running') continue;

        const startTime = new Date(job.startTime).getTime();
        const duration = now - startTime;

        // If job has been running longer than threshold
        if (duration > this.stuckJobThreshold) {
          const jobKey = `restore-${job.id}`;
          
          // Only notify once per job
          if (!this.notifiedStuckJobs.has(jobKey)) {
            const durationHours = Math.round(duration / (60 * 60 * 1000));
            console.log(`[Monitoring] Stuck restore job detected: ${job.vmName} (${durationHours}h)`);
            
            rocketChatService.notifyRestoreStuck(
              job.vmName,
              job.id,
              `${durationHours} hours`
            );
            
            this.notifiedStuckJobs.add(jobKey);
          }
        }
      }

      // Clean up notifications for completed jobs
      for (const jobKey of this.notifiedStuckJobs) {
        if (!jobKey.startsWith('restore-')) continue;
        const jobId = jobKey.replace('restore-', '');
        const job = jobs.find(j => j.id === jobId);
        if (!job || job.status !== 'running') {
          this.notifiedStuckJobs.delete(jobKey);
        }
      }
    } catch (error) {
      // File might not exist yet
      if (error.code !== 'ENOENT') {
        console.error('[Monitoring] Error checking stuck restore jobs:', error);
      }
    }
  }

  /**
   * Check for agents that have been down for extended period
   */
  async checkExtendedAgentDowntime() {
    try {
      const hosts = await getBackupHosts();
      const now = Date.now();
      const jobs = await getBackupJobs();

      for (const host of hosts) {
        if (host.status !== 'offline') {
          // Agent is online, remove from notified list
          this.notifiedDownAgents.delete(host.id);
          continue;
        }

        // Check how long agent has been down
        const lastCheck = host.lastHealthCheck ? new Date(host.lastHealthCheck).getTime() : now;
        const downDuration = now - lastCheck;

        if (downDuration > this.extendedDowntimeThreshold) {
          // Only notify once per agent
          if (!this.notifiedDownAgents.has(host.id)) {
            const downHours = Math.round(downDuration / (60 * 60 * 1000));
            
            // Count missed/skipped backups
            const missedBackups = jobs.filter(j => 
              j.backupHostId === host.id && 
              j.status === 'skipped' &&
              new Date(j.startTime).getTime() > lastCheck
            ).length;

            console.log(`[Monitoring] Extended agent downtime: ${host.name} (${downHours}h, ${missedBackups} missed backups)`);
            
            const downSince = new Date(lastCheck).toISOString();
            rocketChatService.notifyAgentDownExtended(
              host.name,
              downSince,
              missedBackups
            );
            
            this.notifiedDownAgents.add(host.id);
          }
        }
      }
    } catch (error) {
      console.error('[Monitoring] Error checking extended agent downtime:', error);
    }
  }

  /**
   * Check for VMs with consecutive backup failures
   */
  async checkConsecutiveFailures() {
    try {
      const jobs = await getBackupJobs();
      
      // Group jobs by VM
      const vmJobs = new Map();
      for (const job of jobs) {
        if (!vmJobs.has(job.vmId)) {
          vmJobs.set(job.vmId, []);
        }
        vmJobs.get(job.vmId).push(job);
      }

      // Check each VM's recent jobs
      for (const [vmId, vmJobList] of vmJobs) {
        // Sort by start time (newest first)
        vmJobList.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
        
        // Count consecutive failures from most recent jobs
        let consecutiveFailures = 0;
        for (const job of vmJobList) {
          if (job.status === 'failed') {
            consecutiveFailures++;
          } else if (job.status === 'completed') {
            break; // Stop at first success
          }
        }

        // Alert if 3 or more consecutive failures
        if (consecutiveFailures >= 3) {
          const currentCount = this.consecutiveFailures.get(vmId) || 0;
          
          // Only notify if failure count increased
          if (consecutiveFailures > currentCount) {
            const latestJob = vmJobList[0];
            console.log(`[Monitoring] Multiple consecutive failures for VM: ${latestJob.vmName} (${consecutiveFailures} failures)`);
            
            rocketChatService.notifyMultipleBackupFailures(
              latestJob.vmName,
              consecutiveFailures,
              latestJob.error || 'Unknown error'
            );
            
            this.consecutiveFailures.set(vmId, consecutiveFailures);
          }
        } else {
          // Reset counter if no consecutive failures
          this.consecutiveFailures.delete(vmId);
        }
      }
    } catch (error) {
      console.error('[Monitoring] Error checking consecutive failures:', error);
    }
  }

  shutdown() {
    console.log('[Monitoring] Shutting down monitoring service...');
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }
  }
}

const monitoringService = new MonitoringService();
module.exports = monitoringService;
