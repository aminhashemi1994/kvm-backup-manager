const fs = require('fs');
const path = require('path');
const controllerAuthService = require('./controllerAuthService');

/**
 * Mirrors the storage-pool sync pattern: the agent polls the controller
 * for its host's concurrency configuration (maxConcurrentBackups), caches
 * it on disk, and exposes a getter for the executor. When the value
 * changes, registered listeners are notified so the executor can drain
 * any newly-eligible jobs from its queue immediately.
 *
 * Cached file:  <logDir>/concurrent-config.json
 * Sync interval: 60 seconds (matches storagePoolSyncService)
 *
 * Identity (backupHostId) is reused from storagePoolSyncService rather
 * than re-discovered, so we never have two services racing to write to
 * <logDir>/agent-identity.json.
 */
class ConcurrencyConfigSyncService {
  constructor() {
    this.config = null;
    this.cacheFile = null;
    this.syncInterval = null;
    this.SYNC_INTERVAL_MS = 60 * 1000;

    // Sensible default until the first successful sync. Mirrors the
    // controller-side default for backup hosts that have no value set.
    this.maxConcurrentBackups = 20;
    this.lastSync = null;
    this.changeListeners = new Set();
  }

  initialize(config) {
    this.config = config;
    this.cacheFile = path.join(config.logDir, 'concurrent-config.json');

    console.log('✓ Concurrency Config Sync Service initialized');
    console.log(`  Cache file: ${this.cacheFile}`);
    console.log(`  Sync interval: ${this.SYNC_INTERVAL_MS / 1000} seconds`);

    this._loadCache();

    // First sync runs immediately so we don't run with the default for a
    // full minute on agent startup.
    this.sync().catch(err => {
      console.error('[ConcurrencyConfigSync] Initial sync failed:', err.message);
    });

    this.syncInterval = setInterval(() => {
      this.sync().catch(err => {
        console.error('[ConcurrencyConfigSync] Periodic sync failed:', err.message);
      });
    }, this.SYNC_INTERVAL_MS);
  }

  _loadCache() {
    try {
      if (fs.existsSync(this.cacheFile)) {
        const data = fs.readFileSync(this.cacheFile, 'utf8');
        const cached = JSON.parse(data);
        if (cached && Number.isFinite(cached.maxConcurrentBackups)) {
          this.maxConcurrentBackups = cached.maxConcurrentBackups;
          this.lastSync = cached.lastSync || null;
          console.log(`[ConcurrencyConfigSync] Loaded cached value: ${this.maxConcurrentBackups}`);
        }
      } else {
        console.log('[ConcurrencyConfigSync] No cache yet; using default value');
      }
    } catch (err) {
      console.error('[ConcurrencyConfigSync] Failed to load cache:', err.message);
    }
  }

  _writeCache() {
    try {
      fs.writeFileSync(
        this.cacheFile,
        JSON.stringify({
          maxConcurrentBackups: this.maxConcurrentBackups,
          lastSync: this.lastSync,
        }, null, 2)
      );
    } catch (err) {
      console.error('[ConcurrencyConfigSync] Failed to write cache:', err.message);
    }
  }

  /**
   * Pull the value from the controller. Reuses the identity discovered by
   * storagePoolSyncService so we don't run our own discovery loop.
   */
  async sync() {
    const controllerUrl = this.config?.controllerUrl;
    if (!controllerUrl) {
      console.log('[ConcurrencyConfigSync] No controller URL configured — skipping sync');
      return { success: false, error: 'No controller URL' };
    }

    let backupHostId = null;
    try {
      const storagePoolSyncService = require('./storagePoolSyncService');
      backupHostId = storagePoolSyncService.getBackupHostId();
    } catch (_) {
      // Lazy require so a circular load can't break startup.
    }
    if (!backupHostId) {
      // Identity not discovered yet — storagePoolSyncService will
      // populate it on its own loop. Try again on the next tick.
      return { success: false, error: 'Agent identity not yet discovered' };
    }

    try {
      const endpoint = `/backup-hosts/${backupHostId}/concurrent-config`;
      const response = await controllerAuthService.get(controllerUrl, endpoint, { timeout: 5000 });
      if (!response.data?.success || !response.data.data) {
        return { success: false, error: response.data?.error || 'Empty response' };
      }
      const incoming = Number(response.data.data.maxConcurrentBackups);
      if (!Number.isFinite(incoming) || incoming < 1) {
        return { success: false, error: `Invalid maxConcurrentBackups: ${incoming}` };
      }

      const previous = this.maxConcurrentBackups;
      this.lastSync = new Date().toISOString();

      if (previous !== incoming) {
        this.maxConcurrentBackups = incoming;
        this._writeCache();
        console.log(`[ConcurrencyConfigSync] maxConcurrentBackups changed: ${previous} → ${incoming}`);
        this._notifyListeners(previous, incoming);
      } else {
        // Refresh lastSync timestamp on disk so /status reflects health.
        this._writeCache();
      }
      return { success: true, value: this.maxConcurrentBackups };
    } catch (err) {
      console.error('[ConcurrencyConfigSync] Sync failed:', err.message);
      return { success: false, error: err.message };
    }
  }

  _notifyListeners(previous, incoming) {
    for (const fn of this.changeListeners) {
      try { fn(previous, incoming); } catch (e) {
        console.error('[ConcurrencyConfigSync] Listener threw:', e.message);
      }
    }
  }

  /**
   * Subscribe to maxConcurrentBackups changes. Callback receives
   * (previous, incoming) so listeners can decide what to do (the
   * executor uses this to drain its queue if the limit went up).
   * Returns an unsubscribe function.
   */
  onChange(fn) {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  getMaxConcurrent() {
    return this.maxConcurrentBackups;
  }

  getStatus() {
    return {
      maxConcurrentBackups: this.maxConcurrentBackups,
      lastSync: this.lastSync,
      syncIntervalSeconds: this.SYNC_INTERVAL_MS / 1000,
    };
  }

  /**
   * Force an out-of-band refresh — useful for an admin endpoint that
   * pushes "you just changed the config, refetch now".
   */
  async refreshNow() {
    return this.sync();
  }

  shutdown() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    this.changeListeners.clear();
    console.log('✓ Concurrency Config Sync Service shutdown');
  }
}

const concurrencyConfigSyncService = new ConcurrencyConfigSyncService();
module.exports = concurrencyConfigSyncService;
