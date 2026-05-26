const fs = require('fs');
const path = require('path');
const controllerAuthService = require('./controllerAuthService');

class StoragePoolSyncService {
  constructor() {
    this.config = null;
    this.syncInterval = null;
    this.storagePoolsFile = null;
    this.agentIdentityFile = null;
    this.storagePools = [];
    this.backupHostId = null;
    this.SYNC_INTERVAL_MS = 60 * 1000; // 1 minute
  }

  /**
   * Initialize storage pool sync service
   */
  initialize(config) {
    this.config = config;
    this.storagePoolsFile = path.join(config.logDir, 'storage-pools.json');
    this.agentIdentityFile = path.join(config.logDir, 'agent-identity.json');
    
    console.log('✓ Storage Pool Sync Service initialized');
    console.log(`  Storage pools file: ${this.storagePoolsFile}`);
    console.log(`  Agent identity file: ${this.agentIdentityFile}`);
    console.log(`  Sync interval: ${this.SYNC_INTERVAL_MS / 1000} seconds`);

    // Load agent identity if exists
    this.loadAgentIdentity();

    // Load cached storage pools
    this.loadStoragePools();

    // Perform initial sync
    this.syncStoragePools().catch(err => {
      console.error('[StoragePoolSync] Initial sync failed:', err.message);
    });

    // Start periodic sync
    this.syncInterval = setInterval(() => {
      this.syncStoragePools().catch(err => {
        console.error('[StoragePoolSync] Periodic sync failed:', err.message);
      });
    }, this.SYNC_INTERVAL_MS);
  }

  /**
   * Load agent identity from file
   */
  loadAgentIdentity() {
    try {
      if (fs.existsSync(this.agentIdentityFile)) {
        const data = fs.readFileSync(this.agentIdentityFile, 'utf8');
        const identity = JSON.parse(data);
        this.backupHostId = identity.backupHostId;
        console.log(`[StoragePoolSync] Loaded agent identity: ${this.backupHostId}`);
      } else {
        console.log('[StoragePoolSync] No agent identity file found - will discover on first sync');
      }
    } catch (error) {
      console.error('[StoragePoolSync] Failed to load agent identity:', error.message);
    }
  }

  /**
   * Save agent identity to file
   */
  saveAgentIdentity(backupHostId) {
    try {
      const identity = {
        backupHostId,
        discoveredAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString()
      };
      fs.writeFileSync(this.agentIdentityFile, JSON.stringify(identity, null, 2));
      this.backupHostId = backupHostId;
      console.log(`[StoragePoolSync] Saved agent identity: ${backupHostId}`);
    } catch (error) {
      console.error('[StoragePoolSync] Failed to save agent identity:', error.message);
    }
  }

  /**
   * Load storage pools from cache file
   */
  loadStoragePools() {
    try {
      if (fs.existsSync(this.storagePoolsFile)) {
        const data = fs.readFileSync(this.storagePoolsFile, 'utf8');
        const cached = JSON.parse(data);
        this.storagePools = cached.storagePools || [];
        console.log(`[StoragePoolSync] Loaded ${this.storagePools.length} cached storage pools`);
      } else {
        console.log('[StoragePoolSync] No cached storage pools found');
        this.storagePools = [];
      }
    } catch (error) {
      console.error('[StoragePoolSync] Failed to load cached storage pools:', error.message);
      this.storagePools = [];
    }
  }

  /**
   * Save storage pools to cache file
   */
  saveStoragePools(storagePools) {
    try {
      const data = {
        storagePools,
        lastSync: new Date().toISOString(),
        backupHostId: this.backupHostId
      };
      fs.writeFileSync(this.storagePoolsFile, JSON.stringify(data, null, 2));
      this.storagePools = storagePools;
      console.log(`[StoragePoolSync] Saved ${storagePools.length} storage pools to cache`);
    } catch (error) {
      console.error('[StoragePoolSync] Failed to save storage pools:', error.message);
    }
  }

  /**
   * Discover agent identity by checking which backup host this agent belongs to
   */
  async discoverIdentity() {
    try {
      const controllerUrl = this.config.controllerUrl;
      if (!controllerUrl) {
        console.log('[StoragePoolSync] No controller URL configured');
        return null;
      }

      // Get all backup hosts
      const response = await controllerAuthService.get(controllerUrl, '/backup-hosts', { timeout: 5000 });
      const backupHosts = response.data.data || [];
      
      console.log(`[StoragePoolSync] Attempting to discover identity from ${backupHosts.length} backup hosts`);
      console.log(`[StoragePoolSync] Agent port: ${this.config.port}`);

      // Get all possible agent URLs (try different interfaces)
      const os = require('os');
      const networkInterfaces = os.networkInterfaces();
      const agentIPs = [];
      
      // Collect all IP addresses from network interfaces
      for (const interfaceName in networkInterfaces) {
        const interfaces = networkInterfaces[interfaceName];
        for (const iface of interfaces) {
          if (iface.family === 'IPv4' && !iface.internal) {
            agentIPs.push(iface.address);
          }
        }
      }
      
      // Add localhost and 0.0.0.0 as fallbacks
      agentIPs.push('localhost', '127.0.0.1', '0.0.0.0');
      
      console.log(`[StoragePoolSync] Agent IPs to check:`, agentIPs);

      // Try to match by URL
      for (const host of backupHosts) {
        console.log(`[StoragePoolSync] Checking backup host: ${host.name} (${host.url})`);
        
        // Parse the backup host URL
        try {
          const hostUrl = new URL(host.url);
          const hostPort = hostUrl.port || (hostUrl.protocol === 'https:' ? '443' : '80');
          const hostHostname = hostUrl.hostname;
          
          // Check if port matches
          if (hostPort === this.config.port.toString()) {
            // Check if hostname/IP matches any of our IPs
            if (agentIPs.includes(hostHostname)) {
              console.log(`[StoragePoolSync] ✓ Discovered identity: ${host.id} (${host.name})`);
              console.log(`[StoragePoolSync]   Matched by: ${hostHostname}:${hostPort}`);
              this.saveAgentIdentity(host.id);
              return host.id;
            }
          }
        } catch (urlError) {
          console.error(`[StoragePoolSync] Failed to parse URL ${host.url}:`, urlError.message);
        }
      }

      console.log('[StoragePoolSync] ✗ Could not discover agent identity - no matching backup host found');
      console.log('[StoragePoolSync]   Please ensure the backup host URL matches one of the agent IPs');
      return null;
    } catch (error) {
      console.error('[StoragePoolSync] Failed to discover identity:', error.message);
      return null;
    }
  }

