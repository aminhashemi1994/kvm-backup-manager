const cron = require('node-cron');
const { 
  getBackupSchedules, 
  getBackupHosts, 
  getHypervisors, 
  getVirtualMachines,
  getBackupJobs,
  saveBackupJobs,
  getStoragePools,
  getOffsiteHosts,
  appendLog 
} = require('./fileStorage');
const agentService = require('./agentService');
const backupCycleService = require('./backupCycleService');
const rocketChatService = require('./rocketChatService');
const { v4: uuidv4 } = require('uuid');

class SchedulerService {
  constructor() {
    this.tasks = new Map();
    this.customDaysTasks = new Map(); // For custom-days schedules
    this.io = null;
    this.healthCheckInterval = null;
    this.queueReconcilerInterval = null;
    this._retryTimers = new Map(); // Map of jobId -> setTimeout handle for pending retries
    this._hostLocks = new Map(); // Map of hostId -> promise chain (serializes slot decisions)
  }

  async initialize(io) {
    this.io = io;
    console.log('Initializing backup scheduler...');
    await this.loadSchedules();
    this.startHealthChecks();
    this.startQueueReconciler();
    console.log(`✓ Loaded ${this.tasks.size} scheduled tasks`);
  }

  startHealthChecks() {
    this.healthCheckInterval = setInterval(async () => {
      await this.checkHostsHealth();
    }, 60000); // Check every minute
  }

  /**
   * Periodic concurrency reconciler + queue drainer.
   *
   * This is the safety net that guarantees scheduled backups always make
   * progress, even when completion callbacks are lost (controller restart,
   * network blip, agent never reported "done"). Every couple of minutes, for
   * each online host it:
   *   1. Reconciles unfinished jobs against the agent's REAL state
   *      (tmux/process/lock/progress) so finished jobs are finalized and
   *      their concurrency slots are freed.
   *   2. Fails genuinely-stuck jobs (queued but never started, or running far
   *      past any sane runtime) so a lost event can't permanently occupy a
   *      slot and starve every other VM.
   *   3. Drains the concurrent-limit queue into any freed slots.
   *
   * Without this, phantom "running"/"queued" jobs accumulate and eventually
   * consume all concurrency slots — so only a handful of VMs back up each
   * night and the rest silently miss their schedule.
   */
  startQueueReconciler() {
    // Run shortly after startup, then on a fixed interval.
    setTimeout(() => this.periodicMaintenance().catch(() => {}), 15 * 1000);
    this.queueReconcilerInterval = setInterval(() => {
      this.periodicMaintenance().catch(err =>
        console.error('[Scheduler] periodic maintenance error:', err.message)
      );
    }, SchedulerService.QUEUE_RECONCILE_INTERVAL_MS);
  }

  /**
   * One periodic pass that guarantees forward progress for schedules:
   *   1. Catch-up: fire any recently-expected run that has no job record
   *      (node-cron missed the tick, or the controller was briefly down/busy
   *      around the scheduled time). Bounded to a short recent window so it
   *      never replays ancient runs (that's missedRunService's job on startup).
   *   2. Reconcile + drain per host: finalize finished/stuck jobs and start
   *      queued/concurrency-skipped backups in freed slots.
   */
  async periodicMaintenance() {
    await this.catchUpRecentMisses();
    await this.reconcileAndDrainAllHosts();
  }

  /**
   * Active catch-up for missed cron fires. For each enabled recurring
   * schedule, if its most recent expected occurrence within the catch-up
   * window produced NO job record at all, fire it now. Guards on "does a job
   * already exist?" so it never double-fires a run node-cron already handled.
   */
  async catchUpRecentMisses() {
    try {
      const now = Date.now();
      const windowStart = now - SchedulerService.CATCHUP_WINDOW_MS;
      // Ignore occurrences in the very recent past — node-cron is expected to
      // handle those itself; we only step in once they're clearly overdue.
      const settleCutoff = now - SchedulerService.CATCHUP_SETTLE_MS;
      if (settleCutoff <= windowStart) return;

      const recurring = new Set(['daily', 'weekly', 'monthly', 'interval', 'cron', 'custom-days']);
      const missedRunService = require('./missedRunService');
      const schedules = await getBackupSchedules();
      const jobs = await getBackupJobs();
      const tolMs = 60 * 60 * 1000; // 1h match tolerance

      for (const schedule of schedules) {
        if (schedule.enabled === false) continue;
        if (!recurring.has(schedule.scheduleType)) continue;

        // Don't catch up before the schedule existed.
        const createdMs = schedule.createdAt ? new Date(schedule.createdAt).getTime() : 0;
        const from = new Date(Math.max(windowStart, createdMs || windowStart));
        const to = new Date(settleCutoff);
        if (from.getTime() >= to.getTime()) continue;

        let occ;
        try {
          occ = missedRunService.computeMissedRuns(schedule, from, to) || [];
        } catch {
          continue;
        }
        if (occ.length === 0) continue;

        const lastOccMs = occ[occ.length - 1].scheduledAt.getTime();

        // Has ANY job for this schedule been recorded around that occurrence?
        // (any status — running/queued/completed/failed/skipped means it fired)
        const alreadyFired = jobs.some(j =>
          j.scheduleId === schedule.id &&
          new Date(j.startTime).getTime() >= lastOccMs - tolMs
        );
        if (alreadyFired) continue;

        console.log(`[Scheduler] Catch-up: firing schedule ${schedule.id} (${schedule.scheduleType}) for overdue occurrence at ${new Date(lastOccMs).toISOString()}`);
        // Fire it. Slot management (concurrency) is handled inside.
        this.executeScheduledBackup(schedule, {
          replay: true,
          scheduledAt: new Date(lastOccMs),
          reason: 'catch-up: missed scheduled fire',
          actor: 'system:catchup',
          triggeredBy: 'system',
        }).catch(err =>
          console.error(`[Scheduler] catch-up fire failed for ${schedule.id}:`, err.message)
        );
      }
    } catch (err) {
      console.error('[Scheduler] catchUpRecentMisses error:', err.message);
    }
  }

  async reconcileAndDrainAllHosts() {
    const hosts = await getBackupHosts();
    for (const host of hosts) {
      if (host.status && host.status !== 'online') continue;
      try {
        // 1. Reconcile real state (frees completed/failed/orphaned jobs).
        const agentSyncService = require('./agentSyncService');
        await agentSyncService.syncHost(host);
        // 2. Fail genuinely-stuck jobs to free leaked slots.
        await this.failStuckJobsOnHost(host.id);
        // 3. Drain the concurrent-limit queue into free slots.
        await this.releaseConcurrentSlotsOnHost(host.id);
      } catch (err) {
        console.error(`[Scheduler] reconcile/drain error for ${host.name}:`, err.message);
      }
    }
  }

  /**
   * Mark jobs that are stuck in a non-terminal state as failed so their
   * concurrency slot is released. A 'queued' job that never started within
   * QUEUE_STUCK_MS is dead; a 'running' job older than RUNNING_MAX_MS is far
   * past any reasonable backup runtime and is treated as dead. agentSync runs
   * first, so anything the agent could finalize already has been — this only
   * catches jobs the agent has no record of.
   */
  async failStuckJobsOnHost(backupHostId) {
    const jobs = await getBackupJobs();
    const now = Date.now();
    let changed = false;

    for (const j of jobs) {
      if (j.backupHostId !== backupHostId) continue;
      if (j.status !== 'running' && j.status !== 'queued') continue;
      // A job intentionally waiting in the concurrency queue is NOT stuck —
      // it will be promoted when a slot frees. Never fail these.
      if (j.status === 'queued' && j.pendingStart) continue;

      const startedMs = new Date(j.startTime).getTime();
      const ageMs = now - (Number.isFinite(startedMs) ? startedMs : now);

      // If the agent confirmed this job alive very recently (syncHost runs
      // just before this sweep and refreshes lastSyncedAt for live jobs),
      // don't treat it as stuck even if it's a long-running large-VM backup.
      const syncedMs = j.lastSyncedAt ? new Date(j.lastSyncedAt).getTime() : 0;
      const recentlyConfirmed = syncedMs && (now - syncedMs) < SchedulerService.RECENT_SYNC_MS;

      const queuedStuck = j.status === 'queued' && ageMs > SchedulerService.QUEUE_STUCK_MS;
      const runningStuck = j.status === 'running'
        && ageMs > SchedulerService.RUNNING_MAX_MS
        && !recentlyConfirmed;

      if (queuedStuck || runningStuck) {
        j.status = 'failed';
        j.endTime = new Date().toISOString();
        j.error = queuedStuck
          ? `Job never started within ${Math.round(SchedulerService.QUEUE_STUCK_MS / 60000)} minutes (queue stuck) — releasing slot`
          : `Job exceeded maximum runtime of ${Math.round(SchedulerService.RUNNING_MAX_MS / 3600000)}h with no completion — releasing slot`;
        j.failureReason = 'stuck';
        changed = true;
        try { appendLog(j.id, j.error); } catch {}
        if (this.io) this.io.emit('job-updated', j);
        console.log(`[Scheduler] Freed stuck slot: ${j.vmName} (${j.status === 'failed' ? 'was ' : ''}${queuedStuck ? 'queued' : 'running'}, age ${Math.round(ageMs / 60000)}m)`);
      }
    }

    if (changed) await saveBackupJobs(jobs);
  }

