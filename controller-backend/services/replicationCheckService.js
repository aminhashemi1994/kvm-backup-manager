const path = require('path');
const fs = require('fs').promises;
const config = require('../config/config');
const {
  getVirtualMachines,
  getBackupHosts,
  getBackupSchedules,
  getStoragePools,
  getOffsiteHosts,
  getOffsiteJobs,
} = require('./fileStorage');
const agentService = require('./agentService');
const offsiteJobService = require('./offsiteJobService');
const rocketChatService = require('./rocketChatService');

/**
 * Replication check.
 *
 * Answers, on a schedule, the question a backup job can no longer answer for
 * itself: is every offsite copy actually up to date? Backups and transfers are
 * independent now, so a transfer can fail, be cancelled, or simply never have
 * been started for a VM, and nothing about the backups would look wrong. This
 * is what notices.
 *
 * For each VM with offsite targets, it asks the VM's agent to compare the source
 * directory with each destination — file list and sizes, no content checksums —
 * and records the answer. VMs found behind can be synced automatically.
 *
 * A VM with a sync already running is skipped, not judged. Its destination is
 * mid-update by definition, so any verdict would be about a moving target, and
 * the run in progress will report the real outcome.
 *
 * Reads only. It never transfers, never takes the sync lock, and cannot
 * interfere with a backup or a transfer that is running.
 */

const RESULTS_FILE = () => path.join(config.dataDir, 'offsite-check-results.json');

// Same terminal set the offsite job service uses, so updateFromSync only acts
// on a sync that genuinely finished (no point in rewriting the recorded
// verdict for a job that was cancelled or never got past the start gate).
const TERMINAL = ['completed', 'failed', 'cancelled', 'busy', 'unsupported'];

// Per-VM ceiling for one comparison. The check is metadata work, but a very
// large chain over a slow link still takes minutes.
const PER_VM_TIMEOUT_MS = 5 * 60 * 1000;

// VMs compared at once. The check is cheap per VM but not free — it is SSH plus
// a full directory stat on both ends — and firing it at every VM of a busy host
// simultaneously would compete with the backups and transfers actually running.
const CONCURRENCY = 3;

/**
 * Does this schedule still replicate offsite?
 *
 * One predicate, used by the check, by the results it serves, and by
 * offsiteJobService — so "is offsite on for this VM" cannot be answered
 * differently in three places.
 *
 * `offsiteEnabled` was the original gate but is never written by any code path,
 * so `!== false` was always true and the gate was really just "has targets".
 * `syncToOffsite` is what the schedule form actually sets and is now persisted,
 * so it is checked explicitly: once an operator unticks offsite, a stale target
 * left on the record must not resurrect it.
 */
function replicationEnabled(schedule) {
  if (!schedule) return false;
  // A disabled schedule produces no new backups, so its offsite copy falling
  // behind is expected, not an incident.
  if (schedule.enabled === false) return false;
  if (schedule.offsiteEnabled === false) return false;
  if (schedule.syncToOffsite === false) return false;
  const targets = Array.isArray(schedule.offsiteTargets) ? schedule.offsiteTargets : [];
  const legacy = Array.isArray(schedule.offsiteHostIds) ? schedule.offsiteHostIds : [];
  return targets.length > 0 || legacy.length > 0;
}

class ReplicationCheckService {
  constructor() {
    this.io = null;
    this.timer = null;
    this.running = false;
    this.lastRunAt = null;
    this.intervalMs = 0;
  }

  async init(io, { runOnStart = false } = {}) {
    this.io = io;
    await this._reschedule();

    if (runOnStart) {
      // Give the agents a moment to report in first; a host still marked offline
      // from before the restart would otherwise be skipped for a whole cycle.
      setTimeout(() => {
        this.runSettingsRun().catch(err => {
          console.error(`[ReplicationCheck] Startup run failed: ${err.message}`);
        });
      }, 120000);
    }
  }

