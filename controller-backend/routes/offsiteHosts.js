const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { getOffsiteHosts, saveOffsiteHosts, getBackupHosts, getStoragePools } = require('../services/fileStorage');
const agentService = require('../services/agentService');

// Helper to ensure URL has protocol
function ensureProtocol(url) {
  if (!url) return url;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return 'http://' + url;
  }
  return url;
}

// GET /api/offsite-hosts
router.get('/', async (req, res, next) => {
  try {
    const hosts = await getOffsiteHosts();
    res.json({ success: true, data: hosts });
  } catch (error) {
    next(error);
  }
});

// GET /api/offsite-hosts/backup-host/:backupHostId
router.get('/backup-host/:backupHostId', async (req, res, next) => {
  try {
    const hosts = await getOffsiteHosts();
    const filtered = hosts.filter(h => h.backupHostId === req.params.backupHostId);
    res.json({ success: true, data: filtered });
  } catch (error) {
    next(error);
  }
});

// POST /api/offsite-hosts
// NOTE: Offsite backup is handled by backup_manager.sh script
// SSH keys and paths are configured manually on the backup host server
router.post('/', async (req, res, next) => {
  try {
    const { backupHostId, name, ip, username } = req.body;

    if (!backupHostId || !name || !ip) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: backupHostId, name, ip' 
      });
    }

    // Verify backup host exists
    const backupHosts = await getBackupHosts();
    const backupHost = backupHosts.find(h => h.id === backupHostId);
    if (!backupHost) {
      return res.status(400).json({ success: false, error: 'Backup host not found' });
    }

    const hosts = await getOffsiteHosts();

    const newHost = {
      id: uuidv4(),
      backupHostId,
      name,
      ip,
      username: username || 'root',
      status: 'pending',
      lastSync: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Test connection via agent (basic ping test)
    let hostUrl = null;
    if (backupHost.status === 'online') {
      try {
        hostUrl = ensureProtocol(backupHost.url);
        const result = await agentService.testOffsiteConnection(hostUrl, { ip: newHost.ip });
        newHost.status = result.success ? 'connected' : 'error';
        if (!result.success) {
          newHost.lastError = result.message;
        }
      } catch (error) {
        newHost.status = 'error';
        newHost.lastError = error.message;
      }

      // Validate all storage pools exist on this offsite host
      if (hostUrl) {
        const storagePools = await getStoragePools();
        const backupHostPools = storagePools.filter(p => p.backupHostId === backupHostId);
        
        const poolValidationErrors = [];
        for (const pool of backupHostPools) {
          const validation = await agentService.validateOffsiteStoragePool(
            hostUrl,
            pool.path,
            newHost.ip,
            newHost.username
          );
          
          if (!validation.success) {
            poolValidationErrors.push({
              poolName: pool.name,
              path: pool.path,
              error: validation.error
            });
          }
        }

        // If any storage pool validation failed, return error
        if (poolValidationErrors.length > 0) {
          const errorMessages = poolValidationErrors.map(e => 
          `${e.poolName} (${e.path}): ${e.error}`
        ).join('; ');
        
        return res.status(400).json({
          success: false,
          error: `Storage pool validation failed on offsite host: ${errorMessages}`,
          poolErrors: poolValidationErrors
        });
        }
      }
    }

    hosts.push(newHost);
    await saveOffsiteHosts(hosts);

    res.status(201).json({ success: true, data: newHost });
  } catch (error) {
    next(error);
  }
});

// PUT /api/offsite-hosts/:id - Update offsite host
router.put('/:id', async (req, res, next) => {
  try {
    const hosts = await getOffsiteHosts();
    const index = hosts.findIndex(h => h.id === req.params.id);
    
    if (index === -1) {
      return res.status(404).json({ success: false, error: 'Offsite host not found' });
    }

    const host = hosts[index];
    
    // Update fields
    if (req.body.name !== undefined) host.name = req.body.name;
    if (req.body.ip !== undefined) host.ip = req.body.ip;
    if (req.body.username !== undefined) host.username = req.body.username;
    host.updatedAt = new Date().toISOString();

    await saveOffsiteHosts(hosts);
    res.json({ success: true, data: host });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/offsite-hosts/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const hosts = await getOffsiteHosts();
    const index = hosts.findIndex(h => h.id === req.params.id);
    
    if (index === -1) {
      return res.status(404).json({ success: false, error: 'Offsite host not found' });
    }

    const deleted = hosts.splice(index, 1)[0];
    await saveOffsiteHosts(hosts);

    res.json({ success: true, data: { id: deleted.id } });
  } catch (error) {
    next(error);
  }
});

// POST /api/offsite-hosts/:id/test
router.post('/:id/test', async (req, res, next) => {
  try {
    const hosts = await getOffsiteHosts();
    const host = hosts.find(h => h.id === req.params.id);
    
    if (!host) {
      return res.status(404).json({ success: false, error: 'Offsite host not found' });
    }

    const backupHosts = await getBackupHosts();
    const backupHost = backupHosts.find(h => h.id === host.backupHostId);
    
    if (!backupHost || backupHost.status !== 'online') {
      return res.status(400).json({ success: false, error: 'Backup host is offline' });
    }

    const hostUrl = ensureProtocol(backupHost.url);
    const result = await agentService.testOffsiteConnection(hostUrl, { ip: host.ip });

    host.status = result.success ? 'connected' : 'error';
    host.lastError = result.success ? null : result.message;
    host.updatedAt = new Date().toISOString();
    await saveOffsiteHosts(hosts);

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// POST /api/offsite-hosts/:id/init - Initialize offsite host with dependencies
router.post('/:id/init', async (req, res, next) => {
  try {
    const hosts = await getOffsiteHosts();
    const host = hosts.find(h => h.id === req.params.id);
    
    if (!host) {
      return res.status(404).json({ success: false, error: 'Offsite host not found' });
    }

    const backupHosts = await getBackupHosts();
    const backupHost = backupHosts.find(h => h.id === host.backupHostId);
    
    if (!backupHost || backupHost.status !== 'online') {
      return res.status(400).json({ success: false, error: 'Backup host is offline' });
    }

    // Call agent's init endpoint with offsite host IP
    const result = await agentService.initHost(backupHost.url, host.ip);
    
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