  /**
   * Serialize a critical section per backup host. All slot decisions (a cron
   * fire deciding run-vs-queue, and the drainer promoting queued jobs) run
   * through this so the "count active → decide → reserve slot" sequence is
   * atomic. Without it, 20 schedules firing at 02:00 could all read "<limit
   * active" before any writes its running job, and all start at once.
   */
  _withHostLock(hostId, fn) {
    const key = hostId || '_global';
    const prev = this._hostLocks.get(key) || Promise.resolve();
    const run = prev.then(() => fn());
    // Keep the chain alive but swallow errors so one failure doesn't break
    // the lock for subsequent callers.
    this._hostLocks.set(key, run.then(() => {}, () => {}));
    return run;
  }

  /**
   * Count jobs currently occupying a concurrency slot on a host. Jobs that
   * have been running/queued longer than STALE_SLOT_MS are excluded: they are
   * almost certainly dead (a daily backup that's been "running" >24h has been
   * superseded), and counting them would let phantom jobs block every new run.
   * Jobs still waiting in the concurrency queue (pendingStart) do not count.
   */
  countActiveJobsOnHost(jobs, hostId, now = Date.now()) {
    return jobs.filter(j => {
      if (j.backupHostId !== hostId) return false;
      if (j.status !== 'running' && j.status !== 'queued') return false;
      // Jobs waiting in the concurrency queue (not yet sent to the agent) do
      // NOT occupy a slot — otherwise they would block themselves.
      if (j.status === 'queued' && j.pendingStart) return false;
      const startedMs = new Date(j.startTime).getTime();
      if (Number.isFinite(startedMs) && now - startedMs > SchedulerService.STALE_SLOT_MS) {
        return false; // stale — don't let it hold a slot
      }
      return true;
    });
  }

  async checkHostsHealth() {
    try {
      // Read fresh data each time to avoid overwriting changes
      const hosts = await getBackupHosts();
      let hasChanges = false;
      const hostsComingOnline = [];
      
      for (const host of hosts) {
        try {
          // Ensure URL has protocol
          let url = host.url;
          if (!url.startsWith('http://') && !url.startsWith('https://')) {
            url = 'http://' + url;
          }
          
          const result = await agentService.healthCheck(url);
          const newStatus = result.success ? 'online' : 'offline';
          
          if (result.success) {
            // Reset failure tracking on success
            host._consecutiveFailures = 0;
          }
          
          // Only update if status changed
          if (host.status !== newStatus) {
            if (newStatus === 'offline') {
              // Item 4: Debounce — require 2 consecutive failures
              host._consecutiveFailures = (host._consecutiveFailures || 0) + 1;
              if (host._consecutiveFailures < 2) {
                continue; // Don't mark offline yet
              }
            }
            
            const oldStatus = host.status;
            host.status = newStatus;
            host.lastHealthCheck = new Date().toISOString();
            hasChanges = true;
            
            if (!result.success) {
              console.log(`Backup host ${host.name} is offline: ${result.error}`);
            } else if (oldStatus === 'offline' && newStatus === 'online') {
              console.log(`Backup host ${host.name} came back online`);
              hostsComingOnline.push(host);
              
              // Notify RocketChat
              rocketChatService.notifyAgentConnected(host.name);
            }
          }
        } catch (error) {
          host._consecutiveFailures = (host._consecutiveFailures || 0) + 1;
          if (host._consecutiveFailures >= 2) {
            const newStatus = 'offline';
            if (host.status !== newStatus) {
              host.status = newStatus;
              host.lastHealthCheck = new Date().toISOString();
              hasChanges = true;
              
              // Notify RocketChat
              rocketChatService.notifyAgentDisconnected(host.name);
            }
          }
        }
      }

      // Only save if there were actual changes
      if (hasChanges) {
        const { saveBackupHosts } = require('./fileStorage');
        await saveBackupHosts(hosts);
      }

      // Auto-retry skipped backups for hosts that came back online
      if (hostsComingOnline.length > 0) {
        await this.retrySkippedBackupsForHosts(hostsComingOnline);
      }

      if (this.io) {
        this.io.emit('hosts-status-update', hosts);
      }
    } catch (error) {
      console.error('Error checking hosts health:', error);
    }
  }

  /**
   * Auto-retry skipped backups when agent comes back online
   */
  async retrySkippedBackupsForHosts(hosts) {
    try {
      const jobs = await getBackupJobs();
      const schedules = await getBackupSchedules();
      
      // Find skipped jobs from the last 24 hours for these hosts
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const skippedJobs = jobs.filter(job => 
        job.status === 'skipped' && 
        job.canRetry === true &&
        new Date(job.startTime) > oneDayAgo &&
        hosts.some(h => h.id === job.backupHostId)
      );

      if (skippedJobs.length === 0) {
        return;
      }

      console.log(`Found ${skippedJobs.length} skipped backup(s) to retry for hosts that came back online`);

      for (const skippedJob of skippedJobs) {
        const host = hosts.find(h => h.id === skippedJob.backupHostId);
        if (!host) continue;

        console.log(`Auto-retrying skipped backup for VM: ${skippedJob.vmName} on host: ${host.name}`);

        // Notify RocketChat
        rocketChatService.notifyBackupRetry(skippedJob.vmName, host.name, skippedJob.id);

        // Find the schedule for this job
        const schedule = schedules.find(s => s.id === skippedJob.scheduleId);
        if (!schedule) {
          console.log(`Schedule not found for skipped job ${skippedJob.id}, skipping retry`);
          continue;
        }

        // Create a new job for retry
        const newJobId = uuidv4();
        const retryJob = {
          ...skippedJob,
          id: newJobId,
          status: 'queued',
          startTime: new Date().toISOString(),
          endTime: null,
          exitCode: null,
          error: null,
          retryOf: skippedJob.id,
          progress: 0,
          progressText: 'Queued (auto-retry)...',
          autoRetry: true,
        };

        jobs.push(retryJob);
        await saveBackupJobs(jobs);

        await appendLog(newJobId, `Auto-retry of skipped job ${skippedJob.id}`);
        await appendLog(newJobId, `Original job was skipped because: ${skippedJob.error}`);
        await appendLog(newJobId, `Agent ${host.name} came back online, retrying now`);

        // Emit event
        if (this.io) {
          this.io.emit('backup-started', retryJob);
        }

        // Trigger backup on agent
        try {
          const vms = await getVirtualMachines();
          const vm = vms.find(v => v.id === skippedJob.vmId);
          if (!vm) {
            console.error(`VM not found for retry: ${skippedJob.vmId}`);
            continue;
          }

          const hypervisors = await getHypervisors();
          const hypervisor = hypervisors.find(h => h.id === vm.hypervisorId);
          if (!hypervisor) {
            console.error(`Hypervisor not found for retry: ${vm.hypervisorId}`);
            continue;
          }

          const backupData = {
            jobId: newJobId,
            vmName: skippedJob.vmName,
            hypervisorId: hypervisor.id,
            hypervisorIp: hypervisor.ip,
            method: skippedJob.method,
            noCompression: skippedJob.noCompression,
            noVerify: skippedJob.noVerify,
          };

          // Check if this was a scheduled backup with cycle management
          if (schedule && (schedule.scheduleType === 'daily' || schedule.scheduleType === 'interval' || schedule.scheduleType === 'cron' || schedule.scheduleType === 'weekly')) {
            await agentService.triggerScheduledBackup(host.url, {
              ...backupData,
              vmId: skippedJob.vmId,
              incrementalCount: schedule.incrementalCount,
            });
          } else {
            await agentService.triggerBackup(host.url, backupData);
          }

          // Update job status
          retryJob.status = 'running';
          await saveBackupJobs(jobs);

          console.log(`Successfully triggered auto-retry for ${skippedJob.vmName}`);
        } catch (error) {
          console.error(`Failed to trigger auto-retry for ${skippedJob.vmName}:`, error.message);
          retryJob.status = 'failed';
          retryJob.error = `Auto-retry failed: ${error.message}`;
          retryJob.endTime = new Date().toISOString();
          await saveBackupJobs(jobs);
          await appendLog(newJobId, `Error triggering auto-retry: ${error.message}`);
          
          if (this.io) {
            this.io.emit('backup-error', retryJob);
          }
        }
      }
    } catch (error) {
      console.error('Error retrying skipped backups:', error);
    }
  }

