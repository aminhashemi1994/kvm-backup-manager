const {
  getBackupHosts,
  getBackupJobs,
  saveBackupJobs,
  appendLog,
  getRestoreJobs,
  saveRestoreJobs,
} = require('./fileStorage');
const agentService = require('./agentService');
const rocketChatService = require('./rocketChatService');

// Use the unified, atomic helpers from fileStorage. The previous local
// readRestoreJobs/writeRestoreJobs helpers used plain fs.writeFile, which
// could corrupt the file under crash conditions and (worse) races with the
// other modules that also write this file.
const readRestoreJobs = getRestoreJobs;
const writeRestoreJobs = saveRestoreJobs;

/**
 * AgentSyncService
 *
 * Reconciles controller-side job state with the *real* state on the agent
 * by calling /api/jobs/:id/live-status. Triggered:
 *   - On controller startup, after job-state recovery
 *   - When an agent transitions from offline → online
 *   - On demand via API
 *
 * Does NOT mark jobs as failed unilaterally — the agent's live-status is
 * the source of truth. Only updates fields the agent gives us.
 */
class AgentSyncService {
  constructor() {
    this.io = null;
  }

  initialize(io) {
    this.io = io;
  }

  /**
   * Sync all unfinished jobs that belong to a single backup host.
   */
  async syncHost(host) {
    if (!host || !host.url) return { synced: 0, finalized: 0, errors: 0 };
    if (host.status !== 'online') {
      // Still try, but expect failures; helpful for manual triggers.
    }

    const backupJobs = await getBackupJobs();
    const restoreJobs = await readRestoreJobs();

    const liveBackupJobs = backupJobs.filter(j =>
      j.backupHostId === host.id &&
      ['running', 'queued', 'initializing'].includes(j.status)
    );
    const liveRestoreJobs = restoreJobs.filter(j =>
      j.backupHostId === host.id &&
      ['running', 'queued', 'initializing'].includes(j.status)
    );

    const ids = [...liveBackupJobs.map(j => j.id), ...liveRestoreJobs.map(j => j.id)];
    if (ids.length === 0) {
      return { synced: 0, finalized: 0, errors: 0 };
    }

    console.log(`[AgentSync] Reconciling ${ids.length} job(s) on ${host.name}`);
    const result = await agentService.getJobsLiveStatusBatch(host.url, ids);
    if (!result.success || !Array.isArray(result.data)) {
      console.warn(`[AgentSync] Could not fetch live status from ${host.name}: ${result.error}`);
      return { synced: 0, finalized: 0, errors: 1 };
    }

    let synced = 0;
    let finalized = 0;
    let errors = 0;

    const byId = new Map(result.data.map(d => [d.jobId, d]));

    // Reconcile backup jobs
    for (const job of liveBackupJobs) {
      const live = byId.get(job.id);
      if (!live) continue;
      try {
        const changed = this._applyLiveStatusToBackupJob(job, live);
        if (changed) synced++;
        if (['completed', 'failed'].includes(job.status)) finalized++;
      } catch (e) {
        errors++;
        console.error(`[AgentSync] Backup ${job.id} reconcile error:`, e.message);
      }
    }
    if (synced > 0) {
      await saveBackupJobs(backupJobs);
    }

    // Reconcile restore jobs
    let restoreChanged = false;
    for (const job of liveRestoreJobs) {
      const live = byId.get(job.id);
      if (!live) continue;
      try {
        const changed = this._applyLiveStatusToRestoreJob(job, live);
        if (changed) {
          synced++;
          restoreChanged = true;
        }
        if (['completed', 'failed'].includes(job.status)) finalized++;
      } catch (e) {
        errors++;
        console.error(`[AgentSync] Restore ${job.id} reconcile error:`, e.message);
      }
    }
    if (restoreChanged) {
      await writeRestoreJobs(restoreJobs);
    }

    console.log(`[AgentSync] ${host.name}: synced=${synced}, finalized=${finalized}, errors=${errors}`);

    if (this.io) {
      this.io.emit('jobs-synced', {
        backupHostId: host.id,
        backupHostName: host.name,
        synced,
        finalized,
      });
    }
    return { synced, finalized, errors };
  }

