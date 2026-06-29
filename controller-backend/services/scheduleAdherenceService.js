const {
  getBackupSchedules,
  getBackupHosts,
  getVirtualMachines,
  getBackupJobs,
} = require('./fileStorage');
const missedRunService = require('./missedRunService');

/**
 * ScheduleAdherenceService
 *
 * Detects "missed backups" — expected scheduled runs that produced no
 * successful backup. A VM can show 100% health (all existing backup files
 * are valid) yet still have gaps in its timeline because some scheduled
 * runs never happened (power loss, network failure, agent offline, etc.).
 *
 * Approach:
 *   1. For each enabled schedule, enumerate the EXPECTED fire times over a
 *      window using the same occurrence generator the missed-run recovery
 *      uses (missedRunService.computeMissedRuns).
 *   2. Compare against ACTUAL successful backup jobs (status === 'completed').
 *   3. Any expected occurrence with no successful backup in its slot is a
 *      missed backup, annotated with a best-effort reason.
 *
 * This is purely a controller-side, read-only analysis. It does not trigger
 * any backups and does not touch agent communication.
 */

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

// Ignore occurrences newer than this so a just-due or in-progress backup is
// not falsely reported as missed.
const RECENT_GRACE_MS = 2 * 60 * 60 * 1000; // 2 hours

// A successful backup counts toward an occurrence if it started at most this
// long BEFORE the scheduled time (handles slight early runs / clock skew).
const MATCH_TOLERANCE_MS = 60 * 60 * 1000; // 1 hour

// Schedule types that represent a recurring expectation worth checking.
// 'once' is a single event (not a recurring adherence concern) so we skip it.
const RECURRING_TYPES = new Set([
  'daily',
  'weekly',
  'monthly',
  'interval',
  'cron',
  'custom-days',
]);

