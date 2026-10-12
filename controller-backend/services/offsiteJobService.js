const { v4: uuidv4 } = require('uuid');
const {
  getOffsiteJobs,
  saveOffsiteJobs,
  updateOffsiteJobs,
  getBackupSchedules,
  getVirtualMachines,
  getBackupHosts,
  getHypervisors,
  getStoragePools,
  getOffsiteHosts,
  appendLog,
} = require('./fileStorage');
const agentService = require('./agentService');
const { ingestOffsiteSyncResults } = require('./offsiteWarningService');
const rocketChatService = require('./rocketChatService');
const { agentSupports, MIN_AGENT_VERSION } = require('../config/agentCompatibility');

/**
 * Offsite replication jobs.
 *
 * A replication job is not a backup and is deliberately not stored as one. It
 * has no method, no hypervisor and no retention; it covers a whole VM directory
 * rather than one schedule's output; and its failure means "the copy is behind",
 * not "there is no backup". It lives in offsite-jobs.json with its own
 * lifecycle so none of the backup reporting has to learn about it.
 *
 * Statuses:
 *   queued     waiting for a slot on its backup host
 *   running    the agent is transferring
 *   completed  every target verified against the source
 *   failed     at least one target could not be brought into line
 *   busy       the agent already had a sync running for this VM; nothing done
 *   cancelled  stopped by an operator
 *   unsupported  the agent predates the split and has no offsite endpoint
 */

const TERMINAL = ['completed', 'failed', 'cancelled', 'busy', 'unsupported'];
const ACTIVE = ['queued', 'running'];

// Jobs kept per VM before the oldest are dropped. Replication runs at least
// once per backup, so this is what stops the file growing without bound.
const HISTORY_PER_VM = 40;

class OffsiteJobService {
  constructor() {
    this.io = null;
    // Set while a drain is in flight, so several completions finishing at once
    // cannot each start the same queued job.
    this._draining = false;
    // Serialises requestSync. Its coalescing check is a read-modify-write over
    // offsite-jobs.json, and every step between the read and the save is an
    // await — so two requests arriving in the same tick (a backup completion
    // and the replication check, say) would BOTH read a file with no active job
    // for the VM and BOTH create one. The agent's per-VM lock then catches the
    // duplicate and it lands as 'busy', which is a lock icon in the history for
    // work that was never needed. One chain, so the check and the save cannot
    // be interleaved.
    this._requestChain = Promise.resolve();
  }

  /**
   * Run `fn` after every earlier caller has finished. Rejections do not break
   * the chain for the callers behind them.
   */
  _serialize(fn) {
    const run = this._requestChain.then(fn, fn);
    this._requestChain = run.then(() => {}, () => {});
    return run;
  }

  init(io) {
    this.io = io;
  }

  _emit(event, payload) {
    if (this.io) {
      try { this.io.emit(event, payload); } catch (_) { /* never break on socket errors */ }
    }
  }

