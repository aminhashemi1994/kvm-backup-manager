const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const { stripAnsi } = require('../utils/stripAnsi');
const {
  getBackupJobs,
  saveBackupJobs,
  updateBackupJobs,
  getBackupHosts,
  getHypervisors, 
  getVirtualMachines,
  getBackupSchedules,
  saveBackupSchedules,
  getOffsiteHosts,
  getRestoreJobs,
  saveRestoreJobs,
  appendLog, 
  readLog 
} = require('../services/fileStorage');
const agentService = require('../services/agentService');
const backupCycleService = require('../services/backupCycleService');
const rocketChatService = require('../services/rocketChatService');
const notificationPolicy = require('../services/notificationPolicyService');
const auditService = require('../services/auditService');
const schedulerService = require('../services/schedulerService');
const { validateBackupTrigger } = require('../utils/validator');
const { requireUser, requireAdmin } = require('../middleware/rbac');

// The /active (and /history) GET handlers reconcile job state against the agents
// — an HTTP fan-out to every host plus a full rewrite of the jobs file. Every
// open browser tab polls these on a short interval, so without a guard the
// controller ends up doing that expensive work many times a second, fans out to
// slow agents, and starves its own event loop (the API then intermittently
// stops answering). Since the periodic agentSyncService and the manual "Sync
// from agents" button already reconcile, we cap the per-request reconcile to at
// most once every few seconds GLOBALLY; other requests just serve current state
// from disk. Real-time changes still reach the UI via socket events.
let _lastActiveReconcileAt = 0;
const ACTIVE_RECONCILE_MIN_INTERVAL_MS = 4000;

// The reconcile also runs DETACHED from the response. Every agent round-trip
// inside a GET is latency the user watches: opening Active Jobs had to wait for
// the slowest agent before a single row appeared, even though the rows were
// already sitting in the store. So the handlers answer from the store straight
// away and kick the reconcile off behind the response — its results land via
// socket events and the next 5s poll. `liveSessionMirrorService` is doing the
// same discovery on a background timer anyway, so the data is fresh regardless.
let _reconcileInFlight = null;

function runReconcileDetached(label, fn) {
  if (_reconcileInFlight) return;
  _lastActiveReconcileAt = Date.now();
  _reconcileInFlight = Promise.resolve()
    .then(fn)
    .catch(e => console.warn(`[${label}] background reconcile failed:`, e.message))
    .finally(() => {
      // Stamp again on completion: a pass that took 8s shouldn't allow the
      // next one to start the instant it finishes.
      _lastActiveReconcileAt = Date.now();
      _reconcileInFlight = null;
    });
}

/**
 * Sync job status with agent
 * Returns true if status was updated
 */
async function syncJobStatusWithAgent(job, hosts, agentActiveCache = null) {
  if (job.status !== 'running' && job.status !== 'queued') {
    return false; // Already finished
  }

  // Controller-side queued jobs waiting for a free slot were never sent to
  // the agent, so the agent won't know about them. Don't reconcile these
  // against the agent (that would wrongly mark them completed) — the
  // scheduler's drainer promotes them to running when a slot frees.
  if (job.status === 'queued' && job.pendingStart) {
    return false;
  }

  const host = hosts.find(h => h.id === job.backupHostId);
  if (!host) return false;

  try {
    // One agent round-trip per HOST per request, not per job — the callers
    // sync every active job on every /active and /history request, and with
    // 10+ concurrent jobs the duplicate agent calls made the panel crawl.
    let listPromise;
    if (agentActiveCache && agentActiveCache.has(host.id)) {
      listPromise = agentActiveCache.get(host.id);
    } else {
      const client = agentService.createAgentClient(host.url, host.id, host.name);
      listPromise = client.get('/api/backup/active', { timeout: 5000 }).then(r => r.data.data);
      if (agentActiveCache) agentActiveCache.set(host.id, listPromise);
    }
    const agentData = await listPromise;

    const agentActiveJobs = agentData.active || [];
    const agentQueuedJobs = agentData.queued || [];
    const isRunningOnAgent = agentActiveJobs.some(aj => aj.jobId === job.id);
    const isActiveOnAgent = isRunningOnAgent || agentQueuedJobs.some(
      aj => aj.jobId === job.id
    );

    // The agent is actually executing this job but we still show "queued"
    // (e.g. the agent's running update was lost or hasn't arrived yet) —
    // promote so the UI reflects reality immediately.
    if (job.status === 'queued' && isRunningOnAgent) {
      job.status = 'running';
      await appendLog(job.id, 'Job promoted to running (verified with agent)');
      return true;
    }

    // Not in the agent's active list. This does NOT prove success — the job
    // may have finished (and the agent's terminal update reached us on a
    // separate path), OR it may have failed / been killed / dropped off the
    // list after an agent restart while the backup was still running. So we
    // must NOT blindly mark it "completed" (that produced the false
    // "completed, exit code -, no logs" records users could not trust).
    //
    // Ask the agent's live-status endpoint, which inspects the REAL on-host
    // state (recorded exit code, tmux sessions, live processes, lock + progress
    // files):
    //   running             → the backup is still going; leave the job alone.
    //   failed/orphaned     → mark failed.
    //   completed           → mark completed.
    //   unknown (no record) → we genuinely cannot tell. Mark FAILED for review.
    //
    // That last rule is the important one. This used to infer "completed" from
    // a missing agent record, on the theory that a finished-and-cleaned-up job
    // was probably a success. It isn't: a backup that died (e.g. "No full backup
    // found in target directory", exit 1) leaves exactly the same absence, and
    // was filed as a green "completed" in the history — the worst possible
    // failure mode for a backup system, because it hides a real data-loss risk.
    // Absence of evidence is not evidence of success. An unknown outcome is
    // surfaced as failed-needs-review: a false "failed" costs a retry, a false
    // "completed" costs a backup you only discover you never had when you need
    // it. Note the missed-backups report is disk-driven, so a job wrongly marked
    // failed here does NOT produce a phantom missed run.
    //
    // This runs at most once per job (once terminal, this function returns
    // early), so it doesn't add per-request agent load at steady state.
    if (!isActiveOnAgent) {
      let live = null;
      try {
        const client = agentService.createAgentClient(host.url, host.id, host.name);
        const r = await client.get(`/api/jobs/${job.id}/live-status`, { timeout: 5000 });
        live = r.data?.data || null;
      } catch (e) {
        // Couldn't verify — leave the job as-is for the next pass rather than
        // guessing. The periodic agentSyncService will also try.
        return false;
      }

      if (live && live.status === 'running') {
        // Keep the live phase/progress in sync even when the status itself
        // didn't change. The phase drives the "Backing up" vs "Syncing
        // offsite" badge, and it only ever moved when the agent happened to
        // include progressType on an update — so a job that switched to the
        // offsite rsync kept claiming "Backing up" while its own progress text
        // read "Offsite sync (...)". live-status reads the same progress file
        // the script writes, so this is the authoritative answer.
        let changed = false;
        if (job.status !== 'running') {
          job.status = 'running';
          changed = true;
          await appendLog(job.id, 'Job still running (verified via live-status)');
        }
        if (live.phase && live.phase !== job.phase) {
          job.phase = live.phase;
          changed = true;
        }
        if (typeof live.progress === 'number' && live.progress !== job.progress) {
          job.progress = live.progress;
          changed = true;
        }
        if (live.progressText && live.progressText !== job.progressText) {
          job.progressText = live.progressText;
          changed = true;
        }
        return changed;
      }
      // The shell's recorded exit code, when the agent still has it, is hard
      // evidence — it's the script's own verdict, not an inference from
      // leftover artifacts. Trust it over everything else.
      const recordedExit = typeof live?.exitCode === 'number' ? live.exitCode : null;

      if (live && live.status === 'failed') {
        job.status = 'failed';
        job.endTime = job.endTime || new Date().toISOString();
        if (recordedExit !== null) job.exitCode = recordedExit;
        job.error = job.error || (recordedExit !== null
          ? `Backup script exited with code ${recordedExit}`
          : 'Backup orphaned: lock file present without active process');
        job.failureReason = job.failureReason || (recordedExit !== null ? 'script_error' : 'orphaned');
        job.verified = true;
        job.finalizedBy = 'reconciler-livestatus';
        delete job.unverified;
        await appendLog(job.id, recordedExit !== null
          ? `Job marked failed (shell recorded exit code ${recordedExit})`
          : 'Job marked failed (evidence-based via live-status: orphaned)');
        return true;
      }

      if (live && live.status === 'completed') {
        job.status = 'completed';
        job.endTime = job.endTime || new Date().toISOString();
        job.progress = 100;
        job.verified = true;
        job.finalizedBy = 'reconciler-livestatus';
        delete job.unverified;
        if (recordedExit !== null) {
          // Proven: the script itself reported success.
          job.exitCode = recordedExit;
          await appendLog(job.id, `Job completed (shell recorded exit code ${recordedExit})`);
        } else {
          // Inferred from host evidence (progress reached 100%, no orphaned
          // lock). Do NOT fabricate exitCode 0 — an inferred completion must
          // never masquerade as one the script confirmed.
          await appendLog(job.id, 'Job completed (evidence-based via live-status; exit code not captured)');
        }
        return true;
      }

      // Unknown: no agent record AND no recorded exit code. We cannot prove this
      // backup succeeded, so we must not claim it did. Surface it as failed and
      // needing review — it stays retryable, and the report/disk is the place to
      // confirm whether a backup actually exists.
      job.status = 'failed';
      job.endTime = job.endTime || new Date().toISOString();
      job.error = job.error || 'Outcome could not be determined: the agent has no record of this job and no exit code was recorded. It may have completed — check the report to confirm whether the backup exists.';
      job.failureReason = job.failureReason || 'indeterminate';
      job.verified = false;
      job.unverified = true;
      job.canRetry = true;
      job.finalizedBy = 'reconciler-indeterminate';
      await appendLog(job.id, 'Job marked FAILED — outcome indeterminate (agent has no record, no exit code recorded). Not assumed successful.');
      return true;
    }
  } catch (error) {
    // Agent unreachable - mark as failed if too old
    const jobAge = Date.now() - new Date(job.startTime).getTime();
    const maxAge = 2 * 60 * 60 * 1000; // 2 hours
    
    if (jobAge > maxAge) {
      job.status = 'failed';
      job.endTime = job.endTime || new Date().toISOString();
      job.error = job.error || 'Job timeout or agent unreachable';
      await appendLog(job.id, 'Job marked as failed (agent unreachable, timeout)');
      return true;
    }
  }
  
  return false;
}

/**
 * Correct jobs wrongly marked `failed` while their backup is in fact STILL
 * RUNNING in a tmux session on the host (data drift).
 *
 * The reconciler that finalizes jobs can misfire — e.g. an agent restart during
 * a long offsite rsync, where the lock file is gone but the tmux session and
 * the progress file are alive. syncJobStatusWithAgent only re-checks
 * running/queued jobs, so once such a job is stamped `failed` it never
 * self-corrects and the panel shows "failed, 0s, no logs" for a backup that is
 * actively syncing.
 *
 * On every history/active load we grep the host's live tmux sessions for these
 * failed jobs (one `tmux ls` per host, batched) and, when a session for the job
 * is found, flip it back to `running`. Lock-file absence is deliberately NOT
 * treated as death — a live session + progress file is proof of life.
 *
 * Matching is by unique jobId (session name contains it), so we never resurrect
 * the wrong job. Returns true if any job was changed.
 */
