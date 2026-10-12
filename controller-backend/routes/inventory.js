const express = require('express');
const router = express.Router();
const {
  getBackupHosts,
  getHypervisors,
  getVirtualMachines,
  getOffsiteHosts,
  getStoragePools,
  getBackupSchedules,
  getBackupJobs,
} = require('../services/fileStorage');

/**
 * Read-only inventory / asset API for external consumers (CMDB, asset
 * register, capacity reporting).
 *
 * Every route here is a GET and touches no writer. Auth is a static per-client
 * token (see middleware/apiToken.js), not a panel session.
 *
 * Machine `status` is deliberately reported twice: `status` is the raw value
 * this system stores (which differs per machine kind — 'online', 'connected',
 * 'running'), and `state` collapses it to Active/Down for consumers that just
 * want the two-value answer. Normalizing away the raw value would lose the
 * distinction between "never checked" and "checked and down".
 */

// ---------------------------------------------------------------------------
// Site / datacenter resolution
// ---------------------------------------------------------------------------
// The site (datacenter/zone) is stored on the BACKUP HOST only. Everything
// below a backup host — its hypervisors, its offsite targets, and the VMs on
// those hypervisors — inherits that value rather than carrying its own copy,
// so relocating a rack is a single edit on the host.
//
// Hosts added before this field existed have no site; they report null until
// an operator fills one in. Null therefore means "not recorded yet", never
// "no datacenter".

/** Site recorded on a backup host, or null when it is unset/blank. */
function siteOfHost(host) {
  const site = host?.site;
  if (typeof site !== 'string') return null;
  const trimmed = site.trim();
  return trimmed === '' ? null : trimmed;
}