  /**
   * Re-queue syncs that were refused because the agent was too old, once that
   * agent can actually do the work.
   *
   * Without this an operator who updates an agent is left with a wall of
   * "Agent too old" rows describing a state that is no longer true, and — far
   * worse — a set of VMs whose data genuinely never reached the offsite hosts,
   * with nothing scheduled to put that right. Each host is probed once, not
   * once per job, and only hosts that now pass the compatibility check have
   * their jobs revived.
   *
   * Runs at startup and at the top of every replication check, which is where
   * a newly-updated agent is first noticed.
   */
  async rearmUnsupportedJobs() {
    const jobs = await getOffsiteJobs();
    const stranded = jobs.filter(j => j.status === 'unsupported');
    if (stranded.length === 0) return { checked: 0, requeued: 0 };

    const hosts = await getBackupHosts();
    const byHost = new Map();
    for (const job of stranded) {
      if (!byHost.has(job.backupHostId)) byHost.set(job.backupHostId, []);
      byHost.get(job.backupHostId).push(job);
    }

    let requeued = 0;
    for (const [hostId, hostJobs] of byHost) {
      const host = hosts.find(h => h.id === hostId);
      if (!host || host.status !== 'online') continue;

      let url = host.url;
      if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'http://' + url;

      const probe = await this._probeOffsiteSupport(url);
      if (!probe.supported) continue;

      console.log(
        `[OffsiteJobs] ${host.name} now supports replication (${probe.reason}) — ` +
        `re-queueing ${hostJobs.length} sync(s) that it had refused`
      );

      for (const job of hostJobs) {
        // A newer sync for the same VM may already have run since; that one
        // covers this VM's whole directory, so reviving this job would only
        // duplicate it.
        const superseded = jobs.some(j =>
          j.vmId === job.vmId
          && j.id !== job.id
          && new Date(j.createdAt) > new Date(job.createdAt)
          && ['queued', 'running', 'completed'].includes(j.status));
        if (superseded) continue;

        await this._patch(job.id, {
          status: 'queued',
          progress: 0,
          progressText: 'Re-queued — the agent now supports replication',
          error: null,
          exitCode: null,
          startTime: null,
          endTime: null,
          attemptNumber: (job.attemptNumber || 1) + 1,
          trigger: 'retry',
        });
        await appendLog(
          job.id,
          `\n=== RE-QUEUED: ${host.name} now supports offsite replication (${probe.reason}) ===`
        );
        requeued++;
      }

      await this.drain(host.id);
    }

    return { checked: stranded.length, requeued };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Creating work
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Queue a sync for one VM, unless one is already pending or running for it.
   *
   * Coalescing matters more here than it does for backups. The transfer covers
   * the whole VM directory, so a sync started after three backups have finished
   * replicates all three; queuing one job per finished backup would mean two of
   * the three doing no useful work while holding a slot. An existing queued job
   * already covers whatever has landed since.
   *
   * @param {object} opts
   * @param {string} opts.vmId
   * @param {string} [opts.scheduleId]  Where the offsite targets come from.
   * @param {string} opts.trigger       'backup' | 'manual' | 'check' | 'retry'
   * @param {Array}  [opts.offsiteTargets] Destinations that do not come from a
   *   schedule: a one-off "Backup now" with offsite ticked, or a manual sync
   *   picked on the replication page. `{ offsiteHostId, offsitePoolId }` each,
   *   offsitePoolId null for a legacy host-level target. Merged with whatever
   *   the VM's schedules already replicate to.
   * @param {string} [opts.storagePoolId] The source pool, when the caller knows
   *   it (the backup it came from). Otherwise inferred from the schedule.
   * @returns {Promise<{created: boolean, job?: object, reason?: string}>}
   */
  async requestSync(opts) {
    return this._serialize(() => this._requestSync(opts));
  }

  async _requestSync({
    vmId, scheduleId = null, trigger = 'manual', triggeredByJobId = null,
    offsiteTargets = null, storagePoolId = null,
  }) {
    const explicitTargets = this._explicitTargets(offsiteTargets);
    const resolved = await this._resolveContext(vmId, scheduleId, { explicitTargets, storagePoolId });
    if (!resolved.ok) return { created: false, reason: resolved.reason };

    const { vm, host, hypervisor, pool, schedule, targets, encoded } = resolved;

    if (encoded.length === 0) {
      return { created: false, reason: 'This VM has no offsite target configured.' };
    }

    const jobs = await getOffsiteJobs();
    const existing = jobs.find(j => j.vmId === vmId && ACTIVE.includes(j.status));
    if (existing) {
      if (existing.status === 'queued') {
        // Nothing to arrange. A job that has not started yet will read the
        // directory when it does, so it already covers whatever landed since.
        return {
          created: false,
          reason: `An offsite sync for ${vm.name} is already queued.`,
          job: existing,
        };
      }

      // A transfer is already under way, and it may be past the directory this
      // new data landed in — rsync walks the tree once. So the request is not
      // dropped, it is remembered: when the running sync finishes, a follow-up
      // is queued for it. Without this, data that arrived mid-transfer would
      // wait for the next backup or the daily replication check.
      //
      // One flag, not a counter: a single follow-up covers any amount of new
      // data, because the transfer is of the whole directory.
      //
      // Explicit targets are remembered with it: they belong to no schedule, so
      // a follow-up that re-resolved from schedules alone would drop them.
      const pendingTargets = this._mergeExplicit(existing.followUpTargets, explicitTargets);
      if (!existing.followUpRequested || pendingTargets.length !== (existing.followUpTargets || []).length) {
        await this._patch(existing.id, {
          followUpRequested: true,
          followUpReason: existing.followUpReason || trigger,
          followUpTargets: pendingTargets,
          followUpStoragePoolId: existing.followUpStoragePoolId || storagePoolId || null,
        });
      }
      return {
        created: false,
        reason: `An offsite sync for ${vm.name} is already running; another will follow it.`,
        job: existing,
        followUpQueued: true,
      };
    }

    const job = {
      id: uuidv4(),
      vmId: vm.id,
      vmName: vm.name,
      backupHostId: host.id,
      backupHostName: host.name,
      hypervisorId: hypervisor ? hypervisor.id : (vm.hypervisorId || null),
      hypervisorName: hypervisor ? hypervisor.name : null,
      storagePoolId: pool.id,
      storagePoolPath: pool.path,
      scheduleId: schedule ? schedule.id : null,
      // What produced this job, so the history can say why it ran.
      trigger,
      // The backup job whose completion asked for it, when there was one. This
      // is the link back: a backup's history entry can show whether its data
      // reached the offsite hosts, without the backup job itself waiting for it.
      triggeredByJobId,
      offsiteTargets: targets,
      // The non-schedule destinations this job was asked for, kept so a
      // follow-up can ask for them again.
      explicitTargets,
      offsiteHosts: encoded,
      offsiteRetryAttempts: (schedule && schedule.offsiteRetryAttempts) || 3,
      offsiteRetryBackoffSeconds: (schedule && schedule.offsiteRetryBackoffSeconds) || 15,
      offsiteRsyncTimeoutSeconds: (schedule && schedule.offsiteRsyncTimeoutSeconds) || 1800,
      diskUsageThreshold: pool.diskUsageThreshold ?? 80,
      status: 'queued',
      progress: 0,
      progressText: 'Queued',
      createdAt: new Date().toISOString(),
      startTime: null,
      endTime: null,
      error: null,
      offsiteResults: null,
      attemptNumber: 1,
    };

    jobs.push(job);
    await saveOffsiteJobs(this._trimHistory(jobs));
    await appendLog(job.id, `Offsite sync queued for ${vm.name} (${trigger}) → ${encoded.join(', ')}`);
    this._emit('offsite-job-created', job);

    // Try to start it right away; if the host is at its limit it stays queued.
    await this.drain(host.id);

    const fresh = (await getOffsiteJobs()).find(j => j.id === job.id) || job;
    return { created: true, job: fresh };
  }

  /**
   * Resolve everything a sync needs, from a VM and (optionally) a schedule.
   *
   * Offsite targets are configured per schedule, so a VM with several schedules
   * can have several sets. The transfer is VM-wide, so they are merged and
   * de-duplicated by host+pool: syncing to a target twice in one pass would be
   * pointless work at best and two writers on one destination at worst.
   */
  async _resolveContext(vmId, scheduleId, { explicitTargets = [], storagePoolId = null } = {}) {
    const [vms, hosts, hypervisors, pools, schedules, offsiteHosts, manual] = await Promise.all([
      getVirtualMachines(), getBackupHosts(), getHypervisors(), getStoragePools(),
      getBackupSchedules(), getOffsiteHosts(), this.manualReplicas(),
    ]);


    const vm = vms.find(v => v.id === vmId);
    if (!vm) return { ok: false, reason: `VM ${vmId} not found` };

    const host = hosts.find(h => h.id === vm.backupHostId);
    if (!host) return { ok: false, reason: `Backup host for ${vm.name} not found` };

    const hypervisor = hypervisors.find(h => h.id === vm.hypervisorId) || null;

    // A schedule replicates only when the operator has not switched offsite off
    // AND it still has somewhere to send to. Shared with the replication check
    // so the two can never disagree about whether a VM replicates.
    const { replicationEnabled } = require('./replicationCheckService');
    const vmSchedules = schedules.filter(s => replicationEnabled(s) && s.vmId === vmId);

    // A VM synced by hand and replicated by no schedule keeps the destinations
    // it was last sent to, so a request that names none (the panel's Sync
    // button, the check's auto-sync, a follow-up) still goes where the
    // operator chose. Only then: a VM that has an offsite schedule replicates
    // where its schedule says, and a one-off manual sync does not add to that.
    const remembered = manual.get(vmId);
    if (remembered && vmSchedules.length === 0 && explicitTargets.length === 0) {
      explicitTargets = remembered.offsiteTargets;
      storagePoolId = storagePoolId || remembered.storagePoolId;
    }
    // An explicitly named schedule still has to pass the same test. It used to
    // be looked up in the unfiltered list, so a caller passing the scheduleId of
    // a schedule whose offsite had been switched off would have its targets
    // merged in below and replicate anyway — the one path that could resurrect
    // a VM the operator had just unticked.
    const namedSchedule = scheduleId
      ? schedules.find(s => s.id === scheduleId && replicationEnabled(s))
      : null;
    const schedule = namedSchedule
      || vmSchedules.find(s => this._scheduleHasTargets(s))
      || vmSchedules[0]
      || null;

    // Pool: the schedule's if we have one, otherwise the VM's only pool on this
    // host. The transfer needs the source path, and every schedule of a VM
    // writes into the same VM directory under that pool.
    let pool = null;
    if (storagePoolId) {
      pool = pools.find(p => p.id === storagePoolId && p.backupHostId === host.id) || null;
    }
    if (!pool && schedule && schedule.storagePoolId) {
      pool = pools.find(p => p.id === schedule.storagePoolId && p.backupHostId === host.id);
    }
    if (!pool) {
      const hostPools = pools.filter(p => p.backupHostId === host.id);
      pool = hostPools.length === 1 ? hostPools[0] : null;
    }
    if (!pool) {
      return { ok: false, reason: `Could not determine the storage pool holding ${vm.name}'s backups` };
    }

    // Merge the targets of every offsite-enabled schedule of this VM.
    const seen = new Set();
    const targets = [];
    // Explicit targets are shaped like schedules so they resolve through the
    // same code: per-pool ones and legacy host-level ones separately, because
    // _targetsOf reads one shape or the other, never both.
    const sources = schedule ? [schedule, ...vmSchedules.filter(x => x.id !== schedule.id)] : [...vmSchedules];
    if (explicitTargets.length > 0) {
      sources.push({ offsiteTargets: explicitTargets.filter(t => t.offsitePoolId) });
      sources.push({ offsiteHostIds: explicitTargets.filter(t => !t.offsitePoolId).map(t => t.offsiteHostId) });
    }
    for (const s of sources) {
      for (const t of this._targetsOf(s, offsiteHosts)) {
        const key = `${t.offsiteHostId}::${t.offsitePoolId || t.path || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        targets.push(t);
      }
    }

    const encoded = targets.map(t => {
      if (!t.path) return t.ip;
      const base = `${t.ip}:${t.path}`;
      return t.diskUsageThreshold != null ? `${base}:${t.diskUsageThreshold}` : base;
    });

    return { ok: true, vm, host, hypervisor, pool, schedule, targets, encoded };
  }

  /** Normalise caller-supplied targets to `{ offsiteHostId, offsitePoolId }`. */
  _explicitTargets(list) {
    if (!Array.isArray(list)) return [];
    return this._mergeExplicit([], list
      .filter(t => t && t.offsiteHostId)
      .map(t => ({ offsiteHostId: t.offsiteHostId, offsitePoolId: t.offsitePoolId || null })));
  }

  _mergeExplicit(a, b) {
    const out = [];
    const seen = new Set();
    for (const t of [...(a || []), ...(b || [])]) {
      const key = `${t.offsiteHostId}::${t.offsitePoolId || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
    return out;
  }

  /**
   * VMs replicated by hand, and where to.
   *
   * A sync started from "Sync a backup" (or after a one-off backup with offsite
   * ticked) names destinations no schedule holds. The latest such job per VM is
   * what that VM replicates to from then on, so the replication page can list
   * it, check it, and its Sync button and follow-ups know where to send.
   *
   * @returns {Promise<Map<string, {offsiteTargets: Array, storagePoolId: string|null}>>}
   */
  async manualReplicas(jobs = null) {
    const list = jobs || await getOffsiteJobs();
    const out = new Map();
    const sorted = [...list].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    for (const j of sorted) {
      if (!j || !j.vmId || !Array.isArray(j.explicitTargets) || j.explicitTargets.length === 0) continue;
      out.set(j.vmId, { offsiteTargets: j.explicitTargets, storagePoolId: j.storagePoolId || null });
    }
    return out;
  }

  _scheduleHasTargets(schedule) {
    return (Array.isArray(schedule.offsiteTargets) && schedule.offsiteTargets.length > 0)
      || (Array.isArray(schedule.offsiteHostIds) && schedule.offsiteHostIds.length > 0)
      || !!schedule.offsiteHostId;
  }

  /**
   * A schedule's offsite targets, in either shape.
   *
   * Mirrors schedulerService.resolveOffsiteTargets: the per-pool form is what
   * schedules carry now, the host-level form is what older ones carry.
   */
  _targetsOf(schedule, offsiteHosts) {
    if (!schedule) return [];
    const out = [];

    const perPool = Array.isArray(schedule.offsiteTargets) ? schedule.offsiteTargets : [];
    if (perPool.length > 0) {
      for (const t of perPool) {
        if (!t) continue;
        const host = offsiteHosts.find(h => h.id === t.offsiteHostId);
        if (!host) continue;
        const pool = (host.storagePools || []).find(p => p.id === t.offsitePoolId);
        if (!pool) continue;
        out.push({
          offsiteHostId: host.id,
          offsitePoolId: pool.id,
          offsiteHostName: host.name,
          offsitePoolName: pool.name || pool.path,
          ip: host.ip,
          path: pool.path || '',
          diskUsageThreshold: pool.diskUsageThreshold ?? 80,
        });
      }
      return out;
    }

    const legacyIds = Array.isArray(schedule.offsiteHostIds)
      ? schedule.offsiteHostIds
      : (schedule.offsiteHostId ? [schedule.offsiteHostId] : []);
    for (const id of legacyIds) {
      const host = offsiteHosts.find(h => h.id === id);
      if (!host) continue;
      out.push({
        offsiteHostId: host.id,
        offsitePoolId: null,
        offsiteHostName: host.name,
        offsitePoolName: host.backupPath || 'default',
        ip: host.ip,
        path: host.backupPath || '',
      });
    }
    return out;
  }

  // ───────────────────────────────────────────────────────────────────────
  // Starting work
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Start queued jobs on a host until its limit is reached.
   *
   * Replication borrows the host's configured backup concurrency as its number,
   * but counts separately: a transfer must never occupy a slot a backup needs —
   * that coupling is the thing this whole change exists to remove. In the normal
   * case (one sync per finished backup) nothing ever queues. The limit matters
   * when the replication check finds a dozen VMs behind at once and would
   * otherwise start a dozen transfers into the same link.
   */
  async drain(backupHostId = null) {
    if (this._draining) return;
    this._draining = true;
    try {
      const [jobs, hosts] = await Promise.all([getOffsiteJobs(), getBackupHosts()]);
      const queued = jobs.filter(j => j.status === 'queued'
        && (!backupHostId || j.backupHostId === backupHostId));
      if (queued.length === 0) return;

      // Oldest first, so a job that has been waiting does not starve.
      queued.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

      // One transfer per VM at a time. The agent enforces this with a per-VM
      // lock, but a second job started against that lock does nothing and
      // finishes 'busy' — an amber lock icon in the history for work that was
      // never needed. Starting only one keeps the duplicate queued, where the
      // real sync's completion can coalesce it away instead.
      const vmsBusy = new Set(
        jobs.filter(j => j.status === 'running').map(j => j.vmId)
      );

      for (const job of queued) {
        if (vmsBusy.has(job.vmId)) continue;
        const host = hosts.find(h => h.id === job.backupHostId);
        if (!host) {
          await this._finish(job.id, 'failed', { error: 'Backup host no longer exists' });
          continue;
        }
        if (host.status !== 'online') continue; // try again on the next drain

        const rawMax = host.maxConcurrentBackups;
        const max = (rawMax === undefined || rawMax === null) ? 20 : Number(rawMax);
        const unlimited = max === 0;
        const running = (await getOffsiteJobs())
          .filter(j => j.status === 'running' && j.backupHostId === host.id).length;
        if (!unlimited && running >= max) continue;

        await this._start(job, host);
        vmsBusy.add(job.vmId);
      }
    } finally {
      this._draining = false;
    }
  }

  async _start(job, host) {
    let url = host.url;
    if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'http://' + url;

    await this._patch(job.id, {
      status: 'running',
      startTime: new Date().toISOString(),
      progressText: 'Starting offsite sync...',
    });

    try {
      await agentService.triggerOffsiteSync(url, {
        jobId: job.id,
        vmName: job.vmName,
        storagePoolPath: job.storagePoolPath,
        offsiteHosts: job.offsiteHosts,
        offsiteRetryAttempts: job.offsiteRetryAttempts,
        offsiteRetryBackoffSeconds: job.offsiteRetryBackoffSeconds,
        offsiteRsyncTimeoutSeconds: job.offsiteRsyncTimeoutSeconds,
        diskUsageThreshold: job.diskUsageThreshold,
        resetSourceGuard: job.resetSourceGuard === true,
      });
      await appendLog(job.id, `Offsite sync started on ${host.name}`);
      if (job.resetSourceGuard) {
        await appendLog(job.id, 'Source-filesystem baseline re-recorded at the operator\'s request.');
        await this._patch(job.id, { resetSourceGuard: false });
      }
    } catch (err) {
      const status = err.response && err.response.status;
      if (status === 404) {
        // A 404 is NOT proof the agent is old. It is equally what you get from
        // a reverse proxy that does not forward /api/offsite, and from an agent
        // process still running pre-split code after the files were deployed
        // but before it was restarted. Telling an operator to update an agent
        // that is already current wastes their time and hides the real fault,
        // so ask the agent what it supports instead of guessing.
        const probe = await this._probeOffsiteSupport(url);

        if (probe.supported) {
          // The agent says it has the endpoint, yet the request 404'd. The
          // fault is between the controller and the agent process, not in the
          // agent's age. Failed (retryable) rather than unsupported — there is
          // nothing to update, and a retry after fixing the path will work.
          const message =
            `${host.name} advertises offsite replication (agent v${probe.version || 'unknown'}), ` +
            `but POST /api/offsite/sync returned 404. The agent itself is up to date — something ` +
            `between the controller and it is not forwarding that path. Check any reverse proxy ` +
            `in front of the agent, and that the running process was restarted after the deploy.`;
          await this._finish(job.id, 'failed', { error: message });
          await appendLog(job.id, `ERROR: ${message}`);
          console.error(`[OffsiteJobs] ${message}`);
          return;
        }

        if (probe.unreachable) {
          const message =
            `Could not start the offsite sync on ${host.name}: the sync endpoint returned 404 and ` +
            `the agent's health endpoint could not be reached either (${probe.error}). The agent ` +
            `may be down, or nothing is reaching it from here.`;
          await this._finish(job.id, 'failed', { error: message });
          await appendLog(job.id, `ERROR: ${message}`);
          console.error(`[OffsiteJobs] ${message}`);
          return;
        }

        // The agent answered and did not claim the capability: genuinely old.
        // It will never replicate anything — and its backups keep succeeding,
        // which makes this invisible unless it is said plainly.
        const message =
          `Agent on ${host.name} does not support offsite sync jobs — ${probe.reason}; ` +
          `${MIN_AGENT_VERSION.offsiteSync} or newer is required. ` +
          `Backups still run, but nothing is being replicated for VMs on this host ` +
          `until the agent is updated.`;
        await this._finish(job.id, 'unsupported', { error: message });
        await appendLog(job.id, `ERROR: ${message}`);
        console.error(`[OffsiteJobs] ${message}`);
        this._emit('offsite-agent-unsupported', {
          backupHostId: host.id, backupHostName: host.name, message,
        });

        // This one has to leave the panel. An agent that cannot replicate still
        // runs backups perfectly, so every other signal stays green while the
        // offsite copies quietly stop advancing — nobody finds out by looking.
        // Rate-limited to once an hour per host: a busy host would otherwise
        // announce it after every single backup.
        this._announceUnsupported(host, message);
        return;
      }
      await this._finish(job.id, 'failed', { error: `Could not start the offsite sync: ${err.message}` });
      await appendLog(job.id, `ERROR: could not start the offsite sync: ${err.message}`);
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Agent reports
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Apply an update posted by the agent.
   *
   * `busy` deserves a note: the agent found the script's VM lock already held,
   * so it did nothing at all. That is the lock working, not an incident — it
   * spends no retry budget, raises no warning, and the run that holds the lock
   * reports the real outcome.
   */
  async handleAgentUpdate(jobId, payload) {
    const jobs = await getOffsiteJobs();
    const job = jobs.find(j => j.id === jobId);
    if (!job) return { ok: false, reason: 'No such offsite job' };

    const { status, progress, progressText, error, exitCode, offsiteResults, offsiteProgress } = payload;

    // A verdict is delivered once. The agent can send a second one — two
    // session-poll ticks racing, a re-adopted monitor finding a session that
    // has just ended, a retried POST whose response was lost — and applying it
    // again would re-announce the outcome to RocketChat, re-record the
    // warnings, and queue a second follow-up sync for work already done.
    // Late progress is dropped for the same reason: it would move a finished
    // job back to a partial percentage.
    if (TERMINAL.includes(job.status)) {
      return { ok: true, reason: `Offsite job ${jobId} already finished as '${job.status}'` };
    }

    const patch = {};
    if (typeof progress === 'number') patch.progress = Math.max(0, Math.min(100, progress));
    if (progressText) patch.progressText = progressText;
    if (Array.isArray(offsiteResults) && offsiteResults.length > 0) patch.offsiteResults = offsiteResults;
    if (Array.isArray(offsiteProgress)) patch.offsiteProgress = offsiteProgress;
    if (exitCode !== undefined && exitCode !== null) patch.exitCode = exitCode;

    if (status === 'running') {
      patch.status = 'running';
      if (!job.startTime) patch.startTime = new Date().toISOString();
      await this._patch(jobId, patch);
      return { ok: true };
    }

    if (TERMINAL.includes(status)) {
      patch.status = status;
      patch.error = error || null;
      if (status === 'completed') patch.progress = 100;
      const finished = await this._finish(jobId, status, patch);
      // A slot just freed.
      await this.drain(job.backupHostId);
      await this._recordWarnings(finished || { ...job, ...patch });
      await this._announceOutcome(finished || { ...job, ...patch });
      await this._runFollowUp(finished || job);
      return { ok: true };
    }

    await this._patch(jobId, patch);
    return { ok: true };
  }

  /**
   * Start the sync that was asked for while this one was running.
   *
   * Backups do not wait for transfers any more, so a backup can finish in the
   * middle of one. Its data may be in a directory rsync has already walked
   * past, and rsync walks the tree once — so it is not covered by the run that
   * is in flight, and something has to pick it up. This is that something.
   *
   * Skipped after a `busy` outcome: that job never ran, so whatever asked for
   * the follow-up is still owed by the sync that actually holds the lock.
   */
  async _runFollowUp(job) {
    if (!job || !job.followUpRequested) return;
    if (job.status === 'busy') return;

    await this._patch(job.id, { followUpRequested: false, followUpTargets: [], followUpStoragePoolId: null });
    try {
      const result = await this.requestSync({
        vmId: job.vmId,
        scheduleId: job.scheduleId,
        trigger: job.followUpReason || 'backup',
        triggeredByJobId: job.triggeredByJobId || null,
        offsiteTargets: this._mergeExplicit(job.explicitTargets, job.followUpTargets),
        storagePoolId: job.followUpStoragePoolId || job.storagePoolId || null,
      });
      if (result.created) {
        console.log(`[OffsiteJobs] Follow-up sync queued for ${job.vmName} (data arrived mid-transfer)`);
      }
    } catch (err) {
      console.error(`[OffsiteJobs] Could not queue the follow-up sync for ${job.vmName}: ${err.message}`);
    }
  }

  /**
   * Put the per-target outcomes back onto the schedule.
   *
   * This is the link between a replication job and everything that already
   * understands offsite health: the schedule's offsiteWarnings list, the dedup
   * keys the notifications use, and the RocketChat incident board. A target
   * that failed adds (or refreshes) a warning naming the host and pool; a
   * target that later succeeds clears it, so replication recovers on its own
   * without anyone having to dismiss anything.
   *
   * The schedule is never disabled over a transient transfer problem — the
   * backups themselves are fine, only the copy is behind.
   *
   * A replication job carries the same fields the ingest expects
   * (`id`, `vmName`, `scheduleId`, `backupHostId`, `offsiteTargets`), which is
   * why it can reuse this untouched rather than growing a parallel path.
   */
  async _recordWarnings(job) {
    if (!job || !job.scheduleId) return;
    if (!Array.isArray(job.offsiteResults) || job.offsiteResults.length === 0) return;
    // `busy` means the agent did nothing at all — no target was attempted, so
    // there is no outcome to record for any of them.
    if (job.status === 'busy') return;

    try {
      await ingestOffsiteSyncResults(job, job.offsiteResults);
    } catch (err) {
      console.error(`[OffsiteJobs] Could not record warnings for ${job.id}: ${err.message}`);
    }
  }

  /**
   * Say something when the job as a whole failed.
   *
   * _recordWarnings covers the case where the sync ran and individual
   * destinations reported back — each failed target gets its own board line
   * naming it. This covers the case it cannot: the job never got far enough to
   * produce per-target results at all (refused by the source guard, could not
   * start, killed, timed out). Without this those failures were visible only in
   * the panel, which is the one place someone has to already be looking.
   *
   * Deliberately silent for:
   *  - `busy`      nothing ran; the sync holding the lock reports for itself
   *  - `cancelled` an operator did this on purpose
   *  - `unsupported` announced once per host by _announceUnsupported instead,
   *                  because it is a property of the host, not of this VM
   */
  async _announceOutcome(job) {
    if (!job || job.status !== 'failed') return;

    // Already reported per destination, by name — a second, vaguer line about
    // the same run would just be noise.
    const hadTargetResults = Array.isArray(job.offsiteResults)
      && job.offsiteResults.length > 0
      && !!job.scheduleId;
    if (hadTargetResults) return;

    try {
      rocketChatService.notifyOffsiteJobFailed(
        job.vmName,
        job.error || 'the replication job failed',
        job.scheduleId || null,
        job.backupHostId || null
      );
    } catch (err) {
      console.error(`[OffsiteJobs] Could not announce the failed sync for ${job.vmName}: ${err.message}`);
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Operator actions
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Retry a finished sync, the same way the backup history retries a backup.
   *
   * Nothing is reset at the destination: whatever already arrived stays, and
   * partially transferred files resume from their staging copies. So a retry
   * after a link failure sends the remainder, not the whole chain again.
   */
  async retry(jobId, { resetSourceGuard = false } = {}) {
    const jobs = await getOffsiteJobs();
    const job = jobs.find(j => j.id === jobId);
    if (!job) return { ok: false, reason: 'No such offsite job' };
    if (ACTIVE.includes(job.status)) return { ok: false, reason: 'That sync is still running' };

    const active = jobs.find(j => j.vmId === job.vmId && ACTIVE.includes(j.status));
    if (active) {
      return { ok: false, reason: `An offsite sync for ${job.vmName} is already ${active.status}.` };
    }

    await this._patch(jobId, {
      status: 'queued',
      progress: 0,
      progressText: 'Queued for retry',
      error: null,
      exitCode: null,
      endTime: null,
      startTime: null,
      attemptNumber: (job.attemptNumber || 1) + 1,
      trigger: 'retry',
      // Carried on the job, not held here, so it survives the wait for a slot.
      // Cleared once used, so it can never silently disarm a later retry.
      resetSourceGuard: resetSourceGuard === true,
    });
    await appendLog(jobId, `\n=== OFFSITE SYNC RETRY (attempt ${(job.attemptNumber || 1) + 1}) ===`);
    await this.drain(job.backupHostId);

    const fresh = (await getOffsiteJobs()).find(j => j.id === jobId);
    return { ok: true, job: fresh };
  }

  async cancel(jobId) {
    const jobs = await getOffsiteJobs();
    const job = jobs.find(j => j.id === jobId);
    if (!job) return { ok: false, reason: 'No such offsite job' };
    if (!ACTIVE.includes(job.status)) return { ok: false, reason: 'That sync is not running' };

    if (job.status === 'queued') {
      await this._finish(jobId, 'cancelled', { error: null, progressText: 'Cancelled before it started' });
      return { ok: true };
    }

    const hosts = await getBackupHosts();
    const host = hosts.find(h => h.id === job.backupHostId);
    if (host) {
      let url = host.url;
      if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'http://' + url;
      try {
        await agentService.cancelOffsiteSync(url, jobId);
      } catch (err) {
        console.warn(`[OffsiteJobs] Agent could not cancel ${jobId}: ${err.message}`);
      }
    }
    await this._finish(jobId, 'cancelled', {
      progressText: 'Cancelled. Transferred data is kept and the next sync resumes from it.',
    });
    await this.drain(job.backupHostId);
    return { ok: true };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Internals
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Ask an agent whether it can actually replicate, rather than inferring it.
   *
   * Returns one of three answers, and the caller treats each differently:
   *   { supported: true }    the endpoint exists in that process — a 404 came
   *                          from something in between, not from the agent
   *   { supported: false }   the agent answered and does not claim it: old
   *   { unreachable: true }  no usable answer; say so instead of accusing it
   *
   * An agent that predates the capabilities block reports no `capabilities`
   * key at all, which reads as `supported: false` — exactly right, since that
   * is the same build that has no offsite endpoint.
   */
  async _probeOffsiteSupport(url) {
    try {
      const health = await agentService.healthCheck(url);
      if (!health || !health.success) {
        return { unreachable: true, error: (health && health.error) || 'no response' };
      }
      // One place decides what "compatible" means, for both the capability
      // flag and the version fallback — see config/agentCompatibility.js.
      const verdict = agentSupports(health.data, 'offsiteSync');
      return { supported: verdict.supported, version: verdict.version, reason: verdict.reason };
    } catch (err) {
      return { unreachable: true, error: err.message };
    }
  }

  /** Once an hour per host, so a busy host does not repeat it after every backup. */
  _announceUnsupported(host, message) {
    if (!this._unsupportedAnnounced) this._unsupportedAnnounced = new Map();
    const last = this._unsupportedAnnounced.get(host.id) || 0;
    if (Date.now() - last < 60 * 60 * 1000) return;
    this._unsupportedAnnounced.set(host.id, Date.now());

    try {
      // Onto the daily incident board like every other backup-health issue,
      // rather than a standalone message — an operator reading the board
      // should not have to also remember to check for loose alerts elsewhere.
      rocketChatService.notifyOffsiteUnsupported(
        host.name,
        'agent too old for offsite replication — nothing is being replicated from this host',
        host.id
      );
    } catch (err) {
      console.error(`[OffsiteJobs] Could not announce the unsupported agent: ${err.message}`);
    }
  }

  async _patch(jobId, patch) {
    const { data } = await updateOffsiteJobs((jobs) => {
      const job = jobs.find(j => j.id === jobId);
      if (!job) return false;
      Object.assign(job, patch);
      job.updatedAt = new Date().toISOString();
    });
    const job = (data || []).find(j => j.id === jobId);
    if (job) this._emit('offsite-job-updated', job);
    return job;
  }

  async _finish(jobId, status, patch = {}) {
    const job = await this._patch(jobId, {
      ...patch,
      status,
      endTime: new Date().toISOString(),
    });
    if (job) {
      this._emit('offsite-job-finished', job);
      // A successful sync is direct evidence that the destination now matches
      // the source, so refresh the replication-check verdict for this VM
      // without waiting for the next scheduled check. Lazy-required to avoid
      // a load-order cycle with replicationCheckService.
      if (status === 'completed') {
        try {
          // Called on the instance: destructuring it off lost `this`, so every
          // call threw inside getResults() and the panel never moved.
          await require('./replicationCheckService').updateFromSync(job);
        } catch (err) {
          console.error(`[OffsiteJobs] Could not refresh replication-check from sync ${jobId}: ${err.message}`);
        }
      }
    }
    return job;
  }

  /** Keep the newest HISTORY_PER_VM finished jobs per VM; active jobs always stay. */
  _trimHistory(jobs) {
    const byVm = new Map();
    for (const job of jobs) {
      if (!byVm.has(job.vmId)) byVm.set(job.vmId, []);
      byVm.get(job.vmId).push(job);
    }
    const keep = [];
    for (const list of byVm.values()) {
      const active = list.filter(j => ACTIVE.includes(j.status));
      const done = list.filter(j => !ACTIVE.includes(j.status))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, HISTORY_PER_VM);
      keep.push(...active, ...done);
    }
    return keep;
  }
}

module.exports = new OffsiteJobService();
