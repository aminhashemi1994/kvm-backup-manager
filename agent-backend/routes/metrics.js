const express = require('express');
const router = express.Router();
const metricsService = require('../services/metricsService');

/**
 * GET /api/metrics - Get all system metrics
 */
router.get('/', async (req, res, next) => {
  try {
    const metrics = await metricsService.getMetrics();
    res.json({
      success: true,
      data: metrics
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/metrics/mount-point - Get metrics for specific mount point
 */
router.get('/mount-point', async (req, res, next) => {
  try {
    const { path } = req.query;
    
    if (!path) {
      return res.status(400).json({
        success: false,
        error: 'path query parameter is required'
      });
    }

    const metrics = await metricsService.getMountPointMetrics(path);
    
    if (!metrics) {
      return res.status(404).json({
        success: false,
        error: 'Mount point not found'
      });
    }

    res.json({
      success: true,
      data: metrics
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
