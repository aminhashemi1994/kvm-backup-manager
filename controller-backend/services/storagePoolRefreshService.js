const { getStoragePools, getBackupHosts, updateStoragePool } = require('./fileStorage');
const agentService = require('./agentService');

class StoragePoolRefreshService {
  constructor() {
    this.refreshInterval = null;
    this.REFRESH_INTERVAL = 10 * 1000; // 10 seconds to match frontend refetch interval
  }

  initialize() {
    console.log('✓ Storage pool refresh service initialized');
    console.log(`  Refresh interval: ${this.REFRESH_INTERVAL / 1000} seconds`);
    
    // Refresh initial data
    this.refreshAllStoragePools();
    
    // Schedule periodic refresh
    this.refreshInterval = setInterval(() => {
      this.refreshAllStoragePools();
    }, this.REFRESH_INTERVAL);
  }

  async refreshAllStoragePools() {
    try {
      const [pools, backupHosts] = await Promise.all([
        getStoragePools(),
        getBackupHosts()
      ]);

      console.log(`[StoragePoolRefresh] Refreshing ${pools.length} storage pool(s)...`);

      for (const pool of pools) {
        await this.refreshStoragePool(pool, backupHosts);
      }
    } catch (error) {
      console.error('[StoragePoolRefresh] Error refreshing storage pools:', error);
    }
  }

  async refreshStoragePool(pool, backupHosts) {
    try {
      const backupHost = backupHosts.find(h => h.id === pool.backupHostId);
      
      if (!backupHost) {
        console.error(`[StoragePoolRefresh] Backup host not found for pool ${pool.name}`);
        return;
      }

      // Get fresh storage info from agent
      const validation = await agentService.validateStoragePool(backupHost.url, pool.path);
      
      if (validation.success && validation.data) {
        const updates = {
          totalGB: validation.data.totalGB,
          usedGB: validation.data.usedGB,
          availableGB: validation.data.availableGB,
          usagePercent: validation.data.usagePercent,
          updatedAt: new Date().toISOString()
        };

        await updateStoragePool(pool.id, updates);
        console.log(`[StoragePoolRefresh] ✓ Refreshed ${pool.name}: ${updates.usagePercent}% used`);
      } else {
        console.error(`[StoragePoolRefresh] ✗ Failed to refresh ${pool.name}:`, validation.error);
      }
    } catch (error) {
      console.error(`[StoragePoolRefresh] ✗ Error refreshing ${pool.name}:`, error.message);
    }
  }

  shutdown() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
    console.log('✓ Storage pool refresh service shutdown');
  }
}

const storagePoolRefreshService = new StoragePoolRefreshService();
module.exports = storagePoolRefreshService;
