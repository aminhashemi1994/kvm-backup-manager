const {
  getBackupSchedules,
  getBackupHosts,
  getHypervisors,
  getVirtualMachines,
  getStoragePools,
  getBackupJobs,
  saveBackupJobs,
  appendLog,
} = require('./fileStorage');
const agentService = require('./agentService');
const backupCycleService = require('./backupCycleService');
const rocketChatService = require('./rocketChatService');
const { v4: uuidv4 } = require('uuid');

/**
 * MissedRunService
 *
 * On controller startup, this service:
 *   1. Reads the heartbeat snapshot (last seen + boot time = downtime window).
 *   2. For each enabled schedule, computes which scheduled fires fell inside
 *      the downtime window.
 *   3. Applies the schedule's missedRunPolicy to decide what to do:
 *        - "immediate":  replay missed runs (all, or most-recent depending on cap)
 *        - "most-recent": replay only the most recent missed occurrence
 *        - "skip":        do nothing, just record + notify
 *      A per-schedule grace period (default 360 minutes / 6 hours) caps how
 *      far back we will replay. Runs older than the grace period are recorded
 *      as missed-skipped.
 *   4. Triggers replays via the scheduler service (does not duplicate logic).
 */
class MissedRunService {
  constructor() {
    this.io = null;
    this.scheduler = null;
  }

  initialize(io, schedulerService) {
    this.io = io;
    this.scheduler = schedulerService;
  }

  /**
   * Main entry point. Called from server.js after services come up.
   */
  async runRecovery(bootSnapshot) {
    if (!bootSnapshot) {
      console.log('[MissedRun] No previous heartbeat — fresh install or first run, nothing to replay');
      return { replayed: 0, skipped: 0 };
    }

    const lastSeenAt = new Date(bootSnapshot.lastSeenAt);
    const bootedAt = new Date(bootSnapshot.bootedAt);
    const downtimeMs = bootedAt.getTime() - lastSeenAt.getTime();
    const downtimeMinutes = Math.round(downtimeMs / 60000);

    if (downtimeMs <= 0) {
      console.log('[MissedRun] Heartbeat is in the future — clock skew? Skipping recovery');
      return { replayed: 0, skipped: 0 };
    }

    // Anything under 90s likely means a normal restart; cron tasks haven't been
    // missing meaningful work. Skip noisy work in that common case.
    if (downtimeMs < 90 * 1000) {
      console.log(`[MissedRun] Downtime of ${Math.round(downtimeMs / 1000)}s is below threshold, skipping`);
      return { replayed: 0, skipped: 0 };
    }

    console.log(
      `[MissedRun] Controller was down for ${downtimeMinutes} minute(s) ` +
      `(from ${lastSeenAt.toISOString()} to ${bootedAt.toISOString()})`
    );

    const schedules = await getBackupSchedules();
    const enabled = schedules.filter(s => s.enabled !== false);

    let replayed = 0;
    let skippedTooOld = 0;
    let skippedByPolicy = 0;
    let errors = 0;

    for (const schedule of enabled) {
      try {
        const missedRuns = this.computeMissedRuns(schedule, lastSeenAt, bootedAt);
        if (missedRuns.length === 0) continue;

        const policy = schedule.missedRunPolicy || 'immediate';
        const graceMinutes = Number.isFinite(schedule.missedRunGracePeriodMinutes)
          ? schedule.missedRunGracePeriodMinutes
          : 360; // 6h default

        // Filter by grace period: runs older than (bootedAt - grace) are too old
        const graceCutoff = new Date(bootedAt.getTime() - graceMinutes * 60_000);
        const fresh = missedRuns.filter(r => r.scheduledAt >= graceCutoff);
        const tooOld = missedRuns.length - fresh.length;
        skippedTooOld += tooOld;

        if (tooOld > 0) {
          console.log(
            `[MissedRun] Schedule ${schedule.id} (${schedule.name || schedule.scheduleType}): ` +
            `${tooOld} run(s) outside ${graceMinutes}min grace period — skipped`
          );
        }

        if (fresh.length === 0) {
          continue;
        }

        // Apply policy
        let toReplay = [];
        if (policy === 'skip') {
          skippedByPolicy += fresh.length;
          await this.recordMissed(schedule, fresh, 'policy_skip');
          continue;
        } else if (policy === 'most-recent') {
          toReplay = [fresh[fresh.length - 1]];
          if (fresh.length > 1) {
            const olderSkipped = fresh.slice(0, -1);
            skippedByPolicy += olderSkipped.length;
            await this.recordMissed(schedule, olderSkipped, 'policy_most_recent');
          }
        } else {
          // immediate (default): replay everything within grace
          toReplay = fresh;
        }

        for (const run of toReplay) {
          try {
            const triggered = await this.replayRun(schedule, run);
            if (triggered) replayed++;
          } catch (err) {
            errors++;
            console.error(`[MissedRun] Replay error for schedule ${schedule.id}:`, err.message);
          }
        }
      } catch (err) {
        errors++;
        console.error(`[MissedRun] Error processing schedule ${schedule.id}:`, err.message);
      }
    }

    if (replayed || skippedByPolicy || skippedTooOld) {
      console.log(
        `[MissedRun] Recovery summary: replayed=${replayed}, ` +
        `skipped_by_policy=${skippedByPolicy}, skipped_too_old=${skippedTooOld}, errors=${errors}`
      );

      // RocketChat: single summary message instead of one-per-schedule spam
      try {
        await rocketChatService.notifyMissedRunsRecovered({
          downtimeMinutes,
          lastSeenAt: lastSeenAt.toISOString(),
          bootedAt: bootedAt.toISOString(),
          replayed,
          skippedByPolicy,
          skippedTooOld,
        });
      } catch (e) {
        // best-effort
      }
    } else {
      console.log('[MissedRun] No schedules had missed runs in the downtime window');
    }

    return { replayed, skippedByPolicy, skippedTooOld, errors, downtimeMinutes };
  }

