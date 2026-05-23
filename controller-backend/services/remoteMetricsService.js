const { exec } = require('child_process');
const { promisify } = require('util');
const { getHypervisors, getOffsiteHosts, getBackupHosts } = require('./fileStorage');
const agentService = require('./agentService');

const execAsync = promisify(exec);

class RemoteMetricsService {
  constructor() {
    this.metricsCache = new Map();
    this.collectionInterval = null;
    this.COLLECTION_INTERVAL = 2 * 60 * 1000; // 2 minutes
    this.CACHE_EXPIRATION = 5 * 60 * 1000; // 5 minutes - data older than this is considered stale
  }

  initialize() {
    console.log('✓ Remote metrics service initialized');
    console.log(`  Collection interval: ${this.COLLECTION_INTERVAL / 60000} minutes`);
    console.log(`  Cache expiration: ${this.CACHE_EXPIRATION / 60000} minutes`);
    
    // Clear cache on initialization (fresh start)
    this.clearCache();
    
    // Collect initial metrics
    this.collectAllMetrics();
    
    // Schedule periodic collection
    this.collectionInterval = setInterval(() => {
      this.collectAllMetrics();
    }, this.COLLECTION_INTERVAL);
  }

  clearCache() {
    this.metricsCache.clear();
    console.log('[RemoteMetrics] Cache cleared');
  }

  async collectAllMetrics() {
    console.log('[RemoteMetrics] Starting metrics collection...');
    
    try {
      const [hypervisors, offsiteHosts] = await Promise.all([
        getHypervisors(),
        getOffsiteHosts()
      ]);

      // Get current IDs from database
      const currentHypervisorIds = new Set(hypervisors.map(h => h.id));
      const currentOffsiteIds = new Set(offsiteHosts.map(o => o.id));

      // Remove metrics for deleted hypervisors
      for (const [key] of this.metricsCache.entries()) {
        if (key.startsWith('hypervisor-')) {
          const id = key.replace('hypervisor-', '');
          if (!currentHypervisorIds.has(id)) {
            this.metricsCache.delete(key);
            console.log(`[RemoteMetrics] Removed metrics for deleted hypervisor: ${id}`);
          }
        } else if (key.startsWith('offsite-')) {
          const id = key.replace('offsite-', '');
          if (!currentOffsiteIds.has(id)) {
            this.metricsCache.delete(key);
            console.log(`[RemoteMetrics] Removed metrics for deleted offsite host: ${id}`);
          }
        }
      }

      // Collect hypervisor metrics
      for (const hypervisor of hypervisors) {
        this.collectHypervisorMetrics(hypervisor);
      }

      // Collect offsite host metrics
      for (const offsite of offsiteHosts) {
        this.collectOffsiteMetrics(offsite);
      }
    } catch (error) {
      console.error('[RemoteMetrics] Error collecting metrics:', error);
    }
  }

  async collectHypervisorMetrics(hypervisor) {
    try {
      console.log(`[RemoteMetrics] Collecting metrics for hypervisor: ${hypervisor.name} (${hypervisor.ip})`);
      
      // Get the backup host for this hypervisor
      const backupHosts = await getBackupHosts();
      const backupHost = backupHosts.find(h => h.id === hypervisor.backupHostId);
      
      if (!backupHost) {
        throw new Error(`Backup host not found for hypervisor ${hypervisor.name}`);
      }

      // Call agent API to collect metrics via SSH
      const result = await agentService.getRemoteHypervisorMetrics(backupHost.url, {
        ip: hypervisor.ip,
        username: hypervisor.username || 'root',
        port: hypervisor.port || 22
      });

      if (result.success && result.data) {
        this.metricsCache.set(`hypervisor-${hypervisor.id}`, {
          id: hypervisor.id,
          name: hypervisor.name,
          ip: hypervisor.ip,
          backupHostId: hypervisor.backupHostId,
          type: 'hypervisor',
          disks: result.data.disks || [],
          timestamp: result.data.timestamp || new Date().toISOString(),
          status: result.data.status || 'online'
        });

        console.log(`[RemoteMetrics] ✓ Collected ${result.data.disks?.length || 0} disk(s) for ${hypervisor.name}`);
      } else {
        throw new Error(result.error || 'Failed to collect metrics');
      }
    } catch (error) {
      console.error(`[RemoteMetrics] ✗ Failed to collect metrics for ${hypervisor.name}:`, error.message);
      
      this.metricsCache.set(`hypervisor-${hypervisor.id}`, {
        id: hypervisor.id,
        name: hypervisor.name,
        ip: hypervisor.ip,
        backupHostId: hypervisor.backupHostId,
        type: 'hypervisor',
        disks: [],
        timestamp: new Date().toISOString(),
        status: 'offline',
        error: error.message
      });
    }
  }

