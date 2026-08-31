const {
  getBackupSchedules,
  saveBackupSchedules,
  getOffsiteHosts,
} = require('./fileStorage');
const rocketChatService = require('./rocketChatService');

/**
 * Schedule-level offsite warnings.
 *
 * Lifted out of routes/backups.js because it now has two callers. It used to be
 * driven only by a backup job's terminal update, back when the transfer was part
 * of the backup run. The transfer is its own job now, so the same outcomes
 * arrive from offsiteJobService — and they still have to land on the schedule,
 * because the schedule is where an operator looks to see whether a VM's offsite
 * copies are healthy, and where the notification dedup keys live.
 *
 * The caller shape is deliberately unchanged: pass anything carrying
 * `{ id, vmName, scheduleId, backupHostId, offsiteTargets }`. A replication job
 * carries all five, which is why it can reuse this untouched.
 */

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

    // Notify RocketChat, naming the offsite host and reason (Req 6.4).
    // Always sends — via the daily incident board, no on/off gate.
    const scheduleLabel = schedule.name || schedule.vmName || `schedule ${schedule.id}`;
    // A run where SOME destinations succeeded is a partial sync, which the
    // board labels differently from a total offsite failure.
    const anySuccess = Array.isArray(offsiteResults)
      && offsiteResults.some(r => classify(r) === 'success');

    for (const n of notifications) {
      try {
        rocketChatService.notifyOffsiteSyncFailed(
          // The VM alone: the schedule label repeated the VM name verbatim,
          // which doubled the length of every offsite message for no gain.
          job.vmName || scheduleLabel,
          // Bare host name — the board shows it standalone (e.g. "❌ Site3
          // (Offsite Backup)"), the pool suffix just added noise there.
          n.hostName,
          n.reason,
          schedule.id,
          anySuccess,
          job.backupHostId || null
        );
      } catch (err) {
        console.error(`[Backups] Failed to send offsite sync failure notification: ${err.message}`);
      }
    }

    console.log(`[Backups] Offsite sync results for job ${job.id} on schedule ${schedule.id}: recorded ${notifications.length} warning(s), cleared ${cleared} warning(s)`);
  }

  return changed;
}

module.exports = { ingestOffsiteSyncResults };