async function resurrectRunningFailedJobs(jobs, hosts, maxAgeMs = 3 * 24 * 60 * 60 * 1000) {
  // Only recently-failed jobs are worth checking — an old failure won't have a
  // live session, and this bounds the batch we send to each agent. The window is
  // caller-tunable: the frequent /active poll keeps it short (steady-state load),
  // while the manual "Sync from agents" action widens it to catch a long-running
  // backup (e.g. a multi-day offsite rsync) that was wrongly marked failed.
  const now = Date.now();
  const candidates = jobs.filter(j => {
    if (j.status !== 'failed') return false;
    const ref = j.endTime || j.startTime;
    if (!ref) return false;
    return (now - new Date(ref).getTime()) <= maxAgeMs;
  });
  if (candidates.length === 0) return false;

  // Group by host so each agent gets a single batched call.
  const byHost = new Map();
  for (const j of candidates) {
    const host = hosts.find(h => h.id === j.backupHostId);
    if (!host) continue;
    if (!byHost.has(host.id)) byHost.set(host.id, { host, jobs: [] });
    byHost.get(host.id).jobs.push(j);
  }
  if (byHost.size === 0) return false;

  let changed = false;
  await Promise.allSettled(Array.from(byHost.values()).map(async ({ host, jobs: hostJobs }) => {
    let active;
    try {
      const client = agentService.createAgentClient(host.url, host.id, host.name);
      const r = await client.post('/api/jobs/active-sessions', {
        jobs: hostJobs.map(j => ({
          jobId: j.id,
          vmName: j.vmName,
          scheduleType: j.scheduleType || j.method,
        })),
      }, { timeout: 5000 });
      active = r.data?.data || {};
    } catch (e) {
      return; // host unreachable — leave jobs as-is
    }

    for (const j of hostJobs) {
      // Never revive a job that dedupe finalized as a duplicate — its "live"
      // session belongs to the winning run, not to it.
      if (j.supersededBy) continue;
      // Nor one the script itself gave a verdict on. A tmux session survives a
      // few seconds after the shell records its exit code and exits, so a
      // genuinely failed backup can still be "live" here — flipping it back to
      // running makes it pop into Active and then fall out again a moment
      // later. A recorded exit code is proof, a lingering session is not.
      if (typeof j.exitCode === 'number') continue;
      const info = active[j.id];
      if (!info || !info.active) continue;
      j.status = 'running';
      delete j.endTime;
      delete j.unverified;
      j.verified = false;
      if (info.phase) j.phase = info.phase;
      if (typeof info.progress === 'number') j.progress = info.progress;
      if (info.progressText) j.progressText = info.progressText;
      j.error = null;
      j.failureReason = null;
      j.resurrectedFromFailed = true;
      changed = true;
      await appendLog(j.id, `Job restored to running — live tmux session ${info.session} found on host (was wrongly marked failed)`);
    }
  }));

  return changed;
}

// Adoption of live tmux sessions with no (or finalized) controller record lives
// in a shared service so the periodic headless agentSyncService uses the exact
// same logic as the panel's /active poll.
const { adoptLiveTmuxSessions, canInsertAdoptedJob } = require('../services/liveSessionAdoption');
const { snapshotJobs, commitJobChanges } = require('../services/jobReconcileCommit');

/**
 * Collapse duplicate ACTIVE jobs for the same VM + schedule down to one.
 *
 * The agent runs at most one backup per VM+schedule (its per-VM lock), so two
 * jobs both showing "running/queued" for the same VM+schedule cannot both be
 * real — the extra one is a stale record (e.g. a pre-guard retry, or a zombie an
 * agent restart left behind) that live-status can't kill on its own because the
 * winning run's tmux session collides with it on the VM+schedule name.
 *
 * Deterministic rule: keep the most recently STARTED active job (tie → the one
 * already 'running') and finalize the rest as superseded. `supersededBy` marks
 * them so the resurrector never flips them back. Controller-side queued jobs
 * still waiting for a concurrency slot (`pendingStart`) are not runners and are
 * left out of the contest.
 *
 * @returns {boolean} true if any job was changed
 */
