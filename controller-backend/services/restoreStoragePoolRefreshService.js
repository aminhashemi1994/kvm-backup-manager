const { getRestoreStoragePools, getBackupHosts, updateRestoreStoragePool } = require('./fileStorage');
const agentService = require('./agentService');

class RestoreStoragePoolRefreshService {
  constructor() {
    this.refreshInterval = null;
    this.REFRESH_INTERVAL = 10 * 1000; // 10 seconds to match frontend refetch interval
  }

  initialize() {
    console.log('✓ Restore storage pool refresh service initialized');
    console.log(`  Refresh interval: ${this.REFRESH_INTERVAL / 1000} seconds`);
    
    // Refresh initial data
    this.refreshAllRestoreStoragePools();
    
    // Schedule periodic refresh
    this.refreshInterval = setInterval(() => {
      this.refreshAllRestoreStoragePools();
    }, this.REFRESH_INTERVAL);
  }

  async refreshAllRestoreStoragePools() {
    try {
      const [pools, backupHosts] = await Promise.all([
        getRestoreStoragePools(),
        getBackupHosts()
      ]);

      console.log(`[RestorePoolRefresh] Refreshing ${pools.length} restore storage pool(s)...`);

      for (const pool of pools) {
        await this.refreshRestoreStoragePool(pool, backupHosts);
      }
    } catch (error) {
      console.error('[RestorePoolRefresh] Error refreshing restore storage pools:', error);
    }
  }

  async refreshRestoreStoragePool(pool, backupHosts) {
    try {
      const backupHost = backupHosts.find(h => h.id === pool.backupHostId);
      
      if (!backupHost) {
        console.error(`[RestorePoolRefresh] Backup host not found for pool ${pool.name}`);
        return;
      }

      // Get fresh storage info from agent
      const validation = await agentService.validateRestoreStoragePool(backupHost.url, pool.path);
      
      if (validation.success && validation.data) {
        const updates = {
          totalGB: validation.data.totalGB,
          usedGB: validation.data.usedGB,
          availableGB: validation.data.availableGB,
          usagePercent: validation.data.usagePercent,
          updatedAt: new Date().toISOString()
        };

        await updateRestoreStoragePool(pool.id, updates);
        console.log(`[RestorePoolRefresh] ✓ Refreshed ${pool.name}: ${updates.usagePercent}% used`);
      } else {
        console.error(`[RestorePoolRefresh] ✗ Failed to refresh ${pool.name}:`, validation.error);
      }
    } catch (error) {
      console.error(`[RestorePoolRefresh] ✗ Error refreshing ${pool.name}:`, error.message);
    }
  }

  shutdown() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
    console.log('✓ Restore storage pool refresh service shutdown');
  }
}

const restoreStoragePoolRefreshService = new RestoreStoragePoolRefreshService();
module.exports = restoreStoragePoolRefreshService;