  async collectOffsiteMetrics(offsite) {
    try {
      console.log(`[RemoteMetrics] Collecting metrics for offsite: ${offsite.name} (${offsite.ip})`);
      
      // Get the backup host for this offsite host
      const backupHosts = await getBackupHosts();
      const backupHost = backupHosts.find(h => h.id === offsite.backupHostId);
      
      if (!backupHost) {
        throw new Error(`Backup host not found for offsite ${offsite.name}`);
      }

      // Get storage pools for this backup host
      const { getStoragePools } = require('./fileStorage');
      const allPools = await getStoragePools();
      const storagePools = allPools.filter(pool => pool.backupHostId === offsite.backupHostId);

      // Call agent API to collect metrics via SSH, passing storage pools
      const result = await agentService.getRemoteOffsiteMetrics(backupHost.url, {
        ip: offsite.ip,
        username: offsite.username || 'root',
        port: offsite.port || 22,
        storagePools: storagePools.map(pool => ({
          id: pool.id,
          name: pool.name,
          mountPoint: pool.mountPoint,
          offsitePath: pool.offsitePath || pool.mountPoint
        }))
      });

      if (result.success && result.data) {
        this.metricsCache.set(`offsite-${offsite.id}`, {
          id: offsite.id,
          name: offsite.name,
          ip: offsite.ip,
          backupHostId: offsite.backupHostId,
          type: 'offsite',
          disks: result.data.disks || [],
          timestamp: result.data.timestamp || new Date().toISOString(),
          status: result.data.status || 'online'
        });

        console.log(`[RemoteMetrics] ✓ Collected ${result.data.disks?.length || 0} disk(s) for ${offsite.name}`);
      } else {
        throw new Error(result.error || 'Failed to collect metrics');
      }
    } catch (error) {
      console.error(`[RemoteMetrics] ✗ Failed to collect metrics for ${offsite.name}:`, error.message);
      
      this.metricsCache.set(`offsite-${offsite.id}`, {
        id: offsite.id,
        name: offsite.name,
        ip: offsite.ip,
        backupHostId: offsite.backupHostId,
        type: 'offsite',
        disks: [],
        timestamp: new Date().toISOString(),
        status: 'offline',
        error: error.message
      });
    }
  }

  getHypervisorMetrics(hypervisorId) {
    const metrics = this.metricsCache.get(`hypervisor-${hypervisorId}`);
    
    // Don't return stale or offline data
    if (!metrics) return null;
    if (metrics.status === 'offline') return null;
    
    // Check if data is stale
    const age = Date.now() - new Date(metrics.timestamp).getTime();
    if (age > this.CACHE_EXPIRATION) {
      console.log(`[RemoteMetrics] Stale data for hypervisor ${hypervisorId} (age: ${Math.round(age / 60000)}m)`);
      return null;
    }
    
    return metrics;
  }

  getOffsiteMetrics(offsiteId) {
    const metrics = this.metricsCache.get(`offsite-${offsiteId}`);
    
    // Don't return stale or offline data
    if (!metrics) return null;
    if (metrics.status === 'offline') return null;
    
    // Check if data is stale
    const age = Date.now() - new Date(metrics.timestamp).getTime();
    if (age > this.CACHE_EXPIRATION) {
      console.log(`[RemoteMetrics] Stale data for offsite ${offsiteId} (age: ${Math.round(age / 60000)}m)`);
      return null;
    }
    
    return metrics;
  }

  getAllHypervisorMetrics() {
    const metrics = [];
    for (const [key, value] of this.metricsCache.entries()) {
      if (key.startsWith('hypervisor-')) {
        // Skip offline or stale data
        if (value.status === 'offline') continue;
        
        const age = Date.now() - new Date(value.timestamp).getTime();
        if (age > this.CACHE_EXPIRATION) continue;
        
        metrics.push(value);
      }
    }
    return metrics;
  }

  getAllOffsiteMetrics() {
    const metrics = [];
    for (const [key, value] of this.metricsCache.entries()) {
      if (key.startsWith('offsite-')) {
        // Skip offline or stale data
        if (value.status === 'offline') continue;
        
        const age = Date.now() - new Date(value.timestamp).getTime();
        if (age > this.CACHE_EXPIRATION) continue;
        
        metrics.push(value);
      }
    }
    return metrics;
  }

  shutdown() {
    if (this.collectionInterval) {
      clearInterval(this.collectionInterval);
      this.collectionInterval = null;
    }
    console.log('✓ Remote metrics service shutdown');
  }
}

const remoteMetricsService = new RemoteMetricsService();
module.exports = remoteMetricsService;
