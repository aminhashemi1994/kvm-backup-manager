const express = require('express');
const router = express.Router();
const agentService = require('../services/agentService');
const { getBackupHosts } = require('../services/fileStorage');

// POST /api/fix-backup - Trigger fix backup on agent
router.post('/', async (req, res, next) => {
  try {
    const { vmId, vmName, hypervisorIp, backupHostId } = req.body;

    console.log('Fix backup request:', { vmId, vmName, hypervisorIp, backupHostId });

    if (!vmName || !hypervisorIp || !backupHostId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: vmName, hypervisorIp, backupHostId',
      });
    }

    // Get backup host details
    const backupHosts = await getBackupHosts();
    const backupHost = backupHosts.find(h => h.id === backupHostId);

    if (!backupHost) {
      console.error('Backup host not found:', backupHostId);
      return res.status(404).json({
        success: false,
        error: 'Backup host not found',
      });
    }

    // Forward request to agent with JWT authentication
    console.log('Forwarding to agent:', backupHost.url);
    
    const client = agentService.createAgentClient(backupHost.url, backupHost.id, backupHost.name);
    const response = await client.post('/api/fix-backup', {
      vmName,
      hypervisorIp,
    }, {
      timeout: 300000, // 5 minutes timeout
    });

    console.log('Agent response:', response.data);
    res.json(response.data);
  } catch (error) {
    console.error('Fix backup error:', error.message);
    if (error.response) {
      console.error('Agent error response:', error.response.data);
      return res.status(error.response.status).json(error.response.data);
    }
    console.error('Error details:', error);
    next(error);
  }
});

module.exports = router;
