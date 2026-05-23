const agentService = require('./agentService');
const agentSyncService = require('./agentSyncService');
const { getBackupHosts, updateBackupHost, getHypervisors, updateHypervisor, getOffsiteHosts, updateOffsiteHost } = require('./fileStorage');

class HealthCheckService {
  constructor() {
    this.checkInterval = null;
    this.CHECK_INTERVAL = 1 * 60 * 1000; // 1 minute for connectivity checks
    this.isChecking = false;
    this.lastCheckTime = null;
    this.checkCount = 0;
    this.recentlyReconnectedHosts = new Set(); // Track hosts that were just reconnected
    // Item 4: Debounce — require N consecutive failures before marking offline
    this.CONSECUTIVE_FAILURES_THRESHOLD = 2;
    this.failureCounts = new Map(); // hostId -> consecutive failure count
    this.hypervisorFailureCounts = new Map(); // hypervisorId -> consecutive failure count
    this.offsiteFailureCounts = new Map(); // offsiteId -> consecutive failure count
  }

  initialize() {
    console.log('✓ Health check service initialized');
    console.log(`  Connectivity check interval: ${this.CHECK_INTERVAL / 1000} seconds`);
    
    // Run initial health check after a short delay to allow server to fully start
    // First check skips debounce — we want accurate state immediately
    setTimeout(() => {
      this.isFirstCheck = true;
      this.runHealthChecks().then(() => {
        this.isFirstCheck = false;
      });
    }, 5000);
    
    // Schedule periodic health checks (connectivity)
    this.checkInterval = setInterval(() => {
      this.runHealthChecks();
    }, this.CHECK_INTERVAL);
  }

