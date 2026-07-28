const {
  getBackupSchedules,
  getBackupHosts,
  getVirtualMachines,
  getBackupJobs,
} = require('./fileStorage');
const missedRunService = require('./missedRunService');
const agentService = require('./agentService');

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

// Schedule types whose expectation is "one backup per calendar day" (or per
// named day / date). For these we match by LOCAL calendar day, which is both
// how operators think about them AND immune to the timezone off-by-one that
// absolute-millisecond windows suffer (a 02:00 Tehran run serialized to UTC
// lands on the previous calendar day). interval/cron are sub-daily and keep
// the time-window matching.
const CALENDAR_TYPES = new Set(['daily', 'weekly', 'monthly', 'custom-days']);

// Map a controller schedule type to the agent's on-disk schedule directory,
// which is how the backup report keys each VM's schedules.
function toAgentScheduleType(scheduleType) {
  switch (scheduleType) {
    case 'once':
    case 'monthly':
    case 'daily':
    case 'weekly':
    case 'custom': return scheduleType;
    case 'interval':
    case 'cron': return 'daily';
    case 'custom-days': return 'custom';
    default: return scheduleType;
  }
}

// Local-calendar-day key (server timezone) for a Date — used to match an
// expected occurrence against an actual backup regardless of sub-day time.
function localDayKey(d) {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// Pull the exact per-run backup timestamps (ms) out of one report schedule
// entry. Every checkpoint the agent found on disk carries a real `.date`,
// so this is the authoritative "what actually ran" list — independent of any
// controller job record that may have been lost.
function extractBackupDatesFromSchedule(sched) {
  const out = [];
  const a = sched && sched.dump_analysis;
  if (!a || !a.disks) return out;
  for (const disk of Object.values(a.disks)) {
    for (const cp of (disk.checkpoints || [])) {
      if (!cp || !cp.date) continue;
      const t = new Date(cp.date).getTime();
      if (Number.isFinite(t)) out.push(t);
    }
  }
  return out;
}

/**
 * Authoritative index of ACTUAL backups on disk, keyed by vmId → agentScheduleType
 * → sorted timestamps (ms). Sourced from each backup host's report (the same
 * data the Reports view shows), so adherence agrees exactly with what physically
 * exists on the pool.
 *
 * Returns { index, coveredHostIds }. `coveredHostIds` is the set of hosts whose
 * report was fetched successfully — a VM on one of those hosts with NO entry in
 * `index` genuinely has zero backups (a real signal), whereas a VM whose host is
 * NOT covered cannot be assessed at all (report unavailable), and its schedules
 * are skipped rather than guessed. This is what keeps the report precise: we
 * never flag a miss unless we can positively see the disk say the run is absent.
 */
async function buildActualBackupIndex(vmsInScope, hostById) {
  const index = new Map(); // vmId -> Map(agentSchedule -> number[])
  const coveredHostIds = new Set();

  // Group VMs by host and remember name→vm so we can match report entries.
  const vmsByHost = new Map();
  for (const vm of vmsInScope) {
    if (!vm.backupHostId) continue;
    if (!vmsByHost.has(vm.backupHostId)) vmsByHost.set(vm.backupHostId, []);
    vmsByHost.get(vm.backupHostId).push(vm);
  }

  await Promise.all([...vmsByHost.entries()].map(async ([hostId, hostVms]) => {
    const host = hostById.get(hostId);
    if (!host) return;
    let report = null;
    try {
      const result = await agentService.getBackupReport(host.url);
      report = result && result.data ? result.data : result;
    } catch (e) {
      return; // report unavailable — host stays uncovered, its VMs are skipped
    }
    if (!report || !Array.isArray(report.vms)) return;

    // Report fetched and well-formed → this host is authoritatively covered.
    coveredHostIds.add(hostId);

    const vmByName = new Map(hostVms.map(v => [v.name, v]));
    for (const rvm of report.vms) {
      const vm = vmByName.get(rvm.vm_name);
      if (!vm) continue;
      const schedMap = index.get(vm.id) || new Map();
      for (const sched of (rvm.schedules || [])) {
        if (!sched || !sched.schedule) continue;
        const dates = extractBackupDatesFromSchedule(sched);
        if (!dates.length) continue;
        // Archived chains are reported under schedule "archived" with the real
        // schedule in `original_schedule` (e.g. "daily"). Retention rotates a
        // full chain into /archived and starts a fresh one, so a daily VM's
        // older runs live there. Key those dates under the ORIGINAL schedule so
        // they still count toward adherence — otherwise every run that has since
        // been archived is falsely reported as "missed" (the exact symptom:
        // backups plainly exist in the archive but show as missed).
        const key = (sched.schedule === 'archived' && sched.original_schedule)
          ? sched.original_schedule
          : sched.schedule;
        const prev = schedMap.get(key) || [];
        schedMap.set(key, prev.concat(dates));
      }
      if (schedMap.size) index.set(vm.id, schedMap);
    }
  }));

  return { index, coveredHostIds };
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

  // Authoritative "what actually ran" from the backup pools. Only VMs that
  // are in scope (respecting the vmId/backupHostId filters) are queried.
  const vmsInScope = vms.filter(vm => {
    if (vm.disabled) return false;
    if (vmId && vm.id !== vmId) return false;
    if (backupHostId && vm.backupHostId !== backupHostId) return false;
    // Only VMs that actually have a recurring schedule are worth a report fetch.
    return schedules.some(s =>
      s.vmId === vm.id && s.enabled !== false && RECURRING_TYPES.has(s.scheduleType)
    );
  });
  const { index: actualBackupsByVm, coveredHostIds } =
    await buildActualBackupIndex(vmsInScope, hostById);

  const resultsByVm = new Map();

  let totalExpected = 0;
  let totalMissed = 0;
  let totalSchedulesChecked = 0;
  let totalSchedulesUnassessed = 0;

  for (const schedule of schedules) {
    if (schedule.enabled === false) continue;
    if (!RECURRING_TYPES.has(schedule.scheduleType)) continue;

    const vm = vmById.get(schedule.vmId);
    if (!vm) continue;
    if (vm.disabled) continue;

    // Apply filters
    if (vmId && vm.id !== vmId) continue;
    if (backupHostId && vm.backupHostId !== backupHostId) continue;

    // Precision gate: we can only assess a schedule against what physically
    // exists on the pool. If this VM's backup host report could not be fetched,
    // we have no authoritative "what actually ran" list, so we skip it rather
    // than guess from unreliable job records (which produce false misses AND
    // false successes). These are surfaced as `unassessed` in the summary.
    if (!vm.backupHostId || !coveredHostIds.has(vm.backupHostId)) {
      totalSchedulesUnassessed++;
      continue;
    }

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

    // Actual jobs for this VM within the window (+ a little before, so an
    // attempt near the first occurrence's tolerance is included). Used ONLY to
    // annotate WHY a missing backup is missing (failed / skipped) — never to
    // decide whether a run happened. Job records are unreliable (phantom
    // "completed" records with no file on disk hide real gaps); the disk is the
    // sole source of truth for success.
    const vmJobs = (jobsByVm.get(vm.id) || []).filter(j => {
      const t = toDate(j.startTime);
      return t && t.getTime() >= effectiveStartMs - MATCH_TOLERANCE_MS;
    });

    // Authoritative "what actually ran" — real backups on disk for this
    // schedule, taken from the host report (same data the Reports view shows).
    // A checkpoint on disk means the run happened; its absence means it didn't.
    const agentSched = toAgentScheduleType(schedule.scheduleType);
    const successTimes = ((actualBackupsByVm.get(vm.id) || new Map()).get(agentSched) || [])
      .filter(Number.isFinite)
      .slice()
      .sort((a, b) => a - b);

    // Precompute the set of local calendar days that actually have a backup,
    // for calendar-based schedules (daily/weekly/monthly/custom-days).
    const successDayKeys = new Set(successTimes.map(t => localDayKey(new Date(t))));
    const isCalendar = CALENDAR_TYPES.has(schedule.scheduleType);

    // Failed / skipped / rejected attempts (for reason annotation).
    const failedJobs = vmJobs
      .filter(j => j.status === 'failed' || j.status === 'skipped' || j.status === 'rejected')
      .map(j => ({
        t: toDate(j.startTime).getTime(),
        status: j.status,
        error: j.error,
        skippedReason: j.skippedReason || j.rejectedReason,
      }))
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

      // Calendar schedules: satisfied if ANY backup exists on the occurrence's
      // local calendar day (immune to timezone off-by-one). Sub-daily
      // (interval/cron): satisfied if a backup falls in the time slot.
      const satisfied = isCalendar
        ? successDayKeys.has(localDayKey(occurrences[i].scheduledAt))
        : successTimes.some(t => t >= slotStart && t < slotEnd);
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
        } else if (attempt.status === 'rejected') {
          // The run never started: the VM was still backing up from an earlier
          // run. Reported as its own reason so it is not read as a failure —
          // the fix is a longer interval or a faster backup, not a repair.
          reason = 'rejected';
          detail = attempt.error
            ? String(attempt.error).slice(0, 200)
            : 'Run declined: another backup for this VM was still in progress';
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
      schedulesUnassessed: totalSchedulesUnassessed,
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
