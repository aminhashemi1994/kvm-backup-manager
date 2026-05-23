const express = require('express');
const router = express.Router();
const { getBackupHosts } = require('../services/fileStorage');
const agentService = require('../services/agentService');

// GET /api/backup-removal/:backupHostId/vms - List all VM names on a backup host
router.get('/:backupHostId/vms', async (req, res, next) => {
  try {
    const { backupHostId } = req.params;

    // Get backup host details
    const backupHosts = await getBackupHosts();
    const backupHost = backupHosts.find(h => h.id === backupHostId);

    if (!backupHost) {
      return res.status(404).json({
        success: false,
        error: 'Backup host not found',
      });
    }

    // Forward request to agent with JWT authentication
    const client = agentService.createAgentClient(backupHost.url, backupHostId, backupHost.name);
    const response = await client.get('/api/backup-removal/vms', { timeout: 30000 });

    res.json(response.data);
  } catch (error) {
    console.error('Error listing VMs:', error.message);
    if (error.response) {
      return res.status(error.response.status).json(error.response.data);
    }
    next(error);
  }
});

// GET /api/backup-removal/:backupHostId/vm/:vmName/details - Get detailed backup info for a VM
router.get('/:backupHostId/vm/:vmName/details', async (req, res, next) => {
  try {
    const { backupHostId, vmName } = req.params;

    // Get backup host details
    const backupHosts = await getBackupHosts();
    const backupHost = backupHosts.find(h => h.id === backupHostId);

    if (!backupHost) {
      return res.status(404).json({
        success: false,
        error: 'Backup host not found',
      });
    }

    // Forward request to agent with JWT authentication (this may take several minutes)
    const client = agentService.createAgentClient(backupHost.url, backupHostId, backupHost.name);
    const response = await client.get(`/api/backup-removal/vm/${encodeURIComponent(vmName)}/details`, { timeout: 600000 }); // 10 minute timeout

    res.json(response.data);
  } catch (error) {
    console.error('Error getting VM details:', error.message);
    if (error.response) {
      return res.status(error.response.status).json(error.response.data);
    }
    next(error);
  }
});

// DELETE /api/backup-removal/:backupHostId/schedule - Remove specific schedule backup
router.delete('/:backupHostId/schedule', async (req, res, next) => {
  try {
    const { backupHostId } = req.params;
    const { vmName, scheduleType } = req.body;

    if (!vmName || !scheduleType) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: vmName, scheduleType',
      });
    }

    // Get backup host details
    const backupHosts = await getBackupHosts();
    const backupHost = backupHosts.find(h => h.id === backupHostId);

    if (!backupHost) {
      return res.status(404).json({
        success: false,
        error: 'Backup host not found',
      });
    }

    // Forward request to agent with JWT authentication
    const client = agentService.createAgentClient(backupHost.url, backupHostId, backupHost.name);
    const response = await client.delete('/api/backup-removal/schedule', {
      data: { vmName, scheduleType },
      timeout: 60000,
    });

    res.json(response.data);
  } catch (error) {
    console.error('Error removing schedule backup:', error.message);
    if (error.response) {
      return res.status(error.response.status).json(error.response.data);
    }
    next(error);
  }
});

// DELETE /api/backup-removal/:backupHostId/vm - Remove entire VM backup directory
router.delete('/:backupHostId/vm', async (req, res, next) => {
  try {
    const { backupHostId } = req.params;
    const { vmName } = req.body;

    if (!vmName) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: vmName',
      });
    }

    // Get backup host details
    const backupHosts = await getBackupHosts();
    const backupHost = backupHosts.find(h => h.id === backupHostId);

    if (!backupHost) {
      return res.status(404).json({
        success: false,
        error: 'Backup host not found',
      });
    }

    // Forward request to agent with JWT authentication
    const client = agentService.createAgentClient(backupHost.url, backupHostId, backupHost.name);
    const response = await client.delete('/api/backup-removal/vm', {
      data: { vmName },
      timeout: 60000,
    });

    res.json(response.data);
  } catch (error) {
    console.error('Error removing VM backup:', error.message);
    if (error.response) {
      return res.status(error.response.status).json(error.response.data);
    }
    next(error);
  }
});

module.exports = router;
