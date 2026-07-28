const {
  getBackupHosts,
  getBackupJobs,
  getVirtualMachines,
  appendLog,
  getRestoreJobs,
  saveRestoreJobs,
} = require('./fileStorage');
const agentService = require('./agentService');
const rocketChatService = require('./rocketChatService');
const { adoptLiveTmuxSessions, canInsertAdoptedJob } = require('./liveSessionAdoption');
const { snapshotJobs, commitJobChanges } = require('./jobReconcileCommit');

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

    // Everything this method changes is committed as a field-level patch at the
    // end (see jobReconcileCommit): the agent round-trips below take seconds,
    // during which the agent itself posts progress updates for every running
    // job. Writing this snapshot back would roll those updates back, and a
    // concurrent writer landing after us would drop the sessions we adopt.
    const before = snapshotJobs(backupJobs);

    // First, make our records mirror the host's live tmux sessions — even with
    // no browser tab open. This adopts/resurrects sessions the controller has no
    // (or a finalized) record for, so a hung/long backup running on the host is
    // never invisible until someone opens the panel.
    let adopted = false;
    try {
      const vms = await getVirtualMachines();
      adopted = await adoptLiveTmuxSessions(backupJobs, [host], vms);
    } catch (e) {
      console.warn(`[AgentSync] adopt live sessions failed for ${host.name}: ${e.message}`);
    }

    const commitBackupJobs = async () => {
      const { changed } = await commitJobChanges(before, backupJobs, {
        insertGuard: canInsertAdoptedJob,
      });
      return changed;
    };

    const liveBackupJobs = backupJobs.filter(j =>
      j.backupHostId === host.id &&
      ['running', 'queued', 'initializing'].includes(j.status) &&
      // Skip controller-side queued jobs waiting for a slot — they were never
      // sent to the agent, so the agent has no record of them.
      !(j.status === 'queued' && j.pendingStart)
    );
    const liveRestoreJobs = restoreJobs.filter(j =>
      j.backupHostId === host.id &&
      ['running', 'queued', 'initializing'].includes(j.status)
    );

    const ids = [...liveBackupJobs.map(j => j.id), ...liveRestoreJobs.map(j => j.id)];
    if (ids.length === 0) {
      if (adopted) await commitBackupJobs();
      return { synced: 0, finalized: 0, errors: 0 };
    }

    console.log(`[AgentSync] Reconciling ${ids.length} job(s) on ${host.name}`);
    const result = await agentService.getJobsLiveStatusBatch(host.url, ids);
    if (!result.success || !Array.isArray(result.data)) {
      console.warn(`[AgentSync] Could not fetch live status from ${host.name}: ${result.error}`);
      if (adopted) await commitBackupJobs();
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
    if (synced > 0 || adopted) {
      await commitBackupJobs();
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
    // True when the only thing we learned is "still can't verify it" — worth
    // persisting, but not worth a log line or a socket event on every pass.
    let bookkeepingOnly = false;
    const nowIso = new Date().toISOString();
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
      if (job.unverifiedSince) {
        delete job.unverifiedSince; // the agent knows it again
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
      // The agent has no job-state, no recorded exit code, and no live tmux
      // session for this id — it has never heard of this job. Still don't fail
      // it on the first miss (an agent restart can briefly lose its state),
      // but do NOT pretend it was confirmed either.
      //
      // `lastSyncedAt` means "the host confirmed this job is alive" and the
      // stuck-job sweep trusts it. Stamping it here — on the one verdict that
      // proves nothing — made a job the agent had never heard of immune to
      // every sweep: it refreshed the timestamp every 2 minutes, so the job sat
      // "running" for hours (holding a concurrency slot, writing a log line per
      // pass) until someone happened to open the panel. Record the ATTEMPT
      // separately, and finalize once it has been unverifiable for a while.
      job.lastSyncAttemptAt = nowIso;
      if (!job.unverifiedSince) job.unverifiedSince = nowIso;
      changed = true;

      const unverifiedForMs = Date.now() - new Date(job.unverifiedSince).getTime();
      if (unverifiedForMs > AgentSyncService.UNVERIFIABLE_GRACE_MS) {
        const mins = Math.round(unverifiedForMs / 60000);
        job.status = 'failed';
        job.endTime = job.endTime || nowIso;
        job.error = job.error ||
          'Outcome could not be determined: the agent has no record of this job and no exit code was recorded. ' +
          'It may have completed — check the report to confirm whether the backup exists.';
        job.failureReason = job.failureReason || 'indeterminate';
        job.verified = false;
        job.unverified = true;
        job.canRetry = true;
        job.finalizedBy = 'agentsync-indeterminate';
        try {
          appendLog(job.id, `Job marked FAILED — the agent has had no record of it for ${mins} minutes (no job state, no exit code, no live session). Not assumed successful.`);
        } catch {}
      } else {
        bookkeepingOnly = true;
      }
    }

    if (changed && !bookkeepingOnly) {
      job.lastSyncedAt = nowIso;
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

/**
 * How long a job may stay completely unverifiable (agent has no job state, no
 * exit code, no live session) before it is finalized as indeterminate. Long
 * enough to ride out an agent restart, short enough that a job which never
 * started cannot hold a concurrency slot all night.
 */
AgentSyncService.UNVERIFIABLE_GRACE_MS = 30 * 60 * 1000;

const agentSyncService = new AgentSyncService();
module.exports = agentSyncService;
