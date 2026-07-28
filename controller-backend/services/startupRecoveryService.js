const { getBackupJobs, getRestoreJobs, saveRestoreJobs, getBackupHosts } = require('./fileStorage');
const agentService = require('./agentService');
const { snapshotJobs, commitJobChanges } = require('./jobReconcileCommit');

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
      // Recovery queries every host before it writes, and at boot the agents
      // are reconnecting and posting updates while the tmux-session adoption
      // runs. Commit a diff rather than this snapshot so none of that is lost.
      const before = snapshotJobs(jobs);
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
      let skippedCount = 0;

      // Group the jobs we can actually verify (online host) by host so we can
      // ask the agent for authoritative live status in one batch per host.
      const jobsByHost = new Map();

      for (const job of runningJobs) {
        const host = hosts.find(h => h.id === job.backupHostId);

        if (!host) {
          console.log(`[StartupRecovery] ⚠ No host found for job ${job.id}, marking as failed`);
          job.status = 'failed';
          job.error = 'Backup host not found (recovered on startup)';
          job.endTime = new Date().toISOString();
          job.exitCode = 1;
          failedCount++;
          continue;
        }

        if (host.status !== 'online') {
          // The host being marked offline does NOT mean the backup died — a long
          // offsite rsync can outlive a transient agent blip. Leave the job as-is;
          // agentSyncService reconciles it against real live-status the moment the
          // agent comes back online. Failing it here is exactly what turned a
          // still-running backup into a "failed" history entry.
          console.log(`[StartupRecovery] Host ${host.name} offline — deferring job ${job.id} to reconnect reconcile`);
          skippedCount++;
          continue;
        }

        if (!jobsByHost.has(host.id)) jobsByHost.set(host.id, { host, jobs: [] });
        jobsByHost.get(host.id).jobs.push(job);
      }

      // Reconcile each online host's jobs against authoritative live status
      // (tmux/process/exit-code/fresh-progress) — the SAME source of truth the
      // reconnect reconciler uses. A live tmux session (e.g. mid offsite rsync)
      // reports `running`, so the job is kept, not failed.
      for (const { host, jobs: hostJobs } of jobsByHost.values()) {
        const ids = hostJobs.map(j => j.id);
        let byId = new Map();
        try {
          const result = await agentService.getJobsLiveStatusBatch(host.url, ids);
          if (result.success && Array.isArray(result.data)) {
            byId = new Map(result.data.map(d => [d.jobId, d]));
          } else {
            console.log(`[StartupRecovery] ⚠ Live-status batch failed on ${host.name}: ${result.error || 'no data'}`);
          }
        } catch (e) {
          console.log(`[StartupRecovery] ⚠ Live-status batch error on ${host.name}: ${e.message}`);
        }

        for (const job of hostJobs) {
          try {
            const live = byId.get(job.id);

            if (live && live.status === 'running') {
              console.log(`[StartupRecovery] ✓ Job ${job.id} still running on agent (phase=${live.phase || '?'})`);
              if (typeof live.progress === 'number') job.progress = live.progress;
              if (live.progressText) job.progressText = live.progressText;
              if (live.phase) job.phase = live.phase;
              recoveredCount++;
              continue;
            }

            if (live && live.status === 'completed') {
              console.log(`[StartupRecovery] ✓ Job ${job.id} completed while we were away`);
              job.status = 'completed';
              job.progress = 100;
              job.endTime = job.endTime || new Date().toISOString();
              if (typeof live.exitCode === 'number') job.exitCode = live.exitCode;
              recoveredCount++;
              continue;
            }

            if (live && live.status === 'failed') {
              console.log(`[StartupRecovery] ✗ Job ${job.id} failed on agent (${live.phase || 'failed'})`);
              job.status = 'failed';
              job.endTime = job.endTime || new Date().toISOString();
              if (typeof live.exitCode === 'number') job.exitCode = live.exitCode;
              job.error = job.error || live.reason ||
                (live.phase === 'orphaned'
                  ? 'Backup orphaned: lock file present without active process'
                  : 'Backup failed (recovered on startup)');
              failedCount++;
              continue;
            }

            // live.status === 'unknown' (or no response): the agent has no live
            // evidence and no recorded exit code — the run really was interrupted
            // (tmux gone, no fresh progress). This is the genuine "died during a
            // restart" case, and also clears long-stale zombie jobs.
            console.log(`[StartupRecovery] ✗ Job ${job.id} has no live evidence, marking as interrupted`);
            job.status = 'failed';
            job.error = 'Job was interrupted by service restart (recovered on startup)';
            job.endTime = new Date().toISOString();
            job.exitCode = 1;
            failedCount++;
          } catch (error) {
            console.error(`[StartupRecovery] Error recovering job ${job.id}:`, error.message);
            job.status = 'failed';
            job.error = `Recovery error: ${error.message}`;
            job.endTime = new Date().toISOString();
            job.exitCode = 1;
            failedCount++;
          }
        }
      }

      // Save updated jobs
      await commitJobChanges(before, jobs);
      console.log(`[StartupRecovery] Backup jobs: ${recoveredCount} recovered, ${failedCount} failed, ${skippedCount} deferred (host offline)`);
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
