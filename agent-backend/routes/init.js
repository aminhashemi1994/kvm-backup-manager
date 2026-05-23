const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const initHostService = require('../services/initHostService');

/**
 * POST /api/init/host
 * Initialize the local host with real-time WebSocket updates
 */
router.post('/host', async (req, res, next) => {
  try {
    const initId = uuidv4();

    // Start initialization in background (runs locally on this agent)
    initHostService.initHost(initId);

    // Return immediately with initId for tracking
    res.status(202).json({
      success: true,
      data: {
        initId,
        status: 'running',
        message: `Host initialization started. Subscribe to init-${initId} for real-time updates.`
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/init/:initId/logs
 * Get initialization logs
 */
router.get('/:initId/logs', async (req, res, next) => {
  try {
    const logs = await initHostService.readLog(req.params.initId);
    res.json({
      success: true,
      data: {
        initId: req.params.initId,
        logs,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/init/active
 * Get active initializations
 */
router.get('/active', async (req, res, next) => {
  try {
    const activeInits = initHostService.getActiveInits();
    res.json({
      success: true,
      data: activeInits,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/init/:initId/kill
 * Cancel/kill an initialization process
 */
router.post('/:initId/kill', async (req, res, next) => {
  try {
    const result = await initHostService.killInit(req.params.initId);
    
    if (result.success) {
      res.json({ success: true, message: result.message });
    } else {
      res.status(404).json({ success: false, error: result.message });
    }
  } catch (error) {
    next(error);
  }
});

module.exports = router;
