const express = require('express');
const router = express.Router();
const storagePoolSyncService = require('../services/storagePoolSyncService');

/**
 * GET /api/storage-pool-sync/status
 * Get storage pool sync status
 */
router.get('/status', (req, res, next) => {
  try {
    const status = storagePoolSyncService.getStatus();
    res.json({
      success: true,
      data: status
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/storage-pool-sync/sync
 * Manually trigger storage pool sync
 */
router.post('/sync', async (req, res, next) => {
  try {
    console.log('[StoragePoolSync] ═══════════════════════════════════════════════════');
    console.log('[StoragePoolSync] Manual sync triggered');
    console.log('[StoragePoolSync] Request from:', req.ip);
    console.log('[StoragePoolSync] Current backup host ID:', storagePoolSyncService.getBackupHostId());
    console.log('[StoragePoolSync] Current storage pools:', storagePoolSyncService.getStoragePools().length);
    console.log('[StoragePoolSync] ═══════════════════════════════════════════════════');
    
    const result = await storagePoolSyncService.syncStoragePools();
    
    if (result.success) {
      console.log('[StoragePoolSync] ✓ Sync completed successfully');
      console.log('[StoragePoolSync] Storage pools after sync:', result.count);
      res.json({
        success: true,
        message: `Synced ${result.count} storage pools`,
        data: storagePoolSyncService.getStatus()
      });
    } else {
      console.error('[StoragePoolSync] ✗ Sync failed:', result.error);
      res.status(500).json({
        success: false,
        error: result.error,
        data: storagePoolSyncService.getStatus()
      });
    }
  } catch (error) {
    console.error('[StoragePoolSync] ✗ Exception during sync:', error);
    next(error);
  }
});

/**
 * GET /api/storage-pool-sync/pools
 * Get current storage pools
 */
router.get('/pools', (req, res, next) => {
  try {
    const pools = storagePoolSyncService.getStoragePools();
    res.json({
      success: true,
      data: pools
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/storage-pool-sync/debug
 * Get debug information about storage pool sync
 */
router.get('/debug', (req, res, next) => {
  try {
    const fs = require('fs');
    const path = require('path');
    const config = require('../config/config');
    
    const storagePoolsFile = path.join(config.logDir, 'storage-pools.json');
    const agentIdentityFile = path.join(config.logDir, 'agent-identity.json');
    
    let storagePoolsContent = null;
    let agentIdentityContent = null;
    
    try {
      if (fs.existsSync(storagePoolsFile)) {
        storagePoolsContent = JSON.parse(fs.readFileSync(storagePoolsFile, 'utf8'));
      }
    } catch (e) {
      storagePoolsContent = { error: e.message };
    }
    
    try {
      if (fs.existsSync(agentIdentityFile)) {
        agentIdentityContent = JSON.parse(fs.readFileSync(agentIdentityFile, 'utf8'));
      }
    } catch (e) {
      agentIdentityContent = { error: e.message };
    }
    
    res.json({
      success: true,
      data: {
        status: storagePoolSyncService.getStatus(),
        inMemoryPools: storagePoolSyncService.getStoragePools(),
        cachedFile: storagePoolsContent,
        identityFile: agentIdentityContent,
        files: {
          storagePoolsFile,
          agentIdentityFile,
          storagePoolsExists: fs.existsSync(storagePoolsFile),
          agentIdentityExists: fs.existsSync(agentIdentityFile)
        }
      }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