  /**
   * Handle a failed scheduled backup: if the schedule still has retry
   * attempts left, schedule another attempt after the configured delay.
   * The schedule itself is never disabled or removed — it keeps its
   * normal cron cadence regardless of how many retries fail.
   *
   * IMPORTANT: This retries the SAME job (updates its status to 'running' again),
   * rather than creating a new job record.
   *
   * Called from the job-update handler when a scheduled job ends in
   * 'failed'. `failedJob` is the controller-side job record that just
   * failed (it carries attemptNumber / maxAttempts / retryDelayMinutes /
   * scheduleId).
   */
  async handleScheduledBackupFailure(failedJob) {
    try {
      if (!failedJob || !failedJob.scheduled || !failedJob.scheduleId) return;

      const attempt = failedJob.attemptNumber || 1;
      const maxAttempts = failedJob.maxAttempts || 1;

      if (attempt >= maxAttempts) {
        console.log(`[Scheduler] ${failedJob.vmName}: all ${maxAttempts} attempt(s) exhausted; giving up until next scheduled run`);
        return;
      }

      const schedules = await getBackupSchedules();
      const schedule = schedules.find(s => s.id === failedJob.scheduleId);
      if (!schedule) {
        console.log(`[Scheduler] Cannot retry: schedule ${failedJob.scheduleId} no longer exists`);
        return;
      }

      const delayMinutes = typeof failedJob.retryDelayMinutes === 'number'
        ? failedJob.retryDelayMinutes
        : (typeof schedule.retryDelayMinutes === 'number' ? schedule.retryDelayMinutes : 5);
      const delayMs = Math.max(0, delayMinutes) * 60 * 1000;
      const nextAttempt = attempt + 1;

      console.log(`[Scheduler] ${failedJob.vmName}: attempt ${attempt}/${maxAttempts} failed; scheduling attempt ${nextAttempt} in ${delayMinutes} minute(s)`);

      // Track the timer so shutdown can clear it and so it can be cancelled
      const timer = setTimeout(async () => {
        this._retryTimers.delete(failedJob.id);
        
        try {
          // Re-read the schedule at fire time in case it was edited/deleted
          const freshSchedules = await getBackupSchedules();
          const fresh = freshSchedules.find(s => s.id === failedJob.scheduleId);
          if (!fresh) {
            console.log(`[Scheduler] Retry aborted: schedule ${failedJob.scheduleId} was removed during the delay`);
            // Mark job as failed since we can't retry
            const jobs = await getBackupJobs();
            const job = jobs.find(j => j.id === failedJob.id);
            if (job && job.status === 'retrying') {
              job.status = 'failed';
              job.error = (job.error || '') + ' (retry aborted: schedule was deleted)';
              job.endTime = new Date().toISOString();
              await saveBackupJobs(jobs);
            }
            return;
          }
          
          // Retry the SAME job (don't create a new one)
          await this.retryExistingJob(failedJob.id, fresh, nextAttempt, maxAttempts);
        } catch (err) {
          console.error(`[Scheduler] Retry execution failed for ${failedJob.vmName}:`, err.message);
        }
      }, delayMs);

      if (timer.unref) timer.unref();
      this._retryTimers.set(failedJob.id, timer);
    } catch (err) {
      console.error('[Scheduler] handleScheduledBackupFailure error:', err.message);
    }
  }

