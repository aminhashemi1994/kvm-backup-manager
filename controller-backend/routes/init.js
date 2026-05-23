const express = require('express');
const router = express.Router();
const agentService = require('../services/agentService');
const { getBackupHosts } = require('../services/fileStorage');

// POST /api/init/host - Initialize a backup host
router.post('/host', async (req, res, next) => {
  try {
    const { backupHostId } = req.body;

    if (!backupHostId) {
      return res.status(400).json({ 
        success: false, 
        error: 'backupHostId is required' 
      });
    }

    // Get backup host
    const hosts = await getBackupHosts();
    const host = hosts.find(h => h.id === backupHostId);
    
    if (!host) {
      return res.status(404).json({ success: false, error: 'Backup host not found' });
    }

    // Trigger init on agent (agent will run script locally)
    const result = await agentService.initHost(host.url);

    // Get io from app to forward events
    const io = req.app.get('io');
    const initId = result.data.initId;

    // Connect to agent's WebSocket to forward init events
    const agentUrl = host.url.startsWith('http') ? host.url : `http://${host.url}`;
    const ioClient = require('socket.io-client');
    const agentSocket = ioClient(agentUrl, {
      transports: ['websocket', 'polling'],
      reconnection: false,
    });

    agentSocket.on('connect', () => {
      console.log(`✓ Connected to agent ${host.name} for init ${initId}`);
      agentSocket.emit('subscribe-init', initId);
    });

    agentSocket.on('connect_error', (error) => {
      console.error(`✗ Failed to connect to agent ${host.name}:`, error.message);
    });

    // Forward init events from agent to frontend
    agentSocket.on('init-log', (data) => {
      if (data.initId === initId) {
        console.log(`[Controller] Forwarding init-log for ${initId}`);
        io.to(`init-${initId}`).emit('init-log', data);
      }
    });

    agentSocket.on('init-complete', (data) => {
      if (data.initId === initId) {
        console.log(`[Controller] Forwarding init-complete for ${initId}: success=${data.success}, exitCode=${data.exitCode}`);
        io.to(`init-${initId}`).emit('init-complete', data);
        agentSocket.disconnect();
      }
    });

    agentSocket.on('init-error', (data) => {
      if (data.initId === initId) {
        console.log(`[Controller] Forwarding init-error for ${initId}`);
        io.to(`init-${initId}`).emit('init-error', data);
        agentSocket.disconnect();
      }
    });

    res.status(202).json({ 
      success: true, 
      data: {
        ...result.data,
        backupHostId,
        backupHostName: host.name,
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/init/:initId/logs - Get init logs from agent
router.get('/:initId/logs', async (req, res, next) => {
  try {
    const { backupHostId } = req.query;

    if (!backupHostId) {
      return res.status(400).json({ 
        success: false, 
        error: 'backupHostId is required' 
      });
    }

    const hosts = await getBackupHosts();
    const host = hosts.find(h => h.id === backupHostId);
    
    if (!host) {
      return res.status(404).json({ success: false, error: 'Backup host not found' });
    }

    // Fetch logs from agent
    const result = await agentService.getInitLogs(host.url, req.params.initId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// GET /api/init/:initId/status - Get init status from agent
router.get('/:initId/status', async (req, res, next) => {
  try {
    const { backupHostId } = req.query;

    if (!backupHostId) {
      return res.status(400).json({ 
        success: false, 
        error: 'backupHostId is required' 
      });
    }

    const hosts = await getBackupHosts();
    const host = hosts.find(h => h.id === backupHostId);
    
    if (!host) {
      return res.status(404).json({ success: false, error: 'Backup host not found' });
    }

    // Fetch status from agent
    try {
      const client = agentService.createAgentClient(host.url, host.id, host.name);
      const response = await client.get('/api/init/active', { timeout: 5000 });
      
      const activeInits = response.data.data || [];
      const init = activeInits.find(i => i.initId === req.params.initId);
      
      res.json({ 
        success: true, 
        data: init || { status: 'completed', initId: req.params.initId }
      });
    } catch (error) {
      // If agent unreachable, assume completed
      res.json({ 
        success: true, 
        data: { status: 'completed', initId: req.params.initId }
      });
    }
  } catch (error) {
    next(error);
  }
});

module.exports = router;
