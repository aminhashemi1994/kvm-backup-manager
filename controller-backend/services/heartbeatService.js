const fs = require('fs').promises;
const path = require('path');
const config = require('../config/config');
const { writeJSON, readJSON } = require('./fileStorage');

/**
 * HeartbeatService
 *
 * Persists the controller's "last alive" timestamp to disk every N seconds.
 * On startup, the previously stored timestamp is read so the downtime window
 * can be calculated. The window is then handed to MissedRunService.
 *
 * File: <dataDir>/heartbeat.json
 *   { "lastSeenAt": "2026-05-20T08:00:00.000Z", "version": 1 }
 */
class HeartbeatService {
  constructor() {
    this.heartbeatFile = path.join(config.dataDir, 'heartbeat.json');
    this.intervalMs = 15 * 1000; // 15s — small enough that downtime window is accurate
    this.timer = null;
    this.lastBootSnapshot = null; // { lastSeenAt, bootedAt }
  }

  /**
   * Read the last persisted heartbeat (if any) before starting the new heartbeat
   * loop. The returned object captures the downtime window:
   *   - lastSeenAt: when the controller last wrote a heartbeat
   *   - bootedAt:   when this current process started up
   * Both are ISO strings. If no previous heartbeat exists (fresh install), this
   * returns null.
   */
  async readBootSnapshot() {
    try {
      const parsed = await readJSON(this.heartbeatFile);
      // readJSON returns [] for an empty/corrupt/missing file — the
      // heartbeat is an object not an array, so any non-object means
      // "no usable previous heartbeat".
      if (!parsed || Array.isArray(parsed) || !parsed.lastSeenAt) return null;

      const snapshot = {
        lastSeenAt: parsed.lastSeenAt,
        bootedAt: new Date().toISOString(),
      };
      this.lastBootSnapshot = snapshot;
      return snapshot;
    } catch (err) {
      console.warn('[Heartbeat] Could not read previous heartbeat:', err.message);
      return null;
    }
  }

  getBootSnapshot() {
    return this.lastBootSnapshot;
  }

  async writeNow() {
    const payload = {
      lastSeenAt: new Date().toISOString(),
      version: 1,
    };
    try {
      await writeJSON(this.heartbeatFile, payload);
    } catch (err) {
      console.error('[Heartbeat] Failed to write heartbeat:', err.message);
    }
  }

  start() {
    if (this.timer) return;
    // Write an initial heartbeat synchronously-ish so a fast crash still leaves a marker
    this.writeNow().catch(() => {});
    this.timer = setInterval(() => {
      this.writeNow().catch(() => {});
    }, this.intervalMs);
    this.timer.unref?.();
    console.log(`[Heartbeat] Started (interval: ${this.intervalMs / 1000}s)`);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

const heartbeatService = new HeartbeatService();
module.exports = heartbeatService;
