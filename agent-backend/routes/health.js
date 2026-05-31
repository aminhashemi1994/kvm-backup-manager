const express = require('express');
const router = express.Router();
const os = require('os');
const backupExecutor = require('../services/backupExecutor');
const concurrencyConfigSyncService = require('../services/concurrencyConfigSyncService');

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