function dedupeActiveBackupJobs(jobs) {
  const ACTIVE = ['running', 'queued', 'initializing', 'retrying'];
  const groups = new Map();
  for (const j of jobs) {
    if (!ACTIVE.includes(j.status)) continue;
    if (j.status === 'queued' && j.pendingStart) continue;
    const key = `${j.vmId || j.vmName}::${j.scheduleType || j.method || ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(j);
  }

  let changed = false;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // Winner: latest startTime; tie-break prefers an already-running job.
    group.sort((a, b) => {
      const ta = new Date(a.startTime || 0).getTime();
      const tb = new Date(b.startTime || 0).getTime();
      if (tb !== ta) return tb - ta;
      return (b.status === 'running' ? 1 : 0) - (a.status === 'running' ? 1 : 0);
    });
    const winner = group[0];
    for (let i = 1; i < group.length; i++) {
      const loser = group[i];
      loser.status = 'failed';
      loser.endTime = loser.endTime || new Date().toISOString();
      loser.error = loser.error ||
        'Superseded by a newer run for the same VM and schedule (duplicate active job cleaned up)';
      loser.failureReason = loser.failureReason || 'superseded';
      loser.supersededBy = winner.id;
      loser.finalizedBy = 'dedupe';
      loser.canRetry = false;
      changed = true;
      try { appendLog(loser.id, `Job superseded by newer run ${winner.id} for the same VM/schedule; removed from active list`); } catch {}
    }
  }
  return changed;
}

/**
 * Work out which storage pool a retry of `originalJob` should write to.
 *
 * "The job record says so" is only one of several places this is known, and
 * often the weakest: a job adopted from a live tmux session never had a
 * storagePoolId, older records predate the field, and after a schedule is
 * edited the pool on the old job is no longer where this VM backs up. Refusing
 * the retry in those cases ("Original job has no storage pool on record")
 * throws away information the controller demonstrably has.
 *
 * Tried in order, always restricted to pools that exist on THIS backup host:
 *   1. the job's own schedule — its CURRENT pool, so an edited schedule wins;
 *   2. any other live schedule for the same VM (same scheduleType preferred) —
 *      covers a job whose scheduleId is missing or points at a deleted record;
 *   3. the pool recorded on the job itself (manual triggers store it);
 *   4. the pool used by the most recent other job for this VM on this host;
 *   5. the host's only pool, when it has exactly one — then there is nothing
 *      to choose.
 *
 * Only a deleted schedule with no backup history left AND a multi-pool host is
 * genuinely ambiguous; that's the one case the caller still has to refuse.
 *
 * @returns {{pool: object|null, source: string, schedule: object|null}}
 */
function resolveRetryStoragePool({ originalJob, host, pools, schedules, jobs }) {
  const onHost = (pools || []).filter(p => p.backupHostId === host.id);
  const byId = (id) => (id ? onHost.find(p => p.id === id) || null : null);

  // 1. The job's own schedule, at its current settings.
  const ownSchedule = originalJob.scheduleId
    ? (schedules || []).find(s => s.id === originalJob.scheduleId) || null
    : null;
  const fromOwnSchedule = byId(ownSchedule?.storagePoolId);
  if (fromOwnSchedule) return { pool: fromOwnSchedule, source: 'schedule', schedule: ownSchedule };

  // 2. Another schedule for the same VM. Same scheduleType first — a VM can
  //    have a daily and a monthly schedule pointing at different pools.
  const vmSchedules = (schedules || []).filter(s =>
    s.vmId === originalJob.vmId && byId(s.storagePoolId)
  );
  const sameType = vmSchedules.find(s => s.scheduleType === originalJob.scheduleType);
  const vmSchedule = sameType || vmSchedules[0] || null;
  if (vmSchedule) {
    return { pool: byId(vmSchedule.storagePoolId), source: `schedule ${vmSchedule.id} (matched by VM)`, schedule: vmSchedule };
  }

  // 3. The job's own record.
  const fromJob = byId(originalJob.storagePoolId);
  if (fromJob) return { pool: fromJob, source: 'job', schedule: ownSchedule };

  // 4. The VM's backup history on this host — the schedule may be gone, but
  //    where its backups actually landed is still on record.
  const previous = (jobs || [])
    .filter(j =>
      j.id !== originalJob.id &&
      j.backupHostId === host.id &&
      (originalJob.vmId ? j.vmId === originalJob.vmId : j.vmName === originalJob.vmName) &&
      byId(j.storagePoolId)
    )
    .sort((a, b) => new Date(b.startTime || 0) - new Date(a.startTime || 0))[0];
  if (previous) {
    return { pool: byId(previous.storagePoolId), source: `previous backup ${previous.id}`, schedule: ownSchedule };
  }

  // 5. Unambiguous by elimination.
  if (onHost.length === 1) {
    return { pool: onHost[0], source: 'only pool on host', schedule: ownSchedule };
  }

  return { pool: null, source: 'none', schedule: ownSchedule };
}

/**
 * Ingest per-offsite sync outcomes reported by the agent for a finished job and
 * record schedule-level warnings + notifications when an offsite host/pool was
 * skipped or failed while the primary backup itself succeeded (Req 6.2–6.4).
 *
 * ── Assumed payload shape (from the agent job-update body) ──────────────────
 * The agent may include an `offsiteResults` array on the terminal
 * `/api/backups/jobs/:id/update` call. Each entry describes one offsite target:
 *
 *   offsiteResults: [
 *     {
 *       ip,        // offsite host IP the agent synced to (e.g. "10.0.0.5")
 *       host,      // optional hostname/label, used as a secondary match key
 *       poolPath,  // destination path on the offsite host (e.g. "/mnt/pool1")
 *       status,    // "success" | "skipped" | "failed"
 *       reason,    // human-readable reason for a skip/failure (optional)
 *     }, ...
 *   ]
 *
 * This mirrors the agent script's per-host offsite tracking (Backup_Manager.sh
 * emits `offsite_host_fail` / `offsite_complete` events carrying `offsite_ip`).
 * The controller maps each result back to the job's persisted `offsiteTargets`
 * (which carry `{ offsiteHostId, offsitePoolId, ip, path }`) by matching on
 * `ip` first, then `host`/`poolPath`, so a warning can name the exact host+pool.
 *
 * This handler processes the full `offsiteResults` array in a single pass
 * (task 9.2): skipped/failed outcomes APPEND (or refresh) a warning, while a
 * later SUCCESS to the same target CLEARS the matching warning so offsite sync
 * auto-resumes without operator intervention (Req 6.7). The schedule is never
 * disabled for a transient offsite failure — offsite issues only add/remove
 * warnings and the schedule keeps running (Req 6.5). Append and clear share the
 * same dedup key (`offsiteHostId + offsitePoolId`) so the two paths mirror each
 * other exactly.
 *
 * @param {object} job      The finished backup job (must have `scheduleId`).
 * @param {Array}  offsiteResults  Per-offsite outcome entries from the agent.
 * @returns {Promise<boolean>} true when the schedule was modified & saved.
 */
async function ingestOffsiteSyncResults(job, offsiteResults) {
  // Only schedule-triggered jobs carry a schedule to annotate (Req 6.3).
  if (!job || !job.scheduleId) return false;
  if (!Array.isArray(offsiteResults) || offsiteResults.length === 0) return false;

  // Classify every result: successes clear warnings (Req 6.7), skips/failures
  // append/refresh them (Req 6.3). The primary backup outcome is unaffected —
  // we never disable the schedule here (Req 6.5).
  const classify = (r) => {
    const s = (r && typeof r.status === 'string') ? r.status.toLowerCase() : '';
    if (s === 'success' || s === 'succeeded' || s === 'ok') return 'success';
    if (s === 'skipped' || s === 'failed' || s === 'error') return 'problem';
    return 'ignore';
  };
  const hasActionable = offsiteResults.some(r => classify(r) !== 'ignore');
  if (!hasActionable) return false;

  const schedules = await getBackupSchedules();
  const schedule = schedules.find(s => s.id === job.scheduleId);
  if (!schedule) return false;

  // The job persists its resolved offsite targets (Req 9.4) — use them to map
  // an incoming result's ip/host back to offsiteHostId/offsitePoolId. Fall back
  // to the offsite host records when the job predates persisted targets.
  const jobTargets = Array.isArray(job.offsiteTargets) ? job.offsiteTargets : [];
  let offsiteHosts = [];
  try {
    offsiteHosts = await getOffsiteHosts();
  } catch (_) {
    offsiteHosts = [];
  }

  // Resolve a single offsite result to { offsiteHostId, offsitePoolId } plus
  // display names, matching by ip or host/path as available.
  const resolveTarget = (result) => {
    const ip = result && result.ip ? String(result.ip).trim() : '';
    const host = result && result.host ? String(result.host).trim() : '';
    const poolPath = result && result.poolPath ? String(result.poolPath).trim() : '';

    // 1) Prefer the job's persisted targets (authoritative host+pool mapping).
    let target = jobTargets.find(t => t && ip && t.ip === ip);
    if (!target && poolPath) {
      target = jobTargets.find(t => t && ip && t.ip === ip && t.path === poolPath)
        || jobTargets.find(t => t && t.path === poolPath);
    }
    if (!target && host) {
      // host may be an IP-or-name; try matching against target ip as a fallback.
      target = jobTargets.find(t => t && t.ip === host);
    }

    let offsiteHostId = target ? target.offsiteHostId : null;
    let offsitePoolId = target ? target.offsitePoolId : null;

    // 2) Enrich with names (and back-fill ids) from the offsite host records.
    const hostRec = offsiteHosts.find(h =>
      (offsiteHostId && h.id === offsiteHostId) ||
      (ip && h.ip === ip) ||
      (host && (h.ip === host || h.name === host))
    );
    if (hostRec && !offsiteHostId) offsiteHostId = hostRec.id;

    let hostName = hostRec ? (hostRec.name || hostRec.ip) : (host || ip || 'unknown host');
    let poolName = null;
    if (hostRec && Array.isArray(hostRec.storagePools)) {
      const poolRec = hostRec.storagePools.find(p =>
        (offsitePoolId && p.id === offsitePoolId) ||
        (poolPath && p.path === poolPath)
      );
      if (poolRec) {
        if (!offsitePoolId) offsitePoolId = poolRec.id;
        poolName = poolRec.name || poolRec.path;
      }
    }
    if (!poolName) poolName = poolPath || (offsitePoolId || 'default pool');

    return { offsiteHostId, offsitePoolId, hostName, poolName };
  };

  if (!Array.isArray(schedule.offsiteWarnings)) schedule.offsiteWarnings = [];
  const now = new Date().toISOString();
  const notifications = [];
  let changed = false;
  let cleared = 0;

  // Match an existing warning by the shared dedup key (offsiteHostId +
  // offsitePoolId). Mirrors the keying used by the append path (task 9.1).
  const sameTarget = (w, offsiteHostId, offsitePoolId) =>
    w && w.offsiteHostId === offsiteHostId && w.offsitePoolId === offsitePoolId;

  // Single pass over every reported outcome (task 9.2): success clears a
  // matching warning; skip/fail appends or refreshes one.
  for (const result of offsiteResults) {
    const kind = classify(result);
    if (kind === 'ignore') continue;

    const { offsiteHostId, offsitePoolId, hostName, poolName } = resolveTarget(result);

    if (kind === 'success') {
      // A later successful sync to this target clears its warning and lets
      // offsite sync auto-resume without operator intervention (Req 6.7, 6.5).
      const before = schedule.offsiteWarnings.length;
      schedule.offsiteWarnings = schedule.offsiteWarnings.filter(
        w => !sameTarget(w, offsiteHostId, offsitePoolId)
      );
      const removed = before - schedule.offsiteWarnings.length;
      if (removed > 0) {
        cleared += removed;
        changed = true;
        console.log(`[Backups] Cleared offsite warning for ${hostName} / pool ${poolName} on schedule ${schedule.id} after successful sync`);
      }
      continue;
    }

    // kind === 'problem': append/refresh the warning (Req 6.3).
    const reason = (result && result.reason)
      ? String(result.reason)
      : `Offsite sync ${((result && result.status) || 'failed')}`;

    // Dedupe by offsiteHostId + offsitePoolId: update the existing warning's
    // reason/timestamp instead of pushing a duplicate (task requirement).
    const existing = schedule.offsiteWarnings.find(
      w => sameTarget(w, offsiteHostId, offsitePoolId)
    );
    if (existing) {
      existing.reason = reason;
      existing.at = now;
    } else {
      schedule.offsiteWarnings.push({ offsiteHostId, offsitePoolId, reason, at: now });
    }
    changed = true;

    notifications.push({ hostName, poolName, reason });
  }

  if (changed) {
    await saveBackupSchedules(schedules);

    // Notify RocketChat, naming the schedule, offsite host, pool, and reason
    // (Req 6.4). notifyOffsiteSyncFailed(name, offsiteHost, error) is reused;
    // we pass a descriptive destination string including schedule + pool.
    const scheduleLabel = schedule.name || schedule.vmName || `schedule ${schedule.id}`;
    // A run where SOME destinations succeeded is a partial sync, which is a
    // separate (and separately mutable) event from a total offsite failure.
    const anySuccess = Array.isArray(offsiteResults)
      && offsiteResults.some(r => classify(r) === 'success');
    const offsiteEvent = anySuccess ? 'offsitePartial' : 'offsiteFailure';
    const sendOffsite = await notificationPolicy.shouldNotify(schedule, offsiteEvent);

    if (sendOffsite) {
      for (const n of notifications) {
        try {
          rocketChatService.notifyOffsiteSyncFailed(
            // The VM alone: the schedule label repeated the VM name verbatim,
            // which doubled the length of every offsite message for no gain.
            job.vmName || scheduleLabel,
            `${n.hostName} / pool ${n.poolName}`,
            n.reason,
            schedule.id
          );
        } catch (err) {
          console.error(`[Backups] Failed to send offsite sync failure notification: ${err.message}`);
        }
      }
    }

    console.log(`[Backups] Offsite sync results for job ${job.id} on schedule ${schedule.id}: recorded ${notifications.length} warning(s), cleared ${cleared} warning(s)`);
  }

  return changed;
}

/**
 * One full reconcile pass against the agents, shared by /active and /history.
 *
 * Runs detached from any response, so it may take as long as the agents do:
 *   1. verify every running/queued job against the agent's real state;
 *   2. resurrect jobs wrongly marked failed while their session is alive;
 *   3. mirror `tmux ls` (adopt sessions we have no record of);
 *   4. collapse duplicate active jobs for the same VM+schedule.
 *
 * Changes are committed as a field-level patch (never a stale snapshot) and
 * announced over the socket so open panels update without waiting for a poll.
 */
async function reconcileJobsAgainstAgents(io) {
  const jobs = await getBackupJobs();
  const hosts = await getBackupHosts();
  const before = snapshotJobs(jobs);

  const activeJobs = jobs.filter(j =>
    j.status === 'running' || j.status === 'queued' || j.status === 'retrying'
  );

  let statusUpdated = false;
  if (activeJobs.length > 0) {
    const SYNC_BUDGET_MS = 15000;
    const agentActiveCache = new Map(); // one agent call per host, shared by all jobs
    const results = await Promise.race([
      Promise.allSettled(activeJobs.map(j => syncJobStatusWithAgent(j, hosts, agentActiveCache))),
      new Promise(resolve => setTimeout(() => resolve(null), SYNC_BUDGET_MS)),
    ]);
    if (Array.isArray(results)) {
      statusUpdated = results.some(r => r.status === 'fulfilled' && r.value);
    } else {
      console.warn('[Reconcile] Agent status sync exceeded budget; committing what we have');
      statusUpdated = true; // partial results are still worth persisting
    }
  }

  // Correct jobs wrongly marked failed while still running in tmux, so they
  // reappear in the active list instead of sitting failed in history.
  let resurrected = false;
  try {
    resurrected = await resurrectRunningFailedJobs(jobs, hosts);
  } catch (e) {
    console.warn('[Reconcile] resurrect check failed:', e.message);
  }

  // Mirror `tmux ls`: adopt/refresh live sessions the controller isn't already
  // showing as running (records lost, superseded, or finalized while the
  // session kept running). Runs regardless of activeJobs.length — the case we
  // fix is "zero active jobs shown, but sessions alive on the host".
  let adopted = false;
  try {
    const vms = await getVirtualMachines();
    adopted = await adoptLiveTmuxSessions(jobs, hosts, vms);
  } catch (e) {
    console.warn('[Reconcile] adopt live sessions failed:', e.message);
  }

  // Collapse any duplicate active jobs for the same VM+schedule down to the
  // single real run. Runs LAST so it wins over any status the agent sync or
  // resurrector produced (both can be fooled into keeping a zombie "running"
  // when a newer run's tmux session collides on the VM+schedule name).
  let deduped = false;
  try {
    deduped = dedupeActiveBackupJobs(jobs);
  } catch (e) {
    console.warn('[Reconcile] dedupe check failed:', e.message);
  }

  if (!(statusUpdated || resurrected || adopted || deduped)) return false;

  const commit = await commitJobChanges(before, jobs, { insertGuard: canInsertAdoptedJob });
  if (!commit.changed) return false;

  if (io) {
    // Push what changed to open panels; the next poll confirms it.
    for (const job of commit.jobs) {
      const prev = before.get(job.id);
      if (!prev || prev.status !== job.status || prev.phase !== job.phase || prev.progress !== job.progress) {
        io.emit('job-updated', job);
      }
    }
  }
  return true;
}

// GET /api/backups/active - Get active backup jobs
router.get('/active', async (req, res, next) => {
  try {
    const jobs = await getBackupJobs();

    // Reconcile behind the response, never in front of it — see
    // runReconcileDetached. The store is kept current by that pass plus the
    // background tmux mirror, so what we serve here is already right; anything
    // the pass changes reaches the panel over its socket and next poll.
    if ((Date.now() - _lastActiveReconcileAt) > ACTIVE_RECONCILE_MIN_INTERVAL_MS) {
      runReconcileDetached('Active', () => reconcileJobsAgainstAgents(req.app.get('io')));
    }

    let activeJobs = jobs.filter(j => j.status === 'running' || j.status === 'queued' || j.status === 'retrying');

    // Add countdown for retrying jobs
    activeJobs = activeJobs.map(job => ({
      ...job,
      ...(job.status === 'retrying' && job.retryAt ? {
        retryCountdownSeconds: Math.max(0, Math.floor((new Date(job.retryAt) - new Date()) / 1000))
      } : {})
    }));
    
    res.json({ success: true, data: activeJobs });
  } catch (error) {
    next(error);
  }
});

// GET /api/backups/history - Get backup and restore job history
router.get('/history', async (req, res, next) => {
  try {
    const { limit = 100, status, vmId } = req.query;
    let backupJobs = await getBackupJobs();

    // Same detached reconcile as /active, on the same shared throttle: History
    // answers from the store immediately and the agent round-trips happen
    // behind the response. Both handlers drive the identical pass, so it no
    // longer matters which one wins the window (when only /history reconciled,
    // it finalized jobs that nothing re-adopted until /active next won a
    // window — that mismatch is what made rows blink in and out).
    if ((Date.now() - _lastActiveReconcileAt) > ACTIVE_RECONCILE_MIN_INTERVAL_MS) {
      runReconcileDetached('History', () => reconcileJobsAgainstAgents(req.app.get('io')));
    }

    // Get restore jobs
    const fs = require('fs').promises;
    const path = require('path');
    const RESTORE_JOBS_FILE = path.join(__dirname, '../data/restore-jobs.json');
    let restoreJobs = [];
    
    try {
      const restoreData = await fs.readFile(RESTORE_JOBS_FILE, 'utf8');
      const parsed = JSON.parse(restoreData);
      restoreJobs = parsed.jobs || [];
      
      // Add jobType field to distinguish restore jobs
      restoreJobs = restoreJobs.map(job => ({
        ...job,
        jobType: 'restore',
        // Map restore fields to match backup job structure
        scheduleType: job.method,
      }));
    } catch (error) {
      // Restore jobs file doesn't exist or is empty, continue with empty array
      console.log('[History] No restore jobs found:', error.message);
    }
    
    // Add jobType to backup jobs
    backupJobs = backupJobs.map(job => ({
      ...job,
      jobType: 'backup',
      // Calculate countdown for retrying jobs
      ...(job.status === 'retrying' && job.retryAt ? {
        retryCountdownSeconds: Math.max(0, Math.floor((new Date(job.retryAt) - new Date()) / 1000))
      } : {})
    }));
    
    // Combine backup and restore jobs
    let allJobs = [...backupJobs, ...restoreJobs];
    
    // Apply filters
    if (status) {
      allJobs = allJobs.filter(j => j.status === status);
    }
    
    if (vmId) {
      allJobs = allJobs.filter(j => j.vmId === vmId || j.vmName === vmId);
    }
    
    // Still-running jobs come FIRST, then everything else newest-first.
    //
    // Sorting purely by startTime buries a live job on page 3 as soon as it has
    // been running longer than a page of finished ones — and a session adopted
    // from tmux carries the session's real (often hours-old) start time, so it
    // landed several pages back the moment it appeared. Worse, with a `limit`
    // it could be cut from the response entirely. What's happening now belongs
    // on the page the user is looking at.
    const ACTIVE_FIRST = ['running', 'queued', 'retrying', 'initializing'];
    const startedAt = (j) => {
      const t = new Date(j.startTime).getTime();
      return Number.isFinite(t) ? t : 0;
    };
    allJobs.sort((a, b) => {
      const aActive = ACTIVE_FIRST.includes(a.status) ? 1 : 0;
      const bActive = ACTIVE_FIRST.includes(b.status) ? 1 : 0;
      if (aActive !== bActive) return bActive - aActive;
      return startedAt(b) - startedAt(a);
    });
    allJobs = allJobs.slice(0, parseInt(limit));
    
    res.json({ success: true, data: allJobs });
  } catch (error) {
    next(error);
  }
});

// GET /api/backups/jobs/:id - Get single job
router.get('/jobs/:id', async (req, res, next) => {
  try {
    const jobs = await getBackupJobs();
    const job = jobs.find(j => j.id === req.params.id);
    
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }
    
    // Verify status with agent if marked as running/queued
    const hosts = await getBackupHosts();
    const updated = await syncJobStatusWithAgent(job, hosts);
    
    if (updated) {
      await saveBackupJobs(jobs);
    }
    
    // Add countdown for retrying jobs
    const jobData = {
      ...job,
      ...(job.status === 'retrying' && job.retryAt ? {
        retryCountdownSeconds: Math.max(0, Math.floor((new Date(job.retryAt) - new Date()) / 1000))
      } : {})
    };
    
    res.json({ success: true, data: jobData });
  } catch (error) {
    next(error);
  }
});

// GET /api/backups/jobs/:id/logs - Get job logs
router.get('/jobs/:id/logs', async (req, res, next) => {
  try {
    const jobs = await getBackupJobs();
    let job = jobs.find(j => j.id === req.params.id);

    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    // A run that was REJECTED never executed — it has no output of its own,
    // only a controller note. What the operator actually wants to see is the
    // backup it collided with, which is the one doing the work. Follow the
    // link and serve that run's real (tmux/script) log instead.
    let coveredNote = '';
    if (job.status === 'rejected' && job.coveredBy) {
      const covering = jobs.find(j => j.id === job.coveredBy);
      if (covering) {
        coveredNote =
          `[this run was rejected — ${job.vmName} was already being backed up]\n` +
          `[showing the log of the backup that is running: job ${covering.id}]\n\n`;
        job = covering;
      }
    }

    // Get backup host
    const hosts = await getBackupHosts();
    const host = hosts.find(h => h.id === job.backupHostId);
    
    if (!host) {
      // Fallback to controller logs if host not found
      const logs = await readLog(job.id);
      return res.json({ success: true, data: { logs: coveredNote + logs } });
    }

    // Fetch logs from agent. Default to the last 2000 lines so a huge job
    // log can't stall the panel; pass ?full=1 for the complete log.
    const tail = req.query.full === '1' ? undefined : (Number(req.query.tail) > 0 ? Number(req.query.tail) : 2000);

    // Resolve the storage pool path so the agent can fall back to the durable
    // script log on the backup pool if the flat per-job log was lost.
    //
    // A run adopted from a live tmux session has no flat per-job log at all
    // (the agent never registered it), so the pool log is the ONLY way to show
    // what that backup is doing — and it carries `storagePoolPath` straight
    // from the host for exactly this reason. Without it the viewer could only
    // offer the controller-side record, which is not the backup's output.
    let poolPath = job.storagePoolPath || null;
    if (!poolPath && job.storagePoolId) {
      try {
        const { getStoragePools } = require('../services/fileStorage');
        const pools = await getStoragePools();
        const pool = pools.find(p => p.id === job.storagePoolId && p.backupHostId === host.id);
        if (pool) poolPath = pool.path;
      } catch (_) { /* best-effort */ }
    }
    const agentScheduleTypeForLog = (() => {
      switch (job.scheduleType) {
        case 'once': case 'monthly': case 'daily': case 'weekly': case 'custom': return job.scheduleType;
        case 'interval': case 'cron': return 'daily';
        case 'custom-days': return 'custom';
        default: return job.scheduleType || null;
      }
    })();

    try {
      const client = agentService.createAgentClient(host.url, host.id, host.name);
      const response = await client.get(`/api/backup/logs/${job.id}`, {
        timeout: 10000,
        params: {
          ...(tail ? { tail } : {}),
          ...(job.vmName && poolPath && agentScheduleTypeForLog
            ? { vmName: job.vmName, scheduleType: agentScheduleTypeForLog, storagePoolPath: poolPath }
            : {}),
        },
      });

      // The agent returns HTTP 200 with an empty string when it holds no log
      // for this job (missing flat log AND no durable pool log). That is NOT an
      // error, so it never hit the catch-block fallback below — and the viewer
      // showed "no logs" even when the controller itself recorded why the job
      // failed (trigger error, reconciler note, "queued but never started").
      // Fall back to the controller's own log store on an empty agent reply so
      // that reason is always visible.
      const agentLogs = (response.data && response.data.data && response.data.data.logs) || '';
      if (agentLogs.trim()) {
        return res.json({ success: true, data: { logs: coveredNote + agentLogs } });
      }
      const controllerLogs = await readLog(job.id);
      return res.json({
        success: true,
        data: {
          logs: controllerLogs && controllerLogs.trim()
            ? `${coveredNote}[no log on backup host — showing controller-side record]\n\n${controllerLogs}`
            : agentLogs, // both empty: preserve prior behaviour (empty string)
        },
      });
    } catch (error) {
      console.error('Error fetching logs from agent:', error.message);
      
      // Deliberately does NOT touch job status.
      //
      // This used to mark the job "completed" on a 404, which meant merely
      // OPENING THE LOG VIEWER could flip a running — or failed — backup to a
      // green completed with exit code "-". A 404 from the log endpoint says
      // one thing only: the agent isn't holding this job's log right now. It is
      // not evidence about the backup's outcome, and a read endpoint has no
      // business finalising a job as a side effect of being read.
      //
      // Finalisation belongs to syncJobStatusWithAgent, which asks live-status
      // and trusts the shell's recorded exit code before concluding anything.

      // Fallback to controller logs
      const logs = await readLog(job.id);
      res.json({ success: true, data: { logs: coveredNote + logs } });
    }
  } catch (error) {
    next(error);
  }
});

// GET /api/backups/jobs/:id/logs/stream - Stream job logs (SSE proxy to agent)
router.get('/jobs/:id/logs/stream', async (req, res, next) => {
  try {
    const jobs = await getBackupJobs();
    const job = jobs.find(j => j.id === req.params.id);
    
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    // Get backup host
    const hosts = await getBackupHosts();
    const host = hosts.find(h => h.id === job.backupHostId);
    
    if (!host) {
      return res.status(404).json({ success: false, error: 'Backup host not found' });
    }

    // Proxy SSE stream from agent
    const client = agentService.createAgentClient(host.url, host.id, host.name);
    
    const response = await client.get(`/api/backup/logs/${req.params.id}/stream`, {
      responseType: 'stream',
      timeout: 0 // No timeout for streaming
    });

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Pipe the stream
    response.data.pipe(res);

    // Handle client disconnect
    req.on('close', () => {
      response.data.destroy();
      res.end();
    });
  } catch (error) {
    console.error('Error streaming logs from agent:', error.message);
    next(error);
  }
});

// POST /api/backups/trigger - Trigger manual backup
router.post('/trigger', requireUser, async (req, res, next) => {
  try {
    const { 
      vmId, 
      vmName, 
      backupHostId, 
      hypervisorIp, 
      storagePoolId,
      scheduleType = 'once',
      retention = 7,
      keepArchive = 2,
      compression = 2,
      noCompression = false,
      noVerify = false,
      offsiteHostIds = [],
      offsiteTargets = [],
      offsiteRetryAttempts = 3,
      offsiteRetryBackoffSeconds = 15,
      verbose = false
    } = req.body;

    if (!vmId) {
      return res.status(400).json({ 
        success: false, 
        error: 'vmId is required' 
      });
    }

    if (!storagePoolId) {
      return res.status(400).json({ 
        success: false, 
        error: 'storagePoolId is required' 
      });
    }

    // Get backup host
    const hosts = await getBackupHosts();
    const host = hosts.find(h => h.id === backupHostId);
    if (!host) {
      return res.status(404).json({ success: false, error: 'Backup host not found' });
    }

    // Check host status
    if (host.status !== 'online') {
      return res.status(400).json({ success: false, error: 'Backup host is offline' });
    }

    // A job for this VM is already tracked as running/queued — refuse before
    // creating a duplicate record. (The agent-side lock check below catches
    // locks the controller doesn't know about; this catches controller-side
    // jobs before we even touch the agent.)
    const jobs = await getBackupJobs();
    const existingVmJob = jobs.find(j =>
      j.vmId === vmId &&
      j.backupHostId === backupHostId &&
      (j.status === 'running' || (j.status === 'queued' && !j.pendingStart))
    );
    if (existingVmJob) {
      return res.status(409).json({
        success: false,
        error: `A backup for this VM is already ${existingVmJob.status} (job ${existingVmJob.id.substring(0, 8)}). Wait for it to finish or clear its state first.`,
        existingJobId: existingVmJob.id,
      });
    }

    // Check concurrent backup limit
    const runningJobsOnHost = jobs.filter(j =>
      j.backupHostId === backupHostId &&
      (j.status === 'running' || j.status === 'queued')
    );
    
    const rawMax = host.maxConcurrentBackups;
    const maxConcurrent = (rawMax === undefined || rawMax === null) ? 20 : Number(rawMax);
    // 0 = unlimited: never block manual triggers on concurrency.
    if (maxConcurrent !== 0 && runningJobsOnHost.length >= maxConcurrent) {
      return res.status(429).json({ 
        success: false, 
        error: `Maximum concurrent backups (${maxConcurrent}) reached for this backup host. Please wait for a backup to complete.`,
        currentRunning: runningJobsOnHost.length,
        maxAllowed: maxConcurrent
      });
    }

    // Validate storage pool exists and belongs to backup host
    const { getStoragePools } = require('../services/fileStorage');
    const pools = await getStoragePools();
    const pool = pools.find(p => p.id === storagePoolId && p.backupHostId === backupHostId);

    if (!pool) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid storage pool for this backup host' 
      });
    }

    // Get VM info if not provided
    let finalVmName = vmName;
    let finalHypervisorIp = hypervisorIp;

    if (!vmName || !hypervisorIp) {
      const vms = await getVirtualMachines();
      const vm = vms.find(v => v.id === vmId);
      if (!vm) {
        return res.status(404).json({ success: false, error: 'VM not found' });
      }
      finalVmName = vm.name;

      const hypervisors = await getHypervisors();
      const hypervisor = hypervisors.find(h => h.id === vm.hypervisorId);
      if (!hypervisor) {
        return res.status(404).json({ success: false, error: 'Hypervisor not found' });
      }
      finalHypervisorIp = hypervisor.ip;
    }

    // Resolve offsite targets through the shared scheduler helper so manual
    // triggers behave identically to scheduled backups. The helper prefers the
    // per-pool `offsiteTargets` shape and falls back to legacy `offsiteHostIds`
    // + host `backupPath`. `resolved` (with ip/path) is persisted on the job
    // record for retries/replays (Req 9.4); `encoded` (shell-safe ip:path) is
    // sent to the agent (Req 6.6, 9.1).
    const { resolved: offsiteTargetsResolved, encoded: offsiteEncoded } =
      await schedulerService.resolveOffsiteTargets({ offsiteTargets, offsiteHostIds });

    // PRE-FLIGHT CHECK: Verify no backup is already in progress
    console.log(`[BackupTrigger] Checking if backup is already in progress for ${finalVmName}/${scheduleType}`);
    try {
      const statusCheck = await agentService.checkBackupStatus(
        host.url,
        finalVmName,
        scheduleType,
        pool.path
      );

      if (statusCheck.inProgress) {
        console.error(`[BackupTrigger] Backup already in progress for ${finalVmName}/${scheduleType}: ${statusCheck.details}`);
        return res.status(409).json({
          success: false,
          error: 'Backup already in progress',
          message: `Cannot start backup: ${statusCheck.details}`,
          details: {
            vmName: finalVmName,
            scheduleType: scheduleType,
            status: statusCheck.status,
            checks: statusCheck.checks
          }
        });
      }

      console.log(`[BackupTrigger] ✓ No backup in progress, proceeding with backup`);
    } catch (error) {
      // Log error but don't block backup if status check fails
      console.warn(`[BackupTrigger] Warning: Status check failed, proceeding anyway:`, error.message);
    }

    // Create job record
    const jobId = uuidv4();
    const job = {
      id: jobId,
      vmId,
      vmName: finalVmName,
      hypervisorIp: finalHypervisorIp,
      backupHostId,
      backupHostName: host.name,
      storagePoolId,
      storagePoolName: pool.name,
      scheduleType,
      retention,
      keepArchive,
      compression: compression || 2,
      noCompression: noCompression || false,
      noVerify: noVerify || false,
      offsiteTargets: offsiteTargetsResolved,
      status: 'queued',
      startTime: new Date().toISOString(),
      endTime: null,
      exitCode: null,
      error: null,
      scheduled: false,
      progress: 0,
      progressText: 'Queued...',
    };

    // Save job (jobs already loaded above for concurrent check)
    jobs.push(job);
    await saveBackupJobs(jobs);

    // Log start
    await appendLog(jobId, `Manual backup triggered for VM: ${finalVmName}`);
    await appendLog(jobId, `Storage Pool: ${pool.name} (${pool.path})`);
    await appendLog(jobId, `Schedule Type: ${scheduleType}`);
    await appendLog(jobId, `Retention: ${retention}, Keep Archive: ${keepArchive}`);
    await appendLog(jobId, `Compression: ${noCompression ? 'disabled' : compression || 2}`);
    if (offsiteEncoded.length > 0) {
      await appendLog(jobId, `Offsite targets: ${offsiteEncoded.join(', ')}`);
    }

    // Get io from app
    const io = req.app.get('io');
    io.emit('backup-started', job);

    // Trigger backup on agent
    try {
      await agentService.triggerBackup(host.url, {
        jobId,
        vmName: finalVmName,
        hypervisorIp: finalHypervisorIp,
        storagePoolId,
        storagePoolPath: pool.path,
        diskUsageThreshold: pool.diskUsageThreshold ?? 80,
        scheduleType,
        retention,
        keepArchive,
        offsiteRetryAttempts,
        offsiteRetryBackoffSeconds,
        compression: compression || 2,
        noCompression: noCompression || false,
        noVerify: noVerify || false,
        offsiteHosts: offsiteEncoded,
        verbose,
      });

      // Update job status against FRESH store state. The agent may already
      // have posted running/progress updates while the trigger call was in
      // flight; saving our stale `jobs` array would silently roll them back
      // and leave the job stuck on "queued" in the Active list.
      const freshJobs = await getBackupJobs();
      const freshJob = freshJobs.find(j => j.id === jobId);
      if (freshJob && freshJob.status === 'queued') {
        freshJob.status = 'running';
        await saveBackupJobs(freshJobs);
        job.status = 'running';
        io.emit('job-updated', freshJob);
      } else if (freshJob) {
        job.status = freshJob.status;
      }

    } catch (error) {
      const freshJobs = await getBackupJobs();
      let freshJob = freshJobs.find(j => j.id === jobId);
      if (!freshJob) {
        freshJob = job;
        freshJobs.push(freshJob);
      }
      freshJob.status = 'failed';
      freshJob.error = error.message;
      freshJob.endTime = new Date().toISOString();
      await saveBackupJobs(freshJobs);
      job.status = 'failed';
      job.error = error.message;
      await appendLog(jobId, `Error triggering backup: ${error.message}`);
      io.emit('backup-error', freshJob);
    }

    res.status(202).json({ success: true, data: job });
  } catch (error) {
    next(error);
  }
});

// POST /api/backups/trigger-scheduled - Trigger scheduled backup with cycle management
router.post('/trigger-scheduled', async (req, res, next) => {
  try {
    const { vmId, backupHostId, compression, noCompression, noVerify } = req.body;

    if (!vmId) {
      return res.status(400).json({ 
        success: false, 
        error: 'vmId is required' 
      });
    }

    // Get VM
    const vms = await getVirtualMachines();
    const vm = vms.find(v => v.id === vmId);
    if (!vm) {
      return res.status(404).json({ success: false, error: 'VM not found' });
    }

    // Get backup host
    const hosts = await getBackupHosts();
    const host = hosts.find(h => h.id === backupHostId || h.id === vm.backupHostId);
    if (!host) {
      return res.status(404).json({ success: false, error: 'Backup host not found' });
    }

    // Check host status
    if (host.status !== 'online') {
      return res.status(400).json({ success: false, error: 'Backup host is offline' });
    }

    // Get hypervisor info
    const hypervisors = await getHypervisors();
    const hypervisor = hypervisors.find(h => h.id === vm.hypervisorId);
    if (!hypervisor) {
      return res.status(404).json({ success: false, error: 'Hypervisor not found' });
    }

    // Determine backup method and handle archiving
    const cycleConfig = await backupCycleService.executeBackupWithCycle(vmId, host.url);
    
    console.log(`Scheduled backup for ${vm.name}: method=${cycleConfig.method}, cycle=${cycleConfig.cycleInfo.current}/${cycleConfig.cycleInfo.total}`);

    // Create job record
    const jobId = uuidv4();
    const job = {
      id: jobId,
      vmId,
      vmName: vm.name,
      hypervisorIp: hypervisor.ip,
      backupHostId: host.id,
      backupHostName: host.name,
      method: cycleConfig.method,
      compression: compression || 2,
      noCompression: noCompression || false,
      noVerify: noVerify || false,
      status: 'queued',
      startTime: new Date().toISOString(),
      endTime: null,
      exitCode: null,
      error: null,
      scheduled: true,
      cycleInfo: cycleConfig.cycleInfo,
      progress: 0,
      progressText: 'Queued...',
    };

    // Save job
    const jobs = await getBackupJobs();
    jobs.push(job);
    await saveBackupJobs(jobs);

    // Log start
    await appendLog(jobId, `Scheduled backup triggered for VM: ${vm.name}`);
    await appendLog(jobId, `Method: ${cycleConfig.method} (cycle: ${cycleConfig.cycleInfo.current}/${cycleConfig.cycleInfo.total})`);
    if (cycleConfig.cycleInfo.archived) {
      await appendLog(jobId, `Previous backup archived before starting new cycle`);
    }
    await appendLog(jobId, `Compression: ${noCompression ? 'disabled' : compression || 2}`);

    // Get io from app
    const io = req.app.get('io');
    io.emit('backup-started', job);

    // Trigger backup on agent
    try {
      await agentService.triggerBackup(host.url, {
        jobId,
        vmName: vm.name,
        hypervisorIp: hypervisor.ip,
        method: cycleConfig.method,
        compression: compression || 2,
        noCompression: noCompression || false,
        noVerify: noVerify || false,
      });

      // Update job status
      job.status = 'running';
      await saveBackupJobs(jobs);

      // Increment backup counter after successful trigger
      await backupCycleService.incrementBackupCounter(vmId);

    } catch (error) {
      job.status = 'failed';
      job.error = error.message;
      job.endTime = new Date().toISOString();
      await saveBackupJobs(jobs);
      await appendLog(jobId, `Error triggering backup: ${error.message}`);
      io.emit('backup-error', job);
    }

    res.status(202).json({ success: true, data: job });
  } catch (error) {
    next(error);
  }
});
// POST /api/backups/jobs/:id/update - Update job status (called by agent)
router.post('/jobs/:id/update', async (req, res, next) => {
  try {
    const { status, exitCode, error, logLine, progress, progressText, failureReason, offsiteResults, progressType, verdictAlreadyReported, failureStage, offsiteSyncStatus: reportedOffsiteStatus } = req.body;
    
    // Apply the agent report inside a single atomic read-modify-write.
    // The agent posts one of these per running job roughly every second; a
    // plain read → mutate → save would let a slow reconciler that read
    // earlier and wrote later silently roll it back (and vice versa: this
    // handler saving a whole stale array is what used to drop jobs the
    // reconciler had just adopted from a live tmux session).
    let job = null;
    let offsiteRetryFinished = false;
    await updateBackupJobs((jobs) => {
      job = jobs.find(j => j.id === req.params.id);
      if (!job) return false; // nothing to write

      // ── Offsite-only resync in flight ────────────────────────────────
      // The controller re-triggered this SAME job id with offsiteOnly=true to
      // retry a failed/partial offsite sync. The agent reports normal backup
      // statuses for that run, but no backup is happening — the original
      // backup already finished and its verdict is final. Apply only the
      // offsite-related fields so a failing resync can never flip a
      // successful backup to 'failed' (or resurrect a finished job as
      // 'running').
      if (job.offsiteRetryInFlight) {
        if (progress !== undefined) job.offsiteRetryProgress = progress;
        if (progressText !== undefined) {
          job.offsiteRetryProgressText = stripAnsi(progressText, { singleLine: true });
        }
        job.lastProgressAt = new Date().toISOString();

        // Merge per-host outcomes: a retry only targets the hosts that
        // previously failed, so replacing the array would erase the hosts
        // that already succeeded on the original run.
        if (Array.isArray(offsiteResults) && offsiteResults.length > 0) {
          const merged = Array.isArray(job.offsiteResults) ? [...job.offsiteResults] : [];
          for (const r of offsiteResults) {
            const i = merged.findIndex(m => m && r && m.ip === r.ip && (m.poolPath || '') === (r.poolPath || ''));
            if (i >= 0) merged[i] = r;
            else merged.push(r);
          }
          job.offsiteResults = merged;
        }

        const terminal = status === 'completed' || status === 'failed' || status === 'cancelled';
        if (terminal) {
          job.offsiteRetryInFlight = false;
          job.offsiteRetryAt = null;
          job.phase = null;

          const results = Array.isArray(job.offsiteResults) ? job.offsiteResults : [];
          if (results.length > 0) {
            const ok = results.filter(r => r.status === 'success').length;
            job.offsiteSyncStatus = ok === results.length
              ? 'completed'
              : ok > 0 ? 'partial' : 'failed';
          } else {
            job.offsiteSyncStatus = status === 'completed' ? 'completed' : 'failed';
          }
          offsiteRetryFinished = true;
        } else {
          job.offsiteSyncStatus = 'running';
          job.phase = 'rsync';
        }
        return true;
      }

      // The agent already reported this run's failure (the backup phase failed
      // and the script stayed busy with its post-failure offsite sync). This is
      // the same verdict arriving again at script exit: take the offsite
      // outcomes it carries, but leave the status/retry decision alone so the
      // pending retry isn't duplicated or overwritten.
      if (verdictAlreadyReported && status === 'failed') {
        if (Array.isArray(offsiteResults) && offsiteResults.length > 0) {
          job.offsiteResults = offsiteResults;
          const ok = offsiteResults.filter(r => r.status === 'success').length;
          job.offsiteSyncStatus = ok === offsiteResults.length
            ? 'completed'
            : ok > 0 ? 'partial' : 'failed';
        }
        if (exitCode !== undefined) job.exitCode = exitCode;
        job.phase = null;
        job.lastProgressAt = new Date().toISOString();
        return true;
      }

      // Handle status updates
      if (status) {
        console.log(`[Backups] Job ${job.id} received status update: ${status}, current status: ${job.status}`);

        // For scheduled backups with retry capability, check if we should mark as "retrying" instead of "failed"
        if (status === 'failed' && job.scheduled && job.scheduleId) {
          const attempt = job.attemptNumber || 1;
          const maxAttempts = job.maxAttempts || 1;
        
          console.log(`[Backups] Job ${job.id} failed - checking retry eligibility:`);
          console.log(`  - scheduled: ${job.scheduled}`);
          console.log(`  - scheduleId: ${job.scheduleId}`);
          console.log(`  - attempt: ${attempt}/${maxAttempts}`);
          console.log(`  - retryCount from schedule: ${maxAttempts - 1}`);
        
          // If we have retries remaining, mark as "retrying" instead of "failed"
          if (attempt < maxAttempts) {
            job.status = 'retrying';
            job.retryScheduled = true;
            // Set retry timestamp for countdown
            const retryDelayMinutes = job.retryDelayMinutes || 5;
            job.retryAt = new Date(Date.now() + (retryDelayMinutes * 60 * 1000)).toISOString();
            console.log(`[Backups] ✓ Job ${job.id} marked as 'retrying' (attempt ${attempt}/${maxAttempts})`);
            console.log(`[Backups] ✓ Retry scheduled at ${job.retryAt} (in ${retryDelayMinutes} minutes)`);
            console.log(`[Backups] ✓ Job will NOT have endTime set (stays in active)`);
          } else {
            // All retries exhausted, mark as failed
            job.status = 'failed';
            job.retriesExhausted = true;
            job.retryAt = null; // Clear retry timestamp
            console.log(`[Backups] ✗ Job ${job.id} marked as 'failed' - all ${maxAttempts} attempts exhausted`);
          }
        } else {
          job.status = status;
          if (status === 'failed') {
            console.log(`[Backups] Job ${job.id} marked as failed (no retry - scheduled:${job.scheduled}, scheduleId:${job.scheduleId})`);
          }
        }
      
        // Treat cancelled as failed
        if (status === 'cancelled') {
          job.status = 'failed';
          if (!error) {
            job.error = 'Cancelled by user';
          }
          if (exitCode === undefined || exitCode === null) {
            job.exitCode = 1;
          }
        }
      }
    
      if (exitCode !== undefined) job.exitCode = exitCode;
      // The agent scrapes error/progress text out of colourised script logs, so
      // scrub terminal escapes at ingestion: this keeps the stored record clean
      // for the UI regardless of which agent version reported it.
      if (error) job.error = stripAnsi(error, { singleLine: true });
      if (failureReason) job.failureReason = failureReason;
      if (progress !== undefined) job.progress = progress;
      if (progressText !== undefined) job.progressText = stripAnsi(progressText, { singleLine: true });

      // Track the progress phase reported by the agent (backup vs rsync).
      // phase='rsync' drives the purple "Syncing offsite" badge; the offsite
      // sync status persists so History can show it after the job ends —
      // including for failed backups whose offsite sync still ran.
      if (progressType) {
        job.progressType = progressType;
        if (progressType === 'rsync') {
          job.phase = 'rsync';
          if (job.status === 'running' || job.status === 'queued') {
            job.offsiteSyncStatus = 'running';
          }
        } else if (job.phase === 'rsync') {
          job.phase = 'backup';
        }
      }

      // Persist per-offsite-host outcomes (sent with the terminal update).
      if (Array.isArray(offsiteResults) && offsiteResults.length > 0) {
        job.offsiteResults = offsiteResults;
        const ok = offsiteResults.filter(r => r.status === 'success').length;
        job.offsiteSyncStatus = ok === offsiteResults.length
          ? 'completed'
          : ok > 0 ? 'partial' : 'failed';
      }

      // The agent can report an offsite verdict that differs from the backup's
      // own outcome (backup fine, replication not).
      if (reportedOffsiteStatus) job.offsiteSyncStatus = reportedOffsiteStatus;

      // Which stage failed. `failureReason` says WHY (interrupted, script_error);
      // `failureStage` says WHERE — so a backup that succeeded but failed to
      // replicate is no longer indistinguishable from a backup that never ran.
      if (failureStage) {
        job.failureStage = failureStage;
      } else if (job.status === 'completed' &&
                 (job.offsiteSyncStatus === 'failed' || job.offsiteSyncStatus === 'partial')) {
        job.failureStage = 'offsite';
      } else if (job.status === 'completed' && job.offsiteSyncStatus === 'completed') {
        job.failureStage = null;
      }

      // Record the last time we heard from the agent about this job. Used by the
      // monitoring service to detect *inactivity* (a genuinely hung backup or
      // lost connectivity) instead of naively alerting on total runtime — a
      // legitimately long backup keeps updating this and is never "stuck".
      job.lastProgressAt = new Date().toISOString();
    
      // Set end time for terminal states
      if (status === 'completed' || status === 'cancelled' ||
          (status === 'failed' && job.status === 'failed')) { // Only set endTime if actually failed (not retrying)
        job.endTime = new Date().toISOString();
        // This terminal status came straight from the agent's own exit-code
        // detection — it is authoritative. Mark it verified so the UI can
        // distinguish it from a completion inferred by the controller-side
        // reconciler (which can't see the real exit code). A verified
        // completion with exitCode 0 is a backup you can trust.
        job.verified = true;
        delete job.unverified;
        if (status === 'completed') {
          job.progress = 100;
          // Mark if this was a successful retry
          if (job.attemptNumber && job.attemptNumber > 1) {
            job.wasRetried = true;
            job.succeededOnAttempt = job.attemptNumber;
            console.log(`[Backups] Job ${job.id} completed successfully on retry attempt ${job.attemptNumber}`);
          }
        }
        // Terminal: no live phase remains; if the offsite sync was seen running
        // but the agent sent no per-host outcomes, its result is unknown.
        if (job.phase === 'rsync') job.phase = null;
        if (job.offsiteSyncStatus === 'running' && !(Array.isArray(offsiteResults) && offsiteResults.length > 0)) {
          job.offsiteSyncStatus = 'unknown';
        }
      }
    });

    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    if (logLine) {
      await appendLog(req.params.id, logLine);
    }

    const io = req.app.get('io');

    // Offsite-only resync: this run says nothing about the backup itself, so
    // it must not drive backup-complete/backup-error events, RocketChat
    // notifications, backup auto-retry, or concurrency-slot release. Emit a
    // plain job update and, once the resync settles, record the outcome and
    // schedule the next offsite attempt if hosts are still failing.
    if (job.offsiteRetryInFlight || offsiteRetryFinished) {
      io.emit('job-updated', job);

      if (offsiteRetryFinished) {
        if (Array.isArray(job.offsiteResults) && job.offsiteResults.length > 0) {
          ingestOffsiteSyncResults(job, job.offsiteResults).catch(err => {
            console.error(`[Backups] Failed to ingest offsite sync results for job ${job.id}: ${err.message}`);
          });
        }
        if (job.offsiteSyncStatus === 'failed' || job.offsiteSyncStatus === 'partial') {
          schedulerService.handleOffsiteSyncFailure(job).catch(err => {
            console.error('[Backups] Failed to schedule offsite resync:', err.message);
          });
        }
      }

      return res.json({ success: true, data: job });
    }

    // Repeat of a verdict already reported early. The failure was announced
    // (and its retry scheduled) when the backup phase failed; all that is new
    // here is the offsite outcome and the fact that the session finally ended.
    // Record the offsite result and free the slot — but don't re-notify and
    // don't schedule a second retry for the same attempt.
    if (verdictAlreadyReported && status === 'failed') {
      io.emit('job-updated', job);

      if (offsiteResults) {
        ingestOffsiteSyncResults(job, offsiteResults).catch(err => {
          console.error(`[Backups] Failed to ingest offsite sync results for job ${job.id}: ${err.message}`);
        });
      }
      if (job.offsiteSyncStatus === 'failed' || job.offsiteSyncStatus === 'partial') {
        schedulerService.handleOffsiteSyncFailure(job).catch(err => {
          console.error('[Backups] Failed to schedule offsite resync:', err.message);
        });
      }
      schedulerService.releaseConcurrentSlotsOnHost(job.backupHostId).catch(err => {
        console.error('[Backups] Failed to release concurrent slots:', err.message);
      });

      return res.json({ success: true, data: job });
    }

    io.to(`job-${req.params.id}`).emit('backup-progress', {
      jobId: req.params.id,
      status: job.status,
      message: logLine,
      progress: job.progress,
      progressText: job.progressText,
    });

    if (status === 'completed') {
      io.emit('backup-complete', job);
      
      // Notify RocketChat
      const duration = job.endTime && job.startTime 
        ? `${Math.round((new Date(job.endTime) - new Date(job.startTime)) / 1000 / 60)}m`
        : 'unknown';
      
      // Include retry information in notification
      const retryInfo = job.wasRetried ? ` (succeeded on attempt ${job.succeededOnAttempt})` : '';
      notificationPolicy.shouldNotify(job.scheduleId || null, 'backupSuccess').then(send => {
        if (send) rocketChatService.notifyBackupCompleted(job.vmName, job.method || 'unknown', duration + retryInfo, job.scheduleId || null);
      }).catch(() => {
        rocketChatService.notifyBackupCompleted(job.vmName, job.method || 'unknown', duration + retryInfo, job.scheduleId || null);
      });

      // Primary backup succeeded — check whether any offsite host/pool sync was
      // skipped or failed and record a resilience warning + notification on the
      // originating schedule without disabling it (Req 6.2, 6.3, 6.4). Offsite
      // problems never affect the primary outcome. Fire-and-forget so a slow
      // schedule write can't delay the agent's status ack.
      if (offsiteResults) {
        ingestOffsiteSyncResults(job, offsiteResults).catch(err => {
          console.error(`[Backups] Failed to ingest offsite sync results for job ${job.id}: ${err.message}`);
        });
      }
    } else if (job.status === 'failed' || status === 'cancelled') {
      // Only emit backup-error if truly failed (not retrying)
      io.emit('backup-error', job);

      // Notify RocketChat. A backup that failed only at the offsite stage is
      // announced as an offsite problem, not a failed backup — different
      // event, and separately mutable.
      const retryInfo = job.retriesExhausted ? ' (all retries exhausted)' : '';
      const failEvent = job.failureStage === 'offsite' ? 'offsiteFailure' : 'backupFailure';
      notificationPolicy.shouldNotify(job.scheduleId || null, failEvent).then(send => {
        if (send) rocketChatService.notifyBackupFailed(job.vmName, job.method || 'unknown', (job.error || 'Unknown error') + retryInfo, job.scheduleId || null);
      }).catch(() => {
        rocketChatService.notifyBackupFailed(job.vmName, job.method || 'unknown', (job.error || 'Unknown error') + retryInfo, job.scheduleId || null);
      });

      // The offsite sync runs even when the backup fails (it replicates the
      // VM's existing chain). Record its per-host outcomes on the schedule
      // just like the success path does.
      if (offsiteResults) {
        ingestOffsiteSyncResults(job, offsiteResults).catch(err => {
          console.error(`[Backups] Failed to ingest offsite sync results for job ${job.id}: ${err.message}`);
        });
      }
    } else if (job.status === 'retrying') {
      // Emit a special event for retrying status
      io.emit('backup-retrying', job);
    }

    // Auto-retry scheduled backups that failed (not user-cancelled).
    // The scheduler decides whether attempts remain and schedules the
    // next one after the configured delay. The schedule stays intact
    // regardless of the outcome.
    if (status === 'failed' && job.scheduled && job.scheduleId && job.status === 'retrying') {
      schedulerService.handleScheduledBackupFailure(job).catch(err => {
        console.error('[Backups] Failed to schedule auto-retry:', err.message);
      });
    }

    // The offsite sync failed (or only partly succeeded) while the run itself
    // reached a terminal state. Schedule an offsite-only resync so the backup
    // still lands offsite without waiting for the next scheduled run — offsite
    // replication is the whole point of having a DR copy.
    if ((job.status === 'completed' || job.status === 'failed') &&
        (job.offsiteSyncStatus === 'failed' || job.offsiteSyncStatus === 'partial')) {
      schedulerService.handleOffsiteSyncFailure(job).catch(err => {
        console.error('[Backups] Failed to schedule offsite resync:', err.message);
      });
    }

    // A slot just freed up on this host — release any backups that were
    // skipped earlier because the concurrent_limit was hit. Without this
    // step, jobs skipped during a burst would never re-queue: the
    // existing retry logic only fires when an agent transitions
    // offline → online, not when a regular slot frees up.
    if (status === 'completed' || job.status === 'failed' || status === 'cancelled') {
      schedulerService.releaseConcurrentSlotsOnHost(job.backupHostId).catch(err => {
        console.error('[Backups] Failed to release concurrent slots:', err.message);
      });
    }

    res.json({ success: true, data: job });
  } catch (error) {
    next(error);
  }
});

// GET /api/backups/stats - Get backup statistics
router.get('/stats', async (req, res, next) => {
  try {
    const jobs = await getBackupJobs();
    
    const stats = {
      total: jobs.length,
      completed: jobs.filter(j => j.status === 'completed').length,
      failed: jobs.filter(j => j.status === 'failed').length,
      // Declined because the VM was already backing up — counted separately so
      // it never inflates the failure count.
      rejected: jobs.filter(j => j.status === 'rejected').length,
      running: jobs.filter(j => j.status === 'running').length,
      queued: jobs.filter(j => j.status === 'queued').length,
    };

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentJobs = jobs.filter(j => new Date(j.startTime) > oneDayAgo);
    
    stats.last24h = {
      total: recentJobs.length,
      completed: recentJobs.filter(j => j.status === 'completed').length,
      failed: recentJobs.filter(j => j.status === 'failed').length,
    };

    res.json({ success: true, data: stats });
  } catch (error) {
    next(error);
  }
});

// POST /api/backups/kill/:jobId - Kill/cancel a backup job
router.post('/kill/:jobId', requireUser, async (req, res, next) => {
  try {
    const jobs = await getBackupJobs();
    const job = jobs.find(j => j.id === req.params.jobId);
    
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    // If job is in 'retrying' status, it's not running on the agent yet
    // Just cancel it locally without calling the agent
    if (job.status === 'retrying') {
      // Cancel the scheduled retry timer
      schedulerService.cancelRetry(req.params.jobId);
      
      job.status = 'failed';
      job.endTime = new Date().toISOString();
      job.error = 'Cancelled by user during retry wait';
      job.retryAt = null; // Clear retry timestamp
      await saveBackupJobs(jobs);
      await appendLog(req.params.jobId, 'Retry cancelled by user');
      
      const io = req.app.get('io');
      if (io) {
        io.emit('backup-cancelled', job);
      }
      
      // Audit log
      try {
        const username = req.user?.username || 'unknown';
        auditService.logCancelBackup(username, req.params.jobId, job.vmName);
      } catch (auditError) {
        console.error('[Kill] Audit log failed:', auditError.message);
      }
      
      return res.json({ success: true, message: 'Retry cancelled successfully' });
    }

    // Get backup host
    const hosts = await getBackupHosts();
    const host = hosts.find(h => h.id === job.backupHostId);
    
    if (!host) {
      return res.status(404).json({ success: false, error: 'Backup host not found' });
    }

    // Forward kill request to agent for running/queued jobs
    try {
      const client = agentService.createAgentClient(host.url, host.id, host.name);
      await client.post(`/api/backup/kill/${req.params.jobId}`);
      
      // Update job status
      job.status = 'cancelled';
      job.endTime = new Date().toISOString();
      job.error = 'Cancelled by user';
      await saveBackupJobs(jobs);
      await appendLog(req.params.jobId, 'Backup cancelled by user');
      
      const io = req.app.get('io');
      if (io) {
        io.emit('backup-cancelled', job);
      }
      
      // Audit log
      try {
        const username = req.user?.username || 'unknown';
        auditService.logCancelBackup(username, req.params.jobId, job.vmName);
      } catch (auditError) {
        console.error('[Kill] Audit log failed:', auditError.message);
      }
      
      res.json({ success: true, message: 'Backup job cancelled' });
    } catch (error) {
      console.error('[Kill] Failed to cancel job on agent:', error.message);
      res.status(500).json({ 
        success: false, 
        error: `Failed to cancel job: ${error.message}` 
      });
    }
  } catch (error) {
    console.error('[Kill] Unexpected error:', error);
    next(error);
  }
});

// GET /api/backups/:vmName/directories - Get backup directories
router.get('/:vmName/directories', async (req, res, next) => {
  try {
    const { vmName } = req.params;
    const { backupHostId } = req.query;

    if (!backupHostId) {
      return res.status(400).json({ success: false, error: 'backupHostId is required' });
    }

    const hosts = await getBackupHosts();
    const host = hosts.find(h => h.id === backupHostId);
    
    if (!host) {
      return res.status(404).json({ success: false, error: 'Backup host not found' });
    }

    const directories = await agentService.getBackupDirectories(host.url, vmName);
    res.json({ success: true, data: directories });
  } catch (error) {
    next(error);
  }
});

// POST /api/backups/:vmName/archive - Archive current backup
router.post('/:vmName/archive', async (req, res, next) => {
  try {
    const { vmName } = req.params;
    const { backupHostId } = req.body;

    if (!backupHostId) {
      return res.status(400).json({ success: false, error: 'backupHostId is required' });
    }

    const hosts = await getBackupHosts();
    const host = hosts.find(h => h.id === backupHostId);
    
    if (!host) {
      return res.status(404).json({ success: false, error: 'Backup host not found' });
    }

    const result = await agentService.archiveBackup(host.url, vmName);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/backups/:vmName/:type - Delete backup directory
router.delete('/:vmName/:type', async (req, res, next) => {
  try {
    const { vmName, type } = req.params;
    const { backupHostId } = req.query;

    if (!['current', 'archived', 'monthly'].includes(type)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid type. Must be: current, archived, or monthly' 
      });
    }

    if (!backupHostId) {
      return res.status(400).json({ success: false, error: 'backupHostId is required' });
    }

    const hosts = await getBackupHosts();
    const host = hosts.find(h => h.id === backupHostId);
    
    if (!host) {
      return res.status(404).json({ success: false, error: 'Backup host not found' });
    }

    const result = await agentService.deleteBackupDirectory(host.url, vmName, type);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// POST /api/backups/jobs/:jobId/retry - Retry a skipped or failed backup
router.post('/jobs/:jobId/retry', async (req, res, next) => {
  try {
    const jobs = await getBackupJobs();
    const originalJob = jobs.find(j => j.id === req.params.jobId);
    
    if (!originalJob) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    // Only allow retry for runs that did not produce a backup: failed, skipped,
    // or rejected (refused because the VM was already backing up — retrying it
    // once that run finishes is exactly the right move).
    const RETRYABLE_STATUSES = ['skipped', 'failed', 'rejected'];
    if (!RETRYABLE_STATUSES.includes(originalJob.status)) {
      return res.status(400).json({
        success: false,
        error: 'Only failed, skipped or rejected jobs can be retried'
      });
    }

    // Guard against creating a duplicate: refuse if another job for the same VM
    // and schedule type is already active (running/queued/initializing/retrying).
    // Without this, clicking Retry while a previous attempt is still working — or
    // double-clicking — spawns a second concurrent backup for the same VM, which
    // then shows up as two "Backing up" entries. The agent's per-VM lock only
    // catches this when it and its in-memory state are intact (not across an
    // agent restart), so the controller must enforce it too.
    const ACTIVE_STATES = ['running', 'queued', 'initializing', 'retrying'];
    const activeDuplicate = jobs.find(j =>
      j.id !== originalJob.id &&
      j.vmId === originalJob.vmId &&
      (j.scheduleType || null) === (originalJob.scheduleType || null) &&
      ACTIVE_STATES.includes(j.status)
    );
    if (activeDuplicate) {
      return res.status(409).json({
        success: false,
        error: `A backup for ${originalJob.vmName} (${originalJob.scheduleType || 'backup'}) is already ${activeDuplicate.status}. Wait for it to finish before retrying.`,
        existingJobId: activeDuplicate.id,
      });
    }

    // Get backup host
    const hosts = await getBackupHosts();
    const host = hosts.find(h => h.id === originalJob.backupHostId);
    
    if (!host) {
      return res.status(404).json({ success: false, error: 'Backup host not found' });
    }

    // Check host status
    if (host.status !== 'online') {
      return res.status(400).json({ 
        success: false, 
        error: 'Backup host is still offline. Cannot retry backup.' 
      });
    }

    // NOTE: the concurrency-slot check happens further down, inside
    // _withHostLock, together with the job insert — checking here on a
    // stale read let simultaneous retries all pass the limit at once.

    // Get VM and hypervisor info
    const vms = await getVirtualMachines();
    const vm = vms.find(v => v.id === originalJob.vmId);
    if (!vm) {
      return res.status(404).json({ success: false, error: 'VM not found' });
    }

    const hypervisors = await getHypervisors();
    const hypervisor = hypervisors.find(h => h.id === vm.hypervisorId);
    if (!hypervisor) {
      return res.status(404).json({ success: false, error: 'Hypervisor not found' });
    }

    // Look up the schedule (if any) so we can rebuild the same payload
    // executeScheduledBackup uses. The agent rejects without storagePoolPath.
    const schedules = await getBackupSchedules();
    let schedule = originalJob.scheduleId
      ? (schedules.find(s => s.id === originalJob.scheduleId) || null)
      : null;

    // Resolve the storage pool. The job record is NOT the only place this is
    // known: a job adopted from a live tmux session (or an older record) has no
    // storagePoolId, and a schedule that was edited since the run holds the
    // pool the VM backs up to NOW — which is the one a retry should use.
    const { getStoragePools } = require('../services/fileStorage');
    const pools = await getStoragePools();
    const { pool, source: poolSource, schedule: poolSchedule } =
      resolveRetryStoragePool({ originalJob, host, pools, schedules, jobs });
    if (!pool) {
      return res.status(400).json({
        success: false,
        error: originalJob.storagePoolId
          ? `Storage pool ${originalJob.storagePoolId} not found on this backup host`
          : `No storage pool could be resolved for ${originalJob.vmName} on ${host.name}. Its schedule was deleted and no earlier backup recorded a pool — trigger a fresh backup choosing a pool instead.`,
      });
    }
    // A schedule found by VM (because the job carried no usable scheduleId)
    // also supplies retention/offsite settings for the rebuilt payload.
    if (!schedule && poolSchedule) schedule = poolSchedule;
    if (poolSource !== 'job') {
      console.log(`[Retry] Resolved storage pool for ${originalJob.vmName} from ${poolSource}: ${pool.name} (${pool.path})`);
    }

    // Resolve offsite targets through the shared scheduler helper so retries
    // reproduce the same destinations. For scheduled retries, resolve from the
    // schedule (per-pool `offsiteTargets`, or legacy `offsiteHostIds` + host
    // `backupPath`). For non-scheduled retries, reuse the `offsiteTargets`
    // persisted on the original job (Req 9.4). Re-resolving through the helper
    // keeps ip/path fresh against current host/pool config while still
    // persisting resolved targets on the new job.
    const offsiteSource = schedule || { offsiteTargets: originalJob.offsiteTargets };
    let { resolved: offsiteTargetsResolved, encoded: offsiteEncoded } =
      await schedulerService.resolveOffsiteTargets(offsiteSource);

    // Backward compat: a pre-feature original job may carry only the legacy
    // `offsiteHosts` array (string IPs or { ip, backupPath }) with no
    // `offsiteTargets`. Preserve its destinations by encoding them directly.
    if (
      offsiteEncoded.length === 0 &&
      Array.isArray(originalJob.offsiteHosts) &&
      originalJob.offsiteHosts.length > 0
    ) {
      offsiteTargetsResolved = originalJob.offsiteHosts.map(h =>
        typeof h === 'string'
          ? { offsiteHostId: null, offsitePoolId: null, ip: h, path: '' }
          : { offsiteHostId: null, offsitePoolId: null, ip: h.ip, path: h.backupPath || '' }
      );
      offsiteEncoded = offsiteTargetsResolved.map(r => (r.path ? `${r.ip}:${r.path}` : r.ip));
    }

    // Translate the controller's scheduleType to one the bash script
    // accepts (once / monthly / daily / weekly / custom). interval and
    // cron behave like daily chains for the script.
    const sourceScheduleType = schedule?.scheduleType || originalJob.scheduleType || 'once';
    const agentScheduleType = (() => {
      switch (sourceScheduleType) {
        case 'once':
        case 'monthly':
        case 'daily':
        case 'weekly': return sourceScheduleType;
        case 'interval':
        case 'cron': return 'daily';
        case 'custom-days': return 'custom';
        default: return 'once';
      }
    })();

    // Create new job for retry
    const newJobId = uuidv4();
    const retryJob = {
      id: newJobId,
      scheduleId: originalJob.scheduleId,
      vmId: originalJob.vmId,
      vmName: originalJob.vmName,
      hypervisorIp: hypervisor.ip,
      backupHostId: originalJob.backupHostId,
      backupHostName: originalJob.backupHostName,
      method: originalJob.method,
      scheduleType: sourceScheduleType,
      storagePoolId: pool.id,
      storagePoolName: pool.name,
      retention: schedule?.retention ?? originalJob.retention ?? 7,
      keepArchive: schedule?.keepArchive ?? originalJob.keepArchive ?? 2,
      offsiteRetryAttempts: schedule?.offsiteRetryAttempts ?? originalJob.offsiteRetryAttempts ?? 3,
      offsiteRetryBackoffSeconds: schedule?.offsiteRetryBackoffSeconds ?? originalJob.offsiteRetryBackoffSeconds ?? 15,
      compression: schedule?.compression ?? originalJob.compression ?? 2,
      noCompression: originalJob.noCompression || false,
      noVerify: originalJob.noVerify || false,
      offsiteTargets: offsiteTargetsResolved,
      status: 'queued',
      startTime: new Date().toISOString(),
      endTime: null,
      exitCode: null,
      error: null,
      scheduled: originalJob.scheduled || false,
      retryOf: originalJob.id,
      // A retry that fails must itself be retryable — state it explicitly
      // rather than relying on `canRetry` being absent.
      canRetry: true,
      // Persisted so any later trigger of this record (e.g. the queue drainer
      // in _startQueuedJob) still runs the pre-backup cleanup.
      isRetry: true,
      progress: 0,
      progressText: 'Queued (retry)...',
    };

    // Atomic slot decision + insert, serialized per host. Without the lock,
    // several simultaneous retries all read "< limit active" before any of
    // them writes its job, overrun the real limit, and the losers end up
    // failed on the agent. Also dedupe per VM: if a job for this VM is
    // already running/queued on this host, adopt it instead of colliding
    // with the agent's per-VM lock (which would 409).
    const io = req.app.get('io');
    const slotResult = await schedulerService._withHostLock(host.id, async () => {
      const freshJobs = await getBackupJobs();

      const existing = freshJobs.find(j =>
        j.vmId === originalJob.vmId &&
        j.backupHostId === host.id &&
        (j.status === 'running' || (j.status === 'queued' && !j.pendingStart))
      );
      if (existing) {
        return { ok: false, existing };
      }

      const runningOnHost = schedulerService.countActiveJobsOnHost(freshJobs, host.id);
      const rawMax = host.maxConcurrentBackups;
      const maxConcurrent = (rawMax === undefined || rawMax === null) ? 20 : Number(rawMax);
      if (maxConcurrent !== 0 && runningOnHost.length >= maxConcurrent) {
        return { ok: false, running: runningOnHost.length, max: maxConcurrent };
      }

      freshJobs.push(retryJob);
      await saveBackupJobs(freshJobs);
      return { ok: true };
    });

    if (!slotResult.ok && slotResult.existing) {
      // A backup for this VM is already in flight — the skipped records are
      // being satisfied by it. Resolve them and point the user at that job.
      await schedulerService.supersedeSkippedSiblings(originalJob, slotResult.existing.id);
      return res.status(202).json({
        success: true,
        adopted: true,
        data: slotResult.existing,
        message: `A backup for ${originalJob.vmName} is already in progress — retry not needed`,
      });
    }
    if (!slotResult.ok) {
      return res.status(429).json({
        success: false,
        error: `Backup host is at concurrent limit (${slotResult.running}/${slotResult.max}). The retry will run automatically when a slot frees up.`,
        currentRunning: slotResult.running,
        maxAllowed: slotResult.max,
      });
    }

    // Retrying a FAILED job replaces it, so the superseded failure is dropped
    // from history — but ONLY once the retry actually exists in its place
    // (in flight, or itself recorded as a fresh failure). Removing it up front
    // meant a 409 "already in progress" deleted the retry AND the original,
    // leaving nothing in history and no Retry button to click.
    // Skipped originals are left alone; supersedeSkippedSiblings resolves those.
    const retireOriginalFailure = async () => {
      if (originalJob.status !== 'failed') return;
      await schedulerService._removeJob(originalJob.id); // emits job-removed
    };

    await appendLog(newJobId, `Retry of job ${originalJob.id} (${originalJob.status})`);
    await appendLog(newJobId, `Original job: ${originalJob.vmName} - ${originalJob.error || 'No error message'}`);
    await appendLog(newJobId, `Storage pool: ${pool.name} (${pool.path})`);

    io.emit('backup-started', retryJob);

    // Trigger backup on agent with the full payload
    try {
      let url = host.url;
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'http://' + url;
      }

      await agentService.triggerBackup(url, {
        jobId: newJobId,
        vmName: originalJob.vmName,
        hypervisorId: hypervisor.id,
        hypervisorIp: hypervisor.ip,
        scheduleType: agentScheduleType,
        method: originalJob.method,
        storagePoolId: pool.id,
        storagePoolPath: pool.path,
        diskUsageThreshold: pool.diskUsageThreshold ?? 80,
        retention: retryJob.retention,
        keepArchive: retryJob.keepArchive,
        offsiteRetryAttempts: retryJob.offsiteRetryAttempts,
        offsiteRetryBackoffSeconds: retryJob.offsiteRetryBackoffSeconds,
        compression: retryJob.compression,
        noCompression: retryJob.noCompression,
        noVerify: retryJob.noVerify,
        offsiteHosts: offsiteEncoded,
        verbose: schedule?.verbose || false,
        // Makes the agent run Cleanup_Backup.sh to clear partial files from the
        // failed attempt before starting fresh. Without it a manual retry
        // resumed on top of the debris the previous failure left behind.
        isRetry: true,
        ...(sourceScheduleType === 'daily' || sourceScheduleType === 'interval' || sourceScheduleType === 'cron'
          ? { vmId: originalJob.vmId, incrementalCount: schedule?.incrementalCount }
          : {}),
      });

      // Update job status. Re-read the store first: the agent may already
      // have posted running/progress updates for this job while we waited
      // for the trigger call, and saving our stale `jobs` array would
      // silently clobber them.
      const freshJobs = await getBackupJobs();
      const freshJob = freshJobs.find(j => j.id === newJobId);
      if (freshJob && freshJob.status === 'queued') {
        freshJob.status = 'running';
        await saveBackupJobs(freshJobs);
        retryJob.status = 'running';
        io.emit('job-updated', freshJob);
      } else if (freshJob) {
        retryJob.status = freshJob.status;
      }

      // The retry is in flight — mark the original and every sibling
      // skipped record for this VM + schedule as superseded so their
      // Retry buttons disappear.
      await schedulerService.supersedeSkippedSiblings(originalJob, newJobId);
      await retireOriginalFailure();

    } catch (error) {
      const detail = error.response?.data?.error || error.message;

      // 409 = the agent says a backup for this VM is already running.
      // Adopt that job instead of recording a bogus failure. The retry never
      // ran, so the original failure is deliberately NOT retired here — it
      // stays in history, still retryable, once that in-flight backup ends.
      if (error.response?.status === 409) {
        const adoptedId = error.response?.data?.existingJobId || null;
        await schedulerService._removeJob(newJobId);
        await schedulerService.supersedeSkippedSiblings(originalJob, adoptedId || newJobId);
        return res.status(202).json({
          success: true,
          adopted: true,
          existingJobId: adoptedId,
          message: `A backup for ${originalJob.vmName} is already in progress on the agent — retry not needed`,
        });
      }

      const freshJobs = await getBackupJobs();
      let freshJob = freshJobs.find(j => j.id === newJobId);
      if (!freshJob) {
        freshJob = retryJob;
        freshJobs.push(freshJob);
      }
      freshJob.status = 'failed';
      freshJob.error = `Retry trigger failed: ${detail}`;
      freshJob.endTime = new Date().toISOString();
      freshJob.canRetry = true;
      await saveBackupJobs(freshJobs);
      retryJob.status = 'failed';
      retryJob.error = freshJob.error;
      await appendLog(newJobId, `Error triggering retry: ${detail}`);
      io.emit('backup-error', freshJob);
      // This retry record now represents the failure and carries its own Retry
      // button, so the original it replaced can go.
      await retireOriginalFailure();
    }

    res.status(202).json({ 
      success: true, 
      data: retryJob,
      message: 'Backup retry initiated'
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/backups/jobs/:jobId/force - Force remove a job from history
router.delete('/jobs/:jobId/force', requireAdmin, async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const jobs = await getBackupJobs();
    const jobIndex = jobs.findIndex(j => j.id === jobId);

    // First try backup jobs
    if (jobIndex !== -1) {
      const job = jobs[jobIndex];

      // Try to kill the job on the agent if it's running
      if (job.status === 'running' || job.status === 'queued') {
        const hosts = await getBackupHosts();
        const host = hosts.find(h => h.id === job.backupHostId);

        if (host) {
          try {
            const client = agentService.createAgentClient(host.url, host.id, host.name);
            await client.post(`/api/backup/kill/${jobId}`, {}, { timeout: 5000 });
            console.log(`Killed backup job ${jobId} on agent`);
          } catch (error) {
            console.log(`Could not kill backup job on agent: ${error.message}`);
            // Continue with removal even if kill fails
          }
        }
      }

      jobs.splice(jobIndex, 1);
      await saveBackupJobs(jobs);

      await appendLog(jobId, 'Job force removed from history');

      const io = req.app.get('io');
      io.emit('job-removed', { jobId });

      return res.json({
        success: true,
        message: 'Backup job removed from history',
        data: { id: jobId, jobType: 'backup' }
      });
    }

    // Not a backup job — check restore jobs (the unified /jobs endpoint
    // exposes both, so the same force-remove route must handle both).
    const restoreJobs = await getRestoreJobs();
    const restoreIndex = restoreJobs.findIndex(j => j.id === jobId);

    if (restoreIndex !== -1) {
      const restoreJob = restoreJobs[restoreIndex];

      // Try to kill on the agent if still active
      if (restoreJob.status === 'running' || restoreJob.status === 'queued') {
        const hosts = await getBackupHosts();
        const host = hosts.find(h => h.id === restoreJob.backupHostId);

        if (host) {
          try {
            const client = agentService.createAgentClient(host.url, host.id, host.name);
            await client.post(`/api/restore/kill/${jobId}`, {}, { timeout: 5000 });
            console.log(`Killed restore job ${jobId} on agent`);
          } catch (error) {
            console.log(`Could not kill restore job on agent: ${error.message}`);
            // Continue with removal even if kill fails
          }
        }
      }

      restoreJobs.splice(restoreIndex, 1);
      await saveRestoreJobs(restoreJobs);

      const io = req.app.get('io');
      io.emit('job-removed', { jobId });

      return res.json({
        success: true,
        message: 'Restore job removed from history',
        data: { id: jobId, jobType: 'restore' }
      });
    }

    // Neither store has it — treat as already deleted (idempotent)
    console.log(`Job ${jobId} not found in backup or restore stores - considering it already deleted`);
    const io = req.app.get('io');
    io.emit('job-removed', { jobId });

    return res.json({
      success: true,
      message: 'Job not found in database (already deleted or never existed)',
      data: { id: jobId, alreadyDeleted: true }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
