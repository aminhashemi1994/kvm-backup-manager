const express = require('express');
const router = express.Router();
const healthCheckService = require('../services/healthCheckService');

// GET /api/health-check/status - Get health check service status
router.get('/status', async (req, res, next) => {
  try {
    const status = healthCheckService.getStatus();
    res.json({
      success: true,
      data: status
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/health-check/trigger - Manually trigger health check
router.post('/trigger', async (req, res, next) => {
  try {
    // Trigger health check asynchronously
    healthCheckService.triggerManualCheck().catch(error => {
      console.error('[HealthCheck API] Error during manual trigger:', error);
    });
    
    res.json({
      success: true,
      message: 'Health check triggered successfully',
      data: {
        triggered: true,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
