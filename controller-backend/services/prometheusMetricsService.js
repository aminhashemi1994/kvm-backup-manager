/**
 * Prometheus metrics for Grafana.
 *
 * Exposes the platform's state in the Prometheus text exposition format at
 * GET /metrics, so the monitoring team can build dashboards and write their own
 * alert rules without touching this codebase.
 *
 * ---------------------------------------------------------------------------
 * ON TIMESTAMPS
 * ---------------------------------------------------------------------------
 * Every point in time is exposed as a Unix-epoch SECONDS gauge named
 * `*_timestamp_seconds` — never as a per-sample timestamp on the exposition
 * line. Two reasons, and they both matter in production:
 *
 *   1. Prometheus REJECTS samples whose explicit timestamp is far in the past
 *      (out-of-order / too-old). A backup that last succeeded 30 hours ago is
 *      exactly the case we care most about, and stamping the line with that
 *      time would make the series silently disappear at the moment it became
 *      interesting.
 *   2. Explicit timestamps disable staleness handling, so a VM deleted from
 *      the fleet would keep returning its last value forever.
 *
 * A `_timestamp_seconds` gauge is the convention the ecosystem expects
 * (`node_boot_time_seconds`, `ssl_cert_not_after`). In Grafana:
 *
 *     time() - bm_vm_backup_last_success_timestamp_seconds     -> age in seconds
 *
 * Where a value is a cached snapshot rather than live, its own freshness is
 * published alongside it (`*_updated_timestamp_seconds`), so a panel can grey
 * out data that has stopped being collected instead of showing it as current.
 *
 * ---------------------------------------------------------------------------
 * ON CARDINALITY
 * ---------------------------------------------------------------------------
 * Labels are bounded by the size of the fleet: vm, schedule, backup_host,
 * hypervisor, offsite_host, pool, method, result. Never job id, never an error
 * string, never a timestamp — those are unbounded and would eventually take
 * Prometheus down. `emit()` is the single choke point; keep it that way.
 */

const os = require('os');
const {
  getBackupJobs,
  getBackupSchedules,
  getVirtualMachines,
  getBackupHosts,
  getHypervisors,
  getStoragePools,
  getOffsiteHosts,
  getRestoreJobs,
} = require('./fileStorage');
const remoteMetricsService = require('./remoteMetricsService');
const certificateMonitorService = require('./certificateMonitorService');

// One snapshot per scrape is shared by every metric; this caps how often the
// JSON files are re-read when several Prometheus servers (or a human with
// curl) scrape at once. Well below any sane scrape interval.
const SNAPSHOT_TTL_MS = 10 * 1000;

// A run that has not reported progress for this long is exposed as stuck.
// Mirrors monitoringService.stuckInactivityThreshold — keep them in step.
const STUCK_INACTIVITY_MS = 60 * 60 * 1000;

const NS = 'bm'; // backup manager

// ---------------------------------------------------------------------------
// Status encodings.
//
// Grafana renders these through a value-mapping, which is why they are small
// integers rather than a label per state: `bm_vm_backup_last_status{state="x"}`
// would multiply every VM's series by the number of states and make "what is
// this VM doing right now" a query instead of a lookup.
// ---------------------------------------------------------------------------
const BACKUP_STATUS_CODE = {
  completed: 0,
  failed: 1,
  skipped: 2,
  rejected: 3,
  running: 4,
  queued: 5,
  cancelled: 6,
  retrying: 7,
};

const OFFSITE_STATUS_CODE = {
  completed: 0,
  partial: 1,
  failed: 2,
  running: 3,
  retrying: 4,
  unknown: 5,
};

/** Terminal states — a run that will not change again. */
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'skipped', 'rejected']);

// ---------------------------------------------------------------------------
// Exposition-format helpers
// ---------------------------------------------------------------------------

/**
 * Some VM names carry a generated prefix, e.g.
 * "20250426-123240539358103-87_cando-neobanksignoz-1-prod-site2.psg.network".
 * Strip it so dashboards show the real name. Anchored to the
 * "<6-8 digit date>-<digits>[-<digits>]_" shape (the date is not always
 * zero-padded, e.g. "2025928-627898700694863_") rather than "everything before the
 * first _", so ordinary names containing underscores are left alone. Applied
 * to every `vm` label in emit(), so joins between metrics still line up.
 */
const VM_NAME_PREFIX = /^\d{6,8}-\d+(?:-\d+)?_/;
function displayVmName(name) {
  return String(name).replace(VM_NAME_PREFIX, '');
}

/**
 * Backup host names read like "Backup Server Site2 (HV85)"; the short
 * identifier in parentheses is the stable, readable one. Names without a
 * trailing "(...)" are left alone.
 */
function displayHostName(name) {
  const m = String(name).match(/\(([^()]+)\)\s*$/);
  return m ? m[1] : String(name);
}

/** Per-label display transforms applied in MetricWriter.emit(). */
function displayLabelValue(key, value) {
  if (key === 'vm') return displayVmName(value);
  if (key === 'backup_host') return displayHostName(value);
  return value;
}

