const express = require('express');
const router = express.Router();
const concurrencyConfigSyncService = require('../services/concurrencyConfigSyncService');

/**
 * GET /api/concurrency-config/status
 * Returns the cached value plus last-sync timestamp.
 */
router.get('/status', (req, res, next) => {
  try {
    res.json({
      success: true,
      data: concurrencyConfigSyncService.getStatus(),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/concurrency-config/refresh
 * Force an out-of-band sync. Useful for the controller to push "you just
 * changed the value, refetch now" without waiting for the 60-second
 * interval.
 */
router.post('/refresh', async (req, res, next) => {
  try {
    const result = await concurrencyConfigSyncService.refreshNow();
    if (result.success) {
      return res.json({
        success: true,
        data: concurrencyConfigSyncService.getStatus(),
      });
    }
    return res.status(502).json({
      success: false,
      error: result.error,
      data: concurrencyConfigSyncService.getStatus(),
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
