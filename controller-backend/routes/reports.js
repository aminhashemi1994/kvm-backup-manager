const express = require('express');
const router = express.Router();
const agentService = require('../services/agentService');
const { getBackupHosts } = require('../services/fileStorage');

// GET /api/reports/:backupHostId - Get backup report for a specific backup host
router.get('/:backupHostId', async (req, res, next) => {
  try {
    const { backupHostId } = req.params;

    // Get backup host
    const hosts = await getBackupHosts();
    const host = hosts.find(h => h.id === backupHostId);
    
    if (!host) {
      return res.status(404).json({ success: false, error: 'Backup host not found' });
    }

    // Fetch report from agent
    try {
      const result = await agentService.getBackupReport(host.url);
      
      if (result.success) {
        res.json({
          success: true,
          data: {
            ...result.data,
            backupHostId: host.id,
            backupHostName: host.name,
            backupHostUrl: host.url
          },
          meta: {
            ...result.meta,
            isGenerating: result.meta?.isGenerating || false
          }
        });
      } else {
        // Report doesn't exist
        res.status(404).json({
          success: false,
          error: result.error || 'Report not found',
          isGenerating: result.isGenerating || false,
          backupHostId: host.id,
          backupHostName: host.name
        });
      }
    } catch (agentError) {
      // Handle agent errors gracefully
      console.error(`Error fetching report from agent ${host.name}:`, agentError.message);
      
      // Check if it's a connection error
      if (agentError.code === 'ECONNREFUSED' || agentError.code === 'ETIMEDOUT') {
        return res.status(503).json({
          success: false,
          error: `Cannot connect to backup agent: ${host.name}`,
          backupHostId: host.id,
          backupHostName: host.name
        });
      }
      
      // Check if agent returned an error response
      if (agentError.response) {
        return res.status(agentError.response.status).json({
          success: false,
          error: agentError.response.data?.error || 'Agent returned an error',
          backupHostId: host.id,
          backupHostName: host.name
        });
      }
      
      // Unknown error
      return res.status(500).json({
        success: false,
        error: `Failed to fetch report: ${agentError.message}`,
        backupHostId: host.id,
        backupHostName: host.name
      });
    }
  } catch (error) {
    next(error);
  }
});

// GET /api/reports/:backupHostId/status - Get report status
router.get('/:backupHostId/status', async (req, res, next) => {
  try {
    const { backupHostId } = req.params;

    const hosts = await getBackupHosts();
    const host = hosts.find(h => h.id === backupHostId);
    
    if (!host) {
      return res.status(404).json({ success: false, error: 'Backup host not found' });
    }

    const result = await agentService.getBackupReportStatus(host.url);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// POST /api/reports/:backupHostId/generate - Trigger report generation
router.post('/:backupHostId/generate', async (req, res, next) => {
  try {
    const { backupHostId } = req.params;

    const hosts = await getBackupHosts();
    const host = hosts.find(h => h.id === backupHostId);
    
    if (!host) {
      return res.status(404).json({ success: false, error: 'Backup host not found' });
    }

    try {
      const result = await agentService.generateBackupReport(host.url);
      
      // Check if already generating
      if (result.isGenerating) {
        return res.status(409).json(result);
      }
      
      // Check if rate limited
      if (result.rateLimited) {
        return res.status(429).json(result);
      }
      
      // Success
      res.status(200).json(result);
    } catch (error) {
      // Handle specific error responses from agent
      if (error.response) {
        if (error.response.status === 409) {
          return res.status(409).json(error.response.data);
        }
        if (error.response.status === 429) {
          return res.status(429).json(error.response.data);
        }
      }
      throw error;
    }
  } catch (error) {
    next(error);
  }
});

module.exports = router;