  /**
   * Given a schedule and a [from, to] window, return missed scheduled fires
   * that fell inside that window. Returns an array of { scheduledAt: Date, meta }.
   */
  computeMissedRuns(schedule, from, to) {
    const type = schedule.scheduleType;
    const fromMs = from.getTime();
    const toMs = to.getTime();
    const out = [];

    const pushIfInWindow = (date, meta) => {
      const t = date.getTime();
      if (t > fromMs && t <= toMs) {
        out.push({ scheduledAt: date, meta });
      }
    };

    switch (type) {
      case 'daily': {
        // Fires every day at HH:MM
        const [hh, mm] = (schedule.time || '00:00').split(':').map(Number);
        const cursor = new Date(from);
        cursor.setHours(hh, mm, 0, 0);
        if (cursor.getTime() < fromMs) cursor.setDate(cursor.getDate() + 1);
        while (cursor.getTime() <= toMs) {
          pushIfInWindow(new Date(cursor), {});
          cursor.setDate(cursor.getDate() + 1);
        }
        break;
      }

      case 'weekly': {
        // Fires on each day in daysOfWeek at HH:MM
        const [hh, mm] = (schedule.time || '00:00').split(':').map(Number);
        const days = Array.isArray(schedule.daysOfWeek) ? schedule.daysOfWeek : [];
        if (days.length === 0) break;
        const cursor = new Date(from);
        cursor.setHours(hh, mm, 0, 0);
        if (cursor.getTime() < fromMs) cursor.setDate(cursor.getDate() + 1);
        while (cursor.getTime() <= toMs) {
          if (days.includes(cursor.getDay())) {
            const isFullDay = cursor.getDay() === schedule.fullBackupDay;
            pushIfInWindow(new Date(cursor), { method: isFullDay ? 'full' : 'inc' });
          }
          cursor.setDate(cursor.getDate() + 1);
        }
        break;
      }

      case 'monthly': {
        // Fires on day 1 at HH:MM
        const [hh, mm] = (schedule.time || '00:00').split(':').map(Number);
        const cursor = new Date(from.getFullYear(), from.getMonth(), 1, hh, mm, 0, 0);
        // If past, jump to next month
        if (cursor.getTime() < fromMs) {
          cursor.setMonth(cursor.getMonth() + 1);
        }
        while (cursor.getTime() <= toMs) {
          pushIfInWindow(new Date(cursor), {});
          cursor.setMonth(cursor.getMonth() + 1);
        }
        break;
      }

      case 'once': {
        // Fires once at a specific HH:MM on a specific date — but the legacy
        // schema only stores time. We treat "once" as already-fired-or-not
        // using a runOnceAt field if present. If not present, skip — the
        // scheduler will still pick it up later.
        const onceAt = schedule.runOnceAt ? new Date(schedule.runOnceAt) : null;
        if (onceAt) pushIfInWindow(onceAt, {});
        break;
      }

      case 'interval': {
        // Fires every N hours/days from an anchor. Anchor is schedule.createdAt
        // or fall back to last fire time (lastFiredAt) which we maintain.
        const value = Number(schedule.intervalValue) || 0;
        const unit = schedule.intervalUnit || 'hours';
        if (value <= 0) break;
        const stepMs = unit === 'days' ? value * 86_400_000 : value * 3_600_000;
        const anchorRaw = schedule.lastFiredAt || schedule.createdAt;
        if (!anchorRaw) break;
        let next = new Date(anchorRaw).getTime() + stepMs;
        // Walk forward until we pass `from`, then collect occurrences up to `to`
        while (next <= toMs) {
          if (next > fromMs) out.push({ scheduledAt: new Date(next), meta: {} });
          next += stepMs;
        }
        break;
      }

      case 'cron': {
        // Generic cron: only handle the cases we generate ourselves to avoid
        // pulling in cron-parser. node-cron supports much more but in practice
        // the cronExpression here is one we built. For safety, treat unknown
        // cron expressions as having "no missed runs computable" — the
        // scheduler will still resume on the next tick.
        // Try to handle a few common forms.
        const expr = (schedule.cronExpression || '').trim();
        const occurrences = this._enumerateCron(expr, from, to);
        occurrences.forEach(d => pushIfInWindow(d, {}));
        break;
      }

      case 'custom-days': {
        // Each customDate is { date: 'YYYY-MM-DD', time: 'HH:MM', method: 'full'|'inc' }
        const dates = Array.isArray(schedule.customDates) ? schedule.customDates : [];
        for (const cd of dates) {
          if (!cd || !cd.date || !cd.time) continue;
          const [hh, mm] = cd.time.split(':').map(Number);
          const [y, mo, d] = cd.date.split('-').map(Number);
          const dt = new Date(y, (mo || 1) - 1, d || 1, hh || 0, mm || 0, 0, 0);
          pushIfInWindow(dt, { method: cd.method });
        }
        break;
      }

      default:
        break;
    }

    return out.sort((a, b) => a.scheduledAt - b.scheduledAt);
  }

