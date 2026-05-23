const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const agentService = require('../services/agentService');
const { 
  getStoragePools, 
  addStoragePool, 
  updateStoragePool, 
  deleteStoragePool,
  getBackupHosts,
  getOffsiteHosts
} = require('../services/fileStorage');

// GET /api/storage-pools - Get all storage pools
router.get('/', async (req, res, next) => {
  try {
    const pools = await getStoragePools();
    // Transform data to match frontend expectations
    const transformedPools = pools.map(pool => ({
      ...pool,
      isMountPoint: !!pool.mountPoint, // Convert mountPoint string to boolean
      lastChecked: pool.updatedAt || pool.createdAt, // Use updatedAt as lastChecked
      status: pool.status === 'active' ? 'online' : 'offline', // Map status
      usedPercentage: pool.usagePercent || 0 // Add usedPercentage alias
    }));
    res.json({ success: true, data: transformedPools });
  } catch (error) {
    next(error);
  }
});

// GET /api/storage-pools/backup-host/:backupHostId - Get pools for a backup host
router.get('/backup-host/:backupHostId', async (req, res, next) => {
  try {
    const pools = await getStoragePools();
    const filtered = pools.filter(p => p.backupHostId === req.params.backupHostId);
    // Transform data to match frontend expectations
    const transformedPools = filtered.map(pool => ({
      ...pool,
      isMountPoint: !!pool.mountPoint, // Convert mountPoint string to boolean
      lastChecked: pool.updatedAt || pool.createdAt, // Use updatedAt as lastChecked
      status: pool.status === 'active' ? 'online' : 'offline', // Map status
      usedPercentage: pool.usagePercent || 0 // Add usedPercentage alias
    }));
    res.json({ success: true, data: transformedPools });
  } catch (error) {
    next(error);
  }
});

// POST /api/storage-pools - Create a new storage pool
router.post('/', async (req, res, next) => {
  try {
    const { backupHostId, name, path } = req.body;

    console.log('[Storage Pools] Creating new storage pool:', { backupHostId, name, path });

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
      console.error('[Storage Pools] Backup host not found:', backupHostId);
      return res.status(404).json({
        success: false,
        error: 'Backup host not found'
      });
    }

    console.log('[Storage Pools] Found backup host:', backupHost.name);

    // Validate storage pool via agent
    console.log('[Storage Pools] Validating path on agent:', backupHost.url);
    const validation = await agentService.validateStoragePool(backupHost.url, path);
    
    if (!validation.success) {
      console.error('[Storage Pools] Validation failed:', validation.error);
      return res.status(400).json({
        success: false,
        error: validation.error || 'Storage pool validation failed'
      });
    }

    console.log('[Storage Pools] Validation successful:', validation.data);

    // Validate storage pool exists on all offsite hosts for this backup host
    const offsiteHosts = await getOffsiteHosts();
    const backupHostOffsiteHosts = offsiteHosts.filter(h => h.backupHostId === backupHostId);
    
    console.log('[Storage Pools] Checking offsite hosts:', backupHostOffsiteHosts.length);
    
    const offsiteValidationErrors = [];
    for (const offsiteHost of backupHostOffsiteHosts) {
      const offsiteValidation = await agentService.validateOffsiteStoragePool(
        backupHost.url,
        path,
        offsiteHost.ip,
        offsiteHost.username || 'root'
      );
      
      if (!offsiteValidation.success) {
        offsiteValidationErrors.push({
          host: offsiteHost.name,
          ip: offsiteHost.ip,
          error: offsiteValidation.error
        });
      }
    }

    // If any offsite validation failed, return error
    if (offsiteValidationErrors.length > 0) {
      const errorMessages = offsiteValidationErrors.map(e => 
        `${e.host} (${e.ip}): ${e.error}`
      ).join('; ');
      
      console.error('[Storage Pools] Offsite validation failed:', errorMessages);
      
      return res.status(400).json({
        success: false,
        error: `Storage pool validation failed on offsite hosts: ${errorMessages}`,
        offsiteErrors: offsiteValidationErrors
      });
    }

    const pool = {
      id: uuidv4(),
      backupHostId,
      backupHostName: backupHost.name,
      backupHostUrl: backupHost.url,
      name,
      path,
      mountPoint: validation.data.mountPoint,
      device: validation.data.device,
      totalGB: validation.data.totalGB,
      usedGB: validation.data.usedGB,
      availableGB: validation.data.availableGB,
      usagePercent: validation.data.usagePercent,
      offsitePath: validation.data.mountPoint, // Same mount point should exist on offsite hosts
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    console.log('[Storage Pools] Saving storage pool:', pool.id);
    await addStoragePool(pool);
    console.log('[Storage Pools] ✓ Storage pool saved successfully');
    
    // Notify agent to sync storage pools
    console.log('[Storage Pools] ═══════════════════════════════════════════════════');
    console.log('[Storage Pools] Notifying agent to sync storage pools');
    console.log('[Storage Pools] Backup Host ID:', backupHostId);
    console.log('[Storage Pools] Backup Host Name:', backupHost.name);
    console.log('[Storage Pools] Agent URL:', backupHost.url);
    console.log('[Storage Pools] Storage Pool Path:', path);
    console.log('[Storage Pools] ═══════════════════════════════════════════════════');
    
    const notifyResult = await agentService.notifyStoragePoolSync(backupHost.url);
    if (notifyResult.success) {
      console.log('[Storage Pools] ✓ Agent notified successfully');
    } else {
      console.error('[Storage Pools] ✗ Failed to notify agent:', notifyResult.error);
    }
    
    // Transform for response
    const response = {
      ...pool,
      isMountPoint: !!pool.mountPoint,
      lastChecked: pool.updatedAt,
      status: 'online',
      usedPercentage: pool.usagePercent
    };
    
    res.json({ success: true, data: response });
  } catch (error) {
    console.error('[Storage Pools] Error creating storage pool:', error);
    next(error);
  }
});

