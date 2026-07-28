const { updateBackupJobs } = require('./fileStorage');

/**
 * Safe persistence for the *slow* job reconcilers (/active, /history,
 * agentSyncService).
 *
 * Those handlers read the whole jobs array, then spend several seconds talking
 * to every agent (live status, tmux session discovery), then write the array
 * back. Meanwhile the agent is posting a progress update for every running job
 * roughly once a second, and each of those does its own read-modify-write of
 * the same file. Whoever writes last wins the WHOLE file:
 *
 *   • an agent update that read before the reconciler's write and landed after
 *     it deletes the job the reconciler just adopted from a live tmux session —
 *     the row vanishes from Active/History until the next reconcile re-adopts
 *     it (the "disappears and then reappears" flicker);
 *   • the reconciler's own stale write rolls back every progress/status update
 *     the agent posted while it was working.
 *
 * The fix is to never write back a snapshot. Take one before reconciling, diff
 * it afterwards, and apply just those field changes to the authoritative array
 * inside a single atomic read-modify-write. Concurrent writers keep their
 * changes; the reconciler keeps its own.
 *
 * Note: the diff is field-level and compares by value, so a reconciler that
 * mutated a nested object IN PLACE (rather than assigning a new one) would not
 * be detected. Every reconciler assigns scalars/fresh objects, so that's fine.
 */

/** Values as jobs carry them: scalars, or small arrays/objects assigned whole. */
function _equal(a, b) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a === 'object' || typeof b === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Snapshot the jobs array before a reconcile pass. Shallow per-job clones are
 * enough — we only need the pre-reconcile value of each field.
 *
 * @param {Array} jobs
 * @returns {Map<string, object>}
 */
function snapshotJobs(jobs) {
  const map = new Map();
  for (const job of jobs || []) {
    if (job && job.id) map.set(job.id, { ...job });
  }
  return map;
}

/**
 * Persist the difference between `before` and the reconciled `jobs` array.
 *
 * @param {Map<string,object>} before   from snapshotJobs(), taken pre-reconcile
 * @param {Array} jobs                  the reconciled (mutated) array
 * @param {object} [opts]
 * @param {(freshJobs: Array, job: object) => boolean} [opts.insertGuard]
 *        Called before inserting a job the reconciler created, against the
 *        FRESH array. Return false to drop the insert (e.g. someone else
 *        already created a record for that run while we were reconciling).
 * @returns {Promise<{changed: boolean, jobs: Array}>} `jobs` is the freshly
 *        persisted array when anything was written, else the input array.
 */
async function commitJobChanges(before, jobs, opts = {}) {
  const { insertGuard } = opts;
  const patches = [];
  const inserts = [];

  for (const job of jobs || []) {
    if (!job || !job.id) continue;
    const prev = before.get(job.id);
    if (!prev) {
      inserts.push(job);
      continue;
    }
    const fields = {};
    const removed = [];
    for (const key of Object.keys(job)) {
      if (!_equal(job[key], prev[key])) fields[key] = job[key];
    }
    for (const key of Object.keys(prev)) {
      if (!(key in job)) removed.push(key);
    }
    if (Object.keys(fields).length > 0 || removed.length > 0) {
      patches.push({ id: job.id, fields, removed });
    }
  }

  if (patches.length === 0 && inserts.length === 0) {
    return { changed: false, jobs };
  }

  const { data, written } = await updateBackupJobs((fresh) => {
    const byId = new Map(fresh.map(j => [j.id, j]));
    let touched = false;

    for (const patch of patches) {
      const target = byId.get(patch.id);
      // Gone from the store (force-removed, or replaced by a retry) while we
      // were reconciling — deliberately do NOT resurrect it.
      if (!target) continue;
      Object.assign(target, patch.fields);
      for (const key of patch.removed) delete target[key];
      touched = true;
    }

    for (const job of inserts) {
      if (byId.has(job.id)) continue; // someone else recorded this run already
      if (insertGuard && !insertGuard(fresh, job)) continue;
      fresh.push(job);
      byId.set(job.id, job);
      touched = true;
    }

    return touched === true ? undefined : false;
  });

  return { changed: written, jobs: data };
}

module.exports = { snapshotJobs, commitJobChanges };