  /**
   * Enumerate cron occurrences for the limited subset of expressions we
   * actually generate. Best-effort — unknown forms return [].
   */
  _enumerateCron(expr, from, to) {
    if (!expr) return [];
    const parts = expr.split(/\s+/);
    if (parts.length !== 5) return [];
    const [minute, hour, dom, month, dow] = parts;
    const out = [];

    // Helper: every-N-hours form like "0 */N * * *"
    const everyNHoursMatch = /^\*\/(\d+)$/.exec(hour);
    if (
      everyNHoursMatch &&
      minute === '0' &&
      dom === '*' &&
      month === '*' &&
      dow === '*'
    ) {
      const n = Number(everyNHoursMatch[1]) || 1;
      const cursor = new Date(from);
      cursor.setMinutes(0, 0, 0);
      while (cursor.getTime() <= to.getTime()) {
        if (cursor.getTime() > from.getTime() && cursor.getHours() % n === 0) {
          out.push(new Date(cursor));
        }
        cursor.setHours(cursor.getHours() + 1);
      }
      return out;
    }

    // Helper: every-N-days form like "0 0 */N * *"
    const everyNDaysMatch = /^\*\/(\d+)$/.exec(dom);
    if (everyNDaysMatch && month === '*' && dow === '*') {
      const n = Number(everyNDaysMatch[1]) || 1;
      const hh = Number(hour) || 0;
      const mm = Number(minute) || 0;
      const cursor = new Date(from);
      cursor.setHours(hh, mm, 0, 0);
      if (cursor.getTime() < from.getTime()) cursor.setDate(cursor.getDate() + 1);
      while (cursor.getTime() <= to.getTime()) {
        // Day-of-month %N === 1 is what `*/N` typically yields in cron
        if ((cursor.getDate() - 1) % n === 0 && cursor.getTime() > from.getTime()) {
          out.push(new Date(cursor));
        }
        cursor.setDate(cursor.getDate() + 1);
      }
      return out;
    }

    // Fixed time: "M H * * *" daily or "M H D M *" specific
    if (/^\d+$/.test(minute) && /^\d+$/.test(hour)) {
      const hh = Number(hour);
      const mm = Number(minute);
      const cursor = new Date(from);
      cursor.setHours(hh, mm, 0, 0);
      if (cursor.getTime() < from.getTime()) cursor.setDate(cursor.getDate() + 1);
      while (cursor.getTime() <= to.getTime()) {
        let match = true;
        if (dom !== '*' && Number(dom) !== cursor.getDate()) match = false;
        if (month !== '*' && Number(month) !== cursor.getMonth() + 1) match = false;
        if (dow !== '*') {
          const allowed = dow.split(',').map(Number);
          if (!allowed.includes(cursor.getDay())) match = false;
        }
        if (match && cursor.getTime() > from.getTime()) {
          out.push(new Date(cursor));
        }
        cursor.setDate(cursor.getDate() + 1);
      }
      return out;
    }

    return out;
  }

