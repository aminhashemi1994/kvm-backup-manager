const express = require('express');
const router = express.Router();
const agentService = require('../services/agentService');
const { getBackupHosts, getVirtualMachines, getStoragePools } = require('../services/fileStorage');

// POST /api/cleanup-backup - Trigger cleanup backup on agent (cleanup only, no backup start)
router.post('/', async (req, res, next) => {
  try {
    const { vmId, backupHostId } = req.body;

    console.log('Cleanup backup request:', { vmId, backupHostId });

    if (!vmId || !backupHostId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: vmId, backupHostId',
      });
    }

    // Get VM details
    const vms = await getVirtualMachines();
    const vm = vms.find(v => v.id === vmId);

    if (!vm) {
      console.error('VM not found:', vmId);
      return res.status(404).json({
        success: false,
        error: 'VM not found',
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

    // Get all storage pools for this backup host
    const storagePools = await getStoragePools();
    const hostPools = storagePools.filter(p => p.backupHostId === backupHost.id);

    if (hostPools.length === 0) {
      console.error('No storage pools found for backup host:', backupHostId);
      return res.status(404).json({
        success: false,
        error: 'No storage pools configured for this backup host',
      });
    }

    console.log(`[CleanupBackup] Checking ${hostPools.length} storage pool(s) for VM ${vm.name}`);

    // Check each storage pool to see if VM backups exist
    let cleanupResults = [];
    let foundBackup = false;

    for (const pool of hostPools) {
      try {
        console.log(`[CleanupBackup] Checking pool: ${pool.name} (${pool.path})`);
        
        const client = agentService.createAgentClient(backupHost.url, backupHost.id, backupHost.name);
        const response = await client.post('/api/cleanup-backup', {
          vmName: vm.name,
          storagePoolPath: pool.path,
        }, {
          timeout: 120000, // 2 minutes timeout
        });

        // If cleanup was successful (found partial files and cleaned them)
        if (response.data.success) {
          foundBackup = true;
          
          if (response.data.cleaned) {
            // Partial files were found and cleaned
            cleanupResults.push({
              pool: pool.name,
              path: pool.path,
              success: true,
              cleaned: true,
              message: response.data.message,
              output: response.data.output,
            });
            console.log(`[CleanupBackup] ✓ Cleanup performed in pool ${pool.name}`);
          } else if (response.data.healthy) {
            // Backup exists but is healthy (no partial files)
            cleanupResults.push({
              pool: pool.name,
              path: pool.path,
              success: true,
              cleaned: false,
              healthy: true,
              message: response.data.message,
              output: response.data.output,
            });
            console.log(`[CleanupBackup] ✓ Backup is healthy in pool ${pool.name}`);
          }
        }
      } catch (error) {
        // Check if it's a 404 (no backups found in this pool)
        if (error.response?.status === 404 && error.response?.data?.notFound) {
          console.log(`[CleanupBackup] No backups found in pool ${pool.name}`);
          cleanupResults.push({
            pool: pool.name,
            path: pool.path,
            success: false,
            notFound: true,
            message: `No backups found in this pool`,
          });
        } else {
          // Real error (script failure, connection error, etc.)
          console.log(`[CleanupBackup] Pool ${pool.name} check failed:`, error.message);
          cleanupResults.push({
            pool: pool.name,
            path: pool.path,
            success: false,
            error: error.response?.data?.error || error.message,
            details: error.response?.data?.details,
          });
        }
      }
    }

    if (!foundBackup) {
      // No backups found in any storage pool
      return res.status(404).json({
        success: false,
        error: `No backups found for VM "${vm.name}" in any storage pool`,
        message: `Checked ${hostPools.length} storage pool(s) but found no backup directories for this VM.`,
        poolsChecked: hostPools.map(p => ({ name: p.name, path: p.path })),
      });
    }

    // Return aggregated results
    const successfulCleanups = cleanupResults.filter(r => r.success);
    const cleanedPools = cleanupResults.filter(r => r.success && r.cleaned);
    const healthyPools = cleanupResults.filter(r => r.success && r.healthy);
    const failedCleanups = cleanupResults.filter(r => !r.success && !r.notFound);

    // Build message based on results
    let message;
    if (cleanedPools.length > 0 && healthyPools.length > 0) {
      message = `Cleanup completed. Cleaned ${cleanedPools.length} pool(s), ${healthyPools.length} pool(s) were already healthy.`;
    } else if (cleanedPools.length > 0) {
      message = `Cleanup completed successfully. Partial files removed from ${cleanedPools.length} pool(s).`;
    } else if (healthyPools.length > 0) {
      message = `Backup is healthy. No partial files found in any storage pool - no cleanup needed.`;
    } else {
      message = `Checked ${cleanupResults.length} storage pool(s).`;
    }

    res.json({
      success: true,
      message: message,
      results: cleanupResults,
      summary: {
        total: cleanupResults.length,
        successful: successfulCleanups.length,
        cleaned: cleanedPools.length,
        healthy: healthyPools.length,
        failed: failedCleanups.length,
      },
    });
  } catch (error) {
    console.error('Cleanup backup error:', error.message);
    if (error.response) {
      console.error('Agent error response:', error.response.data);
      return res.status(error.response.status).json(error.response.data);
    }
    console.error('Error details:', error);
    next(error);
  }
});

module.exports = router;
