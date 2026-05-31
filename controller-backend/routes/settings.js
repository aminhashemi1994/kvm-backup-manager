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
    if (!Number.isFinite(n) || n < 1 || n > 200) {
      errors.push('defaultMaxConcurrentBackups must be a number between 1 and 200');
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
    merged.updatedAt = new Date().toISOString();

    await writeJSON(SETTINGS_FILE, merged);

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