/** Escape a label VALUE per the exposition format: backslash, quote, newline. */
function escapeLabelValue(v) {
  return String(v)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

/** Escape HELP text: backslash and newline only (quotes are literal there). */
function escapeHelp(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

/**
 * Accumulates metric families and renders them.
 *
 * Samples are grouped under their family so the output carries exactly one
 * HELP/TYPE pair per metric name with all of its series beneath it. Prometheus
 * tolerates interleaved families, but Grafana's metric browser and every
 * human reading `curl /metrics` do not.
 */
class MetricWriter {
  constructor() {
    this.families = new Map(); // name -> { help, type, samples: [], seen: Set }
    this.duplicates = [];      // series keys dropped because they were emitted twice
  }

  family(name, type, help) {
    if (!this.families.has(name)) {
      this.families.set(name, { help, type, samples: [], seen: new Set() });
    }
    return this.families.get(name);
  }

  /**
   * Record one sample. Non-finite values (null, undefined, NaN — an absent
   * measurement) are DROPPED rather than written as 0: a missing disk reading
   * and a genuinely empty disk must not look identical on a dashboard.
   */
  emit(name, labels, value, type, help) {
    // null/undefined/'' mean "no measurement" and must be dropped, not
    // coerced: Number(null) is 0, which would publish a VM that has never
    // been backed up as having last succeeded at the Unix epoch — the most
    // alarming possible reading of "we have no data".
    if (value === null || value === undefined || value === '') return;
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num)) return;

    const fam = this.family(name, type, help);
    const pairs = Object.entries(labels || {})
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}="${escapeLabelValue(displayLabelValue(k, v))}"`);

    // The same name+labels twice is invalid exposition: Prometheus rejects the
    // duplicate sample and may fail the whole scrape. It means two records in
    // the data collapse to one label set (e.g. one hypervisor registered under
    // two backup hosts). Keep the first, drop the rest, and report it.
    const series = pairs.length > 0 ? `${name}{${pairs.join(',')}}` : name;
    if (fam.seen.has(series)) {
      this.duplicates.push(series);
      return;
    }
    fam.seen.add(series);
    fam.samples.push(`${series} ${num}`);
  }

  gauge(name, labels, value, help) {
    this.emit(name, labels, value, 'gauge', help);
  }

  counter(name, labels, value, help) {
    this.emit(name, labels, value, 'counter', help);
  }

  render() {
    const out = [];
    for (const [name, fam] of this.families) {
      if (fam.samples.length === 0) continue;
      if (fam.help) out.push(`# HELP ${name} ${escapeHelp(fam.help)}`);
      out.push(`# TYPE ${name} ${fam.type}`);
      out.push(...fam.samples);
    }
    // The exposition format requires a trailing newline.
    return out.join('\n') + '\n';
  }
}

// ---------------------------------------------------------------------------
// Small conversions
// ---------------------------------------------------------------------------

