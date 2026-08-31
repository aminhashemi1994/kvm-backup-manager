const express = require('express');
const path = require('path');
const router = express.Router();
const config = require('../config/config');
const {
  readJSON,
  writeJSON,
  getBackupHosts,
  saveBackupHosts,
} = require('../services/fileStorage');
const agentService = require('../services/agentService');
const { requireAdmin } = require('../middleware/rbac');

const SETTINGS_FILE = path.join(config.dataDir, 'general-settings.json');

const DEFAULTS = {
  // Default for newly-created backup hosts. Operators can override per
  // host on the Backup Hosts page.
  defaultMaxConcurrentBackups: 20,
  // Health-check cadence used by the scheduler service.
  healthCheckIntervalSeconds: 60,
  // Default policy applied to newly-created schedules.
  defaultMissedRunPolicy: 'immediate', // 'immediate' | 'most-recent' | 'skip'
  // Age (in days) after which agents auto-delete a backup job's flat log
  // file (<logDir>/<jobId>.log). 0 disables automatic deletion — logs are
  // kept until manually removed via the Cleanup page.
  jobLogRetentionDays: 90,
  // How often the replication check compares every VM's backup directory
  // against its offsite copies. Hours; 0 turns the check off.
  //
  // Daily by default. It walks every VM on every backup host and stats the
  // whole tree at both ends, so it is a periodic audit rather than something to
  // watch — the point is noticing replication that has quietly fallen behind,
  // which is a state measured in days, not minutes.
  replicationCheckIntervalHours: 24,
  // Queue a sync automatically for each VM the check finds behind. On by
  // default: finding the problem and not fixing it is rarely what anyone wants.
  replicationCheckAutoSync: true,
};

async function loadSettings() {
  try {
    const stored = await readJSON(SETTINGS_FILE);
    if (!stored || Array.isArray(stored)) return { ...DEFAULTS };
    return { ...DEFAULTS, ...stored };
  } catch (_) {
    return { ...DEFAULTS };
  }
}

function validate(payload) {
  const errors = [];
  if (payload.defaultMaxConcurrentBackups !== undefined) {
    const n = Number(payload.defaultMaxConcurrentBackups);
    // 0 = unlimited (no concurrency cap). Otherwise 1–200.
    if (!Number.isFinite(n) || n < 0 || n > 200) {
      errors.push('defaultMaxConcurrentBackups must be a number between 0 and 200 (0 = unlimited)');
    }
  }
  if (payload.healthCheckIntervalSeconds !== undefined) {
    const n = Number(payload.healthCheckIntervalSeconds);
    if (!Number.isFinite(n) || n < 15 || n > 3600) {
      errors.push('healthCheckIntervalSeconds must be a number between 15 and 3600');
    }
  }
  if (payload.defaultMissedRunPolicy !== undefined) {
    if (!['immediate', 'most-recent', 'skip'].includes(payload.defaultMissedRunPolicy)) {
      errors.push('defaultMissedRunPolicy must be one of: immediate, most-recent, skip');
    }
  }
  if (payload.jobLogRetentionDays !== undefined) {
    const n = Number(payload.jobLogRetentionDays);
    // 0 = disabled (never auto-delete). Otherwise 1–3650 (~10 years).
    if (!Number.isFinite(n) || n < 0 || n > 3650) {
      errors.push('jobLogRetentionDays must be a number between 0 and 3650 (0 = disabled)');
    }
  }
  if (payload.replicationCheckIntervalHours !== undefined) {
    const n = Number(payload.replicationCheckIntervalHours);
    // 0 = disabled. Otherwise 1–168 (a week).
    if (!Number.isFinite(n) || n < 0 || n > 168) {
      errors.push('replicationCheckIntervalHours must be a number between 0 and 168 (0 = disabled)');
    }
  }
  if (payload.replicationCheckAutoSync !== undefined) {
    if (typeof payload.replicationCheckAutoSync !== 'boolean') {
      errors.push('replicationCheckAutoSync must be true or false');
    }
  }
  return errors;
}

