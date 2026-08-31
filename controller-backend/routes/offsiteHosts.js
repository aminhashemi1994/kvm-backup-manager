const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { getOffsiteHosts, saveOffsiteHosts, getBackupHosts, getStoragePools, getBackupSchedules } = require('../services/fileStorage');
const agentService = require('../services/agentService');

// Default disk-usage guard rail (percent) for an offsite pool when unset.
const DEFAULT_DISK_USAGE_THRESHOLD = 80;

// Normalize a user-supplied disk-usage threshold to an integer 1–100, or
// return null when absent/invalid so callers can fall back to a default.
function normalizeThreshold(value) {
  if (value === undefined || value === null || value === '') return null;
  const t = parseInt(value, 10);
  if (!Number.isFinite(t) || t < 1 || t > 100) return null;
  return t;
}

// Helper to ensure URL has protocol
function ensureProtocol(url) {
  if (!url) return url;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return 'http://' + url;
  }
  return url;
}

// GET /api/offsite-hosts
router.get('/', async (req, res, next) => {
  try {
    const hosts = await getOffsiteHosts();
    res.json({ success: true, data: hosts });
  } catch (error) {
    next(error);
  }
});

// How long a single offsite host is allowed to hold up the live-status sweep
// below — see the matching constant/helper in routes/hypervisors.js for why
// this is short and separate from the multi-minute agent request timeout.
const OFFSITE_HOST_STATUS_CHECK_TIMEOUT_MS = 10000;

// Probe every offsite host's live reachability in the background (through
// the owning backup host's agent) and push results out as they land, so the
// list itself never waits on connectivity checks.
function checkOffsiteHostStatusesInBackground(io, backupHostId, hostUrl, offsiteHosts) {
  offsiteHosts.forEach((offsiteHost) => {
    agentService.testOffsiteConnection(hostUrl, { ip: offsiteHost.ip }, OFFSITE_HOST_STATUS_CHECK_TIMEOUT_MS)
      .then(async (result) => {
        const newStatus = result.success ? 'connected' : 'error';
        const newLastError = result.success ? null : result.message;

        const unchanged = offsiteHost.status === newStatus && offsiteHost.lastError === newLastError;

        if (!unchanged) {
          const allHosts = await getOffsiteHosts();
          const index = allHosts.findIndex(h => h.id === offsiteHost.id);
          if (index === -1) return; // deleted while the probe was in flight

          allHosts[index] = {
            ...allHosts[index],
            status: newStatus,
            lastError: newLastError,
            updatedAt: new Date().toISOString(),
          };
          await saveOffsiteHosts(allHosts);
        }

        // Always broadcast, even when nothing changed — see the matching
        // fix/comment in routes/hypervisors.js and routes/backupHosts.js.
        if (io) {
          io.emit('offsite-host-status-updated', {
            backupHostId,
            offsiteHostId: offsiteHost.id,
            status: newStatus,
            lastError: newLastError,
          });
        }
      })
      .catch((error) => {
        console.error(`[OffsiteHosts] Background status check failed for ${offsiteHost.id}: ${error.message}`);
      });
  });
}

