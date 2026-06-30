const { getBackupJobs, saveBackupJobs, getRestoreJobs, saveRestoreJobs, getBackupHosts } = require('./fileStorage');
const agentService = require('./agentService');

class StartupRecoveryService {
  /**
   * Recover job states on startup by checking actual status on agents
   */
  async recoverJobStates() {
    console.log('[StartupRecovery] Starting job state recovery...');
    
    try {
      await Promise.all([
        this.recoverBackupJobs(),
        this.recoverRestoreJobs()
      ]);
      
      console.log('[StartupRecovery] ✓ Job state recovery completed');
    } catch (error) {
      console.error('[StartupRecovery] ✗ Job state recovery failed:', error.message);
    }
  }

  /**
   * Recover backup job states
   */
  async recoverBackupJobs() {
    try {
      const jobs = await getBackupJobs();
      const runningJobs = jobs.filter(j => 
        (j.status === 'running' || 
        j.status === 'queued' || 
        j.status === 'initializing') &&
        // Controller-side queued jobs waiting for a slot were never sent to
        // the agent. Don't "recover" (fail) them on startup — the scheduler's
        // drainer will promote them to running when a slot frees.
        !(j.status === 'queued' && j.pendingStart)
      );

      if (runningJobs.length === 0) {
        console.log('[StartupRecovery] No running backup jobs to recover');
        return;
      }

      console.log(`[StartupRecovery] Found ${runningJobs.length} backup job(s) in running state`);

      const hosts = await getBackupHosts();
      let recoveredCount = 0;
      let failedCount = 0;

      for (const job of runningJobs) {
        try {
          const host = hosts.find(h => h.id === job.backupHostId);
          
          if (!host) {
            console.log(`[StartupRecovery] ⚠ No host found for job ${job.id}, marking as failed`);
            job.status = 'failed';
            job.error = 'Backup host not found (recovered on startup)';
            job.endTime = new Date().toISOString();
            failedCount++;
            continue;
          }

          // Check if host is online
          if (host.status !== 'online') {
            console.log(`[StartupRecovery] ⚠ Host ${host.name} is offline, marking job ${job.id} as failed`);
            job.status = 'failed';
            job.error = `Backup host ${host.name} is offline (recovered on startup)`;
            job.endTime = new Date().toISOString();
            failedCount++;
            continue;
          }

          // Check if job has been stuck for too long (more than 30 minutes without progress)
          const startTime = new Date(job.startTime).getTime();
          const now = Date.now();
          const elapsedMinutes = (now - startTime) / (1000 * 60);
          
          if ((job.progress === 0 || !job.progress) && elapsedMinutes > 30) {
            console.log(`[StartupRecovery] ⚠ Backup job ${job.id} stuck at ${job.progress || 0}% for ${Math.floor(elapsedMinutes)} minutes, marking as failed`);
            job.status = 'failed';
            job.error = `Job stuck at initialization for ${Math.floor(elapsedMinutes)} minutes (recovered on startup)`;
            job.endTime = new Date().toISOString();
            job.exitCode = 1;
            failedCount++;
            continue;
          }

          // Generate report to check actual status
          console.log(`[StartupRecovery] Checking actual status for job ${job.id} on ${host.name}...`);
          const reportResult = await agentService.getBackupReport(host.url);

          if (!reportResult.success || !reportResult.data) {
            console.log(`[StartupRecovery] ⚠ Could not get report from ${host.name}, marking job ${job.id} as failed`);
            job.status = 'failed';
            job.error = 'Could not verify job status (recovered on startup)';
            job.endTime = new Date().toISOString();
            failedCount++;
            continue;
          }

          // Check if VM has a running backup in the report
          const vmReport = reportResult.data.vms?.find(v => v.name === job.vmName);
          const hasRunningBackup = vmReport?.schedules?.some(s => 
            s.status === 'in_progress' || s.status === 'partial'
          );

          if (hasRunningBackup) {
            console.log(`[StartupRecovery] ✓ Job ${job.id} is actually running on agent`);
            recoveredCount++;
          } else {
            // Job is not running on agent, check if it completed
            const hasRecentBackup = vmReport?.schedules?.some(s => {
              if (!s.last_backup_date) return false;
              const backupTime = new Date(s.last_backup_date).getTime();
              const jobStartTime = new Date(job.startTime).getTime();
              // If backup was created after job started, it might have completed
              return backupTime > jobStartTime;
            });

            if (hasRecentBackup) {
              console.log(`[StartupRecovery] ✓ Job ${job.id} appears to have completed`);
              job.status = 'completed';
              job.progress = 100;
              job.endTime = new Date().toISOString();
              job.exitCode = 0;
              recoveredCount++;
            } else {
              console.log(`[StartupRecovery] ✗ Job ${job.id} is not running and did not complete, marking as failed`);
              job.status = 'failed';
              job.error = 'Job was interrupted by service restart (recovered on startup)';
              job.endTime = new Date().toISOString();
              job.exitCode = 1;
              failedCount++;
            }
          }
        } catch (error) {
          console.error(`[StartupRecovery] Error recovering job ${job.id}:`, error.message);
          job.status = 'failed';
          job.error = `Recovery error: ${error.message}`;
          job.endTime = new Date().toISOString();
          failedCount++;
        }
      }

      // Save updated jobs
      await saveBackupJobs(jobs);
      console.log(`[StartupRecovery] Backup jobs: ${recoveredCount} recovered, ${failedCount} marked as failed`);
    } catch (error) {
      console.error('[StartupRecovery] Error recovering backup jobs:', error.message);
    }
  }

