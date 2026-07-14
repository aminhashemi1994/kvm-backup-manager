const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const { 
  getBackupJobs, 
  saveBackupJobs, 
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
const auditService = require('../services/auditService');
const schedulerService = require('../services/schedulerService');
const { validateBackupTrigger } = require('../utils/validator');
const { requireUser, requireAdmin } = require('../middleware/rbac');

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
    // state (tmux sessions, live processes, lock + progress files):
    //   running            → the backup is still going; leave the job alone.
    //   failed/orphaned     → mark failed.
    //   completed           → mark completed, exitCode 0 (trustworthy).
    //   unknown (no record) → the agent finished & cleaned up; most likely a
    //                         success we simply never got the exit code for.
    //                         Mark completed but flag it UNVERIFIED so the UI
    //                         can show that its success wasn't confirmed.
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
        if (job.status !== 'running') {
          job.status = 'running';
          if (live.phase) job.phase = live.phase;
          await appendLog(job.id, 'Job still running (verified via live-status)');
          return true;
        }
        return false;
      }
      if (live && live.status === 'failed') {
        job.status = 'failed';
        job.endTime = job.endTime || new Date().toISOString();
        job.error = job.error || 'Backup orphaned: lock file present without active process';
        job.failureReason = job.failureReason || 'orphaned';
        job.verified = true;
        job.finalizedBy = 'reconciler-livestatus';
        await appendLog(job.id, 'Job marked failed (evidence-based via live-status: orphaned)');
        return true;
      }
      if (live && live.status === 'completed') {
        // Evidence-based: live-status saw the backup reach 100% with no
        // orphaned lock. Trustworthy, but we still never captured the
        // script's real exit code — do NOT fabricate exitCode 0, or an
        // inferred completion would masquerade as an agent-confirmed one.
        // `verified` reflects host-evidence; exitCode stays unknown ("-").
        job.status = 'completed';
        job.endTime = job.endTime || new Date().toISOString();
        job.progress = 100;
        job.verified = true;
        job.finalizedBy = 'reconciler-livestatus';
        delete job.unverified;
        await appendLog(job.id, 'Job completed (evidence-based via live-status; exit code not captured)');
        return true;
      }

      // Unknown / no agent record — infer completion but do NOT claim it's
      // verified. exitCode stays null; the UI shows an "unverified" marker.
      job.status = 'completed';
      job.endTime = job.endTime || new Date().toISOString();
      job.unverified = true;
      job.verified = false;
      await appendLog(job.id, 'Job marked completed but UNVERIFIED (agent has no record; exit code unknown). Check the report to confirm the backup exists.');
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
    for (const n of notifications) {
      try {
        rocketChatService.notifyOffsiteSyncFailed(
          `${job.vmName || scheduleLabel} (schedule: ${scheduleLabel})`,
          `${n.hostName} / pool ${n.poolName}`,
          n.reason
        );
      } catch (err) {
        console.error(`[Backups] Failed to send offsite sync failure notification: ${err.message}`);
      }
    }

    console.log(`[Backups] Offsite sync results for job ${job.id} on schedule ${schedule.id}: recorded ${notifications.length} warning(s), cleared ${cleared} warning(s)`);
  }

  return changed;
}