// GET /api/offsite-hosts/backup-host/:backupHostId
router.get('/backup-host/:backupHostId', async (req, res, next) => {
  try {
    const hosts = await getOffsiteHosts();
    const filtered = hosts.filter(h => h.backupHostId === req.params.backupHostId);

    // Respond immediately with what's already known. If the owning backup
    // host is online, kick off a live reachability sweep in the background —
    // the frontend shows a "checking" state per offsite host until a
    // `offsite-host-status-updated` socket event (or its own timeout)
    // resolves it.
    let checking = false;
    if (filtered.length > 0) {
      const backupHosts = await getBackupHosts();
      const backupHost = backupHosts.find(h => h.id === req.params.backupHostId);
      if (backupHost && backupHost.status === 'online') {
        checkOffsiteHostStatusesInBackground(
          req.app.get('io'),
          req.params.backupHostId,
          ensureProtocol(backupHost.url),
          filtered
        );
        checking = true;
      }
    }

    res.json({
      success: true,
      data: checking ? filtered.map(h => ({ ...h, checking: true })) : filtered,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/offsite-hosts
// NOTE: Offsite backup is handled by backup_manager.sh script
// SSH keys and paths are configured manually on the backup host server
router.post('/', async (req, res, next) => {
  try {
    const { backupHostId, name, ip, username, backupPath } = req.body;

    if (!backupHostId || !name || !ip) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: backupHostId, name, ip' 
      });
    }

    // Optional custom destination base path on the offsite host. When set,
    // this VM's backups replicate to <backupPath>/<vm> on this offsite host
    // instead of mirroring the source storage-pool path. Must be absolute.
    const offsiteBackupPath = (backupPath && String(backupPath).trim()) || '';
    if (offsiteBackupPath && !offsiteBackupPath.startsWith('/')) {
      return res.status(400).json({
        success: false,
        error: 'backupPath must be an absolute path (start with /)'
      });
    }

    // Verify backup host exists
    const backupHosts = await getBackupHosts();
    const backupHost = backupHosts.find(h => h.id === backupHostId);
    if (!backupHost) {
      return res.status(400).json({ success: false, error: 'Backup host not found' });
    }

    const hosts = await getOffsiteHosts();

    const newHost = {
      id: uuidv4(),
      backupHostId,
      name,
      ip,
      username: username || 'root',
      // Empty string = mirror the source pool path (legacy behavior).
      backupPath: offsiteBackupPath,
      status: 'pending',
      lastSync: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Test connection via agent (basic ping test)
    let hostUrl = null;
    if (backupHost.status === 'online') {
      try {
        hostUrl = ensureProtocol(backupHost.url);
        const result = await agentService.testOffsiteConnection(hostUrl, { ip: newHost.ip });
        newHost.status = result.success ? 'connected' : 'error';
        if (!result.success) {
          newHost.lastError = result.message;
        }
      } catch (error) {
        newHost.status = 'error';
        newHost.lastError = error.message;
      }

      // Validate storage on this offsite host.
      // - If a custom backupPath is set, validate just that destination path.
      // - Otherwise validate that every source pool exists at the same path
      //   (legacy mirror behavior).
      if (hostUrl) {
        const poolValidationErrors = [];

        if (offsiteBackupPath) {
          const validation = await agentService.validateOffsiteStoragePool(
            hostUrl,
            offsiteBackupPath,
            newHost.ip,
            newHost.username
          );
          if (!validation.success) {
            poolValidationErrors.push({
              poolName: 'Custom backup path',
              path: offsiteBackupPath,
              error: validation.error
            });
          }
        } else {
          const storagePools = await getStoragePools();
          const backupHostPools = storagePools.filter(p => p.backupHostId === backupHostId);

          for (const pool of backupHostPools) {
            const validation = await agentService.validateOffsiteStoragePool(
              hostUrl,
              pool.path,
              newHost.ip,
              newHost.username
            );

            if (!validation.success) {
              poolValidationErrors.push({
                poolName: pool.name,
                path: pool.path,
                error: validation.error
              });
            }
          }
        }

        // If any storage pool validation failed, return error
        if (poolValidationErrors.length > 0) {
          const errorMessages = poolValidationErrors.map(e => 
          `${e.poolName} (${e.path}): ${e.error}`
        ).join('; ');
        
        return res.status(400).json({
          success: false,
          error: `Storage pool validation failed on offsite host: ${errorMessages}`,
          poolErrors: poolValidationErrors
        });
        }
      }
    }

    hosts.push(newHost);
    await saveOffsiteHosts(hosts);

    res.status(201).json({ success: true, data: newHost });
  } catch (error) {
    next(error);
  }
});

// PUT /api/offsite-hosts/:id - Update offsite host
router.put('/:id', async (req, res, next) => {
  try {
    const hosts = await getOffsiteHosts();
    const index = hosts.findIndex(h => h.id === req.params.id);
    
    if (index === -1) {
      return res.status(404).json({ success: false, error: 'Offsite host not found' });
    }

    const host = hosts[index];
    
    // Update fields
    if (req.body.name !== undefined) host.name = req.body.name;
    if (req.body.ip !== undefined) host.ip = req.body.ip;
    if (req.body.username !== undefined) host.username = req.body.username;
    if (req.body.backupPath !== undefined) {
      const p = (req.body.backupPath && String(req.body.backupPath).trim()) || '';
      if (p && !p.startsWith('/')) {
        return res.status(400).json({
          success: false,
          error: 'backupPath must be an absolute path (start with /)'
        });
      }
      host.backupPath = p;
    }
    host.updatedAt = new Date().toISOString();

    await saveOffsiteHosts(hosts);
    res.json({ success: true, data: host });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/offsite-hosts/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const hosts = await getOffsiteHosts();
    const index = hosts.findIndex(h => h.id === req.params.id);
    
    if (index === -1) {
      return res.status(404).json({ success: false, error: 'Offsite host not found' });
    }

    const deleted = hosts.splice(index, 1)[0];
    await saveOffsiteHosts(hosts);

    res.json({ success: true, data: { id: deleted.id } });
  } catch (error) {
    next(error);
  }
});

// POST /api/offsite-hosts/:id/test
router.post('/:id/test', async (req, res, next) => {
  try {
    const hosts = await getOffsiteHosts();
    const host = hosts.find(h => h.id === req.params.id);
    
    if (!host) {
      return res.status(404).json({ success: false, error: 'Offsite host not found' });
    }

    const backupHosts = await getBackupHosts();
    const backupHost = backupHosts.find(h => h.id === host.backupHostId);
    
    // Same split as the init route: a missing backup host and an offline one
    // need different fixes, so they need different messages.
    if (!backupHost) {
      return res.status(400).json({
        success: false,
        error: `Offsite host "${host.name}" references backup host ${host.backupHostId}, which no longer exists. Re-assign it to a current backup host.`
      });
    }
    if (backupHost.status !== 'online') {
      return res.status(400).json({
        success: false,
        error: `Backup host "${backupHost.name}" is ${backupHost.status || 'not online'} — the test runs through its agent, so it must be online first.`
      });
    }

    const hostUrl = ensureProtocol(backupHost.url);
    const result = await agentService.testOffsiteConnection(hostUrl, { ip: host.ip });

    host.status = result.success ? 'connected' : 'error';
    host.lastError = result.success ? null : result.message;
    host.updatedAt = new Date().toISOString();
    await saveOffsiteHosts(hosts);

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// POST /api/offsite-hosts/:id/init - Initialize offsite host with dependencies
router.post('/:id/init', async (req, res, next) => {
  try {
    const hosts = await getOffsiteHosts();
    const host = hosts.find(h => h.id === req.params.id);
    
    if (!host) {
      return res.status(404).json({ success: false, error: 'Offsite host not found' });
    }

    const backupHosts = await getBackupHosts();
    const backupHost = backupHosts.find(h => h.id === host.backupHostId);
    
    // Report these two separately. Collapsing them into "Backup host is
    // offline" sends the operator to check a host that is up and reachable,
    // when the real problem is that the offsite record points at a backup host
    // id that no longer exists.
    if (!backupHost) {
      return res.status(400).json({
        success: false,
        error: `Offsite host "${host.name}" references backup host ${host.backupHostId}, which no longer exists. Re-assign it to a current backup host.`
      });
    }
    if (backupHost.status !== 'online') {
      return res.status(400).json({
        success: false,
        error: `Backup host "${backupHost.name}" is ${backupHost.status || 'not online'} — initialization runs through its agent, so it must be online first.`
      });
    }

    // Call agent's init endpoint with offsite host IP
    const result = await agentService.initHost(backupHost.url, host.ip);
    
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// Offsite host storage pools (embedded in the offsite host record)
//
// Pools live inside each offsite host's `storagePools` array, independent from
// the backup-host pools in the top-level storagePools.json. Each pool has a
// uuid, a display name, and an absolute path on the offsite host.
// ---------------------------------------------------------------------------

// Resolve the online backup host (and its agent URL) that owns a given offsite
// host, so SSH-based checks can be performed. Returns { backupHost, hostUrl }
// or null when the owning backup host is missing/offline.
async function resolveOnlineBackupHost(offsiteHost) {
  const backupHosts = await getBackupHosts();
  const backupHost = backupHosts.find(h => h.id === offsiteHost.backupHostId);
  if (!backupHost || backupHost.status !== 'online') {
    return null;
  }
  return { backupHost, hostUrl: ensureProtocol(backupHost.url) };
}

// Validate an offsite pool path over SSH via the owning online backup host and
// build the snapshot to persist onto the pool.
//
// Validation requires an online backup host to perform the SSH check (path
// exists, is writable, and lives on a mounted filesystem). When it cannot be
// performed or fails, callers reject the add/update so an invalid/unverified
// pool is never persisted (Req 5.1, 5.4, 5.5).
//
// Returns:
//   { ok: true, path, snapshot }  -> apply snapshot onto the pool
//   { ok: false, path, reason }   -> reject with { path, reason }
async function validateOffsitePoolPath(offsiteHost, poolPath) {
  const resolved = await resolveOnlineBackupHost(offsiteHost);
  if (!resolved) {
    return {
      ok: false,
      path: poolPath,
      reason: `Owning backup host is offline or unreachable; cannot validate the offsite path on ${offsiteHost.ip}`,
    };
  }

  const validation = await agentService.validateOffsiteStoragePool(
    resolved.hostUrl,
    poolPath,
    offsiteHost.ip,
    offsiteHost.username || 'root'
  );

  if (!validation || !validation.success) {
    return {
      ok: false,
      path: poolPath,
      reason: (validation && validation.error) || 'Path validation failed (missing, not writable, or not mounted)',
    };
  }

  // A successful validation means the path exists, is writable, and resides on
  // a mounted filesystem. Disk stats are returned under validation.data.
  const stats = validation.data || {};
  const snapshot = {
    status: 'active',
    lastError: null,
    mounted: true,
    totalGB: stats.totalGB != null ? stats.totalGB : null,
    usedGB: stats.usedGB != null ? stats.usedGB : null,
    availableGB: stats.availableGB != null ? stats.availableGB : null,
    usagePercent: stats.usagePercent != null ? stats.usagePercent : null,
  };

  return { ok: true, path: poolPath, snapshot };
}

// GET /api/offsite-hosts/:id/pools - list pools for an offsite host
router.get('/:id/pools', async (req, res, next) => {
  try {
    const hosts = await getOffsiteHosts();
    const host = hosts.find(h => h.id === req.params.id);

    if (!host) {
      return res.status(404).json({ success: false, error: 'Offsite host not found' });
    }

    res.json({ success: true, data: host.storagePools || [] });
  } catch (error) {
    next(error);
  }
});

// POST /api/offsite-hosts/:id/pools - add a pool to an offsite host
router.post('/:id/pools', async (req, res, next) => {
  try {
    const { name, path: poolPath, diskUsageThreshold } = req.body;

    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, error: 'Pool name is required' });
    }

    const trimmedPath = (poolPath && String(poolPath).trim()) || '';
    if (!trimmedPath) {
      return res.status(400).json({ success: false, error: 'Pool path is required' });
    }
    if (!trimmedPath.startsWith('/')) {
      return res.status(400).json({
        success: false,
        error: 'Pool path must be an absolute path (start with /)'
      });
    }

    const hosts = await getOffsiteHosts();
    const host = hosts.find(h => h.id === req.params.id);

    if (!host) {
      return res.status(404).json({ success: false, error: 'Offsite host not found' });
    }

    if (!Array.isArray(host.storagePools)) {
      host.storagePools = [];
    }

    // Validate the path over SSH before persisting. A pool is only stored when
    // its path exists, is writable, and is on a mounted filesystem (Req 5.1).
    const check = await validateOffsitePoolPath(host, trimmedPath);
    if (!check.ok) {
      return res.status(400).json({
        success: false,
        error: `Offsite pool path validation failed: ${check.reason}`,
        path: check.path,
        reason: check.reason,
      });
    }

    const now = new Date().toISOString();
    const newPool = {
      id: uuidv4(),
      name: String(name).trim(),
      path: trimmedPath,
      diskUsageThreshold: normalizeThreshold(diskUsageThreshold) ?? DEFAULT_DISK_USAGE_THRESHOLD,
      totalGB: check.snapshot.totalGB,
      usedGB: check.snapshot.usedGB,
      availableGB: check.snapshot.availableGB,
      usagePercent: check.snapshot.usagePercent,
      mounted: check.snapshot.mounted,
      status: check.snapshot.status,
      lastError: check.snapshot.lastError,
      createdAt: now,
      updatedAt: now,
    };

    host.storagePools.push(newPool);
    host.updatedAt = now;
    await saveOffsiteHosts(hosts);

    res.status(201).json({ success: true, data: newPool });
  } catch (error) {
    next(error);
  }
});

// PUT /api/offsite-hosts/:id/pools/:poolId - update a pool (rename / change path)
router.put('/:id/pools/:poolId', async (req, res, next) => {
  try {
    const hosts = await getOffsiteHosts();
    const host = hosts.find(h => h.id === req.params.id);

    if (!host) {
      return res.status(404).json({ success: false, error: 'Offsite host not found' });
    }

    const pool = (host.storagePools || []).find(p => p.id === req.params.poolId);
    if (!pool) {
      return res.status(404).json({ success: false, error: 'Storage pool not found' });
    }

    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) {
        return res.status(400).json({ success: false, error: 'Pool name is required' });
      }
      pool.name = name;
    }

    if (req.body.diskUsageThreshold !== undefined) {
      const t = normalizeThreshold(req.body.diskUsageThreshold);
      if (t === null) {
        return res.status(400).json({
          success: false,
          error: 'diskUsageThreshold must be an integer between 1 and 100'
        });
      }
      pool.diskUsageThreshold = t;
    }

    if (req.body.path !== undefined) {
      const trimmedPath = (req.body.path && String(req.body.path).trim()) || '';
      if (!trimmedPath) {
        return res.status(400).json({ success: false, error: 'Pool path is required' });
      }
      if (!trimmedPath.startsWith('/')) {
        return res.status(400).json({
          success: false,
          error: 'Pool path must be an absolute path (start with /)'
        });
      }

      // Only re-validate when the path actually changes. Reject the change (and
      // keep the previously stored, valid path) if validation fails (Req 5.1).
      if (trimmedPath !== pool.path) {
        const check = await validateOffsitePoolPath(host, trimmedPath);
        if (!check.ok) {
          return res.status(400).json({
            success: false,
            error: `Offsite pool path validation failed: ${check.reason}`,
            path: check.path,
            reason: check.reason,
          });
        }

        pool.path = trimmedPath;
        pool.status = check.snapshot.status;
        pool.lastError = check.snapshot.lastError;
        pool.mounted = check.snapshot.mounted;
        pool.totalGB = check.snapshot.totalGB;
        pool.usedGB = check.snapshot.usedGB;
        pool.availableGB = check.snapshot.availableGB;
        pool.usagePercent = check.snapshot.usagePercent;
      }
    }

    pool.updatedAt = new Date().toISOString();
    host.updatedAt = pool.updatedAt;
    await saveOffsiteHosts(hosts);

    res.json({ success: true, data: pool });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/offsite-hosts/:id/pools/:poolId - remove a pool
router.delete('/:id/pools/:poolId', async (req, res, next) => {
  try {
    const hosts = await getOffsiteHosts();
    const host = hosts.find(h => h.id === req.params.id);

    if (!host) {
      return res.status(404).json({ success: false, error: 'Offsite host not found' });
    }

    const pools = host.storagePools || [];
    const index = pools.findIndex(p => p.id === req.params.poolId);
    if (index === -1) {
      return res.status(404).json({ success: false, error: 'Storage pool not found' });
    }

    // Block deletion when any schedule still references this offsite host + pool
    // as a replication target. Deleting it would orphan those selections, so we
    // return 409 and list the referencing schedules (Req 1.3).
    const schedules = await getBackupSchedules();
    const referencingSchedules = (schedules || []).filter(schedule =>
      Array.isArray(schedule.offsiteTargets) &&
      schedule.offsiteTargets.some(
        t => t && t.offsiteHostId === host.id && t.offsitePoolId === req.params.poolId
      )
    );

    if (referencingSchedules.length > 0) {
      const referencedBy = referencingSchedules.map(s => ({ id: s.id, name: s.name }));
      const names = referencedBy
        .map(s => s.name || s.id)
        .filter(Boolean)
        .join(', ');
      return res.status(409).json({
        success: false,
        error: `Cannot delete storage pool: it is referenced by ${referencingSchedules.length} schedule(s): ${names}`,
        referencedBy,
      });
    }

    const deleted = pools.splice(index, 1)[0];
    host.storagePools = pools;
    host.updatedAt = new Date().toISOString();
    await saveOffsiteHosts(hosts);

    res.json({ success: true, data: { id: deleted.id } });
  } catch (error) {
    next(error);
  }
});

// POST /api/offsite-hosts/:id/pools/:poolId/validate - re-validate path + free space
// SSH path validation logic is finalized in a later task; this wires the route
// to the agent service and records the validation snapshot on the pool.
router.post('/:id/pools/:poolId/validate', async (req, res, next) => {
  try {
    const hosts = await getOffsiteHosts();
    const host = hosts.find(h => h.id === req.params.id);

    if (!host) {
      return res.status(404).json({ success: false, error: 'Offsite host not found' });
    }

    const pool = (host.storagePools || []).find(p => p.id === req.params.poolId);
    if (!pool) {
      return res.status(404).json({ success: false, error: 'Storage pool not found' });
    }

    const check = await validateOffsitePoolPath(host, pool.path);

    if (check.ok) {
      pool.status = check.snapshot.status;
      pool.lastError = check.snapshot.lastError;
      pool.mounted = check.snapshot.mounted;
      pool.totalGB = check.snapshot.totalGB;
      pool.usedGB = check.snapshot.usedGB;
      pool.availableGB = check.snapshot.availableGB;
      pool.usagePercent = check.snapshot.usagePercent;
    } else {
      pool.status = 'error';
      pool.lastError = check.reason;
    }
    pool.updatedAt = new Date().toISOString();
    host.updatedAt = pool.updatedAt;
    await saveOffsiteHosts(hosts);

    res.json({
      success: check.ok,
      data: pool,
      validation: check.ok
        ? { success: true, snapshot: check.snapshot }
        : { success: false, path: check.path, reason: check.reason },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