  /**
   * Sync storage pools from controller
   */
  async syncStoragePools() {
    try {
      const controllerUrl = this.config.controllerUrl;
      if (!controllerUrl) {
        console.log('[StoragePoolSync] No controller URL configured - skipping sync');
        return { success: false, error: 'No controller URL' };
      }

      // If we don't have an identity yet, try to discover it
      if (!this.backupHostId) {
        console.log('[StoragePoolSync] No agent identity - attempting discovery...');
        await this.discoverIdentity();
        
        if (!this.backupHostId) {
          console.log('[StoragePoolSync] Cannot sync without agent identity');
          return { success: false, error: 'No agent identity' };
        }
      }

      // Fetch storage pools for this backup host
      const endpoint = `/storage-pools/backup-host/${this.backupHostId}`;
      console.log(`[StoragePoolSync] Fetching from: ${controllerUrl}${endpoint}`);
      const response = await controllerAuthService.get(controllerUrl, endpoint, { timeout: 5000 });
      
      if (response.data.success) {
        const storagePools = response.data.data || [];
        console.log(`[StoragePoolSync] Received ${storagePools.length} storage pools from controller`);
        
        // Log all received pools
        storagePools.forEach((pool, index) => {
          console.log(`[StoragePoolSync] Pool ${index + 1}: ${pool.name} (${pool.id}) -> ${pool.path}`);
        });
        
        // Check if storage pools changed by comparing JSON
        const currentJson = JSON.stringify(this.storagePools.map(p => ({ id: p.id, path: p.path })).sort((a, b) => a.id.localeCompare(b.id)));
        const newJson = JSON.stringify(storagePools.map(p => ({ id: p.id, path: p.path })).sort((a, b) => a.id.localeCompare(b.id)));
        
        console.log(`[StoragePoolSync] Current JSON: ${currentJson}`);
        console.log(`[StoragePoolSync] New JSON: ${newJson}`);
        
        if (currentJson !== newJson) {
          console.log(`[StoragePoolSync] Storage pools changed: ${this.storagePools.length} -> ${storagePools.length}`);
          console.log(`[StoragePoolSync] Old pools:`, this.storagePools.map(p => `${p.name}: ${p.path}`));
          console.log(`[StoragePoolSync] New pools:`, storagePools.map(p => `${p.name}: ${p.path}`));
          this.saveStoragePools(storagePools);

          // Notify report service so it can trigger an immediate generation
          // if the agent has just received its first set of storage pools.
          // Lazy-require to avoid any circular load issues at module init.
          try {
            const reportService = require('./reportService');
            if (typeof reportService.onStoragePoolsSynced === 'function') {
              reportService.onStoragePoolsSynced().catch(() => {});
            }
          } catch (notifyErr) {
            // Non-fatal — the report service will still run on its periodic interval.
            console.error('[StoragePoolSync] Failed to notify report service:', notifyErr.message);
          }
        } else {
          console.log(`[StoragePoolSync] Storage pools unchanged (${storagePools.length} pools)`);
        }
        
        return { success: true, count: storagePools.length };
      } else {
        console.error('[StoragePoolSync] Failed to fetch storage pools:', response.data.error);
        return { success: false, error: response.data.error };
      }
    } catch (error) {
      console.error('[StoragePoolSync] Sync error:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get current storage pools (from cache)
   */
  getStoragePools() {
    console.log(`[StoragePoolSync] getStoragePools() called - returning ${this.storagePools.length} pools`);
    if (this.storagePools.length > 0) {
      console.log('[StoragePoolSync] Pool details:', this.storagePools.map(p => `${p.id}: ${p.path}`));
    }
    return this.storagePools;
  }

  /**
   * Get backup host ID
   */
  getBackupHostId() {
    return this.backupHostId;
  }

  /**
   * Get sync status
   */
  getStatus() {
    let lastSync = null;
    try {
      if (fs.existsSync(this.storagePoolsFile)) {
        const data = JSON.parse(fs.readFileSync(this.storagePoolsFile, 'utf8'));
        lastSync = data.lastSync;
      }
    } catch (error) {
      // Ignore
    }

    return {
      backupHostId: this.backupHostId,
      storagePoolCount: this.storagePools.length,
      lastSync,
      syncInterval: this.SYNC_INTERVAL_MS / 1000,
      hasIdentity: !!this.backupHostId
    };
  }

  /**
   * Shutdown service
   */
  shutdown() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    console.log('✓ Storage Pool Sync Service shutdown');
  }
}

// Export singleton instance
const storagePoolSyncService = new StoragePoolSyncService();
module.exports = storagePoolSyncService;
