const express = require('express');
const router = express.Router();
const os = require('os');
const pkg = require('../package.json');
const backupExecutor = require('../services/backupExecutor');
const concurrencyConfigSyncService = require('../services/concurrencyConfigSyncService');
const controllerTlsService = require('../services/controllerTlsService');
const controllerOutbox = require('../services/controllerOutbox');

// GET /api/health - Health check
router.get('/', async (req, res) => {
  const config = req.app.get('config');
  
  res.json({
    success: true,
    status: 'ok',
    service: 'agent',
    timestamp: new Date().toISOString(),
    system: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      uptime: os.uptime(),
      loadAvg: os.loadavg(),
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
    },
    config: {
      backupPath: config.backupPath,
      restorePath: config.restorePath,
      // Pulled from the controller; see concurrencyConfigSyncService.
      maxConcurrentBackups: concurrencyConfigSyncService.getMaxConcurrent(),
      concurrencyConfigLastSync: concurrencyConfigSyncService.getStatus().lastSync,
    },
    jobs: {
      active: backupExecutor.getActiveJobs().length,
      queued: backupExecutor.getQueuedJobs().length,
    },
    // The controller polls this on its health-check loop, so a degraded
    // certificate on the agent's side of the link surfaces in the panel even
    // when the controller's own cert is fine.
    tls: controllerTlsService.getState(),
    outbox: controllerOutbox.getStatus(),
    version: pkg.version,
    /**
     * What this agent can actually do, stated outright.
     *
     * The controller used to infer "this agent is too old to replicate" from a
     * 404 on /api/offsite/sync. A 404 has several other causes — a reverse
     * proxy that does not forward that path, a process still running old code
     * after a deploy — and every one of them was reported to the operator as
     * "agent too old", which sends them to update an agent that is already
     * current. An explicit flag cannot be guessed wrong: if this key is
     * present and true, the endpoint exists in this process.
     */
    capabilities: {
      offsiteSync: true,
      replicationCheck: true,
    },
  });
});

// GET /api/health/detailed - Detailed health check
router.get('/detailed', async (req, res) => {
  const config = req.app.get('config');
  const fs = require('fs').promises;
  
  // Check backup path accessibility
  let backupPathOk = false;
  try {
    await fs.access(config.backupPath);
    backupPathOk = true;
  } catch (e) {
    // Path not accessible
  }

  // Check restore path accessibility
  let restorePathOk = false;
  try {
    await fs.access(config.restorePath);
    restorePathOk = true;
  } catch (e) {
    // Path not accessible
  }

  res.json({
    success: true,
    checks: {
      backupPath: {
        path: config.backupPath,
        accessible: backupPathOk,
      },
      restorePath: {
        path: config.restorePath,
        accessible: restorePathOk,
      },
    },
    activeJobs: backupExecutor.getActiveJobs(),
    queuedJobs: backupExecutor.getQueuedJobs(),
  });
});

module.exports = router;