// GET /api/settings
router.get('/', async (req, res, next) => {
  try {
    const settings = await loadSettings();
    res.json({ success: true, data: settings });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/settings  (admin only)
 *
 * Persists the system-wide defaults. Optional flags in the body let the
 * admin propagate the new concurrency cap to every existing backup host
 * (and push a refresh to each agent so the change takes effect without
 * waiting for the 60-second poll).
 *
 * Body:
 *   {
 *     defaultMaxConcurrentBackups: number,
 *     healthCheckIntervalSeconds: number,
 *     defaultMissedRunPolicy: 'immediate' | 'most-recent' | 'skip',
 *     applyConcurrencyToAllHosts: boolean   // optional, default false
 *   }
 */
router.put('/', requireAdmin, async (req, res, next) => {
  try {
    const incoming = req.body || {};

    const errors = validate(incoming);
    if (errors.length > 0) {
      return res.status(400).json({ success: false, error: errors.join('; ') });
    }

    const current = await loadSettings();
    const merged = { ...current };

    // Only update fields that were sent.
    if (incoming.defaultMaxConcurrentBackups !== undefined) {
      merged.defaultMaxConcurrentBackups = Number(incoming.defaultMaxConcurrentBackups);
    }
    if (incoming.healthCheckIntervalSeconds !== undefined) {
      merged.healthCheckIntervalSeconds = Number(incoming.healthCheckIntervalSeconds);
    }
    if (incoming.defaultMissedRunPolicy !== undefined) {
      merged.defaultMissedRunPolicy = incoming.defaultMissedRunPolicy;
    }
    if (incoming.jobLogRetentionDays !== undefined) {
      merged.jobLogRetentionDays = Number(incoming.jobLogRetentionDays);
    }
    if (incoming.replicationCheckIntervalHours !== undefined) {
      merged.replicationCheckIntervalHours = Number(incoming.replicationCheckIntervalHours);
    }
    if (incoming.replicationCheckAutoSync !== undefined) {
      merged.replicationCheckAutoSync = incoming.replicationCheckAutoSync === true;
    }
    merged.updatedAt = new Date().toISOString();

    await writeJSON(SETTINGS_FILE, merged);

    // Re-arm the replication check against the new cadence immediately.
    // Its timer only re-read the interval when it next fired, so a change
    // took up to a full interval to apply — and setting the interval to 0
    // cleared the timer with nothing left to re-arm it, leaving the check
    // permanently off until a controller restart even after turning it back on.
    if (incoming.replicationCheckIntervalHours !== undefined) {
      try {
        const replicationCheckService = require('../services/replicationCheckService');
        const armed = await replicationCheckService.reschedule();
        console.log(`[Settings] Replication check re-armed: ${
          armed.enabled ? `every ${merged.replicationCheckIntervalHours}h` : 'disabled'}`);
      } catch (err) {
        console.error(`[Settings] Could not re-arm the replication check: ${err.message}`);
      }
    }

    let propagated = null;
    if (incoming.applyConcurrencyToAllHosts === true) {
      const hosts = await getBackupHosts();
      let changed = 0;
      for (const host of hosts) {
        if (host.maxConcurrentBackups !== merged.defaultMaxConcurrentBackups) {
          host.maxConcurrentBackups = merged.defaultMaxConcurrentBackups;
          host.updatedAt = new Date().toISOString();
          changed++;
        }
      }
      if (changed > 0) {
        await saveBackupHosts(hosts);
      }

      // Best-effort push refresh to every host so the agent picks up the
      // new limit immediately. Failures are logged but don't fail the
      // request — the agent will reconcile on its next 60s poll.
      const refreshResults = await Promise.allSettled(
        hosts.map(async (host) => {
          try {
            const client = agentService.createAgentClient(host.url, host.id, host.name);
            await client.post('/api/concurrency-config/refresh', {}, { timeout: 5000 });
            return { hostId: host.id, ok: true };
          } catch (e) {
            return { hostId: host.id, ok: false, error: e.message };
          }
        })
      );
      const refreshed = refreshResults.filter(r => r.status === 'fulfilled' && r.value?.ok).length;
      propagated = {
        hostsUpdated: changed,
        agentsRefreshed: refreshed,
        agentsTotal: hosts.length,
      };
    }

    res.json({ success: true, data: merged, propagated });
  } catch (err) {
    next(err);
  }
});

module.exports = {
  router,
  loadSettings,
};