/** Site for anything that hangs off a backup host, looked up by that host id. */
function siteOfHostId(backupHostId, hostById) {
  if (!backupHostId) return null;
  return siteOfHost(hostById.get(backupHostId));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pull a bare host/IP out of a stored URL such as http://172.30.88.9:3001. */
function ipFromUrl(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

function portFromUrl(url) {
  if (!url) return null;
  try {
    const p = new URL(url).port;
    return p ? Number(p) : null;
  } catch {
    return null;
  }
}

/**
 * Collapse this system's several per-kind status vocabularies into the
 * Active/Down answer an asset register wants. Anything never health-checked
 * reports Unknown rather than being guessed into Down.
 */
const ACTIVE_STATUSES = new Set(['online', 'connected', 'running', 'active', 'ok', 'up']);
const DOWN_STATUSES = new Set(['offline', 'disconnected', 'error', 'down', 'shut off', 'shutoff', 'stopped', 'inactive', 'failed']);

function normalizeState(status) {
  if (status === undefined || status === null || status === '') return 'Unknown';
  const s = String(status).toLowerCase().trim();
  if (ACTIVE_STATUSES.has(s)) return 'Active';
  if (DOWN_STATUSES.has(s)) return 'Down';
  return 'Unknown';
}

/**
 * Disk-usage percentage the way `df` reports it: against used+available, NOT
 * against the raw total. On ext4 the reserved-blocks pool means used+available
 * is several percent short of total, so dividing by total understates usage —
 * a host rollup would read 78% while its only pool reported 83%.
 */
function usagePercentOf(usedGB, availableGB, totalGB) {
  const denominator = usedGB + availableGB;
  if (denominator > 0) return Math.round((usedGB / denominator) * 100);
  // No reserve information (an agent that only reported a total): fall back to
  // the raw total rather than reporting a misleading 0%.
  return totalGB > 0 ? Math.round((usedGB / totalGB) * 100) : 0;
}

/** Parse ?limit= with a bound, so one call cannot ask for the whole journal. */
function parseLimit(value, fallback, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

/** Parse an ISO date filter; returns null for absent AND for unparseable. */
function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------------------
// GET /api/inventory — endpoint index
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  res.json({
    success: true,
    client: req.apiClient?.label || null,
    data: {
      endpoints: [
        { path: '/api/inventory/machines', description: 'All machines: backup hosts, hypervisors, offsite hosts, VMs' },
        { path: '/api/inventory/backup-hosts', description: 'Backup hosts with pool and VM rollups' },
        { path: '/api/inventory/storage-pools', description: 'Storage pools grouped per backup host, with disk usage' },
        { path: '/api/inventory/schedules', description: 'Backup schedules with VM, pool and last/next-run info' },
        { path: '/api/inventory/backup-history', description: 'Backup job history (filterable, paginated)' },
      ],
      generatedAt: new Date().toISOString(),
    },
  });
});

// ---------------------------------------------------------------------------
// GET /api/inventory/machines
// ---------------------------------------------------------------------------
// Query: ?type=hypervisor|backup-host|offsite-host|virtual-machine
//        ?state=Active|Down|Unknown   ?site=<name>   ?includeVms=false
router.get('/machines', async (req, res, next) => {
  try {
    const [backupHosts, hypervisors, offsiteHosts, vms] = await Promise.all([
      getBackupHosts(),
      getHypervisors(),
      getOffsiteHosts(),
      getVirtualMachines(),
    ]);

    const hostById = new Map(backupHosts.map((h) => [h.id, h]));
    const hypervisorById = new Map(hypervisors.map((h) => [h.id, h]));

    const machines = [];

    for (const h of backupHosts) {
      const ip = ipFromUrl(h.url);
      machines.push({
        id: h.id,
        hostname: h.name || null,
        ip,
        port: portFromUrl(h.url),
        site: siteOfHost(h),
        type: 'backup-host',
        role: 'Backup Server',
        status: h.status ?? null,
        state: normalizeState(h.status),
        parent: null,
        description: h.description || null,
        url: h.url || null,
        hypervisorCount: hypervisors.filter((x) => x.backupHostId === h.id).length,
        vmCount: vms.filter((v) => v.backupHostId === h.id).length,
        lastHealthCheck: h.lastHealthCheck || null,
        createdAt: h.createdAt || null,
        updatedAt: h.updatedAt || null,
      });
    }

    for (const hv of hypervisors) {
      const parent = hostById.get(hv.backupHostId);
      machines.push({
        id: hv.id,
        hostname: hv.name || null,
        ip: hv.ip || null,
        port: hv.port ?? null,
        // Inherited from the backup host, not stored on the hypervisor.
        site: siteOfHost(parent),
        type: 'hypervisor',
        role: 'KVM/QEMU Hypervisor',
        status: hv.status ?? null,
        state: normalizeState(hv.status),
        parent: parent ? { id: parent.id, hostname: parent.name || null, type: 'backup-host' } : null,
        username: hv.username || null,
        vmCount: vms.filter((v) => v.hypervisorId === hv.id).length,
        lastHealthCheck: hv.lastHealthCheck || null,
        lastError: hv.lastError || null,
        createdAt: hv.createdAt || null,
        updatedAt: hv.updatedAt || null,
      });
    }

    for (const oh of offsiteHosts) {
      const parent = hostById.get(oh.backupHostId);
      machines.push({
        id: oh.id,
        hostname: oh.name || null,
        ip: oh.ip || null,
        port: oh.port ?? null,
        site: siteOfHost(parent),
        type: 'offsite-host',
        role: 'Offsite Replication Target',
        status: oh.status ?? null,
        state: normalizeState(oh.status),
        parent: parent ? { id: parent.id, hostname: parent.name || null, type: 'backup-host' } : null,
        username: oh.username || null,
        lastSync: oh.lastSync || null,
        lastHealthCheck: oh.lastHealthCheck || null,
        createdAt: oh.createdAt || null,
        updatedAt: oh.updatedAt || null,
      });
    }

    // VMs are the bulk of the inventory and are opt-out rather than opt-in:
    // an asset register wants them, but a topology view usually does not.
    if (req.query.includeVms !== 'false') {
      for (const vm of vms) {
        const hv = hypervisorById.get(vm.hypervisorId);
        machines.push({
          id: vm.id,
          hostname: vm.name || null,
          // The panel tracks VMs through libvirt on the hypervisor and never
          // learns a guest IP, so this is null by design rather than missing.
          ip: null,
          port: null,
          // A guest inherits its backup host's site. vm.backupHostId is the
          // direct link; the hypervisor's is the fallback for older records
          // written before VMs carried one.
          site: siteOfHostId(vm.backupHostId || hv?.backupHostId, hostById),
          type: 'virtual-machine',
          role: 'Virtual Machine',
          status: vm.state ?? null,
          state: normalizeState(vm.state),
          parent: hv ? { id: hv.id, hostname: hv.name || null, ip: hv.ip || null, type: 'hypervisor' } : null,
          backupHostId: vm.backupHostId || null,
          createdAt: vm.createdAt || null,
          updatedAt: vm.updatedAt || null,
        });
      }
    }

    // Filters are applied after assembly so that parent/rollup fields are
    // computed against the full fleet, not against the filtered subset.
    let result = machines;
    if (req.query.type) {
      const wanted = new Set(String(req.query.type).split(',').map((t) => t.trim().toLowerCase()));
      result = result.filter((m) => wanted.has(m.type));
    }
    if (req.query.state) {
      const wanted = String(req.query.state).toLowerCase();
      result = result.filter((m) => m.state.toLowerCase() === wanted);
    }
    if (req.query.site) {
      const wanted = String(req.query.site).toLowerCase();
      result = result.filter((m) => (m.site || '').toLowerCase() === wanted);
    }

    res.json({
      success: true,
      count: result.length,
      generatedAt: new Date().toISOString(),
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// GET /api/inventory/backup-hosts
// ---------------------------------------------------------------------------
router.get('/backup-hosts', async (req, res, next) => {
  try {
    const [hosts, hypervisors, vms, pools] = await Promise.all([
      getBackupHosts(),
      getHypervisors(),
      getVirtualMachines(),
      getStoragePools(),
    ]);

    const data = hosts.map((h) => {
      const ip = ipFromUrl(h.url);
      const hostPools = pools.filter((p) => p.backupHostId === h.id);
      const totalGB = hostPools.reduce((sum, p) => sum + (Number(p.totalGB) || 0), 0);
      const usedGB = hostPools.reduce((sum, p) => sum + (Number(p.usedGB) || 0), 0);
      const availableGB = hostPools.reduce((sum, p) => sum + (Number(p.availableGB) || 0), 0);

      return {
        id: h.id,
        hostname: h.name || null,
        ip,
        port: portFromUrl(h.url),
        url: h.url || null,
        site: siteOfHost(h),
        type: 'backup-host',
        status: h.status ?? null,
        state: normalizeState(h.status),
        description: h.description || null,
        hypervisorCount: hypervisors.filter((x) => x.backupHostId === h.id).length,
        vmCount: vms.filter((v) => v.backupHostId === h.id).length,
        storagePoolCount: hostPools.length,
        capacity: {
          totalGB,
          usedGB,
          availableGB,
          // Recomputed from the summed figures rather than averaging the
          // per-pool percentages, which would weight a small pool equally
          // with a large one.
          usagePercent: usagePercentOf(usedGB, availableGB, totalGB),
        },
        lastHealthCheck: h.lastHealthCheck || null,
        createdAt: h.createdAt || null,
        updatedAt: h.updatedAt || null,
      };
    });

    res.json({ success: true, count: data.length, generatedAt: new Date().toISOString(), data });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// GET /api/inventory/storage-pools
// ---------------------------------------------------------------------------
// Query: ?backupHostId=<id>   ?flat=true  (ungrouped, one row per pool)
router.get('/storage-pools', async (req, res, next) => {
  try {
    const [hosts, pools] = await Promise.all([getBackupHosts(), getStoragePools()]);

    const selected = req.query.backupHostId
      ? pools.filter((p) => p.backupHostId === req.query.backupHostId)
      : pools;

    const hostById = new Map(hosts.map((h) => [h.id, h]));

    const shapePool = (p) => {
      const totalGB = Number(p.totalGB) || 0;
      const usedGB = Number(p.usedGB) || 0;
      return {
        id: p.id,
        name: p.name || null,
        backupHostId: p.backupHostId || null,
        backupHostName: p.backupHostName || null,
        site: siteOfHostId(p.backupHostId, hostById),
        path: p.path || null,
        mountPoint: p.mountPoint || null,
        device: p.device || null,
        offsitePath: p.offsitePath || null,
        status: p.status ?? null,
        state: normalizeState(p.status),
        diskUsage: {
          totalGB,
          usedGB,
          availableGB: Number(p.availableGB) || 0,
          // Prefer the stored percentage (the agent measures it on the box
          // with df); fall back to a computed one so the field is never null.
          usagePercent: p.usagePercent ?? usagePercentOf(usedGB, Number(p.availableGB) || 0, totalGB),
          thresholdPercent: p.diskUsageThreshold ?? null,
        },
        lastChecked: p.updatedAt || p.createdAt || null,
        createdAt: p.createdAt || null,
        updatedAt: p.updatedAt || null,
      };
    };

    if (req.query.flat === 'true') {
      const data = selected.map(shapePool);
      return res.json({ success: true, count: data.length, generatedAt: new Date().toISOString(), data });
    }

    const relevantHosts = req.query.backupHostId
      ? hosts.filter((h) => h.id === req.query.backupHostId)
      : hosts;

    const data = relevantHosts.map((h) => {
      const hostPools = selected.filter((p) => p.backupHostId === h.id).map(shapePool);
      const totalGB = hostPools.reduce((s, p) => s + p.diskUsage.totalGB, 0);
      const usedGB = hostPools.reduce((s, p) => s + p.diskUsage.usedGB, 0);
      const ip = ipFromUrl(h.url);
      return {
        backupHostId: h.id,
        backupHostName: h.name || null,
        ip,
        site: siteOfHost(h),
        status: h.status ?? null,
        state: normalizeState(h.status),
        poolCount: hostPools.length,
        totals: {
          totalGB,
          usedGB,
          availableGB: hostPools.reduce((s, p) => s + p.diskUsage.availableGB, 0),
          usagePercent: usagePercentOf(
            usedGB,
            hostPools.reduce((s, p) => s + p.diskUsage.availableGB, 0),
            totalGB
          ),
        },
        pools: hostPools,
      };
    });

    // Pools whose backupHostId no longer resolves to a host would otherwise
    // vanish from a grouped view; surface them rather than dropping them.
    const knownHostIds = new Set(hosts.map((h) => h.id));
    const orphaned = selected.filter((p) => !knownHostIds.has(p.backupHostId)).map(shapePool);
    if (orphaned.length > 0) {
      data.push({
        backupHostId: null,
        backupHostName: null,
        ip: null,
        site: null,
        status: null,
        state: 'Unknown',
        poolCount: orphaned.length,
        totals: {
          totalGB: orphaned.reduce((s, p) => s + p.diskUsage.totalGB, 0),
          usedGB: orphaned.reduce((s, p) => s + p.diskUsage.usedGB, 0),
          availableGB: orphaned.reduce((s, p) => s + p.diskUsage.availableGB, 0),
          usagePercent: usagePercentOf(
            orphaned.reduce((s, p) => s + p.diskUsage.usedGB, 0),
            orphaned.reduce((s, p) => s + p.diskUsage.availableGB, 0),
            orphaned.reduce((s, p) => s + p.diskUsage.totalGB, 0)
          ),
        },
        pools: orphaned,
      });
    }

    res.json({ success: true, count: data.length, generatedAt: new Date().toISOString(), data });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// GET /api/inventory/schedules
// ---------------------------------------------------------------------------
// Query: ?enabled=true|false  ?backupHostId=<id>  ?vmId=<id>
router.get('/schedules', async (req, res, next) => {
  try {
    const [schedules, vms, hypervisors, hosts, pools, jobs] = await Promise.all([
      getBackupSchedules(),
      getVirtualMachines(),
      getHypervisors(),
      getBackupHosts(),
      getStoragePools(),
      getBackupJobs(),
    ]);

    const vmById = new Map(vms.map((v) => [v.id, v]));
    const hypervisorById = new Map(hypervisors.map((h) => [h.id, h]));
    const hostById = new Map(hosts.map((h) => [h.id, h]));
    const poolById = new Map(pools.map((p) => [p.id, p]));

    // Last job per schedule, resolved in one pass rather than scanning the
    // whole job list once per schedule.
    const lastJobBySchedule = new Map();
    for (const job of jobs) {
      if (!job.scheduleId) continue;
      const current = lastJobBySchedule.get(job.scheduleId);
      const t = new Date(job.startTime || 0).getTime();
      if (!current || t > new Date(current.startTime || 0).getTime()) {
        lastJobBySchedule.set(job.scheduleId, job);
      }
    }

    let data = schedules.map((s) => {
      const vm = vmById.get(s.vmId);
      const hv = vm ? hypervisorById.get(vm.hypervisorId) : null;
      const host = vm ? hostById.get(vm.backupHostId) : null;
      const pool = poolById.get(s.storagePoolId);
      const lastJob = lastJobBySchedule.get(s.id) || null;

      return {
        id: s.id,
        name: s.name || null,
        enabled: s.enabled !== false,
        scheduleType: s.scheduleType || null,
        time: s.time || null,
        cronExpression: s.cronExpression || null,
        incrementalCount: s.incrementalCount ?? null,
        options: {
          noCompression: !!s.noCompression,
          noVerify: !!s.noVerify,
          missedRunPolicy: s.missedRunPolicy || null,
          missedRunGracePeriodMinutes: s.missedRunGracePeriodMinutes ?? null,
        },
        target: {
          vmId: s.vmId || null,
          vmName: vm?.name || null,
          vmState: vm?.state ?? null,
          hypervisorId: hv?.id || null,
          hypervisorName: hv?.name || null,
          hypervisorIp: hv?.ip || null,
          site: siteOfHost(host),
          backupHostId: host?.id || null,
          backupHostName: host?.name || null,
        },
        storagePool: pool
          ? { id: pool.id, name: pool.name || null, path: pool.path || null, usagePercent: pool.usagePercent ?? null }
          : null,
        lastFiredAt: s.lastFiredAt || null,
        lastRun: lastJob
          ? {
              jobId: lastJob.id,
              status: lastJob.status || null,
              method: lastJob.method || null,
              startTime: lastJob.startTime || null,
              endTime: lastJob.endTime || null,
              exitCode: lastJob.exitCode ?? null,
              error: lastJob.error || null,
            }
          : null,
        createdAt: s.createdAt || null,
        updatedAt: s.updatedAt || null,
      };
    });

    if (req.query.enabled === 'true') data = data.filter((s) => s.enabled);
    if (req.query.enabled === 'false') data = data.filter((s) => !s.enabled);
    if (req.query.vmId) data = data.filter((s) => s.target.vmId === req.query.vmId);
    if (req.query.backupHostId) data = data.filter((s) => s.target.backupHostId === req.query.backupHostId);

    res.json({ success: true, count: data.length, generatedAt: new Date().toISOString(), data });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// GET /api/inventory/backup-history
// ---------------------------------------------------------------------------
// Query: ?limit=100&offset=0 &status= &vmId= &scheduleId= &backupHostId=
//        &since=<ISO> &until=<ISO>
router.get('/backup-history', async (req, res, next) => {
  try {
    const [jobs, hypervisors, vms, hosts] = await Promise.all([
      getBackupJobs(),
      getHypervisors(),
      getVirtualMachines(),
      getBackupHosts(),
    ]);

    const vmById = new Map(vms.map((v) => [v.id, v]));
    const hypervisorByIp = new Map(hypervisors.map((h) => [h.ip, h]));
    const hostById = new Map(hosts.map((h) => [h.id, h]));

    let filtered = jobs;

    if (req.query.status) {
      const wanted = new Set(String(req.query.status).split(',').map((s) => s.trim().toLowerCase()));
      filtered = filtered.filter((j) => wanted.has(String(j.status || '').toLowerCase()));
    }
    if (req.query.vmId) filtered = filtered.filter((j) => j.vmId === req.query.vmId);
    if (req.query.scheduleId) filtered = filtered.filter((j) => j.scheduleId === req.query.scheduleId);
    if (req.query.backupHostId) filtered = filtered.filter((j) => j.backupHostId === req.query.backupHostId);

    const since = parseDate(req.query.since);
    const until = parseDate(req.query.until);
    if (since) filtered = filtered.filter((j) => j.startTime && new Date(j.startTime) >= since);
    if (until) filtered = filtered.filter((j) => j.startTime && new Date(j.startTime) <= until);

    // Newest first — history is read from the recent end far more often than
    // paged through from the beginning.
    const sorted = [...filtered].sort(
      (a, b) => new Date(b.startTime || 0) - new Date(a.startTime || 0)
    );

    const total = sorted.length;
    const limit = parseLimit(req.query.limit, 100, 1000);
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const page = sorted.slice(offset, offset + limit);

    const data = page.map((j) => {
      const vm = vmById.get(j.vmId);
      const hv = hypervisorByIp.get(j.hypervisorIp);
      const start = j.startTime ? new Date(j.startTime) : null;
      const end = j.endTime ? new Date(j.endTime) : null;
      return {
        id: j.id,
        scheduleId: j.scheduleId || null,
        status: j.status || null,
        method: j.method || null,
        vmId: j.vmId || null,
        vmName: j.vmName || vm?.name || null,
        hypervisorIp: j.hypervisorIp || null,
        hypervisorName: hv?.name || null,
        site: siteOfHostId(j.backupHostId, hostById),
        backupHostId: j.backupHostId || null,
        backupHostName: j.backupHostName || null,
        startTime: j.startTime || null,
        endTime: j.endTime || null,
        // Precomputed so a consumer charting run length does not have to
        // re-derive it (and get the in-flight/null case wrong).
        durationSeconds: start && end ? Math.max(0, Math.round((end - start) / 1000)) : null,
        exitCode: j.exitCode ?? null,
        error: j.error || null,
        scheduled: !!j.scheduled,
        attemptNumber: j.attemptNumber ?? null,
        maxAttempts: j.maxAttempts ?? null,
        triggeredBy: j.triggeredBy || null,
        actor: j.actor || null,
        progress: j.progress ?? null,
        options: { noCompression: !!j.noCompression, noVerify: !!j.noVerify },
      };
    });

    res.json({
      success: true,
      count: data.length,
      total,
      limit,
      offset,
      hasMore: offset + data.length < total,
      generatedAt: new Date().toISOString(),
      data,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