  /**
   * Record a missed run as a "skipped" job so it shows up in history without
   * actually triggering a backup.
   */
  async recordMissed(schedule, runs, reason) {
    const jobs = await getBackupJobs();
    const vms = await getVirtualMachines();
    const hosts = await getBackupHosts();
    const hypervisors = await getHypervisors();
    const vm = vms.find(v => v.id === schedule.vmId);
    const host = vm ? hosts.find(h => h.id === vm.backupHostId) : null;
    const hypervisor = vm ? hypervisors.find(h => h.id === vm.hypervisorId) : null;

    for (const run of runs) {
      const id = uuidv4();
      jobs.push({
        id,
        scheduleId: schedule.id,
        vmId: schedule.vmId,
        vmName: vm ? vm.name : 'Unknown',
        hypervisorIp: hypervisor ? hypervisor.ip : null,
        backupHostId: host ? host.id : null,
        backupHostName: host ? host.name : null,
        method: run.meta?.method || 'inc',
        status: 'skipped',
        startTime: run.scheduledAt.toISOString(),
        endTime: run.scheduledAt.toISOString(),
        scheduled: true,
        scheduledAt: run.scheduledAt.toISOString(),
        skippedReason: reason === 'policy_skip' ? 'controller_downtime_policy_skip'
          : reason === 'policy_most_recent' ? 'controller_downtime_older_run_dropped'
          : 'controller_downtime',
        canRetry: false,
        triggeredBy: 'system',
        actor: 'system:missed-run',
      });
      await appendLog(id, `Missed run for schedule ${schedule.id} at ${run.scheduledAt.toISOString()} — recorded as skipped (${reason})`);
    }
    await saveBackupJobs(jobs);
  }

  /**
   * Replay a single missed run by delegating to the scheduler service.
   * Returns true if a backup was triggered.
   */
  async replayRun(schedule, run) {
    if (!this.scheduler) {
      console.error('[MissedRun] Scheduler not wired in');
      return false;
    }
    if (typeof this.scheduler.fireScheduleNow === 'function') {
      const reason = `Missed run replay (originally scheduled at ${run.scheduledAt.toISOString()})`;
      const ok = await this.scheduler.fireScheduleNow(schedule, {
        reason,
        scheduledAt: run.scheduledAt,
        method: run.meta?.method,
        actor: 'system:missed-run',
        triggeredBy: 'system',
      });
      return !!ok;
    }
    return false;
  }
}

const missedRunService = new MissedRunService();
module.exports = missedRunService;
