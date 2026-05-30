const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const agentService = require('../services/agentService');
const {
  getBackupHosts,
  getRestoreStoragePools,
  saveRestoreStoragePools,
} = require('../services/fileStorage');

// All persistence routed through fileStorage's atomic write helpers.
// The previous local helpers used fs.writeFile, which could leave the
// JSON truncated under crash conditions.

// GET /api/restore-storage-pools - Get all restore storage pools
router.get('/', async (req, res, next) => {
  try {
    const pools = await getRestoreStoragePools();
    res.json({ success: true, data: pools });
  } catch (error) {
    next(error);
  }
});

// GET /api/restore-storage-pools/backup-host/:backupHostId - Get restore pools by backup host
router.get('/backup-host/:backupHostId', async (req, res, next) => {
  try {
    const { backupHostId } = req.params;
    const pools = await getRestoreStoragePools();
    const filtered = pools.filter(p => p.backupHostId === backupHostId);
    res.json({ success: true, data: filtered });
  } catch (error) {
    next(error);
  }
});

// GET /api/restore-storage-pools/:id - Get single restore storage pool
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const pools = await getRestoreStoragePools();
    const pool = pools.find(p => p.id === id);
    
    if (!pool) {
      return res.status(404).json({ success: false, error: 'Restore storage pool not found' });
    }
    
    res.json({ success: true, data: pool });
  } catch (error) {
    next(error);
  }
});

// POST /api/restore-storage-pools - Create new restore storage pool
router.post('/', async (req, res, next) => {
  try {
    const { backupHostId, name, path } = req.body;

    if (!backupHostId || !name || !path) {
      return res.status(400).json({
        success: false,
        error: 'backupHostId, name, and path are required'
      });
    }

    // Get backup host
    const backupHosts = await getBackupHosts();
    const backupHost = backupHosts.find(h => h.id === backupHostId);
    
    if (!backupHost) {
      return res.status(404).json({ success: false, error: 'Backup host not found' });
    }

    // Validate path on agent
    const validation = await agentService.validateStoragePool(backupHost.url, path);
    
    if (!validation.success) {
      return res.status(400).json({
        success: false,
        error: validation.error || 'Failed to validate restore storage pool path'
      });
    }

    // Create restore pool
    const newPool = {
      id: uuidv4(),
      backupHostId,
      name,
      path,
      mountPoint: validation.data.mountPoint,
      device: validation.data.device,
      totalGB: validation.data.totalGB || 0,
      usedGB: validation.data.usedGB || 0,
      availableGB: validation.data.availableGB || 0,
      usagePercent: validation.data.usagePercent || 0,
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const pools = await getRestoreStoragePools();
    pools.push(newPool);
    await saveRestoreStoragePools(pools);

    console.log(`[RestoreStoragePools] Created: ${name} at ${path}`);
    res.json({ success: true, data: newPool });
  } catch (error) {
    console.error('[RestoreStoragePools] Create error:', error);
    next(error);
  }
});

// PUT /api/restore-storage-pools/:id - Update restore storage pool
router.put('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, path } = req.body;

    const pools = await getRestoreStoragePools();
    const index = pools.findIndex(p => p.id === id);
    
    if (index === -1) {
      return res.status(404).json({ success: false, error: 'Restore storage pool not found' });
    }

    const pool = pools[index];

    // If path changed, validate it
    if (path && path !== pool.path) {
      const backupHosts = await getBackupHosts();
      const backupHost = backupHosts.find(h => h.id === pool.backupHostId);
      
      if (backupHost) {
        const validation = await agentService.validateStoragePool(backupHost.url, path);
        
        if (!validation.success) {
          return res.status(400).json({
            success: false,
            error: validation.error || 'Failed to validate new path'
          });
        }

        pool.mountPoint = validation.data.mountPoint;
        pool.device = validation.data.device;
        pool.totalGB = validation.data.totalGB || pool.totalGB;
        pool.usedGB = validation.data.usedGB || pool.usedGB;
        pool.availableGB = validation.data.availableGB || pool.availableGB;
        pool.usagePercent = validation.data.usagePercent || pool.usagePercent;
      }
    }

    // Update fields
    if (name) pool.name = name;
    if (path) pool.path = path;
    pool.updatedAt = new Date().toISOString();

    pools[index] = pool;
    await saveRestoreStoragePools(pools);

    console.log(`[RestoreStoragePools] Updated: ${pool.name}`);
    res.json({ success: true, data: pool });
  } catch (error) {
    console.error('[RestoreStoragePools] Update error:', error);
    next(error);
  }
});

// DELETE /api/restore-storage-pools/:id - Delete restore storage pool
router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    const pools = await getRestoreStoragePools();
    const filtered = pools.filter(p => p.id !== id);
    
    if (filtered.length === pools.length) {
      return res.status(404).json({ success: false, error: 'Restore storage pool not found' });
    }

    await saveRestoreStoragePools(filtered);

    console.log(`[RestoreStoragePools] Deleted: ${id}`);
    res.json({ success: true, message: 'Restore storage pool deleted successfully' });
  } catch (error) {
    console.error('[RestoreStoragePools] Delete error:', error);
    next(error);
  }
});

// POST /api/restore-storage-pools/:id/refresh - Refresh restore storage pool metrics
router.post('/:id/refresh', async (req, res, next) => {
  try {
    const { id } = req.params;

    const pools = await getRestoreStoragePools();
    const index = pools.findIndex(p => p.id === id);
    
    if (index === -1) {
      return res.status(404).json({ success: false, error: 'Restore storage pool not found' });
    }

    const pool = pools[index];

    // Get backup host
    const backupHosts = await getBackupHosts();
    const backupHost = backupHosts.find(h => h.id === pool.backupHostId);
    
    if (!backupHost) {
      return res.status(404).json({ success: false, error: 'Backup host not found' });
    }

    // Validate/refresh metrics
    const validation = await agentService.validateStoragePool(backupHost.url, pool.path);
    
    if (!validation.success) {
      pool.status = 'inactive';
    } else {
      pool.status = 'active';
      pool.mountPoint = validation.data.mountPoint;
      pool.device = validation.data.device;
      pool.totalGB = validation.data.totalGB || pool.totalGB;
      pool.usedGB = validation.data.usedGB || pool.usedGB;
      pool.availableGB = validation.data.availableGB || pool.availableGB;
      pool.usagePercent = validation.data.usagePercent || pool.usagePercent;
    }

    pool.updatedAt = new Date().toISOString();
    pools[index] = pool;
    await saveRestoreStoragePools(pools);

    console.log(`[RestoreStoragePools] Refreshed: ${pool.name}`);
    res.json({ success: true, data: pool });
  } catch (error) {
    console.error('[RestoreStoragePools] Refresh error:', error);
    next(error);
  }
});

module.exports = router;