  /**
   * Retry an existing job (same job ID, just re-trigger the backup on the agent)
   */
  async retryExistingJob(jobId, schedule, attemptNumber, maxAttempts) {
    try {
      const jobs = await getBackupJobs();
      const job = jobs.find(j => j.id === jobId);
      
      if (!job) {
        console.error(`[Scheduler] Cannot retry: job ${jobId} not found`);
        return;
      }

      const hosts = await getBackupHosts();
      const hypervisors = await getHypervisors();
      const vms = await getVirtualMachines();

      const vm = vms.find(v => v.id === schedule.vmId);
      if (!vm) {
        console.error(`[Scheduler] Cannot retry: VM ${schedule.vmId} not found`);
        job.status = 'failed';
        job.error = (job.error || '') + ' (retry failed: VM not found)';
        job.endTime = new Date().toISOString();
        job.retryAt = null; // Clear retry timestamp
        await saveBackupJobs(jobs);
        return;
      }

      const hypervisor = hypervisors.find(h => h.id === vm.hypervisorId);
      if (!hypervisor) {
        console.error(`[Scheduler] Cannot retry: Hypervisor ${vm.hypervisorId} not found`);
        job.status = 'failed';
        job.error = (job.error || '') + ' (retry failed: Hypervisor not found)';
        job.endTime = new Date().toISOString();
        job.retryAt = null; // Clear retry timestamp
        await saveBackupJobs(jobs);
        return;
      }

      const host = hosts.find(h => h.id === vm.backupHostId);
      if (!host) {
        console.error(`[Scheduler] Cannot retry: Backup host ${vm.backupHostId} not found`);
        job.status = 'failed';
        job.error = (job.error || '') + ' (retry failed: Backup host not found)';
        job.endTime = new Date().toISOString();
        job.retryAt = null; // Clear retry timestamp
        await saveBackupJobs(jobs);
        return;
      }

      if (host.status !== 'online') {
        console.error(`[Scheduler] Cannot retry: Backup host ${host.name} is offline`);
        job.status = 'failed';
        job.error = (job.error || '') + ' (retry failed: Backup host offline)';
        job.endTime = new Date().toISOString();
        job.retryAt = null; // Clear retry timestamp
        await saveBackupJobs(jobs);
        return;
      }

      // Update job for retry attempt
      job.attemptNumber = attemptNumber;
      job.status = 'running';
      job.progress = 0;
      job.progressText = `Retrying (attempt ${attemptNumber}/${maxAttempts})...`;
      job.error = null; // Clear previous error
      job.exitCode = null;
      // Don't update startTime - keep original
      // Don't set endTime - job is running again
      job.endTime = null;
      job.retryAt = null; // Clear retry timestamp since retry is starting now

      await saveBackupJobs(jobs);
      await appendLog(jobId, `\n=== RETRY ATTEMPT ${attemptNumber}/${maxAttempts} ===`);
      await appendLog(jobId, `Retrying backup after ${job.retryDelayMinutes || 5} minute delay...`);

      // Emit event
      if (this.io) {
        this.io.emit('backup-started', job);
      }

      // Resolve storage pool
      const pools = await getStoragePools();
      const pool = pools.find(p => p.id === schedule.storagePoolId && p.backupHostId === host.id);
      if (!pool) {
        throw new Error('Storage pool not found on backup host');
      }

      // Resolve offsite hosts
      let offsiteHostIps = [];
      const offsiteIds = Array.isArray(schedule.offsiteHostIds)
        ? schedule.offsiteHostIds
        : (schedule.offsiteHostId ? [schedule.offsiteHostId] : []);
      if (offsiteIds.length > 0) {
        const allOffsiteHosts = await getOffsiteHosts();
        offsiteHostIps = offsiteIds
          .map(id => allOffsiteHosts.find(h => h.id === id))
          .filter(Boolean)
          .map(h => h.ip);
      }

      const agentScheduleType = (() => {
        switch (schedule.scheduleType) {
          case 'once':
          case 'monthly':
          case 'daily':
          case 'weekly': return schedule.scheduleType;
          case 'interval':
          case 'cron': return 'daily';
          case 'custom-days': return 'custom';
          default: return 'once';
        }
      })();

      let url = host.url;
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'http://' + url;
      }

      // Trigger backup on agent with SAME job ID
      await agentService.triggerBackup(url, {
        jobId: job.id, // SAME job ID!
        vmName: vm.name,
        hypervisorId: hypervisor.id,
        hypervisorIp: hypervisor.ip,
        scheduleType: agentScheduleType,
        storagePoolId: pool.id,
        storagePoolPath: pool.path,
        retention: schedule.retention || 7,
        keepArchive: schedule.keepArchive || 2,
        compression: schedule.compression || 2,
        noCompression: schedule.noCompression || false,
        noVerify: schedule.noVerify || false,
        offsiteHosts: offsiteHostIps,
        verbose: schedule.verbose || false,
        method: job.method, // Use same method as original
        isRetry: true, // NEW: Flag to indicate this is a retry
        ...(schedule.scheduleType === 'daily' || schedule.scheduleType === 'interval' || schedule.scheduleType === 'cron' || schedule.scheduleType === 'weekly'
          ? { vmId: vm.id, incrementalCount: schedule.incrementalCount }
          : {}),
      });

      console.log(`[Scheduler] ✓ Retry triggered for ${vm.name} (attempt ${attemptNumber}/${maxAttempts})`);
    } catch (err) {
      console.error(`[Scheduler] Failed to retry job ${jobId}:`, err.message);
      
      // Mark job as failed
      const jobs = await getBackupJobs();
      const job = jobs.find(j => j.id === jobId);
      if (job) {
        job.status = 'failed';
        job.error = (job.error || '') + ` (retry trigger failed: ${err.message})`;
        job.endTime = new Date().toISOString();
        await saveBackupJobs(jobs);
        await appendLog(jobId, `ERROR: Failed to trigger retry: ${err.message}`);
        
        if (this.io) {
          this.io.emit('backup-error', job);
        }
      }
    }
  }

  /**
   * Release backups that were skipped because the host's concurrent
   * limit was hit. Called whenever a backup job on that host finishes
   * (completed / failed / cancelled), which frees up a slot.
   *
   * The previous behaviour stalled forever in scenarios like the user's:
   *   - 5 backups fire at once
   *   - First few hit the concurrent_limit and get marked skipped
   *   - When the running ones finish, no one ever retried the skipped ones
   *
   * This method picks up to N skipped-by-concurrent-limit jobs (oldest
   * first), where N is the number of free slots on that host right now,
   * and re-issues them through the same payload-resolving path that
   * `executeScheduledBackup` uses.
   */
  async releaseConcurrentSlotsOnHost(backupHostId) {
    if (!backupHostId) return;
    try {
      // Serialize with scheduled-fire slot decisions so promotion and new
      // fires can't both claim the same freed slot and exceed the limit.
      await this._withHostLock(backupHostId, async () => {
      const hosts = await getBackupHosts();
      const host = hosts.find(h => h.id === backupHostId);
      if (!host) return;

      const jobs = await getBackupJobs();
      const running = this.countActiveJobsOnHost(jobs, backupHostId);
      const rawMax = host.maxConcurrentBackups;
      const max = (rawMax === undefined || rawMax === null) ? 20 : Number(rawMax);
      const unlimited = max === 0;
      // 0 = unlimited: release every queued/skipped-concurrent candidate.
      const free = unlimited ? Number.MAX_SAFE_INTEGER : max - running.length;
      if (free <= 0) return;

      // Only consider jobs from the last 24h to avoid replaying ancient
      // runs the operator may have intentionally abandoned.
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

      // Primary path: real QUEUED jobs waiting for a slot (pendingStart).
      // These are promoted IN PLACE (same job id) — true FIFO queueing.
      const queuedWaiting = jobs
        .filter(j =>
          j.backupHostId === backupHostId &&
          j.status === 'queued' &&
          j.pendingStart === true &&
          new Date(j.startTime).getTime() > oneDayAgo
        )
        .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

      // Legacy/back-compat path: jobs previously recorded as skipped due to
      // the concurrent limit (older records before queueing was introduced).
      const skippedLegacy = jobs
        .filter(j =>
          j.backupHostId === backupHostId &&
          j.status === 'skipped' &&
          j.canRetry === true &&
          j.skippedReason === 'concurrent_limit' &&
          new Date(j.startTime).getTime() > oneDayAgo
        )
        .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

      // Fill free slots: prefer queued-waiting (oldest first), then legacy.
      const toStart = [...queuedWaiting, ...skippedLegacy].slice(0, free);
      if (toStart.length === 0) return;

      console.log(`[Scheduler] Starting ${toStart.length} queued backup(s) on ${host.name} (free slots: ${unlimited ? '∞' : free}/${unlimited ? '∞' : max})`);

      const schedules = await getBackupSchedules();
      for (const job of toStart) {
        if (job.status === 'queued' && job.pendingStart) {
          await this._startQueuedJob(job, host, schedules, jobs);
        } else {
          await this._retrySkippedJob(job, host, schedules, jobs);
        }
      }
      });
    } catch (err) {
      console.error('[Scheduler] releaseConcurrentSlotsOnHost error:', err.message);
    }
  }

  /**
   * Promote a waiting (pendingStart) queued job to running IN PLACE: resolve
   * its payload from the schedule and trigger the agent, keeping the same job
   * id so the UI shows a clean queued → running transition.
   */
  async _startQueuedJob(job, host, schedules, jobs) {
    const schedule = schedules.find(s => s.id === job.scheduleId);
    if (!schedule) {
      // Schedule gone — can't resolve payload. Fail so the slot isn't held.
      job.status = 'failed';
      job.pendingStart = false;
      job.endTime = new Date().toISOString();
      job.error = `Cannot start queued backup: schedule ${job.scheduleId} no longer exists`;
      await saveBackupJobs(jobs);
      if (this.io) this.io.emit('job-updated', job);
      return;
    }

    // Mark running first so it occupies a slot and won't be double-started.
    job.status = 'running';
    job.pendingStart = false;
    job.startTime = new Date().toISOString();
    job.progress = 0;
    job.progressText = 'Starting (slot freed)...';
    await saveBackupJobs(jobs);
    await appendLog(job.id, 'Slot freed — starting queued backup');
    if (this.io) this.io.emit('backup-started', job);

    try {
      const vms = await getVirtualMachines();
      const vm = vms.find(v => v.id === job.vmId);
      if (!vm) throw new Error(`VM ${job.vmId} not found`);
      const hypervisors = await getHypervisors();
      const hypervisor = hypervisors.find(h => h.id === vm.hypervisorId);
      if (!hypervisor) throw new Error(`Hypervisor ${vm.hypervisorId} not found`);

      const pools = await getStoragePools();
      const pool = pools.find(p => p.id === schedule.storagePoolId && p.backupHostId === host.id);
      if (!pool) throw new Error('Storage pool for schedule not found on backup host');

      let offsiteHostIps = [];
      const offsiteIds = Array.isArray(schedule.offsiteHostIds)
        ? schedule.offsiteHostIds
        : (schedule.offsiteHostId ? [schedule.offsiteHostId] : []);
      if (offsiteIds.length > 0) {
        const allOffsiteHosts = await getOffsiteHosts();
        offsiteHostIps = offsiteIds
          .map(id => allOffsiteHosts.find(h => h.id === id))
          .filter(Boolean)
          .map(h => h.ip);
      }

      const agentScheduleType = (() => {
        switch (schedule.scheduleType) {
          case 'once':
          case 'monthly':
          case 'daily':
          case 'weekly': return schedule.scheduleType;
          case 'interval':
          case 'cron': return 'daily';
          case 'custom-days': return 'custom';
          default: return 'once';
        }
      })();

      let url = host.url;
      if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'http://' + url;

      await agentService.triggerBackup(url, {
        jobId: job.id,
        vmName: vm.name,
        hypervisorId: hypervisor.id,
        hypervisorIp: hypervisor.ip,
        scheduleType: agentScheduleType,
        storagePoolId: pool.id,
        storagePoolPath: pool.path,
        retention: schedule.retention || 7,
        keepArchive: schedule.keepArchive || 2,
        compression: schedule.compression || 2,
        noCompression: schedule.noCompression || false,
        noVerify: schedule.noVerify || false,
        offsiteHosts: offsiteHostIps,
        verbose: schedule.verbose || false,
        ...(schedule.scheduleType === 'daily' || schedule.scheduleType === 'interval' || schedule.scheduleType === 'cron' || schedule.scheduleType === 'weekly'
          ? { vmId: vm.id, incrementalCount: schedule.incrementalCount }
          : {}),
      });

      await saveBackupJobs(jobs);
      console.log(`[Scheduler] ✓ Started queued backup for ${job.vmName} on ${host.name}`);
    } catch (err) {
      job.status = 'failed';
      job.error = `Failed to start queued backup: ${err.message}`;
      job.endTime = new Date().toISOString();
      await saveBackupJobs(jobs);
      await appendLog(job.id, job.error);
      if (this.io) this.io.emit('backup-error', job);
      console.error(`[Scheduler] ✗ Failed to start queued backup for ${job.vmName}: ${err.message}`);
    }
  }

  /**
   * Internal: re-issue a single skipped job. Reuses the exact same
   * payload shape as executeScheduledBackup (storage pool, offsite hosts,
   * retention, compression — all from the schedule record). Without
   * this the agent rejects with 400 because storagePoolPath is missing.
   */
  async _retrySkippedJob(skipped, host, schedules, jobs) {
    const schedule = schedules.find(s => s.id === skipped.scheduleId);
    if (!schedule) {
      console.log(`[Scheduler] Cannot retry ${skipped.id}: schedule ${skipped.scheduleId} not found`);
      return;
    }

    const newJobId = uuidv4();
    const retryJob = {
      ...skipped,
      id: newJobId,
      status: 'queued',
      startTime: new Date().toISOString(),
      endTime: null,
      exitCode: null,
      error: null,
      retryOf: skipped.id,
      progress: 0,
      progressText: 'Queued (auto-retry)...',
      autoRetry: true,
    };
    jobs.push(retryJob);
    await saveBackupJobs(jobs);
    await appendLog(newJobId, `Auto-retry of job ${skipped.id} that was skipped due to concurrent_limit`);

    if (this.io) this.io.emit('backup-started', retryJob);

    try {
      const vms = await getVirtualMachines();
      const vm = vms.find(v => v.id === skipped.vmId);
      if (!vm) throw new Error(`VM ${skipped.vmId} not found`);
      const hypervisors = await getHypervisors();
      const hypervisor = hypervisors.find(h => h.id === vm.hypervisorId);
      if (!hypervisor) throw new Error(`Hypervisor ${vm.hypervisorId} not found`);

      const pools = await getStoragePools();
      const pool = pools.find(p => p.id === schedule.storagePoolId && p.backupHostId === host.id);
      if (!pool) throw new Error('Storage pool for schedule not found on backup host');

      let offsiteHostIps = [];
      const offsiteIds = Array.isArray(schedule.offsiteHostIds)
        ? schedule.offsiteHostIds
        : (schedule.offsiteHostId ? [schedule.offsiteHostId] : []);
      if (offsiteIds.length > 0) {
        const allOffsiteHosts = await getOffsiteHosts();
        offsiteHostIps = offsiteIds
          .map(id => allOffsiteHosts.find(h => h.id === id))
          .filter(Boolean)
          .map(h => h.ip);
      }

      const agentScheduleType = (() => {
        switch (schedule.scheduleType) {
          case 'once':
          case 'monthly':
          case 'daily':
          case 'weekly': return schedule.scheduleType;
          case 'interval':
          case 'cron': return 'daily';
          case 'custom-days': return 'custom';
          default: return 'once';
        }
      })();

      let url = host.url;
      if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'http://' + url;

      await agentService.triggerBackup(url, {
        jobId: newJobId,
        vmName: vm.name,
        hypervisorId: hypervisor.id,
        hypervisorIp: hypervisor.ip,
        scheduleType: agentScheduleType,
        storagePoolId: pool.id,
        storagePoolPath: pool.path,
        retention: schedule.retention || 7,
        keepArchive: schedule.keepArchive || 2,
        compression: schedule.compression || 2,
        noCompression: schedule.noCompression || false,
        noVerify: schedule.noVerify || false,
        offsiteHosts: offsiteHostIps,
        verbose: schedule.verbose || false,
        ...(schedule.scheduleType === 'daily' || schedule.scheduleType === 'interval' || schedule.scheduleType === 'cron' || schedule.scheduleType === 'weekly'
          ? { vmId: vm.id, incrementalCount: schedule.incrementalCount }
          : {}),
      });

      retryJob.status = 'running';
      await saveBackupJobs(jobs);
      try {
        rocketChatService.notifyBackupRetry(skipped.vmName, host.name, skipped.id);
      } catch (_) { /* non-fatal */ }
      console.log(`[Scheduler] ✓ Auto-retry triggered for ${skipped.vmName} on ${host.name}`);
    } catch (err) {
      retryJob.status = 'failed';
      retryJob.error = `Auto-retry failed: ${err.message}`;
      retryJob.endTime = new Date().toISOString();
      await saveBackupJobs(jobs);
      await appendLog(newJobId, `Error triggering auto-retry: ${err.message}`);
      if (this.io) this.io.emit('backup-error', retryJob);
      console.error(`[Scheduler] ✗ Auto-retry failed for ${skipped.vmName}: ${err.message}`);
    }
  }

  async loadSchedules() {
    this.tasks.forEach(task => task.stop());
    this.tasks.clear();
    this.customDaysTasks.forEach(task => task.stop());
    this.customDaysTasks.clear();

    const schedules = await getBackupSchedules();
    
    for (const schedule of schedules) {
      if (schedule.enabled !== false) {
        this.createTask(schedule);
      }
    }
  }

  createTask(schedule) {
    try {
      if (schedule.scheduleType === 'custom-days') {
        this.createCustomDaysTasks(schedule);
        return;
      }

      if (!schedule.cronExpression) {
        console.error(`No cron expression for schedule ${schedule.id}`);
        return;
      }

      if (!cron.validate(schedule.cronExpression)) {
        console.error(`Invalid cron expression for schedule ${schedule.id}: ${schedule.cronExpression}`);
        return;
      }

      const task = cron.schedule(schedule.cronExpression, async () => {
        console.log(`Running scheduled backup: ${schedule.id} (${schedule.scheduleType})`);
        await this.executeScheduledBackup(schedule);
      });

      this.tasks.set(schedule.id, task);
      console.log(`Created ${schedule.scheduleType} task for schedule ${schedule.id}: ${schedule.cronExpression}`);
    } catch (error) {
      console.error(`Error creating task for schedule ${schedule.id}:`, error);
    }
  }

  createCustomDaysTasks(schedule) {
    // For custom-days, create a cron task for each custom date
    const tasks = [];
    
    schedule.customDates.forEach((customDate, index) => {
      try {
        const [hour, minute] = customDate.time.split(':');
        const date = new Date(customDate.date);
        const dayOfMonth = date.getDate();
        const month = date.getMonth() + 1;
        
        // Create cron for specific date and time
        const cronExpression = `${minute} ${hour} ${dayOfMonth} ${month} *`;
        
        if (!cron.validate(cronExpression)) {
          console.error(`Invalid cron for custom date ${index}: ${cronExpression}`);
          return;
        }

        const task = cron.schedule(cronExpression, async () => {
          console.log(`Running custom-days backup: ${schedule.id} - ${customDate.date}`);
          await this.executeCustomDaysBackup(schedule, customDate);
        });

        tasks.push(task);
        console.log(`Created custom-days task ${index} for schedule ${schedule.id}: ${cronExpression}`);
      } catch (error) {
        console.error(`Error creating custom-days task ${index}:`, error);
      }
    });

    if (tasks.length > 0) {
      this.customDaysTasks.set(schedule.id, tasks);
    }
  }

  /**
   * Programmatic entry point for replaying a missed scheduled run.
   * Delegates to executeScheduledBackup with metadata so the resulting job
   * is tagged as a missed-run replay. Returns true if a job was actually
   * triggered, false otherwise (e.g. host offline + skipped).
   */
  async fireScheduleNow(schedule, opts = {}) {
    try {
      await this.executeScheduledBackup(schedule, {
        replay: true,
        scheduledAt: opts.scheduledAt || new Date(),
        reason: opts.reason || 'manual replay',
        method: opts.method,
        actor: opts.actor || 'system:replay',
        triggeredBy: opts.triggeredBy || 'system',
      });
      return true;
    } catch (err) {
      console.error('[Scheduler] fireScheduleNow failed:', err.message);
      return false;
    }
  }

  /**
   * Update lastFiredAt on a schedule (used by interval anchor + missed-run calc)
   */
  async _markScheduleFired(scheduleId) {
    try {
      const { getBackupSchedules, saveBackupSchedules } = require('./fileStorage');
      const schedules = await getBackupSchedules();
      const idx = schedules.findIndex(s => s.id === scheduleId);
      if (idx === -1) return;
      schedules[idx].lastFiredAt = new Date().toISOString();
      await saveBackupSchedules(schedules);
    } catch (e) {
      // non-fatal
    }
  }

  async executeScheduledBackup(schedule, replayMeta = null) {
    const jobId = uuidv4();
    
    try {
      const hosts = await getBackupHosts();
      const hypervisors = await getHypervisors();
      const vms = await getVirtualMachines();

      const vm = vms.find(v => v.id === schedule.vmId);
      if (!vm) {
        console.error(`VM not found: ${schedule.vmId}`);
        return;
      }

      const hypervisor = hypervisors.find(h => h.id === vm.hypervisorId);
      if (!hypervisor) {
        console.error(`Hypervisor not found: ${vm.hypervisorId}`);
        return;
      }

      const host = hosts.find(h => h.id === vm.backupHostId);
      if (!host) {
        console.error(`Backup host not found: ${vm.backupHostId}`);
        return;
      }

      // Determine backup method based on schedule type
      let method = 'full';
      
      if (schedule.scheduleType === 'daily' || schedule.scheduleType === 'interval' || schedule.scheduleType === 'cron' || schedule.scheduleType === 'weekly') {
        // Use backup cycle service to determine method (same logic as daily)
        const cycleStatus = await backupCycleService.getBackupCycleStatus(vm.id);
        method = cycleStatus.nextMethod;
      }

      if (host.status !== 'online') {
        console.error(`Backup host ${host.name} is offline, skipping backup`);
        
        // Create a skipped job record for tracking
        const skippedJob = {
          id: jobId,
          scheduleId: schedule.id,
          vmId: vm.id,
          vmName: vm.name,
          hypervisorIp: hypervisor.ip,
          backupHostId: host.id,
          backupHostName: host.name,
          method,
          noCompression: schedule.noCompression || false,
          noVerify: schedule.noVerify || false,
          status: 'skipped',
          startTime: new Date().toISOString(),
          endTime: new Date().toISOString(),
          exitCode: null,
          error: `Backup host ${host.name} was offline or unreachable`,
          scheduled: true,
          skippedReason: 'agent_offline',
          canRetry: true,
        };

        const jobs = await getBackupJobs();
        jobs.push(skippedJob);
        await saveBackupJobs(jobs);
        
        await appendLog(jobId, `Backup skipped: ${skippedJob.error}`);
        
        // Notify RocketChat
        rocketChatService.notifyBackupSkipped(vm.name, host.name, skippedJob.error);
        
        if (this.io) {
          this.io.emit('backup-skipped', skippedJob);
        }
        
        return;
      }

      // Reserve a concurrency slot atomically. All scheduled fires for this
      // host serialize here so the count→decide→create sequence can't race
      // (otherwise 20 backups firing at 02:00 could all start at once). A
      // limit of 0 means UNLIMITED — every backup starts immediately.
      let job = null;
      let didQueue = false;
      await this._withHostLock(host.id, async () => {
        const jobs = await getBackupJobs();
        const runningJobsOnHost = this.countActiveJobsOnHost(jobs, host.id);

        const rawMax = host.maxConcurrentBackups;
        const maxConcurrent = (rawMax === undefined || rawMax === null) ? 20 : Number(rawMax);
        const unlimited = maxConcurrent === 0;

        if (!unlimited && runningJobsOnHost.length >= maxConcurrent) {
          console.log(`Concurrent limit (${maxConcurrent}) reached for ${host.name}; queueing backup for ${vm.name}`);

          // Create a real QUEUED job (waiting for a free slot). It is NOT sent
          // to the agent yet and does NOT occupy a concurrency slot
          // (pendingStart). The drainer promotes it to running in place as
          // soon as a slot frees up.
          const queuedJob = {
            id: jobId,
            scheduleId: schedule.id,
            vmId: vm.id,
            vmName: vm.name,
            hypervisorIp: hypervisor.ip,
            backupHostId: host.id,
            backupHostName: host.name,
            method,
            noCompression: schedule.noCompression || false,
            noVerify: schedule.noVerify || false,
            status: 'queued',
            pendingStart: true,
            queuedReason: 'concurrent_limit',
            startTime: new Date().toISOString(),
            endTime: null,
            exitCode: null,
            error: null,
            progress: 0,
            progressText: `Queued — waiting for a free slot (limit ${maxConcurrent})`,
            scheduled: true,
            canRetry: true,
            ...(replayMeta ? { replay: true, originallyScheduledAt: replayMeta.scheduledAt, replayReason: replayMeta.reason } : {}),
          };

          jobs.push(queuedJob);
          await saveBackupJobs(jobs);
          await appendLog(jobId, `Backup queued: concurrent limit ${maxConcurrent} reached (currently ${runningJobsOnHost.length} active). Will start automatically when a slot frees.`);
          if (this.io) this.io.emit('backup-queued', queuedJob);
          didQueue = true;
          return;
        }

        // Slot available — create the running job and persist it INSIDE the
        // lock so sibling fires immediately count it against the limit.
        job = {
          id: jobId,
          scheduleId: schedule.id,
          vmId: vm.id,
          vmName: vm.name,
          hypervisorIp: hypervisor.ip,
          backupHostId: host.id,
          backupHostName: host.name,
          method,
          noCompression: schedule.noCompression || false,
          noVerify: schedule.noVerify || false,
          status: 'running',
          startTime: new Date().toISOString(),
          endTime: null,
          exitCode: null,
          error: null,
          scheduled: true,
          attemptNumber: replayMeta && replayMeta.attemptNumber ? replayMeta.attemptNumber : 1,
          maxAttempts: (typeof schedule.retryCount === 'number' ? schedule.retryCount : 3) + 1,
          retryDelayMinutes: typeof schedule.retryDelayMinutes === 'number' ? schedule.retryDelayMinutes : 5,
          ...(replayMeta ? {
            replay: true,
            originallyScheduledAt: replayMeta.scheduledAt
              ? new Date(replayMeta.scheduledAt).toISOString()
              : null,
            replayReason: replayMeta.reason || 'replay',
            actor: replayMeta.actor || 'system:replay',
            triggeredBy: replayMeta.triggeredBy || 'system',
          } : {
            actor: 'system:scheduler',
            triggeredBy: 'system',
          }),
        };
        jobs.push(job);
        await saveBackupJobs(jobs);
      });

      // Queued for later — a freed slot will promote it. Try an immediate
      // drain in case a slot opened up since we counted.
      if (didQueue) {
        this.releaseConcurrentSlotsOnHost(host.id).catch(() => {});
        return;
      }
      // Defensive: if no job was created for any reason, stop here.
      if (!job) return;

      this.io.emit('backup-started', job);
      const replayPrefix = replayMeta ? '[MISSED-REPLAY] ' : '';
      const originalAt = replayMeta && replayMeta.scheduledAt
        ? ` (originally scheduled at ${new Date(replayMeta.scheduledAt).toISOString()})`
        : '';
      await appendLog(
        jobId,
        `${replayPrefix}Scheduled backup started for VM: ${vm.name} ` +
        `(${schedule.scheduleType}, method: ${method})${originalAt}`
      );

      // Ensure URL has protocol
      let url = host.url;
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'http://' + url;
      }

      // Resolve the storage pool the user picked when they created this
      // schedule. The agent's /api/backup/trigger requires storagePoolPath;
      // without it the request is rejected with 400.
      const pools = await getStoragePools();
      const pool = pools.find(p => p.id === schedule.storagePoolId && p.backupHostId === host.id);
      if (!pool) {
        throw new Error(
          schedule.storagePoolId
            ? `Storage pool ${schedule.storagePoolId} not found on backup host ${host.name}`
            : 'Schedule has no storage pool configured'
        );
      }

      // Resolve offsite host IPs (optional)
      let offsiteHostIps = [];
      const offsiteIds = Array.isArray(schedule.offsiteHostIds)
        ? schedule.offsiteHostIds
        : (schedule.offsiteHostId ? [schedule.offsiteHostId] : []);
      if (offsiteIds.length > 0) {
        const allOffsiteHosts = await getOffsiteHosts();
        offsiteHostIps = offsiteIds
          .map(id => allOffsiteHosts.find(h => h.id === id))
          .filter(Boolean)
          .map(h => h.ip);
      }

      // Map controller schedule types to the agent script's accepted values.
      // The Backup_Manager.sh script accepts only: once | monthly | daily |
      // weekly | custom. The controller has additional logical types
      // (interval, cron, custom-days) that all behave like daily chains
      // for the script's purposes. The cycle service still controls the
      // full/inc rotation via incrementalCount.
      const agentScheduleType = (() => {
        switch (schedule.scheduleType) {
          case 'once':
          case 'monthly':
          case 'daily':
          case 'weekly':
            return schedule.scheduleType;
          case 'interval':
          case 'cron':
            return 'daily';
          case 'custom-days':
            return 'custom';
          default:
            return 'once';
        }
      })();

      const backupData = {
        jobId,
        vmName: vm.name,
        hypervisorId: hypervisor.id,
        hypervisorIp: hypervisor.ip,
        // scheduleType drives the script's behaviour (chain vs single).
        // We deliberately do NOT send `method` here. The form has no
        // top-level method picker for daily/weekly/interval/cron
        // schedules, and the Backup_Manager.sh script auto-detects
        // full vs inc based on existing checkpoints when --method is
        // omitted. The cycleStatus.nextMethod we computed above is
        // used only as informational metadata on the controller-side
        // job record.
        scheduleType: agentScheduleType,
        storagePoolId: pool.id,
        storagePoolPath: pool.path,
        retention: schedule.retention || 7,
        keepArchive: schedule.keepArchive || 2,
        compression: schedule.compression || 2,
        noCompression: schedule.noCompression || false,
        noVerify: schedule.noVerify || false,
        offsiteHosts: offsiteHostIps,
        verbose: schedule.verbose || false,
        ...(schedule.scheduleType === 'daily' || schedule.scheduleType === 'interval' || schedule.scheduleType === 'cron' || schedule.scheduleType === 'weekly'
          ? { vmId: vm.id, incrementalCount: schedule.incrementalCount }
          : {}),
      };

      // PRE-FLIGHT CHECK: Verify no backup is already in progress
      console.log(`[Scheduler] Checking if backup is already in progress for ${vm.name}/${agentScheduleType}`);
      try {
        const statusCheck = await agentService.checkBackupStatus(
          url,
          vm.name,
          agentScheduleType,
          pool.path
        );

        if (statusCheck.inProgress) {
          console.error(`[Scheduler] Backup already in progress for ${vm.name}/${agentScheduleType}: ${statusCheck.details}`);
          
          // Mark job as failed
          const jobs = await getBackupJobs();
          const job = jobs.find(j => j.id === jobId);
          if (job) {
            job.status = 'failed';
            job.error = `Backup already in progress: ${statusCheck.details}`;
            job.endTime = new Date().toISOString();
            job.failureReason = 'already_running';
            await saveBackupJobs(jobs);
          }
          
          await appendLog(jobId, `ERROR: Backup already in progress`);
          await appendLog(jobId, `Status: ${statusCheck.status}`);
          await appendLog(jobId, `Details: ${statusCheck.details}`);
          
          if (this.io) {
            this.io.emit('backup-error', job);
          }
          
          return; // Don't trigger backup
        }

        console.log(`[Scheduler] ✓ No backup in progress, proceeding with scheduled backup`);
      } catch (error) {
        // Log error but don't block backup if status check fails
        console.warn(`[Scheduler] Warning: Status check failed, proceeding anyway:`, error.message);
        await appendLog(jobId, `Warning: Status check failed: ${error.message}`);
      }

      // The agent only exposes /api/backup/trigger. The previous
      // triggerScheduledBackup helper called /api/backup/trigger-scheduled
      // which does not exist — that's the source of the 404 errors that
      // the user was seeing on every scheduled run.
      await agentService.triggerBackup(url, backupData);

      // Mark schedule as fired (anchor for interval missed-run computation)
      await this._markScheduleFired(schedule.id);

      // Auto-disable 'once' schedules after first successful trigger
      if (schedule.scheduleType === 'once') {
        try {
          const { getBackupSchedules: getScheds, saveBackupSchedules: saveScheds } = require('./fileStorage');
          const scheds = await getScheds();
          const idx = scheds.findIndex(s => s.id === schedule.id);
          if (idx !== -1) {
            scheds[idx].enabled = false;
            scheds[idx].updatedAt = new Date().toISOString();
            await saveScheds(scheds);
            // Stop the cron task
            const task = this.tasks.get(schedule.id);
            if (task) {
              task.stop();
              this.tasks.delete(schedule.id);
            }
            console.log(`[Scheduler] 'once' schedule ${schedule.id} auto-disabled after execution`);
          }
        } catch (e) {
          console.error(`[Scheduler] Failed to auto-disable 'once' schedule:`, e.message);
        }
      }

    } catch (error) {
      console.error('Error executing scheduled backup:', error);
      await appendLog(jobId, `Error: ${error.message}`);
      
      const jobs = await getBackupJobs();
      const job = jobs.find(j => j.id === jobId);
      if (job) {
        job.status = 'failed';
        job.error = error.message;
        job.endTime = new Date().toISOString();
        await saveBackupJobs(jobs);
      }

      // Notify RocketChat of scheduled backup failure
      const vms = await getVirtualMachines();
      const vm = vms.find(v => v.id === schedule.vmId);
      if (vm) {
        rocketChatService.notifyScheduledBackupFailed(
          vm.name, 
          schedule.scheduleType, 
          error.message
        );
      }

      this.io.emit('backup-error', { jobId, error: error.message });

      // The trigger itself failed (agent unreachable, bad payload, etc.).
      // Apply the same auto-retry policy as an agent-reported failure.
      if (job) {
        this.handleScheduledBackupFailure(job).catch(err => {
          console.error('[Scheduler] Failed to schedule auto-retry after trigger error:', err.message);
        });
      }
    }
  }

  async executeCustomDaysBackup(schedule, customDate) {
    const jobId = uuidv4();
    
    try {
      const hosts = await getBackupHosts();
      const hypervisors = await getHypervisors();
      const vms = await getVirtualMachines();

      const vm = vms.find(v => v.id === schedule.vmId);
      if (!vm) {
        console.error(`VM not found: ${schedule.vmId}`);
        return;
      }

      const hypervisor = hypervisors.find(h => h.id === vm.hypervisorId);
      if (!hypervisor) {
        console.error(`Hypervisor not found: ${vm.hypervisorId}`);
        return;
      }

      const host = hosts.find(h => h.id === vm.backupHostId);
      if (!host) {
        console.error(`Backup host not found: ${vm.backupHostId}`);
        return;
      }

      if (host.status !== 'online') {
        console.error(`Backup host ${host.name} is offline, skipping backup`);
        
        // Create a skipped job record for tracking
        const skippedJob = {
          id: jobId,
          scheduleId: schedule.id,
          vmId: vm.id,
          vmName: vm.name,
          hypervisorIp: hypervisor.ip,
          backupHostId: host.id,
          backupHostName: host.name,
          method: customDate.method,
          noCompression: schedule.noCompression || false,
          noVerify: schedule.noVerify || false,
          status: 'skipped',
          startTime: new Date().toISOString(),
          endTime: new Date().toISOString(),
          exitCode: null,
          error: `Backup host ${host.name} was offline or unreachable`,
          scheduled: true,
          skippedReason: 'agent_offline',
          canRetry: true,
        };

        const jobs = await getBackupJobs();
        jobs.push(skippedJob);
        await saveBackupJobs(jobs);
        
        await appendLog(jobId, `Backup skipped: ${skippedJob.error}`);
        
        // Notify RocketChat
        rocketChatService.notifyBackupSkipped(vm.name, host.name, skippedJob.error);
        
        if (this.io) {
          this.io.emit('backup-skipped', skippedJob);
        }
        
        return;
      }

      const job = {
        id: jobId,
        scheduleId: schedule.id,
        vmId: vm.id,
        vmName: vm.name,
        hypervisorIp: hypervisor.ip,
        backupHostId: host.id,
        backupHostName: host.name,
        method: customDate.method,
        noCompression: schedule.noCompression || false,
        noVerify: schedule.noVerify || false,
        status: 'running',
        startTime: new Date().toISOString(),
        endTime: null,
        exitCode: null,
        error: null,
        scheduled: true,
      };

      const jobs = await getBackupJobs();
      jobs.push(job);
      await saveBackupJobs(jobs);

      this.io.emit('backup-started', job);
      await appendLog(jobId, `Custom-days backup started for VM: ${vm.name} (method: ${customDate.method})`);

      // Ensure URL has protocol
      let url = host.url;
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'http://' + url;
      }

      const backupData = {
        jobId,
        vmName: vm.name,
        hypervisorId: hypervisor.id,
        hypervisorIp: hypervisor.ip,
        // custom-days entries pick their own method (full/inc/copy) per
        // date. The agent script's --schedule must be one of its
        // recognized types — 'custom' is the right one for hand-picked
        // dates with retentionCount-based pruning.
        scheduleType: 'custom',
        method: customDate.method,
        noCompression: schedule.noCompression || false,
        noVerify: schedule.noVerify || false,
      };

      // Resolve storage pool — agent rejects without storagePoolPath.
      const pools = await getStoragePools();
      const pool = pools.find(p => p.id === schedule.storagePoolId && p.backupHostId === host.id);
      if (!pool) {
        throw new Error(
          schedule.storagePoolId
            ? `Storage pool ${schedule.storagePoolId} not found on backup host ${host.name}`
            : 'Custom-days schedule has no storage pool configured'
        );
      }
      backupData.storagePoolId = pool.id;
      backupData.storagePoolPath = pool.path;
      backupData.retention = schedule.retention || schedule.retentionCount || 7;
      backupData.keepArchive = schedule.keepArchive || 2;
      backupData.compression = schedule.compression || 2;

      // Resolve offsite host IPs (optional)
      const offsiteIds = Array.isArray(schedule.offsiteHostIds)
        ? schedule.offsiteHostIds
        : (schedule.offsiteHostId ? [schedule.offsiteHostId] : []);
      if (offsiteIds.length > 0) {
        const allOffsiteHosts = await getOffsiteHosts();
        backupData.offsiteHosts = offsiteIds
          .map(id => allOffsiteHosts.find(h => h.id === id))
          .filter(Boolean)
          .map(h => h.ip);
      } else {
        backupData.offsiteHosts = [];
      }

      await agentService.triggerBackup(url, backupData);
      await this._markScheduleFired(schedule.id);

    } catch (error) {
      console.error('Error executing custom-days backup:', error);
      await appendLog(jobId, `Error: ${error.message}`);
      
      const jobs = await getBackupJobs();
      const job = jobs.find(j => j.id === jobId);
      if (job) {
        job.status = 'failed';
        job.error = error.message;
        job.endTime = new Date().toISOString();
        await saveBackupJobs(jobs);
      }

      // Notify RocketChat of scheduled backup failure
      const vms = await getVirtualMachines();
      const vm = vms.find(v => v.id === schedule.vmId);
      if (vm) {
        rocketChatService.notifyScheduledBackupFailed(
          vm.name, 
          'custom-days', 
          error.message
        );
      }

      this.io.emit('backup-error', { jobId, error: error.message });
    }
  }

  async addSchedule(schedule) {
    if (schedule.enabled !== false) {
      this.createTask(schedule);
    }
  }

  async updateSchedule(schedule) {
    // Remove old task
    const task = this.tasks.get(schedule.id);
    if (task) {
      task.stop();
      this.tasks.delete(schedule.id);
    }

    // Remove old custom-days tasks
    const customTasks = this.customDaysTasks.get(schedule.id);
    if (customTasks) {
      customTasks.forEach(t => t.stop());
      this.customDaysTasks.delete(schedule.id);
    }

    // Create new task if enabled
    if (schedule.enabled !== false) {
      this.createTask(schedule);
    }
  }

  async removeSchedule(scheduleId) {
    const task = this.tasks.get(scheduleId);
    if (task) {
      task.stop();
      this.tasks.delete(scheduleId);
    }

    const customTasks = this.customDaysTasks.get(scheduleId);
    if (customTasks) {
      customTasks.forEach(t => t.stop());
      this.customDaysTasks.delete(scheduleId);
    }
  }

  /**
   * Best-effort upcoming backups for the next 24h. Returns up to `limit`
   * occurrences sorted by time. Used by the dashboard / schedules page.
   */
  async getUpcomingBackups(limit = 10) {
    try {
      const schedules = await getBackupSchedules();
      const now = new Date();
      const horizon = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const missedRunService = require('./missedRunService');
      const all = [];

      for (const s of schedules) {
        if (s.enabled === false) continue;
        // Reuse computeMissedRuns over (now, now+24h) to enumerate upcoming
        const occs = missedRunService.computeMissedRuns(s, now, horizon);
        for (const occ of occs) {
          all.push({
            scheduleId: s.id,
            scheduleName: s.name,
            vmId: s.vmId,
            scheduleType: s.scheduleType,
            scheduledAt: occ.scheduledAt.toISOString(),
            method: occ.meta?.method || null,
          });
        }
      }

      all.sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
      return all.slice(0, limit);
    } catch (err) {
      console.error('[Scheduler] getUpcomingBackups failed:', err.message);
      return [];
    }
  }

  /**
   * Cancel a pending retry for a specific job
   */
  cancelRetry(jobId) {
    const timer = this._retryTimers.get(jobId);
    if (timer) {
      clearTimeout(timer);
      this._retryTimers.delete(jobId);
      console.log(`[Scheduler] Cancelled retry timer for job ${jobId}`);
      return true;
    }
    return false;
  }

  shutdown() {
    console.log('Shutting down scheduler...');
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    // Cancel any pending auto-retry timers
    for (const [jobId, timer] of this._retryTimers) {
      clearTimeout(timer);
    }
    this._retryTimers.clear();
    this.tasks.forEach(task => task.stop());
    this.tasks.clear();
    this.customDaysTasks.forEach(tasks => tasks.forEach(t => t.stop()));
    this.customDaysTasks.clear();
  }
}