  async runHealthChecks() {
    if (this.isChecking) {
      console.log('[HealthCheck] Previous check still running, skipping...');
      return;
    }

    this.isChecking = true;
    this.checkCount++;
    this.lastCheckTime = new Date();
    
    console.log(`[HealthCheck] Starting health check #${this.checkCount} at ${this.lastCheckTime.toISOString()}`);
    const startTime = Date.now();

    try {
      // Run checks sequentially to ensure backup hosts are checked first
      // This is important because hypervisors and offsite hosts depend on backup host status
      await this.checkBackupHosts();
      await Promise.all([
        this.checkHypervisors(),
        this.checkOffsiteHosts()
      ]);

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`[HealthCheck] ✓ Health check #${this.checkCount} completed in ${duration}s`);
    } catch (error) {
      console.error('[HealthCheck] Error during health checks:', error);
    } finally {
      this.isChecking = false;
    }
  }

  // Manual trigger for immediate health check (can be called via API)
  async triggerManualCheck() {
    console.log('[HealthCheck] Manual health check triggered');
    return await this.runHealthChecks();
  }

  getStatus() {
    return {
      isChecking: this.isChecking,
      checkInterval: this.CHECK_INTERVAL,
      lastCheckTime: this.lastCheckTime,
      checkCount: this.checkCount,
      nextCheckIn: this.lastCheckTime 
        ? Math.max(0, this.CHECK_INTERVAL - (Date.now() - this.lastCheckTime.getTime()))
        : 0
    };
  }

  async checkBackupHosts() {
    try {
      const hosts = await getBackupHosts();
      
      if (hosts.length === 0) {
        console.log('[HealthCheck] No backup hosts to check');
        return;
      }
      
      console.log(`[HealthCheck] Checking ${hosts.length} backup host(s)...`);

      // Track which backup hosts were just brought back online
      this.recentlyReconnectedHosts = new Set();

      for (const host of hosts) {
        try {
          console.log(`[HealthCheck] Testing backup host ${host.name} (${host.url})...`);
          const result = await agentService.healthCheck(host.url);
          const newStatus = result.success ? 'online' : 'offline';
          const oldStatus = host.status;

          if (result.success) {
            // Reset failure counter on success
            this.failureCounts.delete(host.id);
          }

          if (newStatus !== oldStatus) {
            if (newStatus === 'offline') {
              // Item 4: Debounce — only mark offline after N consecutive failures
              // BUT skip debounce on first check (startup) to get accurate state fast
              if (!this.isFirstCheck) {
                const count = (this.failureCounts.get(host.id) || 0) + 1;
                this.failureCounts.set(host.id, count);
                
                if (count < this.CONSECUTIVE_FAILURES_THRESHOLD) {
                  console.log(`[HealthCheck] → Backup host ${host.name} failed check ${count}/${this.CONSECUTIVE_FAILURES_THRESHOLD} (not marking offline yet)`);
                  continue; // Don't update status yet
                }
              }
              console.log(`[HealthCheck] ✓ Backup host ${host.name} status changed: ${oldStatus} → ${newStatus}`);
            } else {
              console.log(`[HealthCheck] ✓ Backup host ${host.name} status changed: ${oldStatus} → ${newStatus}`);
            }
            
            // If backup host just came online (or is online on first check), re-register hypervisors
            if (newStatus === 'online') {
              console.log(`[HealthCheck] Backup host ${host.name} is online, re-registering hypervisors...`);
              await this.reregisterHypervisors(host);
              // Mark this host so we skip redundant hypervisor checks in this cycle
              this.recentlyReconnectedHosts.add(host.id);
              
              // Item 2: Reconcile running jobs with agent's live-status
              try {
                const syncResult = await agentSyncService.syncHost(host);
                if (syncResult.synced > 0 || syncResult.finalized > 0) {
                  console.log(`[HealthCheck] Agent sync for ${host.name}: synced=${syncResult.synced}, finalized=${syncResult.finalized}`);
                }
              } catch (syncErr) {
                console.error(`[HealthCheck] Agent sync failed for ${host.name}:`, syncErr.message);
              }
            }
          } else if (newStatus === 'online' && this.isFirstCheck) {
            // Host was already marked online in the file, but on first check
            // we still need to re-register hypervisors (agent may have restarted)
            console.log(`[HealthCheck] First check: ${host.name} is online, re-registering hypervisors...`);
            await this.reregisterHypervisors(host);
            this.recentlyReconnectedHosts.add(host.id);
          } else {
            console.log(`[HealthCheck] → Backup host ${host.name} status unchanged: ${newStatus}`);
          }

          await updateBackupHost(host.id, {
            status: newStatus,
            lastHealthCheck: new Date().toISOString()
          });
        } catch (error) {
          console.error(`[HealthCheck] ✗ Failed to check backup host ${host.name}:`, error.message);
          
          // Item 4: Debounce for exceptions too (skip on first check)
          if (this.isFirstCheck) {
            await updateBackupHost(host.id, {
              status: 'offline',
              lastHealthCheck: new Date().toISOString()
            });
          } else {
            const count = (this.failureCounts.get(host.id) || 0) + 1;
            this.failureCounts.set(host.id, count);
            
            if (count >= this.CONSECUTIVE_FAILURES_THRESHOLD) {
              await updateBackupHost(host.id, {
                status: 'offline',
                lastHealthCheck: new Date().toISOString()
              });
            } else {
              console.log(`[HealthCheck] → Backup host ${host.name} exception ${count}/${this.CONSECUTIVE_FAILURES_THRESHOLD} (not marking offline yet)`);
            }
          }
        }
      }
    } catch (error) {
      console.error('[HealthCheck] Error checking backup hosts:', error);
    }
  }

  async reregisterHypervisors(backupHost) {
    try {
      const hypervisors = await getHypervisors();
      const hostHypervisors = hypervisors.filter(h => h.backupHostId === backupHost.id);
      
      if (hostHypervisors.length === 0) {
        console.log(`[HealthCheck] No hypervisors to re-register for ${backupHost.name}`);
        return;
      }

      console.log(`[HealthCheck] Re-registering ${hostHypervisors.length} hypervisor(s) with ${backupHost.name}...`);

      for (const hypervisor of hostHypervisors) {
        try {
          // Re-register hypervisor with agent
          await agentService.addHypervisor(backupHost.url, {
            id: hypervisor.id,
            name: hypervisor.name,
            ip: hypervisor.ip,
            port: hypervisor.port || 22,
            username: hypervisor.username || 'root'
          });
          console.log(`[HealthCheck] ✓ Re-registered hypervisor ${hypervisor.name}`);

          // Reset failure counter — fresh start
          this.hypervisorFailureCounts.delete(hypervisor.id);

          // Immediately test the connection and update status — retry up to 3 times
          // because the agent may need a moment to fully initialize after restart.
          let testResult = null;
          let lastError = null;
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              testResult = await agentService.testHypervisor(backupHost.url, hypervisor.id);
              if (testResult.success) break;
              lastError = testResult.message || 'Test failed';
              if (attempt < 3) {
                await new Promise(r => setTimeout(r, 1500)); // 1.5s between retries
              }
            } catch (e) {
              lastError = e.message;
              if (attempt < 3) await new Promise(r => setTimeout(r, 1500));
            }
          }
          
          const newStatus = testResult?.success ? 'connected' : 'disconnected';
          await updateHypervisor(hypervisor.id, {
            status: newStatus,
            lastHealthCheck: new Date().toISOString(),
            ...(testResult?.success ? { lastError: null } : { lastError }),
          });
          
          console.log(`[HealthCheck] ✓ Hypervisor ${hypervisor.name} tested: ${newStatus}`);
        } catch (error) {
          console.error(`[HealthCheck] ✗ Failed to re-register hypervisor ${hypervisor.name}:`, error.message);
          // Don't mark as failed yet — let the periodic check handle it
        }
      }

      // Also re-check offsite hosts that depend on this backup host
      try {
        await this.recheckOffsiteForHost(backupHost);
      } catch (e) {
        console.error('[HealthCheck] Failed to recheck offsite hosts:', e.message);
      }
    } catch (error) {
      console.error('[HealthCheck] Error re-registering hypervisors:', error);
    }
  }

  /**
   * Re-check offsite hosts immediately when their backup host comes back online.
   */
  async recheckOffsiteForHost(backupHost) {
    const offsiteHosts = await getOffsiteHosts();
    const hostOffsites = offsiteHosts.filter(o => o.backupHostId === backupHost.id);
    
    if (hostOffsites.length === 0) return;
    
    console.log(`[HealthCheck] Re-checking ${hostOffsites.length} offsite host(s) for ${backupHost.name}...`);
    
    for (const offsite of hostOffsites) {
      try {
        // Reset failure counter
        this.offsiteFailureCounts.delete(offsite.id);
        
        // Retry up to 3 times
        let result = null;
        let lastError = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            result = await agentService.testOffsiteConnection(backupHost.url, {
              ip: offsite.ip,
              port: offsite.port || 22,
              username: offsite.username || 'root'
            });
            if (result.success) break;
            lastError = result.message || 'Test failed';
            if (attempt < 3) await new Promise(r => setTimeout(r, 1500));
          } catch (e) {
            lastError = e.message;
            if (attempt < 3) await new Promise(r => setTimeout(r, 1500));
          }
        }
        
        const newStatus = result?.success ? 'online' : 'offline';
        await updateOffsiteHost(offsite.id, {
          status: newStatus,
          lastHealthCheck: new Date().toISOString(),
        });
        
        console.log(`[HealthCheck] ✓ Offsite ${offsite.name} tested: ${newStatus}`);
      } catch (error) {
        console.error(`[HealthCheck] ✗ Failed to re-check offsite ${offsite.name}:`, error.message);
      }
    }
  }

  async checkHypervisors() {
    try {
      const hypervisors = await getHypervisors();
      
      if (hypervisors.length === 0) {
        console.log('[HealthCheck] No hypervisors to check');
        return;
      }
      
      console.log(`[HealthCheck] Checking ${hypervisors.length} hypervisor(s)...`);

      // Get backup hosts to find agent URLs
      const backupHosts = await getBackupHosts();
      const backupHostMap = new Map(backupHosts.map(h => [h.id, h]));

      for (const hypervisor of hypervisors) {
        try {
          const backupHost = backupHostMap.get(hypervisor.backupHostId);
          
          if (!backupHost) {
            console.warn(`[HealthCheck] ⚠ No backup host found for hypervisor ${hypervisor.name} (ID: ${hypervisor.backupHostId})`);
            continue;
          }

          // Skip if this hypervisor was just re-registered in this cycle
          if (this.recentlyReconnectedHosts && this.recentlyReconnectedHosts.has(backupHost.id)) {
            console.log(`[HealthCheck] → Skipping hypervisor ${hypervisor.name} (already tested during re-registration)`);
            continue;
          }

          console.log(`[HealthCheck] Checking hypervisor ${hypervisor.name} via backup host ${backupHost.name} (${backupHost.status})`);

          if (backupHost.status !== 'online') {
            // If backup host is offline, mark hypervisor as offline too
            if (hypervisor.status !== 'offline') {
              console.log(`[HealthCheck] → Hypervisor ${hypervisor.name} marked offline (backup host ${backupHost.name} is ${backupHost.status})`);
              await updateHypervisor(hypervisor.id, {
                status: 'offline',
                lastHealthCheck: new Date().toISOString()
              });
            } else {
              console.log(`[HealthCheck] → Hypervisor ${hypervisor.name} remains offline (backup host offline)`);
            }
            continue;
          }

          // Test SSH connection via agent
          console.log(`[HealthCheck] Testing SSH connection to ${hypervisor.name} (${hypervisor.ip})...`);
          let result = await agentService.testHypervisor(backupHost.url, hypervisor.id);
          
          // If the test fails, the agent may have lost the hypervisor from in-memory
          // state (e.g., agent restarted). Try re-registering and testing again.
          if (!result.success) {
            console.log(`[HealthCheck] Test failed, attempting re-register for ${hypervisor.name}...`);
            try {
              await agentService.addHypervisor(backupHost.url, {
                id: hypervisor.id,
                name: hypervisor.name,
                ip: hypervisor.ip,
                port: hypervisor.port || 22,
                username: hypervisor.username || 'root'
              });
              // Brief pause then retest
              await new Promise(r => setTimeout(r, 1000));
              result = await agentService.testHypervisor(backupHost.url, hypervisor.id);
            } catch (regError) {
              console.error(`[HealthCheck] Re-register failed: ${regError.message}`);
            }
          }
          
          const newStatus = result.success ? 'connected' : 'disconnected';
          const oldStatus = hypervisor.status;

          if (result.success) {
            this.hypervisorFailureCounts.delete(hypervisor.id);
          }

          if (newStatus !== oldStatus) {
            if (newStatus === 'disconnected') {
              const count = (this.hypervisorFailureCounts.get(hypervisor.id) || 0) + 1;
              this.hypervisorFailureCounts.set(hypervisor.id, count);
              if (count < this.CONSECUTIVE_FAILURES_THRESHOLD) {
                console.log(`[HealthCheck] → Hypervisor ${hypervisor.name} failed ${count}/${this.CONSECUTIVE_FAILURES_THRESHOLD} (not marking disconnected yet)`);
                // Still update lastHealthCheck so UI shows it was checked
                await updateHypervisor(hypervisor.id, { lastHealthCheck: new Date().toISOString() });
                continue;
              }
            }
            console.log(`[HealthCheck] ✓ Hypervisor ${hypervisor.name} status changed: ${oldStatus} → ${newStatus}`);
          } else {
            console.log(`[HealthCheck] → Hypervisor ${hypervisor.name} status unchanged: ${newStatus}`);
          }

          await updateHypervisor(hypervisor.id, {
            status: newStatus,
            lastHealthCheck: new Date().toISOString(),
            ...(result.success ? { lastError: null } : {}),
          });
        } catch (error) {
          console.error(`[HealthCheck] ✗ Failed to check hypervisor ${hypervisor.name}:`, error.message);
          const count = (this.hypervisorFailureCounts.get(hypervisor.id) || 0) + 1;
          this.hypervisorFailureCounts.set(hypervisor.id, count);
          if (count >= this.CONSECUTIVE_FAILURES_THRESHOLD) {
            await updateHypervisor(hypervisor.id, {
              status: 'disconnected',
              lastHealthCheck: new Date().toISOString()
            });
          }
        }
      }
    } catch (error) {
      console.error('[HealthCheck] Error checking hypervisors:', error);
    }
  }

  async checkOffsiteHosts() {
    try {
      const offsiteHosts = await getOffsiteHosts();
      
      if (offsiteHosts.length === 0) {
        console.log('[HealthCheck] No offsite hosts to check');
        return;
      }
      
      console.log(`[HealthCheck] Checking ${offsiteHosts.length} offsite host(s)...`);

      // Get backup hosts to find agent URLs
      const backupHosts = await getBackupHosts();
      const backupHostMap = new Map(backupHosts.map(h => [h.id, h]));

      for (const offsite of offsiteHosts) {
        try {
          const backupHost = backupHostMap.get(offsite.backupHostId);
          
          if (!backupHost) {
            console.warn(`[HealthCheck] ⚠ No backup host found for offsite ${offsite.name} (ID: ${offsite.backupHostId})`);
            continue;
          }

          console.log(`[HealthCheck] Checking offsite ${offsite.name} via backup host ${backupHost.name} (${backupHost.status})`);

          if (backupHost.status !== 'online') {
            // If backup host is offline, mark offsite as offline too
            if (offsite.status !== 'offline') {
              console.log(`[HealthCheck] → Offsite ${offsite.name} marked offline (backup host ${backupHost.name} is ${backupHost.status})`);
              await updateOffsiteHost(offsite.id, {
                status: 'offline',
                lastHealthCheck: new Date().toISOString()
              });
            } else {
              console.log(`[HealthCheck] → Offsite ${offsite.name} remains offline (backup host offline)`);
            }
            continue;
          }

          // Test SSH connection via agent
          console.log(`[HealthCheck] Testing connection to offsite ${offsite.name} (${offsite.ip})...`);
          const result = await agentService.testOffsiteConnection(backupHost.url, {
            ip: offsite.ip,
            port: offsite.port || 22,
            username: offsite.username || 'root'
          });
          
          const newStatus = result.success ? 'online' : 'offline';
          const oldStatus = offsite.status;

          if (result.success) {
            this.offsiteFailureCounts.delete(offsite.id);
          }

          if (newStatus !== oldStatus) {
            if (newStatus === 'offline') {
              const count = (this.offsiteFailureCounts.get(offsite.id) || 0) + 1;
              this.offsiteFailureCounts.set(offsite.id, count);
              if (count < this.CONSECUTIVE_FAILURES_THRESHOLD) {
                console.log(`[HealthCheck] → Offsite ${offsite.name} failed ${count}/${this.CONSECUTIVE_FAILURES_THRESHOLD} (not marking offline yet)`);
                await updateOffsiteHost(offsite.id, { lastHealthCheck: new Date().toISOString() });
                continue;
              }
            }
            console.log(`[HealthCheck] ✓ Offsite ${offsite.name} status changed: ${oldStatus} → ${newStatus}`);
          } else {
            console.log(`[HealthCheck] → Offsite ${offsite.name} status unchanged: ${newStatus}`);
          }

          await updateOffsiteHost(offsite.id, {
            status: newStatus,
            lastHealthCheck: new Date().toISOString()
          });
        } catch (error) {
          console.error(`[HealthCheck] ✗ Failed to check offsite ${offsite.name}:`, error.message);
          const count = (this.offsiteFailureCounts.get(offsite.id) || 0) + 1;
          this.offsiteFailureCounts.set(offsite.id, count);
          if (count >= this.CONSECUTIVE_FAILURES_THRESHOLD) {
            await updateOffsiteHost(offsite.id, {
              status: 'offline',
              lastHealthCheck: new Date().toISOString()
            });
          }
        }
      }
    } catch (error) {
      console.error('[HealthCheck] Error checking offsite hosts:', error);
    }
  }

  shutdown() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    console.log('✓ Health check service shutdown');
  }
}

const healthCheckService = new HealthCheckService();
module.exports = healthCheckService;