/** ISO string (or Date) -> Unix seconds, or null when unparseable/absent. */
function unixSeconds(value) {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

/** The agents report disk sizes in whole GiB; Prometheus convention is bytes. */
const GIB = 1024 ** 3;
function gibToBytes(gb) {
  const n = Number(gb);
  return Number.isFinite(n) ? n * GIB : null;
}

/**
 * How often this schedule is expected to produce a backup, in seconds.
 *
 * This is the denominator for every freshness question the monitoring team
 * will ask ("is this VM overdue?"), which is why it is published rather than
 * hard-coded into their alert rules: change a schedule here and their alert
 * follows automatically.
 *
 * Cron expressions are not evaluated — a cron cadence can be arbitrary and a
 * wrong number is worse than no number. Those schedules simply omit the
 * metric, and the monitoring team can alert on absolute age instead.
 */
function expectedIntervalSeconds(schedule) {
  if (!schedule) return null;
  switch (schedule.scheduleType) {
    case 'daily':
      return 86400;
    case 'weekly':
      return 7 * 86400;
    case 'monthly':
      return 30 * 86400;
    case 'interval': {
      const value = Number(schedule.intervalValue);
      if (!Number.isFinite(value) || value <= 0) return null;
      const unit = String(schedule.intervalUnit || 'hours').toLowerCase();
      const perUnit = unit.startsWith('min') ? 60 : unit.startsWith('day') ? 86400 : 3600;
      return value * perUnit;
    }
    default:
      // 'cron', 'custom-days', 'once' — no single meaningful cadence.
      return null;
  }
}

// ---------------------------------------------------------------------------
// Cumulative counters.
//
// These are incremented in-process as jobs finish, NOT recomputed from the job
// history file. History gets pruned, and a counter that goes backwards breaks
// every rate()/increase() query built on top of it. They reset to zero when the
// controller restarts, which is normal and which Prometheus handles natively.
//
// `bm_controller_start_timestamp_seconds` is published so a rate() spanning a
// restart can be explained rather than mistaken for a data loss.
// ---------------------------------------------------------------------------
class CounterStore {
  constructor() {
    this.values = new Map(); // metricName -> Map(labelKey -> { labels, value })
  }

  add(name, labels, delta = 1) {
    if (!Number.isFinite(delta)) return;
    if (!this.values.has(name)) this.values.set(name, new Map());
    const series = this.values.get(name);
    const key = JSON.stringify(labels);
    const existing = series.get(key);
    if (existing) existing.value += delta;
    else series.set(key, { labels, value: delta });
  }

  writeTo(writer, name, help) {
    const series = this.values.get(name);
    if (!series) return;
    for (const { labels, value } of series.values()) {
      writer.counter(name, labels, value, help);
    }
  }
}

class PrometheusMetricsService {
  constructor() {
    this.counters = new CounterStore();
    this.startedAt = Date.now();
    this.snapshot = null;
    this.snapshotAt = 0;
    this.snapshotPromise = null;
    this.lastScrapeAt = null;
    this.lastScrapeDurationSeconds = null;
  }

  // -------------------------------------------------------------------------
  // Recording hooks — called from the routes as work finishes.
  // -------------------------------------------------------------------------

  /**
   * A backup run reached a terminal state.
   * @param {object} job the finalised job record
   */
  recordBackupFinished(job) {
    if (!job) return;
    const labels = {
      vm: job.vmName || 'unknown',
      backup_host: job.backupHostName || '',
      method: job.method || job.scheduleType || 'unknown',
      result: TERMINAL.has(job.status) ? job.status : 'unknown',
    };
    this.counters.add(`${NS}_backup_runs_total`, labels, 1);

    const start = Date.parse(job.startTime);
    const end = Date.parse(job.endTime || new Date().toISOString());
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      const durationLabels = { vm: labels.vm, backup_host: labels.backup_host };
      // Sum + count rather than a histogram: bucket boundaries that suit a
      // 40-second VM and a 14-hour VM do not exist, and an average per VM is
      // what the duration panel actually plots.
      this.counters.add(`${NS}_backup_duration_seconds_sum`, durationLabels, (end - start) / 1000);
      this.counters.add(`${NS}_backup_duration_seconds_count`, durationLabels, 1);
    }

    if (job.wasRetried) {
      this.counters.add(`${NS}_backup_retries_total`, { vm: labels.vm }, 1);
    }
  }

  /**
   * One offsite (rsync) replication outcome, per destination host.
   *
   * Called once per entry in the agent's offsiteResults, so "3 of 5 targets
   * failed" is visible per target rather than collapsed into one verdict.
   */
  recordOffsiteResult({ vmName, offsiteHost, result }) {
    const normalized = ['success', 'failed', 'skipped'].includes(result) ? result : 'unknown';
    this.counters.add(`${NS}_offsite_sync_results_total`, {
      vm: vmName || 'unknown',
      offsite_host: offsiteHost || 'unknown',
      result: normalized,
    }, 1);
  }

  /**
   * The whole-run replication verdict: completed / partial / failed.
   * This is the one the monitoring team alerts on — `partial` means some
   * copies of this VM exist offsite and some do not, which reads as success
   * on any dashboard that only counts failures.
   */
  recordOffsiteRunFinished({ vmName, status }) {
    const normalized = ['completed', 'partial', 'failed'].includes(status) ? status : 'unknown';
    this.counters.add(`${NS}_offsite_sync_runs_total`, {
      vm: vmName || 'unknown',
      result: normalized,
    }, 1);
  }

  /** A restore run reached a terminal state. */
  recordRestoreFinished({ vmName, status }) {
    const normalized = TERMINAL.has(status) ? status : 'unknown';
    this.counters.add(`${NS}_restore_runs_total`, {
      vm: vmName || 'unknown',
      result: normalized,
    }, 1);
  }

  // -------------------------------------------------------------------------
  // Snapshot
  // -------------------------------------------------------------------------

  /**
   * Read every source once. Concurrent scrapes share one in-flight read
   * (`snapshotPromise`) rather than each starting their own — otherwise two
   * Prometheus servers hitting the endpoint together would double the file IO
   * at exactly the moment the controller is busiest.
   */
  async getSnapshot() {
    const fresh = this.snapshot && Date.now() - this.snapshotAt < SNAPSHOT_TTL_MS;
    if (fresh) return this.snapshot;
    if (this.snapshotPromise) return this.snapshotPromise;

    this.snapshotPromise = (async () => {
      const [jobs, schedules, vms, hosts, hypervisors, pools, offsiteHosts, restoreJobs] =
        await Promise.all([
          getBackupJobs().catch(() => []),
          getBackupSchedules().catch(() => []),
          getVirtualMachines().catch(() => []),
          getBackupHosts().catch(() => []),
          getHypervisors().catch(() => []),
          getStoragePools().catch(() => []),
          getOffsiteHosts().catch(() => []),
          getRestoreJobs().catch(() => []),
        ]);

      const snapshot = {
        jobs: Array.isArray(jobs) ? jobs : [],
        schedules: Array.isArray(schedules) ? schedules : [],
        vms: Array.isArray(vms) ? vms : [],
        hosts: Array.isArray(hosts) ? hosts : [],
        hypervisors: Array.isArray(hypervisors) ? hypervisors : [],
        pools: Array.isArray(pools) ? pools : [],
        offsiteHosts: Array.isArray(offsiteHosts) ? offsiteHosts : [],
        restoreJobs: Array.isArray(restoreJobs) ? restoreJobs : [],
      };

      this.snapshot = snapshot;
      this.snapshotAt = Date.now();
      return snapshot;
    })().finally(() => {
      this.snapshotPromise = null;
    });

    return this.snapshotPromise;
  }

  // -------------------------------------------------------------------------
  // Collection
  // -------------------------------------------------------------------------

  async collect() {
    const startedAt = Date.now();
    const w = new MetricWriter();
    const snap = await this.getSnapshot();
    const nowSec = Math.floor(Date.now() / 1000);

    this.collectPlatform(w, snap, nowSec);
    this.collectVMs(w, snap, nowSec);
    this.collectBackupHosts(w, snap);
    this.collectHypervisors(w, snap);
    this.collectStorage(w, snap);
    this.collectOffsiteHosts(w, snap);
    this.collectCertificates(w);
    this.collectCounters(w);

    this.lastScrapeAt = Date.now();
    this.lastScrapeDurationSeconds = (this.lastScrapeAt - startedAt) / 1000;

    // Self-instrumentation, written last so it reflects this scrape. If the
    // scrape itself starts costing hundreds of milliseconds, that is a signal
    // the job history has outgrown a file read and needs an index.
    w.gauge(`${NS}_scrape_duration_seconds`, {}, this.lastScrapeDurationSeconds,
      'Time the controller spent building this /metrics response.');
    w.gauge(`${NS}_snapshot_age_seconds`, {}, (Date.now() - this.snapshotAt) / 1000,
      'Age of the cached data snapshot this response was rendered from.');
    w.gauge(`${NS}_scrape_duplicate_series_dropped`, {}, w.duplicates.length,
      'Series left out of this response because the data produced the same label set twice. Should be 0; above 0 means duplicate records in the data.');
    this.warnAboutDuplicates(w.duplicates);

    return w.render();
  }

  /** Log duplicate series at most once every 10 minutes, with a few examples. */
  warnAboutDuplicates(duplicates) {
    if (duplicates.length === 0) return;
    const now = Date.now();
    if (this.lastDuplicateWarnAt && now - this.lastDuplicateWarnAt < 10 * 60 * 1000) return;
    this.lastDuplicateWarnAt = now;
    const sample = [...new Set(duplicates)].slice(0, 3).join(' ; ');
    console.warn(`⚠ /metrics dropped ${duplicates.length} duplicate series (duplicate hypervisor/VM records?). e.g. ${sample}`);
  }

  /** Fleet-wide totals — the top row of any dashboard. */
  collectPlatform(w, snap, nowSec) {
    const { jobs, schedules, vms, hosts, hypervisors } = snap;

    w.gauge(`${NS}_build_info`, {
      version: process.env.APP_VERSION || 'unknown',
      node: process.version,
      hostname: os.hostname(),
    }, 1, 'Controller build information. Always 1; read the labels.');

    w.gauge(`${NS}_controller_start_timestamp_seconds`, {},
      Math.floor(this.startedAt / 1000),
      'When this controller process started. Counters reset at this point.');

    w.gauge(`${NS}_scrape_timestamp_seconds`, {}, nowSec,
      'Controller clock when this response was produced. Compare with the ' +
      'Prometheus server clock to detect drift between them.');

    const enabledSchedules = schedules.filter(s => s.enabled !== false);
    const protectedVmIds = new Set(enabledSchedules.map(s => s.vmId).filter(Boolean));

    w.gauge(`${NS}_vms_total`, {}, vms.length, 'Virtual machines known to the controller.');
    w.gauge(`${NS}_vms_protected_total`, {}, protectedVmIds.size,
      'VMs with at least one enabled backup schedule. The gap between this ' +
      'and bm_vms_total is unprotected capacity.');
    w.gauge(`${NS}_schedules_total`, {}, schedules.length, 'Backup schedules defined.');
    w.gauge(`${NS}_schedules_enabled_total`, {}, enabledSchedules.length,
      'Backup schedules currently enabled.');
    w.gauge(`${NS}_backup_hosts_total`, {}, hosts.length, 'Backup hosts registered.');
    w.gauge(`${NS}_backup_hosts_online_total`, {},
      hosts.filter(h => h.status === 'online').length, 'Backup hosts currently online.');
    w.gauge(`${NS}_hypervisors_total`, {}, hypervisors.length, 'Hypervisors registered.');
    w.gauge(`${NS}_hypervisors_connected_total`, {},
      hypervisors.filter(h => h.status === 'connected').length,
      'Hypervisors currently reachable.');

    w.gauge(`${NS}_jobs_running_total`, {},
      jobs.filter(j => j.status === 'running').length, 'Backup runs in progress.');
    w.gauge(`${NS}_jobs_queued_total`, {},
      jobs.filter(j => j.status === 'queued').length, 'Backup runs waiting to start.');
    w.gauge(`${NS}_jobs_history_total`, {}, jobs.length,
      'Job records currently retained. Also the size of the scrape\'s working set.');
  }

  /**
   * Per-VM series — the VM dashboard.
   *
   * Everything here is keyed on the VM name, which is what an operator
   * searches for, with the owning host/hypervisor/schedule as extra labels so
   * the same panel can be filtered by any of them.
   */
  collectVMs(w, snap, nowSec) {
    const { jobs, schedules, vms, hypervisors } = snap;

    const hypervisorById = new Map(hypervisors.map(h => [h.id, h]));
    const scheduleById = new Map(schedules.map(s => [s.id, s]));

    // Latest schedule per VM, so a VM with several schedules still gets one
    // identity row rather than flapping between them.
    const scheduleByVmId = new Map();
    for (const s of schedules) {
      if (!s.vmId) continue;
      const current = scheduleByVmId.get(s.vmId);
      if (!current || (s.enabled !== false && current.enabled === false)) {
        scheduleByVmId.set(s.vmId, s);
      }
    }

    // Walk the history ONCE, keeping only what each VM needs. The history can
    // hold tens of thousands of records; anything per-VM here must stay O(n).
    const byVm = new Map();
    const dayAgo = Date.now() - 86400000;

    const vmState = (name) => {
      if (!byVm.has(name)) {
        byVm.set(name, {
          lastAttempt: null,
          lastSuccess: null,
          lastFailure: null,
          latest: null,
          active: null,
          runs24h: new Map(),
          consecutiveFailures: 0,
          countingStreak: true,
        });
      }
      return byVm.get(name);
    };

    // Newest first, so the consecutive-failure streak counts back from now.
    const ordered = [...jobs].sort(
      (a, b) => Date.parse(b.startTime || 0) - Date.parse(a.startTime || 0)
    );

    for (const job of ordered) {
      const name = job.vmName;
      if (!name) continue;
      const st = vmState(name);
      const started = Date.parse(job.startTime || '');

      if (!st.latest) st.latest = job;
      if (!st.active && (job.status === 'running' || job.status === 'queued')) st.active = job;

      if (TERMINAL.has(job.status)) {
        if (!st.lastAttempt) st.lastAttempt = job;
        if (job.status === 'completed' && !st.lastSuccess) st.lastSuccess = job;
        if (job.status === 'failed' && !st.lastFailure) st.lastFailure = job;

        // The streak is only over real outcomes: a skipped or rejected run
        // neither proves the VM is healthy nor that it is broken, so it must
        // not silently reset a genuine failure streak.
        if (st.countingStreak) {
          if (job.status === 'failed') st.consecutiveFailures += 1;
          else if (job.status === 'completed') st.countingStreak = false;
        }
      }

      if (Number.isFinite(started) && started >= dayAgo && TERMINAL.has(job.status)) {
        st.runs24h.set(job.status, (st.runs24h.get(job.status) || 0) + 1);
      }
    }

    // Emit one block per VM the controller knows about — driven by the VM list,
    // not by the history, so a VM that has NEVER been backed up still appears
    // (with no success timestamp). A VM missing from the dashboard entirely is
    // the failure mode that loses data unnoticed.
    for (const vm of vms) {
      const name = vm.name;
      if (!name) continue;

      const schedule = scheduleByVmId.get(vm.id);
      const hypervisor = hypervisorById.get(vm.hypervisorId);
      const st = byVm.get(name);
      const latest = st?.latest;

      const labels = {
        vm: name,
        hypervisor: hypervisor?.name || '',
        backup_host: latest?.backupHostName || '',
        schedule_type: schedule?.scheduleType || '',
      };
      const vmOnly = { vm: name };

      w.gauge(`${NS}_vm_info`, {
        ...labels,
        method: schedule?.method || latest?.method || '',
      }, 1, 'VM identity and its current backup configuration. Always 1; join on the labels.');

      w.gauge(`${NS}_vm_protected`, vmOnly, schedule && schedule.enabled !== false ? 1 : 0,
        '1 when the VM has an enabled backup schedule, 0 when nothing will back it up.');

      const interval = expectedIntervalSeconds(schedule);
      if (interval !== null) {
        w.gauge(`${NS}_vm_backup_expected_interval_seconds`, vmOnly, interval,
          'How often this VM is scheduled to be backed up. Use as the ' +
          'threshold for freshness alerts instead of a hard-coded constant.');
      }

      // --- Freshness: the metrics that catch silent failure ---------------
      const lastSuccessTs = unixSeconds(st?.lastSuccess?.endTime || st?.lastSuccess?.startTime);
      const lastAttemptTs = unixSeconds(st?.lastAttempt?.endTime || st?.lastAttempt?.startTime);
      const lastFailureTs = unixSeconds(st?.lastFailure?.endTime || st?.lastFailure?.startTime);

      w.gauge(`${NS}_vm_backup_last_success_timestamp_seconds`, vmOnly, lastSuccessTs,
        'When this VM last completed a backup. Absent means it never has — ' +
        'alert on absent() as well as on age.');
      w.gauge(`${NS}_vm_backup_last_attempt_timestamp_seconds`, vmOnly, lastAttemptTs,
        'When this VM last finished a backup run of any outcome.');
      w.gauge(`${NS}_vm_backup_last_failure_timestamp_seconds`, vmOnly, lastFailureTs,
        'When this VM last failed a backup.');

      if (lastSuccessTs !== null) {
        w.gauge(`${NS}_vm_backup_age_seconds`, vmOnly, nowSec - lastSuccessTs,
          'Seconds since the last successful backup. Equivalent to ' +
          'time() - bm_vm_backup_last_success_timestamp_seconds, precomputed ' +
          'so single-stat panels need no expression.');
      }

      // --- Last run detail ------------------------------------------------
      if (latest) {
        const code = BACKUP_STATUS_CODE[latest.status];
        w.gauge(`${NS}_vm_backup_last_status`, vmOnly, code === undefined ? -1 : code,
          'Outcome of the most recent run: 0 completed, 1 failed, 2 skipped, ' +
          '3 rejected, 4 running, 5 queued, 6 cancelled, 7 retrying, -1 unknown.');

        w.gauge(`${NS}_vm_backup_last_start_timestamp_seconds`, vmOnly,
          unixSeconds(latest.startTime), 'Start of the most recent run.');
        w.gauge(`${NS}_vm_backup_last_end_timestamp_seconds`, vmOnly,
          unixSeconds(latest.endTime), 'End of the most recent run; absent while it is still going.');

        if (latest.exitCode !== null && latest.exitCode !== undefined) {
          w.gauge(`${NS}_vm_backup_last_exit_code`, vmOnly, Number(latest.exitCode),
            'Exit code the agent reported for the most recent run. 0 is success.');
        }

        const start = Date.parse(latest.startTime || '');
        const end = Date.parse(latest.endTime || '');
        if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
          w.gauge(`${NS}_vm_backup_last_duration_seconds`, vmOnly, (end - start) / 1000,
            'Wall-clock duration of the most recent finished run.');
        }
      }

      // --- What is happening right now ------------------------------------
      const active = st?.active;
      w.gauge(`${NS}_vm_backup_running`, vmOnly, active?.status === 'running' ? 1 : 0,
        '1 while a backup of this VM is running.');
      w.gauge(`${NS}_vm_backup_queued`, vmOnly, active?.status === 'queued' ? 1 : 0,
        '1 while a backup of this VM is queued.');

      if (active) {
        w.gauge(`${NS}_vm_backup_progress_percent`, vmOnly, Number(active.progress) || 0,
          'Progress of the in-flight run, 0-100.');

        const lastProgress = Date.parse(active.lastProgressAt || active.startTime || '');
        if (Number.isFinite(lastProgress)) {
          w.gauge(`${NS}_vm_backup_last_progress_timestamp_seconds`, vmOnly,
            Math.floor(lastProgress / 1000),
            'When the in-flight run last reported progress.');
          // Stuck is defined by SILENCE, not by total runtime: a 14-hour
          // backup that keeps reporting is healthy, a 90-minute one that has
          // said nothing for an hour is not.
          w.gauge(`${NS}_vm_backup_stuck`, vmOnly,
            Date.now() - lastProgress > STUCK_INACTIVITY_MS ? 1 : 0,
            '1 when an in-flight run has reported no progress for over an hour.');
        }
      } else {
        w.gauge(`${NS}_vm_backup_stuck`, vmOnly, 0,
          '1 when an in-flight run has reported no progress for over an hour.');
      }

      w.gauge(`${NS}_vm_backup_consecutive_failures`, vmOnly, st?.consecutiveFailures || 0,
        'Failed runs since the last success. Rises with a persistent fault ' +
        'rather than firing once per night.');

      // --- 24h window, for panels that must survive a controller restart ---
      for (const status of ['completed', 'failed', 'skipped', 'rejected']) {
        w.gauge(`${NS}_vm_backup_runs_24h`, { ...vmOnly, result: status },
          st?.runs24h.get(status) || 0,
          'Runs per outcome in the last 24 hours, computed from history. ' +
          'Unlike bm_backup_runs_total this survives a controller restart.');
      }

      // --- Offsite replication (rsync) for this VM ------------------------
      this.collectVmOffsite(w, name, st?.lastSuccess, latest, byVm.get(name));
    }

    // Schedule-level configuration, kept separate from VM state so a dashboard
    // can show "what should happen" next to "what did happen".
    for (const s of schedules) {
      const vmName = vms.find(v => v.id === s.vmId)?.name;
      if (!vmName) continue;
      const labels = { vm: vmName, schedule_type: s.scheduleType || '' };

      w.gauge(`${NS}_schedule_enabled`, labels, s.enabled === false ? 0 : 1,
        '1 when the schedule is enabled. A schedule silently disabled after ' +
        'repeated failures is a common cause of stale backups.');
      w.gauge(`${NS}_schedule_retention`, labels, Number(s.retention) || 0,
        'Configured retention depth for this schedule.');
      w.gauge(`${NS}_schedule_offsite_targets`, labels,
        Array.isArray(s.offsiteTargets) ? s.offsiteTargets.length : 0,
        'Number of offsite destinations configured on this schedule.');
      w.gauge(`${NS}_schedule_warnings`, labels,
        Array.isArray(s.warnings) ? s.warnings.length : 0,
        'Open resilience warnings recorded on this schedule (offsite skips and failures).');
    }

    // Reference the map so the linter and the reader both see it is used.
    void scheduleById;
  }

  /**
   * Offsite replication state for one VM.
   *
   * `partial` is deliberately its own value and not folded into success: it
   * means SOME destinations hold this VM and some do not, which is the state
   * most likely to be mistaken for healthy right up until a restore is needed.
   */
  collectVmOffsite(w, vmName, lastSuccessJob, latestJob, state) {
    const vmOnly = { vm: vmName };
    const job = latestJob;
    if (!job) return;

    const status = job.offsiteSyncStatus;
    if (status) {
      const code = OFFSITE_STATUS_CODE[status];
      w.gauge(`${NS}_vm_offsite_last_status`, vmOnly, code === undefined ? -1 : code,
        'Most recent replication verdict: 0 completed, 1 partial, 2 failed, ' +
        '3 running, 4 retrying, 5 unknown, -1 unrecognised. 1 (partial) means ' +
        'some destinations have this VM and some do not.');
    }

    const results = Array.isArray(job.offsiteResults) ? job.offsiteResults : [];
    if (results.length > 0) {
      const counts = { success: 0, failed: 0, skipped: 0 };
      for (const r of results) {
        if (counts[r.status] !== undefined) counts[r.status] += 1;
      }
      w.gauge(`${NS}_vm_offsite_targets_total`, vmOnly, results.length,
        'Offsite destinations attempted on the most recent run.');
      for (const [result, value] of Object.entries(counts)) {
        w.gauge(`${NS}_vm_offsite_targets`, { ...vmOnly, result }, value,
          'Offsite destinations on the most recent run, by outcome.');
      }

      // Per-destination, so "which offsite host is broken" is one panel and
      // not an investigation. Bounded by the number of offsite hosts.
      for (const r of results) {
        const host = r.host || r.ip;
        if (!host) continue;
        w.gauge(`${NS}_vm_offsite_target_status`, { ...vmOnly, offsite_host: host },
          r.status === 'success' ? 0 : r.status === 'skipped' ? 1 : 2,
          'Per-destination outcome of the most recent replication: ' +
          '0 success, 1 skipped, 2 failed.');
      }
    }

    if (job.offsiteRetryAt) {
      w.gauge(`${NS}_vm_offsite_retry_timestamp_seconds`, vmOnly,
        unixSeconds(job.offsiteRetryAt),
        'When the controller will retry replication for this VM.');
    }

    // Last run whose replication fully completed — the offsite equivalent of
    // backup freshness, and the number that matters for off-premises RPO.
    const lastOffsiteOk = state?.lastSuccess?.offsiteSyncStatus === 'completed'
      ? state.lastSuccess
      : null;
    if (lastOffsiteOk) {
      w.gauge(`${NS}_vm_offsite_last_success_timestamp_seconds`, vmOnly,
        unixSeconds(lastOffsiteOk.endTime || lastOffsiteOk.startTime),
        'When this VM was last fully replicated to every offsite destination.');
    }
    void lastSuccessJob;
  }

  /** Backup hosts — half of the infrastructure dashboard. */
  collectBackupHosts(w, snap) {
    const { hosts, jobs } = snap;

    const runningByHost = new Map();
    const queuedByHost = new Map();
    for (const j of jobs) {
      if (!j.backupHostId) continue;
      if (j.status === 'running') runningByHost.set(j.backupHostId, (runningByHost.get(j.backupHostId) || 0) + 1);
      if (j.status === 'queued') queuedByHost.set(j.backupHostId, (queuedByHost.get(j.backupHostId) || 0) + 1);
    }

    for (const host of hosts) {
      const labels = { backup_host: host.name || host.id };

      w.gauge(`${NS}_backup_host_up`, labels, host.status === 'online' ? 1 : 0,
        '1 when the controller last reached this backup host. When it is 0 ' +
        'every VM behind this host stops being backed up.');
      w.gauge(`${NS}_backup_host_last_health_check_timestamp_seconds`, labels,
        unixSeconds(host.lastHealthCheck),
        'When the controller last health-checked this host. If this stops ' +
        'advancing the health checker itself has stalled, and bm_backup_host_up ' +
        'is no longer trustworthy.');
      w.gauge(`${NS}_backup_host_jobs_running`, labels, runningByHost.get(host.id) || 0,
        'Backup runs in progress on this host.');
      w.gauge(`${NS}_backup_host_jobs_queued`, labels, queuedByHost.get(host.id) || 0,
        'Backup runs queued on this host.');
    }
  }

  /**
   * Hypervisors — the other half of the infrastructure dashboard.
   *
   * Deliberately narrow: reachability, when that was last confirmed, how many
   * VMs are exposed if it goes, and its disks. A hypervisor's own CPU/RAM is
   * the virtualisation team's dashboard, not the backup team's.
   */
  collectHypervisors(w, snap) {
    const { hypervisors, vms, hosts, schedules } = snap;
    const hostById = new Map(hosts.map(h => [h.id, h]));
    const enabledVmIds = new Set(
      schedules.filter(s => s.enabled !== false).map(s => s.vmId).filter(Boolean)
    );

    const vmsByHypervisor = new Map();
    for (const vm of vms) {
      if (!vm.hypervisorId) continue;
      if (!vmsByHypervisor.has(vm.hypervisorId)) vmsByHypervisor.set(vm.hypervisorId, []);
      vmsByHypervisor.get(vm.hypervisorId).push(vm);
    }

    for (const hv of hypervisors) {
      const backupHost = hostById.get(hv.backupHostId);
      const labels = { hypervisor: hv.name || hv.id };
      const hvVms = vmsByHypervisor.get(hv.id) || [];

      w.gauge(`${NS}_hypervisor_info`, {
        ...labels,
        backup_host: backupHost?.name || '',
      }, 1, 'Hypervisor identity and the backup host that reaches it. Always 1.');

      w.gauge(`${NS}_hypervisor_up`, labels, hv.status === 'connected' ? 1 : 0,
        '1 when the hypervisor answered its last connection test.');
      w.gauge(`${NS}_hypervisor_last_health_check_timestamp_seconds`, labels,
        unixSeconds(hv.lastHealthCheck), 'When the hypervisor was last tested.');
      w.gauge(`${NS}_hypervisor_vms_total`, labels, hvVms.length,
        'VMs on this hypervisor.');
      w.gauge(`${NS}_hypervisor_vms_protected`, labels,
        hvVms.filter(v => enabledVmIds.has(v.id)).length,
        'VMs on this hypervisor with an enabled backup schedule. The gap to ' +
        'bm_hypervisor_vms_total is unprotected capacity on this host.');

      // Disks come from the SSH probe the agent runs, cached by
      // remoteMetricsService. Its freshness is published so a panel can tell
      // "the disk is fine" apart from "we have not looked recently".
      const metrics = remoteMetricsService.getHypervisorMetrics?.(hv.id);
      if (metrics) {
        w.gauge(`${NS}_hypervisor_metrics_updated_timestamp_seconds`, labels,
          unixSeconds(metrics.timestamp),
          'When this hypervisor\'s disk figures were last collected.');

        for (const disk of metrics.disks || []) {
          const diskLabels = {
            ...labels,
            mountpoint: disk.mountPoint || disk.mountpoint || '',
          };
          w.gauge(`${NS}_hypervisor_disk_bytes_total`, diskLabels,
            gibToBytes(disk.total ?? disk.totalGB), 'Hypervisor filesystem size in bytes.');
          w.gauge(`${NS}_hypervisor_disk_used_bytes`, diskLabels,
            gibToBytes(disk.used ?? disk.usedGB), 'Hypervisor filesystem bytes used.');
          w.gauge(`${NS}_hypervisor_disk_available_bytes`, diskLabels,
            gibToBytes(disk.available ?? disk.availableGB), 'Hypervisor filesystem bytes available.');
          if (Number.isFinite(Number(disk.usage))) {
            w.gauge(`${NS}_hypervisor_disk_usage_ratio`, diskLabels, Number(disk.usage) / 100,
              'Hypervisor filesystem usage as a ratio 0-1. Format the panel as ' +
              'a percentage rather than alerting on a percentage number.');
          }
        }
      }
    }
  }

  /**
   * Storage pools — where the backups actually live.
   *
   * Sourced from the pool records maintained by storagePoolRefreshService, not
   * from a live agent call: a scrape must never depend on an SSH round-trip to
   * every host, or /metrics becomes the slowest endpoint on the controller and
   * fails exactly when a host is unreachable.
   */
  collectStorage(w, snap) {
    const { pools, hosts } = snap;
    const hostById = new Map(hosts.map(h => [h.id, h]));

    for (const pool of pools) {
      const host = hostById.get(pool.backupHostId);
      const labels = {
        backup_host: host?.name || '',
        pool: pool.name || pool.id,
      };

      const total = gibToBytes(pool.totalGB);
      const used = gibToBytes(pool.usedGB);
      const available = gibToBytes(pool.availableGB);

      w.gauge(`${NS}_storage_pool_bytes_total`, labels, total, 'Storage pool size in bytes.');
      w.gauge(`${NS}_storage_pool_used_bytes`, labels, used, 'Storage pool bytes used.');
      w.gauge(`${NS}_storage_pool_available_bytes`, labels, available,
        'Storage pool bytes available. This is the number that ends backups ' +
        'when it reaches zero.');

      if (Number.isFinite(Number(pool.usagePercent))) {
        w.gauge(`${NS}_storage_pool_usage_ratio`, labels, Number(pool.usagePercent) / 100,
          'Storage pool usage as a ratio 0-1.');
      }

      w.gauge(`${NS}_storage_pool_updated_timestamp_seconds`, labels,
        unixSeconds(pool.updatedAt),
        'When these pool figures were last refreshed. Stale figures mean the ' +
        'refresh loop or the host is down, not that usage stopped changing.');
    }
  }

  /** Offsite hosts and their pools — the replication destinations. */
  collectOffsiteHosts(w, snap) {
    const { offsiteHosts } = snap;

    for (const host of offsiteHosts) {
      const labels = { offsite_host: host.name || host.id };

      w.gauge(`${NS}_offsite_host_up`, labels,
        host.status === 'online' || host.status === 'connected' ? 1 : 0,
        '1 when the offsite host was reachable at the last check.');
      w.gauge(`${NS}_offsite_host_last_check_timestamp_seconds`, labels,
        unixSeconds(host.lastHealthCheck || host.updatedAt),
        'When this offsite host was last checked.');

      // The field is `storagePools`, not `pools` — reading the wrong name
      // silently published no offsite capacity at all, which looks identical
      // to "this host has no pools configured".
      for (const pool of host.storagePools || host.pools || []) {
        const poolLabels = { ...labels, pool: pool.name || pool.id };
        w.gauge(`${NS}_offsite_pool_bytes_total`, poolLabels,
          gibToBytes(pool.totalGB), 'Offsite pool size in bytes.');
        w.gauge(`${NS}_offsite_pool_used_bytes`, poolLabels,
          gibToBytes(pool.usedGB), 'Offsite pool bytes used.');
        w.gauge(`${NS}_offsite_pool_available_bytes`, poolLabels,
          gibToBytes(pool.availableGB), 'Offsite pool bytes available.');
        if (Number.isFinite(Number(pool.usagePercent))) {
          w.gauge(`${NS}_offsite_pool_usage_ratio`, poolLabels,
            Number(pool.usagePercent) / 100, 'Offsite pool usage as a ratio 0-1.');
        }
        w.gauge(`${NS}_offsite_pool_updated_timestamp_seconds`, poolLabels,
          unixSeconds(pool.updatedAt), 'When these offsite pool figures were collected.');
      }
    }
  }

  /**
   * TLS certificates. Expiry is published as the absolute moment it happens,
   * the same shape as the blackbox exporter's `ssl_cert_not_after`, so the
   * monitoring team's existing certificate panels work unchanged.
   */
  collectCertificates(w) {
    let status;
    try {
      status = certificateMonitorService.getStatus?.();
    } catch (_) {
      return;
    }
    if (!status) return;

    for (const cert of status.certificates || []) {
      const labels = { label: cert.label || '', subject: cert.subject || '' };
      const expiry = unixSeconds(cert.validTo);
      w.gauge(`${NS}_certificate_expiry_timestamp_seconds`, labels, expiry,
        'When this certificate expires. Alert on ' +
        '(bm_certificate_expiry_timestamp_seconds - time()) / 86400 < days. ' +
        'Backups keep running past expiry; browser access does not.');
      if (Number.isFinite(Number(cert.daysRemaining))) {
        w.gauge(`${NS}_certificate_days_remaining`, labels, Number(cert.daysRemaining),
          'Whole days until this certificate expires; negative once expired.');
      }
    }

    w.gauge(`${NS}_certificates_monitored_total`, {}, status.monitored || 0,
      'Certificates the controller is watching.');
    w.gauge(`${NS}_certificate_check_timestamp_seconds`, {},
      unixSeconds(status.lastCheckedAt), 'When certificates were last checked.');
  }

  /** Cumulative counters recorded since this controller started. */
  collectCounters(w) {
    this.counters.writeTo(w, `${NS}_backup_runs_total`,
      'Backup runs by outcome since controller start. Use increase()/rate(); ' +
      'resets to 0 on restart (see bm_controller_start_timestamp_seconds).');
    this.counters.writeTo(w, `${NS}_backup_duration_seconds_sum`,
      'Total backup seconds since controller start. Divide by _count for a mean.');
    this.counters.writeTo(w, `${NS}_backup_duration_seconds_count`,
      'Finished backup runs counted for the duration sum.');
    this.counters.writeTo(w, `${NS}_backup_retries_total`,
      'Backup runs that succeeded only after a retry.');
    this.counters.writeTo(w, `${NS}_offsite_sync_runs_total`,
      'Replication runs by whole-run verdict: completed, partial or failed. ' +
      '"partial" means some destinations received this VM and some did not.');
    this.counters.writeTo(w, `${NS}_offsite_sync_results_total`,
      'Individual rsync outcomes per destination host: success, failed or skipped.');
    this.counters.writeTo(w, `${NS}_restore_runs_total`,
      'Restore runs by outcome since controller start.');
  }
}

module.exports = new PrometheusMetricsService();
module.exports.BACKUP_STATUS_CODE = BACKUP_STATUS_CODE;
module.exports.OFFSITE_STATUS_CODE = OFFSITE_STATUS_CODE;
