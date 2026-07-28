const { exec } = require('child_process');
const { promisify } = require('util');
const { getHypervisors, getOffsiteHosts, getBackupHosts, updateOffsiteHost } = require('./fileStorage');
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

      // Collect offsite host metrics.
      // Collect sequentially (await) so the per-pool metrics write-back into
      // each offsite host record does not race with another host's write-back
      // (the update reads the full offsite-hosts list, merges one host, saves).
      for (const offsite of offsiteHosts) {
        await this.collectOffsiteMetrics(offsite);
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

      // Skip when the owning backup host is offline — the agent that runs the SSH
      // probe is unreachable, so every attempt is an immediate ECONNREFUSED. Mark
      // the metrics offline (without hammering the agent) and move on.
      if (backupHost.status && backupHost.status !== 'online') {
        this.metricsCache.set(`hypervisor-${hypervisor.id}`, {
          id: hypervisor.id,
          name: hypervisor.name,
          ip: hypervisor.ip,
          backupHostId: hypervisor.backupHostId,
          type: 'hypervisor',
          disks: [],
          timestamp: new Date().toISOString(),
          status: 'offline',
          error: 'Backup host offline',
        });
        return;
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

      // Skip when the owning backup host is offline — its agent runs the SSH
      // probe, so every attempt is an immediate ECONNREFUSED. Cache offline and
      // move on instead of hammering the dead host each cycle.
      if (backupHost.status && backupHost.status !== 'online') {
        this.metricsCache.set(`offsite-${offsite.id}`, {
          id: offsite.id,
          name: offsite.name,
          ip: offsite.ip,
          backupHostId: offsite.backupHostId,
          type: 'offsite',
          disks: [],
          timestamp: new Date().toISOString(),
          status: 'offline',
          error: 'Backup host offline',
        });
        return;
      }

      // Use THIS offsite host's own storage pools (embedded in the offsite
      // host record), not the backup host's pools. Each pool has a name and an
      // absolute path on the offsite host (Req 7.1).
      const offsitePools = Array.isArray(offsite.storagePools) ? offsite.storagePools : [];

      // Call agent API to collect metrics via SSH, passing the offsite pools.
      // The agent df-checks each offsitePath independently and returns per-pool
      // metrics keyed by poolId/poolName (Req 7.2).
      const result = await agentService.getRemoteOffsiteMetrics(backupHost.url, {
        ip: offsite.ip,
        username: offsite.username || 'root',
        port: offsite.port || 22,
        storagePools: offsitePools.map(pool => ({
          id: pool.id,
          name: pool.name,
          offsitePath: pool.path
        }))
      });

      if (result.success && result.data) {
        const disks = result.data.disks || [];

        this.metricsCache.set(`offsite-${offsite.id}`, {
          id: offsite.id,
          name: offsite.name,
          ip: offsite.ip,
          backupHostId: offsite.backupHostId,
          type: 'offsite',
          disks,
          timestamp: result.data.timestamp || new Date().toISOString(),
          status: result.data.status || 'online'
        });

        // Write per-pool metrics back into each offsite pool snapshot so the UI
        // and the 80% disk-usage checks can read the latest usage (Req 7.1).
        if (offsitePools.length > 0) {
          const disksByPoolId = new Map();
          for (const disk of disks) {
            if (disk.poolId) disksByPoolId.set(disk.poolId, disk);
          }

          const now = new Date().toISOString();
          const updatedPools = offsitePools.map(pool => {
            const disk = disksByPoolId.get(pool.id);
            if (!disk) return pool;
            return {
              ...pool,
              device: disk.device,
              path: pool.path,
              totalGB: disk.total,
              usedGB: disk.used,
              availableGB: disk.available,
              usagePercent: disk.usage,
              status: 'active',
              lastError: null,
              updatedAt: now
            };
          });

          await updateOffsiteHost(offsite.id, { storagePools: updatedPools });
        }

        console.log(`[RemoteMetrics] ✓ Collected ${disks.length} disk(s) for ${offsite.name}`);
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