// GET /api/backups/active - Get active backup jobs
router.get('/active', async (req, res, next) => {
  try {
    const jobs = await getBackupJobs();
    const hosts = await getBackupHosts();

    let activeJobs = jobs.filter(j => j.status === 'running' || j.status === 'queued' || j.status === 'retrying');
    let statusUpdated = false;

    if (activeJobs.length > 0) {
      const SYNC_BUDGET_MS = 6000;
      const agentActiveCache = new Map(); // one agent call per host, shared by all jobs
      const results = await Promise.race([
        Promise.allSettled(activeJobs.map(j => syncJobStatusWithAgent(j, hosts, agentActiveCache))),
        new Promise(resolve => setTimeout(() => resolve(null), SYNC_BUDGET_MS)),
      ]);
      if (Array.isArray(results)) {
        statusUpdated = results.some(r => r.status === 'fulfilled' && r.value);
      } else {
        console.warn('[Active] Agent status sync exceeded budget; serving stale data');
      }
    }

    // Save if any status was updated
    if (statusUpdated) {
      await saveBackupJobs(jobs);
    }
    
    // Re-filter after sync
    activeJobs = jobs.filter(j => j.status === 'running' || j.status === 'queued' || j.status === 'retrying');
    
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
    const hosts = await getBackupHosts();

    // Sync status for backup jobs marked as running/queued — but in parallel
    // and with a hard overall budget so unreachable agents can't block the
    // dashboard. Previously this loop ran serially with a 5s timeout per job;
    // a handful of hung jobs would freeze /history (and the dashboard's
    // Recent Activity card would spin forever).
    const runningBackupJobs = backupJobs.filter(j => j.status === 'running' || j.status === 'queued');
    let statusUpdated = false;

    if (runningBackupJobs.length > 0) {
      const SYNC_BUDGET_MS = 6000;
      const agentActiveCache = new Map(); // one agent call per host, shared by all jobs
      const results = await Promise.race([
        Promise.allSettled(runningBackupJobs.map(j => syncJobStatusWithAgent(j, hosts, agentActiveCache))),
        new Promise(resolve => setTimeout(() => resolve(null), SYNC_BUDGET_MS)),
      ]);
      if (Array.isArray(results)) {
        statusUpdated = results.some(r => r.status === 'fulfilled' && r.value);
      } else {
        // Budget exceeded — skip the save and return what we already have on
        // disk. The next call (or background reconciler) can finish the job.
        console.warn('[History] Agent status sync exceeded budget; serving stale data');
      }
    }
    
    // Save updated backup jobs
    if (statusUpdated) {
      await saveBackupJobs(backupJobs);
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
    
    // Sort by start time (newest first)
    allJobs.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
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
    const job = jobs.find(j => j.id === req.params.id);
    
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    // Get backup host
    const hosts = await getBackupHosts();
    const host = hosts.find(h => h.id === job.backupHostId);
    
    if (!host) {
      // Fallback to controller logs if host not found
      const logs = await readLog(req.params.id);
      return res.json({ success: true, data: { logs } });
    }

    // Fetch logs from agent. Default to the last 2000 lines so a huge job
    // log can't stall the panel; pass ?full=1 for the complete log.
    const tail = req.query.full === '1' ? undefined : (Number(req.query.tail) > 0 ? Number(req.query.tail) : 2000);

    // Resolve the storage pool path so the agent can fall back to the durable
    // script log on the backup pool if the flat per-job log was lost.
    let poolPath = null;
    if (job.storagePoolId) {
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
      const response = await client.get(`/api/backup/logs/${req.params.id}`, {
        timeout: 10000,
        params: {
          ...(tail ? { tail } : {}),
          ...(job.vmName && poolPath && agentScheduleTypeForLog
            ? { vmName: job.vmName, scheduleType: agentScheduleTypeForLog, storagePoolPath: poolPath }
            : {}),
        },
      });

      res.json({ success: true, data: { logs: response.data.data.logs } });
    } catch (error) {
      console.error('Error fetching logs from agent:', error.message);
      
      // A 404 only tells us the job is no longer active on the agent — NOT
      // that it succeeded. Marking it a clean "completed" here is exactly
      // what produced false "completed / exit -" records. Flag it UNVERIFIED
      // so the UI shows its success was never confirmed; exit code stays "-".
      if (error.response?.status === 404 && (job.status === 'running' || job.status === 'queued')) {
        job.status = 'completed';
        job.endTime = job.endTime || new Date().toISOString();
        job.unverified = true;
        job.verified = false;
        job.finalizedBy = 'reconciler-inferred';
        await saveBackupJobs(jobs);
        await appendLog(req.params.id, 'Job marked completed but UNVERIFIED (no longer active on agent; exit code unknown)');
      }
      
      // Fallback to controller logs
      const logs = await readLog(req.params.id);
      res.json({ success: true, data: { logs } });
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
        scheduleType,
        retention,
        keepArchive,
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
    const { status, exitCode, error, logLine, progress, progressText, failureReason, offsiteResults, progressType } = req.body;
    
    const jobs = await getBackupJobs();
    const job = jobs.find(j => j.id === req.params.id);
    
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found' });
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
    if (error) job.error = error;
    if (failureReason) job.failureReason = failureReason;
    if (progress !== undefined) job.progress = progress;
    if (progressText !== undefined) job.progressText = progressText;

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

    await saveBackupJobs(jobs);

    if (logLine) {
      await appendLog(req.params.id, logLine);
    }

    const io = req.app.get('io');
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
      rocketChatService.notifyBackupCompleted(job.vmName, job.method || 'unknown', duration + retryInfo);

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

      // Notify RocketChat
      const retryInfo = job.retriesExhausted ? ' (all retries exhausted)' : '';
      rocketChatService.notifyBackupFailed(job.vmName, job.method || 'unknown', (job.error || 'Unknown error') + retryInfo);

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

    // Only allow retry for skipped or failed jobs
    if (originalJob.status !== 'skipped' && originalJob.status !== 'failed') {
      return res.status(400).json({ 
        success: false, 
        error: 'Only skipped or failed jobs can be retried' 
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
    let schedule = null;
    if (originalJob.scheduleId) {
      const schedules = await getBackupSchedules();
      schedule = schedules.find(s => s.id === originalJob.scheduleId) || null;
    }

    // Resolve storage pool. Prefer the schedule's pool, then the original
    // job's pool id (manual triggers store storagePoolId on the job
    // record), otherwise refuse — without it the agent returns 400.
    const { getStoragePools } = require('../services/fileStorage');
    const pools = await getStoragePools();
    const poolId = schedule?.storagePoolId || originalJob.storagePoolId;
    const pool = poolId
      ? pools.find(p => p.id === poolId && p.backupHostId === host.id)
      : null;
    if (!pool) {
      return res.status(400).json({
        success: false,
        error: poolId
          ? `Storage pool ${poolId} not found on this backup host`
          : 'Original job has no storage pool on record; cannot retry. Edit the schedule and trigger a fresh backup instead.',
      });
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

      // Retrying a FAILED job replaces it: drop the original record so the
      // history isn't cluttered with the superseded failure. The new retry
      // job carries retryOf for lineage. (Skipped jobs are handled by
      // supersedeSkippedSiblings instead, which resolves the whole group.)
      if (originalJob.status === 'failed') {
        const oi = freshJobs.findIndex(j => j.id === originalJob.id);
        if (oi !== -1) freshJobs.splice(oi, 1);
      }

      freshJobs.push(retryJob);
      await saveBackupJobs(freshJobs);
      return { ok: true, removedOriginal: originalJob.status === 'failed' };
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

    // The original failed record was removed inside the lock — tell the UI.
    if (slotResult.removedOriginal) {
      io.emit('job-removed', { jobId: originalJob.id });
    }

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
        retention: retryJob.retention,
        keepArchive: retryJob.keepArchive,
        compression: retryJob.compression,
        noCompression: retryJob.noCompression,
        noVerify: retryJob.noVerify,
        offsiteHosts: offsiteEncoded,
        verbose: schedule?.verbose || false,
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

    } catch (error) {
      const detail = error.response?.data?.error || error.message;

      // 409 = the agent says a backup for this VM is already running.
      // Adopt that job instead of recording a bogus failure.
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
      await saveBackupJobs(freshJobs);
      retryJob.status = 'failed';
      retryJob.error = freshJob.error;
      await appendLog(newJobId, `Error triggering retry: ${detail}`);
      io.emit('backup-error', freshJob);
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