  /**
   * Recover restore job states
   */
  async recoverRestoreJobs() {
    try {
      const jobs = await getRestoreJobs();
      const runningJobs = jobs.filter(j => 
        j.status === 'running' || 
        j.status === 'queued' || 
        j.status === 'initializing'
      );

      if (runningJobs.length === 0) {
        console.log('[StartupRecovery] No running restore jobs to recover');
        return;
      }

      console.log(`[StartupRecovery] Found ${runningJobs.length} restore job(s) in running state`);

      const hosts = await getBackupHosts();
      let recoveredCount = 0;
      let failedCount = 0;

      for (const job of runningJobs) {
        try {
          const host = hosts.find(h => h.id === job.backupHostId);
          
          if (!host) {
            console.log(`[StartupRecovery] ⚠ No host found for restore job ${job.id}, marking as failed`);
            job.status = 'failed';
            job.error = 'Backup host not found (recovered on startup)';
            job.endTime = new Date().toISOString();
            failedCount++;
            continue;
          }

          // Check if host is online
          if (host.status !== 'online') {
            console.log(`[StartupRecovery] ⚠ Host ${host.name} is offline, marking restore job ${job.id} as failed`);
            job.status = 'failed';
            job.error = `Backup host ${host.name} is offline (recovered on startup)`;
            job.endTime = new Date().toISOString();
            failedCount++;
            continue;
          }

          // Check if job has been stuck for too long (more than 30 minutes without progress)
          const startTime = new Date(job.startTime).getTime();
          const now = Date.now();
          const elapsedMinutes = (now - startTime) / (1000 * 60);
          
          if (job.progress === 0 && elapsedMinutes > 30) {
            console.log(`[StartupRecovery] ⚠ Restore job ${job.id} stuck at 0% for ${Math.floor(elapsedMinutes)} minutes, marking as failed`);
            job.status = 'failed';
            job.error = `Job stuck at initialization for ${Math.floor(elapsedMinutes)} minutes (recovered on startup)`;
            job.endTime = new Date().toISOString();
            job.exitCode = 1;
            failedCount++;
            continue;
          }

          // Try to check if restore completed by checking the restore path
          try {
            console.log(`[StartupRecovery] Checking restore path for job ${job.id}...`);
            
            // Check if restore path exists and has files
            const client = agentService.createAgentClient(host.url, host.id, host.name);
            
            // Try to get restore status from agent
            // We'll check if the progress file still exists
            const checkResult = await client.post('/api/restore/check-status', {
              jobId: job.id,
              progressFile: job.progressFile,
              restorePath: job.restorePath
            }, { timeout: 10000 }).catch(err => {
              console.log(`[StartupRecovery] Could not check restore status: ${err.message}`);
              return null;
            });

            if (checkResult && checkResult.data) {
              const { exists, completed, hasFiles } = checkResult.data.data || {};
              
              if (completed) {
                console.log(`[StartupRecovery] ✓ Restore job ${job.id} appears to have completed`);
                job.status = 'completed';
                job.progress = 100;
                job.progressText = 'Restore completed';
                job.endTime = new Date().toISOString();
                job.exitCode = 0;
                recoveredCount++;
                continue;
              } else if (hasFiles && !exists) {
                // Progress file gone but restore path has files - likely completed
                console.log(`[StartupRecovery] ✓ Restore job ${job.id} has files but no progress file, marking as completed`);
                job.status = 'completed';
                job.progress = 100;
                job.progressText = 'Restore completed';
                job.endTime = new Date().toISOString();
                job.exitCode = 0;
                recoveredCount++;
                continue;
              }
            }
          } catch (error) {
            console.log(`[StartupRecovery] Could not verify restore completion: ${error.message}`);
          }

          // If we can't verify, mark as failed since restore was interrupted
          console.log(`[StartupRecovery] ✗ Cannot verify restore job ${job.id} status, marking as failed`);
          job.status = 'failed';
          job.error = 'Restore job was interrupted by service restart (recovered on startup)';
          job.endTime = new Date().toISOString();
          job.exitCode = 1;
          failedCount++;
        } catch (error) {
          console.error(`[StartupRecovery] Error recovering restore job ${job.id}:`, error.message);
          job.status = 'failed';
          job.error = `Recovery error: ${error.message}`;
          job.endTime = new Date().toISOString();
          failedCount++;
        }
      }

      // Save updated jobs
      await saveRestoreJobs(jobs);
      console.log(`[StartupRecovery] Restore jobs: ${recoveredCount} recovered, ${failedCount} marked as failed`);
    } catch (error) {
      console.error('[StartupRecovery] Error recovering restore jobs:', error.message);
    }
  }
}

const startupRecoveryService = new StartupRecoveryService();
module.exports = startupRecoveryService;