  /**
   * Read the cadence from the panel settings and arm the timer.
   *
   * Re-read on every tick rather than cached at startup, so changing the
   * interval in the panel takes effect on the next cycle instead of needing a
   * controller restart. An interval of 0 disables the check entirely — the
   * timer is simply not re-armed.
   */
  async _reschedule() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const settings = await this._settings();
    const hours = Number(settings.replicationCheckIntervalHours);
    if (!Number.isFinite(hours) || hours <= 0) {
      console.log('[ReplicationCheck] Disabled (replicationCheckIntervalHours = 0)');
      this.intervalMs = 0;
      return;
    }

    this.intervalMs = hours * 60 * 60 * 1000;
    this.timer = setTimeout(() => {
      this.runSettingsRun()
        .catch(err => console.error(`[ReplicationCheck] Scheduled run failed: ${err.message}`))
        .finally(() => this._reschedule());
    }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();

    console.log(`[ReplicationCheck] Next run in ${hours}h`);
  }

  /**
   * Re-arm from the current settings, right now.
   *
   * Called when the panel saves the replication settings. Without it the timer
   * only re-read the interval when it next fired, which had two consequences:
   * shortening a 24h interval to 1h still meant waiting up to a day, and — far
   * worse — setting the interval to 0 cleared the timer and nothing ever
   * re-armed it, so turning the check back on did nothing at all until the
   * controller was restarted.
   */
  async reschedule() {
    await this._reschedule();
    return { intervalMs: this.intervalMs, enabled: this.intervalMs > 0 };
  }

  /** A scheduled run, using whatever the settings currently say about auto-sync. */
  async runSettingsRun() {
    const settings = await this._settings();
    return this.runNow({ autoSync: settings.replicationCheckAutoSync !== false });
  }

  async _settings() {
    try {
      const { loadSettings } = require('../routes/settings');
      return await loadSettings();
    } catch (err) {
      console.error(`[ReplicationCheck] Could not read settings: ${err.message}`);
      return { replicationCheckIntervalHours: 24, replicationCheckAutoSync: true };
    }
  }

  shutdown() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  // ───────────────────────────────────────────────────────────────────────

