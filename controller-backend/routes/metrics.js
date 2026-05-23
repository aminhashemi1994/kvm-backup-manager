const express = require('express');
const router = express.Router();
const agentService = require('../services/agentService');
const remoteMetricsService = require('../services/remoteMetricsService');
const { getBackupHosts } = require('../services/fileStorage');

// GET /api/metrics/debug - Debug endpoint to see all cached metrics (must be before :backupHostId route)
router.get('/debug', async (req, res, next) => {
  try {
    const hypervisorMetrics = remoteMetricsService.getAllHypervisorMetrics();
    const offsiteMetrics = remoteMetricsService.getAllOffsiteMetrics();
    
    res.json({
      success: true,
      data: {
        hypervisors: hypervisorMetrics,
        offsite: offsiteMetrics
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/metrics/:backupHostId - Get metrics for a specific backup host
router.get('/:backupHostId', async (req, res, next) => {
  try {
    const { backupHostId } = req.params;

    const hosts = await getBackupHosts();
    const host = hosts.find(h => h.id === backupHostId);
    
    if (!host) {
      return res.status(404).json({ success: false, error: 'Backup host not found' });
    }

    const result = await agentService.getMetrics(host.url);
    
    if (result.success) {
      res.json({
        success: true,
        data: {
          ...result.data,
          backupHostId: host.id,
          backupHostName: host.name,
          backupHostUrl: host.url
        }
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error || 'Failed to fetch metrics'
      });
    }
  } catch (error) {
    next(error);
  }
});

// GET /api/metrics/hypervisors/all - Get metrics for all hypervisors
router.get('/hypervisors/all', async (req, res, next) => {
  try {
    const metrics = remoteMetricsService.getAllHypervisorMetrics();
    res.json({
      success: true,
      data: metrics
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/metrics/hypervisors/:hypervisorId - Get metrics for a specific hypervisor
router.get('/hypervisors/:hypervisorId', async (req, res, next) => {
  try {
    const metrics = remoteMetricsService.getHypervisorMetrics(req.params.hypervisorId);
    
    if (!metrics) {
      return res.status(404).json({
        success: false,
        error: 'Metrics not available yet. Please wait for next collection cycle.'
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

// GET /api/metrics/offsite/all - Get metrics for all offsite hosts
router.get('/offsite/all', async (req, res, next) => {
  try {
    const metrics = remoteMetricsService.getAllOffsiteMetrics();
    res.json({
      success: true,
      data: metrics
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/metrics/offsite/:offsiteId - Get metrics for a specific offsite host
router.get('/offsite/:offsiteId', async (req, res, next) => {
  try {
    const metrics = remoteMetricsService.getOffsiteMetrics(req.params.offsiteId);
    
    if (!metrics) {
      return res.status(404).json({
        success: false,
        error: 'Metrics not available yet. Please wait for next collection cycle.'
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

// POST /api/metrics/collect - Manually trigger metrics collection
router.post('/collect', async (req, res, next) => {
  try {
    console.log('[Metrics] Manual collection triggered');
    await remoteMetricsService.collectAllMetrics();
    
    res.json({
      success: true,
      message: 'Metrics collection triggered successfully'
    });
  } catch (error) {
    console.error('[Metrics] Manual collection failed:', error);
    next(error);
  }
});

module.exports = router;