  /**
   * Sync every backup host. Used on startup.
   */
  async syncAll() {
    const hosts = await getBackupHosts();
    let synced = 0, finalized = 0, errors = 0;
    for (const host of hosts) {
      try {
        const r = await this.syncHost(host);
        synced += r.synced;
        finalized += r.finalized;
        errors += r.errors;
      } catch (e) {
        errors++;
      }
    }
    return { synced, finalized, errors };
  }

  /**
   * Mutate the in-memory job object in place. Returns true if anything
   * changed so the caller knows whether to persist.
   */
  _applyLiveStatusToBackupJob(job, live) {
    let changed = false;
    const before = { status: job.status, phase: job.phase, progress: job.progress };

    // Update progress & phase regardless of terminal status — gives the user
    // accurate visualization even for very-recently-finished jobs.
    if (typeof live.progress === 'number' && live.progress !== job.progress) {
      job.progress = live.progress;
      changed = true;
    }
    if (live.progressText && live.progressText !== job.progressText) {
      job.progressText = live.progressText;
      changed = true;
    }
    if (live.phase && live.phase !== job.phase) {
      job.phase = live.phase;
      changed = true;
    }

    if (live.status === 'running') {
      // Agent is still actively running this job. Make sure controller
      // reflects "running" (not stuck in "queued").
      if (job.status !== 'running') {
        job.status = 'running';
        changed = true;
      }
    } else if (live.status === 'failed' && live.phase === 'orphaned') {
      // Lock-file with no process — orphaned. Mark failed once.
      if (job.status !== 'failed') {
        job.status = 'failed';
        job.endTime = job.endTime || new Date().toISOString();
        job.error = job.error || 'Backup orphaned: lock file present without active process';
        changed = true;
        try { rocketChatService.notifyBackupFailed(job.vmName, job.method, job.error); } catch {}
      }
    } else if (live.status === 'completed') {
      if (job.status !== 'completed') {
        job.status = 'completed';
        job.endTime = job.endTime || new Date().toISOString();
        job.progress = 100;
        changed = true;
      }
    } else if (live.status === 'unknown' && live.evidence && !live.evidence.jobStateFound) {
      // Agent has no record of this job. It either finished long ago
      // (state file deleted) or never started. Don't unilaterally fail
      // here; the agent's startup recovery already handles cleanup. Just
      // bookkeep that we tried to look it up.
      job.lastSyncedAt = new Date().toISOString();
      changed = true;
    }

    if (changed) {
      job.lastSyncedAt = new Date().toISOString();
      job.syncSource = 'agent-live-status';
      // Append a single concise log line so the trail explains the change.
      const summary = `liveSync status=${before.status}→${job.status} phase=${before.phase || '-'}→${job.phase || '-'} progress=${before.progress || 0}→${job.progress || 0}`;
      try { appendLog(job.id, summary); } catch {}
      if (this.io) this.io.emit('job-updated', job);
    }
    return changed;
  }

  _applyLiveStatusToRestoreJob(job, live) {
    let changed = false;
    if (typeof live.progress === 'number' && live.progress !== job.progress) {
      job.progress = live.progress;
      changed = true;
    }
    if (live.progressText && live.progressText !== job.progressText) {
      job.progressText = live.progressText;
      changed = true;
    }
    if (live.phase && live.phase !== job.phase) {
      job.phase = live.phase;
      changed = true;
    }
    if (live.status === 'running' && job.status !== 'running') {
      job.status = 'running';
      changed = true;
    }
    if (live.status === 'completed' && job.status !== 'completed') {
      job.status = 'completed';
      job.endTime = job.endTime || new Date().toISOString();
      job.progress = 100;
      changed = true;
    }
    if (changed) {
      job.lastSyncedAt = new Date().toISOString();
      job.syncSource = 'agent-live-status';
      if (this.io) this.io.emit('restore-updated', job);
    }
    return changed;
  }
}

const agentSyncService = new AgentSyncService();
module.exports = agentSyncService;