  /**
   * Compare every offsite-enabled VM against its targets.
   *
   * @param {object}  opts
   * @param {string}  [opts.backupHostId]  Limit to one backup host.
   * @param {boolean} [opts.autoSync]      Queue a sync for each VM found behind.
   */
  async runNow({ backupHostId = null, autoSync = false } = {}) {
    if (this.running) {
      return { started: false, reason: 'A replication check is already running' };
    }
    this.running = true;
    const startedAt = new Date().toISOString();

    try {
      const { candidates, broken } = await this._candidates(backupHostId);
      if (candidates.length === 0 && broken.length === 0) {
        const summary = {
          startedAt, finishedAt: new Date().toISOString(),
          checked: 0, inSync: 0, outOfSync: 0, skipped: 0, failed: 0,
          sourceUnavailable: 0, noTarget: 0, synced: 0, vms: [],
        };
        await this._saveResults(summary);
        return summary;
      }

      // A check is exactly when a newly-updated agent gets noticed, so give
      // anything it previously refused a chance to run before comparing trees.
      try {
        const rearmed = await offsiteJobService.rearmUnsupportedJobs();
        if (rearmed && rearmed.requeued > 0) {
          console.log(`[ReplicationCheck] Re-queued ${rearmed.requeued} sync(s) an updated agent can now run`);
        }
      } catch (err) {
        console.error(`[ReplicationCheck] Could not re-arm refused syncs: ${err.message}`);
      }

      console.log(`[ReplicationCheck] Checking ${candidates.length} VM(s)`);

      // Broken configurations need no agent round-trip — they are known to be
      // wrong from the controller's own records — but they belong in the same
      // results so the panel shows them next to everything else.
      const results = [...broken];
      for (let i = 0; i < candidates.length; i += CONCURRENCY) {
        const batch = candidates.slice(i, i + CONCURRENCY);
        const settled = await Promise.all(batch.map(c => this._checkOne(c)));
        results.push(...settled);
      }

      // Queue a sync for everything found behind. requestSync coalesces, so a
      // VM that already has one pending is left alone.
      let synced = 0;
      if (autoSync) {
        for (const r of results) {
          if (r.state !== 'out_of_sync') continue;
          try {
            const req = await offsiteJobService.requestSync({
              vmId: r.vmId, scheduleId: r.scheduleId, trigger: 'check',
            });
            if (req.created) {
              synced++;
              r.syncJobId = req.job.id;
            } else {
              r.syncNote = req.reason;
            }
          } catch (err) {
            r.syncNote = `Could not queue a sync: ${err.message}`;
          }
        }
      }

      const summary = {
        startedAt,
        finishedAt: new Date().toISOString(),
        checked: results.length,
        inSync: results.filter(r => r.state === 'in_sync').length,
        outOfSync: results.filter(r => r.state === 'out_of_sync').length,
        skipped: results.filter(r => r.state === 'skipped').length,
        failed: results.filter(r => r.state === 'error' || r.state === 'unreachable').length,
        sourceUnavailable: results.filter(r => r.state === 'source_unavailable').length,
        noTarget: results.filter(r => r.state === 'no_target').length,
        synced,
        vms: results,
      };

      this.lastRunAt = summary.finishedAt;
      await this._saveResults(summary);

      console.log(
        `[ReplicationCheck] Done: ${summary.inSync} in sync, ${summary.outOfSync} behind, ` +
        `${summary.skipped} skipped, ${summary.failed} could not be checked` +
        (autoSync ? `, ${synced} sync(s) queued` : '')
      );

      // A pool that is not mounted is loud, and separate from the tally above.
      // Every backup for those VMs is failing or writing somewhere unintended,
      // and their offsite copy may be the only one left.
      if (summary.sourceUnavailable > 0) {
        const affected = results.filter(r => r.state === 'source_unavailable');
        const names = affected.map(r => `${r.vmName} (${r.backupHostName})`).join(', ');
        console.error(`[ReplicationCheck] SOURCE POOL UNAVAILABLE for ${summary.sourceUnavailable} VM(s): ${names}`);
        this._announceSourceUnavailable(affected);
      }

      // A VM that is behind and that nothing is doing anything about. If the
      // check queued a sync for it, that sync's own outcome is the thing worth
      // saying — announcing both would be two messages about one problem, and
      // the second one would usually be stale by the time anyone read it.
      this._announceBehind(results.filter(r => r.state === 'out_of_sync' && !r.syncJobId));

      if (this.io) {
        try { this.io.emit('offsite-check-complete', summary); } catch (_) { /* ignore */ }
      }
      return summary;
    } finally {
      this.running = false;
    }
  }