// ── Concurrency reconciler tuning ────────────────────────────────────────────
// How often the periodic reconcile + queue drain runs.
SchedulerService.QUEUE_RECONCILE_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
// Running/queued jobs older than this no longer occupy a concurrency slot
// (treated as dead/superseded so phantom jobs can't starve the scheduler).
SchedulerService.STALE_SLOT_MS = 24 * 60 * 60 * 1000; // 24 hours
// A 'queued' job that never transitions to 'running' within this window is
// considered stuck and is failed to release its slot.
SchedulerService.QUEUE_STUCK_MS = 20 * 60 * 1000; // 20 minutes
// A 'running' job older than this (with no completion) is treated as dead and
// failed to release its slot. Generous so real large-VM backups aren't killed.
SchedulerService.RUNNING_MAX_MS = 24 * 60 * 60 * 1000; // 24 hours
// If the agent confirmed a job alive within this window, never treat it as
// stuck (protects legitimately long-running large-VM backups).
SchedulerService.RECENT_SYNC_MS = 10 * 60 * 1000; // 10 minutes
// Catch-up: how far back to look for an overdue scheduled run that produced
// no job record (node-cron missed the tick / controller was briefly down).
SchedulerService.CATCHUP_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours
// Grace before catch-up steps in, leaving on-time firing to node-cron.
SchedulerService.CATCHUP_SETTLE_MS = 5 * 60 * 1000; // 5 minutes

const schedulerService = new SchedulerService();
module.exports = schedulerService;
