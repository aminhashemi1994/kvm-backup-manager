const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const config = require('../config/config');

const AUDIT_DIR = path.join(config.dataDir, 'audit');
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB per file before rotation
const RETENTION_DAYS = 90;

/**
 * AuditService (Item 9)
 *
 * Records all significant actions with actor, timestamp, action type, and
 * details. Stored as JSON files with rotation to prevent performance issues.
 *
 * File naming: audit-YYYY-MM-DD.json (one file per day, rotated at 5MB)
 * Overflow: audit-YYYY-MM-DD_001.json, audit-YYYY-MM-DD_002.json, etc.
 */
class AuditService {
  constructor() {
    this.pruneTimer = null;
  }

  async initialize() {
    try {
      await fs.mkdir(AUDIT_DIR, { recursive: true });
    } catch (e) {}

    // Prune old logs daily
    this.pruneTimer = setInterval(() => {
      this._pruneOldLogs().catch(() => {});
    }, 24 * 60 * 60 * 1000);
    this.pruneTimer.unref?.();

    // Initial prune
    this._pruneOldLogs().catch(() => {});
    console.log('✓ Audit service initialized');
  }

  /**
   * Record an audit event.
   *
   * @param {string} action - Action category (e.g. 'backup.trigger', 'user.create')
   * @param {object} opts
   * @param {string} opts.actor - Who performed the action (username or 'system:xxx')
   * @param {string} opts.actorId - User ID of the actor
   * @param {string} opts.actorRole - Role of the actor
   * @param {string} [opts.targetType] - Type of target (e.g. 'vm', 'schedule', 'user')
   * @param {string} [opts.targetId] - ID of the target
   * @param {string} [opts.targetName] - Human-readable name of the target
   * @param {object} [opts.details] - Additional details
   * @param {string} [opts.ip] - Request IP
   */
  async log(action, opts = {}) {
    const entry = {
      id: require('uuid').v4(),
      timestamp: new Date().toISOString(),
      action,
      actor: opts.actor || 'unknown',
      actorId: opts.actorId || null,
      actorRole: opts.actorRole || null,
      targetType: opts.targetType || null,
      targetId: opts.targetId || null,
      targetName: opts.targetName || null,
      details: opts.details || null,
      ip: opts.ip || null,
    };

    try {
      const filePath = await this._getCurrentFile();
      // Append as JSON line
      await fs.appendFile(filePath, JSON.stringify(entry) + '\n', 'utf8');
    } catch (e) {
      console.error('[Audit] Failed to write audit log:', e.message);
    }

    return entry;
  }

  /**
   * Query audit logs with filters.
   * Returns most recent entries first.
   */
  async query({ page = 1, limit = 50, action, actor, targetType, targetId, from, to } = {}) {
    try {
      const files = await this._getAuditFiles();
      // Read files in reverse order (newest first)
      const reversedFiles = files.reverse();

      const results = [];
      let skipped = 0;
      const skip = (page - 1) * limit;

      for (const file of reversedFiles) {
        const content = await fs.readFile(path.join(AUDIT_DIR, file), 'utf8');
        const lines = content.trim().split('\n').filter(Boolean).reverse();

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);

            // Apply filters
            if (action && !entry.action.startsWith(action)) continue;
            if (actor && entry.actor !== actor) continue;
            if (targetType && entry.targetType !== targetType) continue;
            if (targetId && entry.targetId !== targetId) continue;
            if (from && entry.timestamp < from) continue;
            if (to && entry.timestamp > to) continue;

            if (skipped < skip) {
              skipped++;
              continue;
            }

            results.push(entry);
            if (results.length >= limit) break;
          } catch (e) {
            // Skip malformed lines
          }
        }

        if (results.length >= limit) break;
      }

      return {
        success: true,
        data: results,
        pagination: { page, limit, hasMore: results.length === limit },
      };
    } catch (e) {
      return { success: true, data: [], pagination: { page, limit, hasMore: false } };
    }
  }

  /**
   * Get audit stats (for dashboard).
   */
  async getStats() {
    try {
      const files = await this._getAuditFiles();
      let totalEntries = 0;
      let totalSize = 0;
      let oldestFile = files[0] || null;
      let newestFile = files[files.length - 1] || null;

      for (const file of files) {
        const stat = await fs.stat(path.join(AUDIT_DIR, file));
        totalSize += stat.size;
        // Rough line count estimate
        totalEntries += Math.round(stat.size / 200); // ~200 bytes per entry
      }

      return {
        totalFiles: files.length,
        totalSizeBytes: totalSize,
        totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
        estimatedEntries: totalEntries,
        oldestFile,
        newestFile,
        retentionDays: RETENTION_DAYS,
        rotated: files.length > 1,
      };
    } catch (e) {
      return { totalFiles: 0, totalSizeBytes: 0, estimatedEntries: 0 };
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  async _getCurrentFile() {
    const today = new Date().toISOString().split('T')[0];
    const baseFile = path.join(AUDIT_DIR, `audit-${today}.json`);

    // Check if current file exceeds max size
    try {
      const stat = await fs.stat(baseFile);
      if (stat.size >= MAX_FILE_SIZE) {
        // Find next available overflow file
        let i = 1;
        let overflowFile;
        do {
          overflowFile = path.join(AUDIT_DIR, `audit-${today}_${String(i).padStart(3, '0')}.json`);
          i++;
        } while (fsSync.existsSync(overflowFile) && fsSync.statSync(overflowFile).size >= MAX_FILE_SIZE);
        return overflowFile;
      }
    } catch (e) {
      // File doesn't exist yet — will be created
    }

    return baseFile;
  }

  async _getAuditFiles() {
    try {
      const files = await fs.readdir(AUDIT_DIR);
      return files.filter(f => f.startsWith('audit-') && f.endsWith('.json')).sort();
    } catch (e) {
      return [];
    }
  }

  async _pruneOldLogs() {
    try {
      const files = await this._getAuditFiles();
      const cutoffDate = new Date(Date.now() - RETENTION_DAYS * 86400000)
        .toISOString().split('T')[0];
      const cutoffPrefix = `audit-${cutoffDate}`;

      for (const file of files) {
        if (file < cutoffPrefix) {
          await fs.unlink(path.join(AUDIT_DIR, file));
          console.log(`[Audit] Pruned old log: ${file}`);
        }
      }
    } catch (e) {}
  }

  shutdown() {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }
}

const auditService = new AuditService();
module.exports = auditService;