  /**
   * Every VM that has somewhere to replicate to, with the context needed to ask
   * its agent. A VM whose host is offline is left out entirely rather than
   * recorded as failed — nothing is known about it either way.
   */
  async _candidates(backupHostId) {
    const [vms, hosts, schedules, pools, offsiteHosts, manual] = await Promise.all([
      getVirtualMachines(), getBackupHosts(), getBackupSchedules(),
      getStoragePools(), getOffsiteHosts(), offsiteJobService.manualReplicas(),
    ]);

    const out = [];
    // VMs whose offsite configuration no longer resolves. Carried out alongside
    // the candidates so the caller can report them rather than lose them.
    const broken = [];
    for (const vm of vms) {
      if (backupHostId && vm.backupHostId !== backupHostId) continue;

      const host = hosts.find(h => h.id === vm.backupHostId);
      if (!host || host.status !== 'online') continue;

      // A schedule replicates only when the operator has not switched offsite
      // off AND it still has somewhere to send to. See replicationEnabled().
      // Or it was synced by hand ("Sync a backup"), which counts too.
      const vmSchedules = schedules.filter(s => replicationEnabled(s) && s.vmId === vm.id);
      const hasEnabledSchedule = schedules.some(s => s.vmId === vm.id && s.enabled !== false);
      if (vmSchedules.length === 0 && !(manual.has(vm.id) && hasEnabledSchedule)) continue;

      // Reuse the job service's resolution so the check and the sync can never
      // disagree about which targets a VM has.
      const ctx = await offsiteJobService._resolveContext(vm.id, null);
      if (!ctx.ok || ctx.encoded.length === 0) {
        // The schedule still says "replicate offsite", but nothing it points at
        // resolves any more — the offsite host was deleted, or the destination
        // pool was removed from it. Silently dropping the VM here is how
        // replication stops without anyone noticing: the tickbox stays on, the
        // backups keep succeeding, and no copy is ever made again. It is
        // reported as a broken configuration instead of being skipped.
        broken.push({
          vmId: vm.id,
          vmName: vm.name,
          backupHostId: host.id,
          backupHostName: host.name,
          scheduleId: (ctx.ok && ctx.schedule) ? ctx.schedule.id : null,
          targets: [],
          checkedAt: new Date().toISOString(),
          state: 'no_target',
          reason: ctx.ok
            ? 'Offsite sync is on for this VM, but none of its destinations exist any more — '
              + 'the offsite host or its destination pool was deleted. Nothing is being replicated. '
              + 'Pick a destination again, or turn offsite sync off for this schedule.'
            : ctx.reason,
        });
        continue;
      }

      let url = host.url;
      if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'http://' + url;

      out.push({
        vm, host, url,
        pool: ctx.pool,
        scheduleId: ctx.schedule ? ctx.schedule.id : null,
        encoded: ctx.encoded,
        targets: ctx.targets,
      });
    }
    return { candidates: out, broken };
  }

  async _checkOne({ vm, host, url, pool, scheduleId, encoded, targets }) {
    const base = {
      vmId: vm.id,
      vmName: vm.name,
      backupHostId: host.id,
      backupHostName: host.name,
      scheduleId,
      targets: targets.map(t => ({
        ip: t.ip, path: t.path,
        offsiteHostId: t.offsiteHostId, offsiteHostName: t.offsiteHostName,
        offsitePoolId: t.offsitePoolId, offsitePoolName: t.offsitePoolName,
      })),
      checkedAt: new Date().toISOString(),
    };

    try {
      const res = await agentService.checkOffsiteReplication(url, {
        vmName: vm.name,
        storagePoolPath: pool.path,
        offsiteHosts: encoded,
        diskUsageThreshold: pool.diskUsageThreshold ?? 80,
        timeoutMs: PER_VM_TIMEOUT_MS,
      }, PER_VM_TIMEOUT_MS + 30000);

      const data = (res && res.data) || {};

      // The agent declined to answer. Two very different reasons for that.
      if (data.checked === false) {
        if (data.reason === 'source_unavailable') {
          // The pool holding the backups is not mounted, or is not the
          // filesystem it used to be. This is the opposite of a minor finding:
          // the local copy is the one that is missing, and the offsite copies
          // may now be the only ones. It must never be filed as "skipped", and
          // auto-sync must not act on it — the agent would refuse anyway, but
          // the operator needs to see the real cause.
          return {
            ...base,
            state: 'source_unavailable',
            reason: `The backup pool for ${vm.name} on ${host.name} is not mounted, ` +
                    `or is not the filesystem it was. Replication is refused until that is resolved.`,
          };
        }
        return { ...base, state: 'skipped', reason: data.reason || 'sync in progress' };
      }

      return {
        ...base,
        state: data.state === 'in_sync' ? 'in_sync'
          : data.state === 'unreachable' ? 'unreachable'
            : 'out_of_sync',
        outOfSyncTargets: data.outOfSync || 0,
        unreachableTargets: data.unreachable || 0,
        targetDetail: Array.isArray(data.targets) ? data.targets : [],
      };
    } catch (err) {
      const status = err.response && err.response.status;
      if (status === 404) {
        // Same reasoning as offsiteJobService: a 404 is not proof of an old
        // agent. Ask the agent what it supports before telling anyone to
        // update something that is already current.
        const probe = await offsiteJobService._probeOffsiteSupport(url);

        if (probe.supported) {
          return {
            ...base,
            state: 'error',
            reason: `${host.name} advertises the replication check (agent v${probe.version || 'unknown'}), `
              + 'but POST /api/offsite/check returned 404. The agent is up to date — something between '
              + 'the controller and it is not forwarding that path. Check any reverse proxy in front of '
              + 'the agent, and that the process was restarted after the deploy.',
          };
        }
        if (probe.unreachable) {
          return {
            ...base,
            state: 'unreachable',
            reason: `${host.name} did not answer its health endpoint either (${probe.error}).`,
          };
        }
        return {
          ...base,
          state: 'error',
          reason: `Agent on ${host.name} does not support the replication check`
            + `${probe.version ? ` (agent v${probe.version})` : ''}. `
            + 'Replication cannot be verified for this host until the agent is updated.',
          agentUnsupported: true,
        };
      }
      return { ...base, state: 'error', reason: err.message };
    }
  }