function toDate(v) {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Compute missed backups across schedules.
 *
 * @param {object} opts
 * @param {number} [opts.days=30]     lookback window in days (capped at 365)
 * @param {string} [opts.backupHostId] limit to one backup host
 * @param {string} [opts.vmId]         limit to one VM
 * @returns {Promise<object>} { window, summary, vms: [...] }
 */
async function getMissedBackups(opts = {}) {
  const days = Math.min(Math.max(parseInt(opts.days, 10) || DEFAULT_DAYS, 1), MAX_DAYS);
  const { backupHostId, vmId } = opts;

  const now = Date.now();
  const windowStart = now - days * 86400000;
  const cutoffRecent = now - RECENT_GRACE_MS;

  const [schedules, vms, hosts, jobs] = await Promise.all([
    getBackupSchedules(),
    getVirtualMachines(),
    getBackupHosts(),
    getBackupJobs(),
  ]);

  const vmById = new Map(vms.map(v => [v.id, v]));
  const hostById = new Map(hosts.map(h => [h.id, h]));

  // Pre-index jobs by vmId for quick lookup.
  const jobsByVm = new Map();
  for (const j of jobs) {
    if (!j.vmId) continue;
    if (!jobsByVm.has(j.vmId)) jobsByVm.set(j.vmId, []);
    jobsByVm.get(j.vmId).push(j);
  }

  const resultsByVm = new Map();

  let totalExpected = 0;
  let totalMissed = 0;
  let totalSchedulesChecked = 0;

  for (const schedule of schedules) {
    if (schedule.enabled === false) continue;
    if (!RECURRING_TYPES.has(schedule.scheduleType)) continue;

    const vm = vmById.get(schedule.vmId);
    if (!vm) continue;
    if (vm.disabled) continue;

    // Apply filters
    if (vmId && vm.id !== vmId) continue;
    if (backupHostId && vm.backupHostId !== backupHostId) continue;

    // Clamp window start to when the schedule was created so we don't flag
    // "misses" for dates before the schedule existed.
    const createdAt = toDate(schedule.createdAt);
    const effectiveStartMs = createdAt
      ? Math.max(windowStart, createdAt.getTime())
      : windowStart;

    const from = new Date(effectiveStartMs);
    const to = new Date(now);

    // Expected occurrences (sorted ascending).
    let occurrences = [];
    try {
      occurrences = missedRunService.computeMissedRuns(schedule, from, to) || [];
    } catch (e) {
      console.error(`[Adherence] Failed to enumerate schedule ${schedule.id}:`, e.message);
      continue;
    }

    // Only consider occurrences that are far enough in the past.
    occurrences = occurrences.filter(o => o.scheduledAt.getTime() <= cutoffRecent);
    if (occurrences.length === 0) {
      totalSchedulesChecked++;
      continue;
    }

    // Actual jobs for this VM within the window (+ a little before, so a
    // success that satisfies the first occurrence's tolerance is included).
    const vmJobs = (jobsByVm.get(vm.id) || []).filter(j => {
      const t = toDate(j.startTime);
      return t && t.getTime() >= effectiveStartMs - MATCH_TOLERANCE_MS;
    });

    const successTimes = vmJobs
      .filter(j => j.status === 'completed')
      .map(j => toDate(j.startTime).getTime())
      .sort((a, b) => a - b);

    // Failed / skipped attempts (for reason annotation).
    const failedJobs = vmJobs
      .filter(j => j.status === 'failed' || j.status === 'skipped')
      .map(j => ({ t: toDate(j.startTime).getTime(), status: j.status, error: j.error, skippedReason: j.skippedReason }))
      .filter(j => Number.isFinite(j.t))
      .sort((a, b) => a.t - b.t);

    const missed = [];

    for (let i = 0; i < occurrences.length; i++) {
      const occMs = occurrences[i].scheduledAt.getTime();
      const nextBoundary = i + 1 < occurrences.length
        ? occurrences[i + 1].scheduledAt.getTime()
        : now;
      const slotStart = occMs - MATCH_TOLERANCE_MS;
      const slotEnd = nextBoundary; // exclusive upper bound

      // Satisfied if any successful backup falls in this slot.
      const satisfied = successTimes.some(t => t >= slotStart && t < slotEnd);
      if (satisfied) continue;

      // Not satisfied → missed. Determine reason.
      const attempt = failedJobs.find(j => j.t >= slotStart && j.t < slotEnd);
      let reason = 'no_run';
      let detail = 'No backup ran (controller/agent offline, power loss, or network failure)';
      if (attempt) {
        if (attempt.status === 'failed') {
          reason = 'failed';
          detail = attempt.error
            ? `Backup attempt failed: ${String(attempt.error).slice(0, 200)}`
            : 'Backup attempt failed';
        } else {
          reason = 'skipped';
          detail = attempt.skippedReason
            ? `Backup was skipped: ${attempt.skippedReason}`
            : 'Backup was skipped';
        }
      }

      missed.push({
        scheduledAt: occurrences[i].scheduledAt.toISOString(),
        reason,
        detail,
      });
    }

    totalSchedulesChecked++;
    totalExpected += occurrences.length;
    totalMissed += missed.length;

    if (missed.length === 0) continue;

    const host = hostById.get(vm.backupHostId);
    const expectedCount = occurrences.length;
    const adherencePct = expectedCount > 0
      ? Math.round(((expectedCount - missed.length) / expectedCount) * 100)
      : 100;

    if (!resultsByVm.has(vm.id)) {
      resultsByVm.set(vm.id, {
        vmId: vm.id,
        vmName: vm.name,
        backupHostId: vm.backupHostId || null,
        backupHostName: host ? host.name : null,
        schedules: [],
        totalExpected: 0,
        totalMissed: 0,
      });
    }
    const vmEntry = resultsByVm.get(vm.id);
    vmEntry.schedules.push({
      scheduleId: schedule.id,
      scheduleName: schedule.name || schedule.scheduleType,
      scheduleType: schedule.scheduleType,
      expectedCount,
      missedCount: missed.length,
      adherencePct,
      missed: missed.sort((a, b) => new Date(b.scheduledAt) - new Date(a.scheduledAt)),
    });
    vmEntry.totalExpected += expectedCount;
    vmEntry.totalMissed += missed.length;
  }

  const vmsOut = Array.from(resultsByVm.values()).sort(
    (a, b) => b.totalMissed - a.totalMissed
  );

  return {
    window: {
      days,
      from: new Date(windowStart).toISOString(),
      to: new Date(now).toISOString(),
    },
    summary: {
      schedulesChecked: totalSchedulesChecked,
      vmsWithMissed: vmsOut.length,
      totalExpected,
      totalMissed,
      overallAdherencePct: totalExpected > 0
        ? Math.round(((totalExpected - totalMissed) / totalExpected) * 100)
        : 100,
    },
    vms: vmsOut,
  };
}

module.exports = { getMissedBackups };