// PUT /api/storage-pools/:id - Update storage pool
router.put('/:id', async (req, res, next) => {
  try {
    const { name } = req.body;
    const pools = await getStoragePools();
    const pool = pools.find(p => p.id === req.params.id);

    if (!pool) {
      return res.status(404).json({
        success: false,
        error: 'Storage pool not found'
      });
    }

    // Get backup host
    const backupHosts = await getBackupHosts();
    const backupHost = backupHosts.find(h => h.id === pool.backupHostId);
    
    if (!backupHost) {
      return res.status(404).json({
        success: false,
        error: 'Backup host not found'
      });
    }

    // Refresh storage info
    const validation = await agentService.validateStoragePool(backupHost.url, pool.path);
    
    if (!validation.success) {
      return res.status(400).json({
        success: false,
        error: validation.error || 'Storage pool validation failed'
      });
    }

    const updates = {
      name: name || pool.name,
      totalGB: validation.data.totalGB,
      usedGB: validation.data.usedGB,
      availableGB: validation.data.availableGB,
      usagePercent: validation.data.usagePercent,
      updatedAt: new Date().toISOString()
    };

    await updateStoragePool(req.params.id, updates);
    
    // Notify agent to sync storage pools
    console.log('[Storage Pools] ═══════════════════════════════════════════════════');
    console.log('[Storage Pools] Notifying agent to sync after update');
    console.log('[Storage Pools] Backup Host ID:', pool.backupHostId);
    console.log('[Storage Pools] Backup Host Name:', backupHost.name);
    console.log('[Storage Pools] Agent URL:', backupHost.url);
    console.log('[Storage Pools] Storage Pool Path:', pool.path);
    console.log('[Storage Pools] ═══════════════════════════════════════════════════');
    
    const notifyResult = await agentService.notifyStoragePoolSync(backupHost.url);
    if (notifyResult.success) {
      console.log('[Storage Pools] ✓ Agent notified successfully');
    } else {
      console.error('[Storage Pools] ✗ Failed to notify agent:', notifyResult.error);
    }
    
    // Transform for response
    const response = {
      ...pool,
      ...updates,
      isMountPoint: !!pool.mountPoint,
      lastChecked: updates.updatedAt,
      status: 'online',
      usedPercentage: updates.usagePercent
    };
    
    res.json({ success: true, data: response });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/storage-pools/:id - Delete storage pool
router.delete('/:id', async (req, res, next) => {
  try {
    const pools = await getStoragePools();
    const pool = pools.find(p => p.id === req.params.id);

    if (!pool) {
      return res.status(404).json({
        success: false,
        error: 'Storage pool not found'
      });
    }

    // Get backup host to notify
    const backupHosts = await getBackupHosts();
    const backupHost = backupHosts.find(h => h.id === pool.backupHostId);

    // TODO: Check if pool is in use by any schedules or backups
    // For now, allow deletion

    await deleteStoragePool(req.params.id);
    
    // Notify agent to sync storage pools
    if (backupHost) {
      console.log('[Storage Pools] ═══════════════════════════════════════════════════');
      console.log('[Storage Pools] Notifying agent to sync after deletion');
      console.log('[Storage Pools] Backup Host ID:', pool.backupHostId);
      console.log('[Storage Pools] Backup Host Name:', backupHost.name);
      console.log('[Storage Pools] Agent URL:', backupHost.url);
      console.log('[Storage Pools] Deleted Storage Pool Path:', pool.path);
      console.log('[Storage Pools] ═══════════════════════════════════════════════════');
      
      const notifyResult = await agentService.notifyStoragePoolSync(backupHost.url);
      if (notifyResult.success) {
        console.log('[Storage Pools] ✓ Agent notified successfully');
      } else {
        console.error('[Storage Pools] ✗ Failed to notify agent:', notifyResult.error);
      }
    } else {
      console.warn('[Storage Pools] ⚠ Backup host not found, cannot notify agent');
    }
    
    res.json({ success: true, message: 'Storage pool deleted' });
  } catch (error) {
    next(error);
  }
});

// POST /api/storage-pools/:id/refresh - Refresh storage pool info
router.post('/:id/refresh', async (req, res, next) => {
  try {
    const pools = await getStoragePools();
    const pool = pools.find(p => p.id === req.params.id);

    if (!pool) {
      return res.status(404).json({
        success: false,
        error: 'Storage pool not found'
      });
    }

    // Get backup host
    const backupHosts = await getBackupHosts();
    const backupHost = backupHosts.find(h => h.id === pool.backupHostId);
    
    if (!backupHost) {
      return res.status(404).json({
        success: false,
        error: 'Backup host not found'
      });
    }

    // Refresh storage info
    const validation = await agentService.validateStoragePool(backupHost.url, pool.path);
    
    if (!validation.success) {
      return res.status(400).json({
        success: false,
        error: validation.error || 'Storage pool validation failed'
      });
    }

    const updates = {
      totalGB: validation.data.totalGB,
      usedGB: validation.data.usedGB,
      availableGB: validation.data.availableGB,
      usagePercent: validation.data.usagePercent,
      updatedAt: new Date().toISOString()
    };

    await updateStoragePool(req.params.id, updates);
    
    // Transform for response
    const response = {
      ...pool,
      ...updates,
      isMountPoint: !!pool.mountPoint,
      lastChecked: updates.updatedAt,
      status: 'online',
      usedPercentage: updates.usagePercent
    };
    
    res.json({ success: true, data: response });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