  /**
   * Per VM, onto the daily incident board.
   *
   * Unlike the host-level alerts below this is not rate-limited here: the board
   * dedupes by VM for the whole period and edits one message in place, so a VM
   * that is still behind at the next check refreshes its existing line rather
   * than adding another.
   */
  _announceBehind(rows) {
    for (const r of rows) {
      try {
        const targets = r.outOfSyncTargets || 0;
        const detail = [
          targets ? `${targets} destination${targets === 1 ? '' : 's'} behind` : 'offsite copy is out of date',
          r.unreachableTargets ? `${r.unreachableTargets} unreachable` : null,
          r.syncNote || null,
        ].filter(Boolean).join(', ');

        rocketChatService.notifyOffsiteBehind(r.vmName, detail, r.scheduleId || null, r.backupHostId || null);
      } catch (err) {
        console.error(`[ReplicationCheck] Could not announce that ${r.vmName} is behind: ${err.message}`);
      }
    }
  }

  /**
   * One alert per backup host, not per VM: a pool that is not mounted takes
   * every VM on it down at once, and forty identical messages would bury the
   * one fact that matters. Rate-limited to once an hour per host.
   */
  _announceSourceUnavailable(affected) {
    if (!this._sourceAlerted) this._sourceAlerted = new Map();

    const byHost = new Map();
    for (const r of affected) {
      if (!byHost.has(r.backupHostId)) byHost.set(r.backupHostId, []);
      byHost.get(r.backupHostId).push(r);
    }

    for (const [hostId, rows] of byHost) {
      const last = this._sourceAlerted.get(hostId) || 0;
      if (Date.now() - last < 60 * 60 * 1000) continue;
      this._sourceAlerted.set(hostId, Date.now());

      const hostName = rows[0].backupHostName;
      try {
        // The daily incident board, like every other backup-health issue —
        // and as a critical, because the missing copy here is the LOCAL one.
        const names = rows.map(r => r.vmName).slice(0, 6).join(', ');
        rocketChatService.notifySourceUnavailable(
          hostName,
          `not mounted — ${rows.length} VM(s) affected (${names}${rows.length > 6 ? ', …' : ''}), `
          + 'replication refused until it is mounted',
          hostId
        );
      } catch (err) {
        console.error(`[ReplicationCheck] Could not announce the unmounted pool: ${err.message}`);
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────────

  async getResults() {
    let summary;
    try {
      const raw = await fs.readFile(RESULTS_FILE(), 'utf8');
      summary = JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { startedAt: null, finishedAt: null, checked: 0, vms: [] };
      }
      throw err;
    }

    // The file is a snapshot of one run. A VM whose offsite sync has been
    // switched off SINCE that run is still in it, and would keep appearing in
    // the panel — with a stale verdict and a Sync button — until the next check
    // happened to run. So the stored rows are filtered against the CURRENT
    // schedules on every read: unticking offsite removes the VM immediately.
    //
    // Deliberately filtered on configuration only, never on host status. A VM
    // whose backup host is briefly offline is skipped by _candidates() when
    // choosing what to check, but it must not disappear from results that were
    // gathered while it was up — offline is temporary, unticked is intentional.
    return this._withCurrentConfig(summary);
  }

  /**
   * The results as the panel should show them.
   *
   * `getResults()` answers "what did the last run find, minus VMs that no
   * longer replicate". That covers unticking offsite — the row disappears on
   * the next read. It does NOT cover the opposite move: tick offsite ON for a
   * VM and it is simply absent from the last run's snapshot, so the panel
   * shows nothing about it until the next check happens to fire, which can be
   * a whole interval away. An operator who just enabled replication reads that
   * absence as "it didn't take".
   *
   * So enabling is made symmetric with disabling: every VM that replicates
   * right now but was not in the snapshot is added as `not_checked`. It is an
   * honest verdict — nothing has been compared yet — and it carries the
   * destinations and the Sync button, so the VM is actionable the moment it is
   * configured instead of an interval later.
   *
   * Kept separate from `getResults()` because these rows are synthetic:
   * `updateFromSync()` reads results and writes them back, and injected rows
   * must never be persisted into the snapshot file.
   */
  async getResultsForDisplay() {
    const summary = await this.getResults();
    return this._withPendingVms(summary);
  }

  /** Append `not_checked` rows for VMs that replicate but aren't in the snapshot. */
  async _withPendingVms(summary) {
    const base = summary && Array.isArray(summary.vms)
      ? summary
      : { startedAt: null, finishedAt: null, checked: 0, vms: [] };

    let vms, hosts, schedules;
    try {
      [vms, hosts, schedules] = await Promise.all([
        getVirtualMachines(), getBackupHosts(), getBackupSchedules(),
      ]);
    } catch (err) {
      // Cannot tell what is configured — show the snapshot as recorded rather
      // than inventing rows we cannot stand behind.
      console.error(`[ReplicationCheck] Could not list VMs for pending rows: ${err.message}`);
      return base;
    }

    const known = new Set(base.vms.map(v => v && v.vmId));
    const enabledVmIds = await this._replicatedVmIds(schedules);

    const pending = [];
    for (const vm of vms) {
      if (known.has(vm.id)) continue;
      if (!enabledVmIds.has(vm.id)) continue;

      const host = hosts.find(h => h.id === vm.backupHostId);

      // Resolve the destinations the same way the check itself does, so the
      // row names the real offsite hosts rather than an empty cell — and so a
      // configuration that points at a deleted host is called out here too,
      // without waiting for a check to discover it.
      let ctx = { ok: false, encoded: [], targets: [], schedule: null, reason: null };
      try {
        ctx = await offsiteJobService._resolveContext(vm.id, null);
      } catch (err) {
        ctx = { ...ctx, reason: err.message };
      }

      const resolved = ctx.ok && Array.isArray(ctx.encoded) && ctx.encoded.length > 0;

      pending.push({
        vmId: vm.id,
        vmName: vm.name,
        backupHostId: host ? host.id : vm.backupHostId,
        backupHostName: host ? host.name : (vm.backupHostName || 'unknown'),
        scheduleId: (ctx.ok && ctx.schedule) ? ctx.schedule.id : null,
        targets: resolved
          ? ctx.targets.map(t => ({
              ip: t.ip, path: t.path,
              offsiteHostId: t.offsiteHostId, offsiteHostName: t.offsiteHostName,
              offsitePoolId: t.offsitePoolId, offsitePoolName: t.offsitePoolName,
            }))
          : [],
        checkedAt: null,
        // Three outcomes, kept distinct so the row means what it says:
        //   resolved         → nothing compared yet, nothing wrong
        //   ok but 0 targets → the destinations it pointed at are gone
        //   not ok           → the configuration itself does not resolve
        state: resolved ? 'not_checked' : (ctx.ok ? 'no_target' : 'error'),
        reason: resolved
          ? 'Offsite sync is on for this VM, but the check has not compared it yet. '
            + 'Run the check, or sync it now.'
          : ctx.ok
            ? 'Offsite sync is on for this VM, but none of its destinations exist any more — '
              + 'the offsite host or its destination pool was deleted. Nothing is being replicated. '
              + 'Pick a destination again, or turn offsite sync off for this schedule.'
            : (ctx.reason || 'This VM\'s offsite configuration could not be resolved.'),
      });
    }

    if (pending.length === 0) return base;

    const merged = [...base.vms, ...pending];
    return {
      ...base,
      vms: merged,
      checked: base.checked || 0,
      notChecked: pending.filter(v => v.state === 'not_checked').length,
      noTarget: merged.filter(v => v.state === 'no_target').length,
      failed: merged.filter(v => v.state === 'error' || v.state === 'unreachable').length,
    };
  }

  /** Drop rows for VMs that no longer replicate, and re-derive the tallies. */
  async _withCurrentConfig(summary) {
    if (!summary || !Array.isArray(summary.vms) || summary.vms.length === 0) return summary;

    let schedules;
    try {
      schedules = await getBackupSchedules();
    } catch (err) {
      // Cannot tell — show what was recorded rather than hiding everything.
      console.error(`[ReplicationCheck] Could not re-check schedules: ${err.message}`);
      return summary;
    }

    const enabledVmIds = await this._replicatedVmIds(schedules);

    const vms = summary.vms.filter(v => enabledVmIds.has(v.vmId));
    if (vms.length === summary.vms.length) return summary;

    // The header counters are part of the same statement as the rows, so they
    // are recomputed rather than left describing VMs that are no longer listed.
    return {
      ...summary,
      vms,
      checked: vms.length,
      inSync: vms.filter(v => v.state === 'in_sync').length,
      outOfSync: vms.filter(v => v.state === 'out_of_sync').length,
      skipped: vms.filter(v => v.state === 'skipped').length,
      failed: vms.filter(v => v.state === 'error' || v.state === 'unreachable').length,
      sourceUnavailable: vms.filter(v => v.state === 'source_unavailable').length,
      noTarget: vms.filter(v => v.state === 'no_target').length,
    };
  }

  /** VMs that replicate: by an offsite-enabled schedule, or synced by hand. */
  async _replicatedVmIds(schedules) {
    const ids = new Set(schedules.filter(replicationEnabled).map(s => s.vmId));
    try {
      // A hand-synced VM stops counting once none of its schedules is enabled.
      const active = new Set(schedules.filter(s => s.enabled !== false).map(s => s.vmId));
      for (const vmId of (await offsiteJobService.manualReplicas()).keys()) {
        if (active.has(vmId)) ids.add(vmId);
      }
    } catch (err) {
      console.error(`[ReplicationCheck] Could not read manual replicas: ${err.message}`);
    }
    return ids;
  }

  async _saveResults(summary) {
    try {
      await fs.writeFile(RESULTS_FILE(), JSON.stringify(summary, null, 2), 'utf8');
    } catch (err) {
      console.error(`[ReplicationCheck] Could not save results: ${err.message}`);
    }
  }

  /**
   * Reflect the outcome of one finished offsite sync back into the latest
   * replication-check results, so the panel stops showing a VM as "Behind"
   * for up to a whole interval after the sync that fixed it.
   *
   * Only acts on a sync that genuinely finished and confirmed every target:
   *   - terminal status
   *   - per-target outcomes attached by the agent
   *   - every target reports success
   *
   * Partial syncs (some targets still failing) are left alone — the existing
   * check state is at least as truthful, and "I tried and some are still
   * behind" is exactly the moment to wait for the next real check rather
   * than rewrite the recorded verdict.
   */
  async updateFromSync(job) {
    if (!job || !job.vmId) return false;
    if (!TERMINAL.includes(job.status)) return false;
    if (job.status !== 'completed') return false;
    if (!Array.isArray(job.offsiteResults) || job.offsiteResults.length === 0) return false;

    const allOk = job.offsiteResults.every(r => r && (r.status === 'success' || r.status === 'synced'));
    if (!allOk) return false;

    let results;
    try {
      results = await this.getResults();
    } catch (err) {
      console.error(`[ReplicationCheck] Could not load results to update from sync: ${err.message}`);
      return false;
    }
    if (!results || !Array.isArray(results.vms)) {
      results = { startedAt: null, finishedAt: null, checked: 0, vms: [] };
    }

    // A VM the last check never saw (just synced by hand, or just configured)
    // gets its row from this sync, instead of staying "not checked" until the
    // next check happens to run.
    let idx = results.vms.findIndex(v => v && v.vmId === job.vmId);
    if (idx < 0) {
      results.vms.push({
        vmId: job.vmId,
        vmName: job.vmName,
        backupHostId: job.backupHostId,
        backupHostName: job.backupHostName,
        scheduleId: job.scheduleId || null,
        targets: (job.offsiteTargets || []).map(t => ({
          ip: t.ip, path: t.path,
          offsiteHostId: t.offsiteHostId, offsiteHostName: t.offsiteHostName,
          offsitePoolId: t.offsitePoolId, offsitePoolName: t.offsitePoolName,
        })),
      });
      idx = results.vms.length - 1;
      results.checked = (results.checked || 0) + 1;
    }

    const prev = results.vms[idx];
    const checkedAt = job.endTime || new Date().toISOString();

    // The sync's per-target results only carry IP and pool path. Fold them
    // back into the same per-host shape the check itself emits so the panel
    // can keep rendering the same tooltip without a special case.
    const targetDetail = job.offsiteResults.map(r => {
      const orig = (prev.targets || []).find(t => t && t.ip === r.ip);
      return {
        ip: r.ip,
        path: r.poolPath || (orig && orig.path),
        offsiteHostId: orig && orig.offsiteHostId,
        offsiteHostName: orig && orig.offsiteHostName,
        offsitePoolId: orig && orig.offsitePoolId,
        offsitePoolName: orig && orig.offsitePoolName,
        state: 'in_sync',
        differences: 0,
        pendingRotations: 0,
      };
    });

    results.vms[idx] = {
      ...prev,
      state: 'in_sync',
      checkedAt,
      outOfSyncTargets: 0,
      unreachableTargets: 0,
      targetDetail,
      // The sync that the check had queued for this VM is now done — clear
      // the pointer so the panel stops implying follow-up is pending.
      syncJobId: undefined,
      syncNote: undefined,
      reason: undefined,
    };

    // Recompute the headline counts from the updated vms so the stat tiles
    // and the summary line agree with the row data.
    results.inSync = results.vms.filter(v => v.state === 'in_sync').length;
    results.outOfSync = results.vms.filter(v => v.state === 'out_of_sync').length;
    results.skipped = results.vms.filter(v => v.state === 'skipped').length;
    results.failed = results.vms.filter(v => v.state === 'error' || v.state === 'unreachable').length;
    results.sourceUnavailable = results.vms.filter(v => v.state === 'source_unavailable').length;

    await this._saveResults(results);

    if (this.io) {
      try { this.io.emit('offsite-check-updated', results); } catch (_) { /* ignore */ }
    }

    console.log(
      `[ReplicationCheck] Sync for ${job.vmName} confirmed all ${job.offsiteResults.length} target(s); ` +
      `marked in_sync (was ${prev.state})`
    );
    return true;
  }

  getStatus() {
    return {
      running: this.running,
      lastRunAt: this.lastRunAt,
      intervalMs: this.intervalMs,
    };
  }
}

const instance = new ReplicationCheckService();
// The predicate is exported alongside the service so offsiteJobService can
// share it. Attached to the instance because the module's default export is
// the singleton, and a second named export would not survive `require(...)`
// destructuring the way callers already use it.
instance.replicationEnabled = replicationEnabled;
module.exports = instance;
module.exports.replicationEnabled = replicationEnabled;
