const {
  getOffsiteHosts,
  saveOffsiteHosts,
  getBackupSchedules,
  saveBackupSchedules,
} = require('./fileStorage');
const { v4: uuidv4 } = require('uuid');

/**
 * Startup migration pass for the offsite storage pools feature.
 *
 * Two responsibilities (Req 8.1, 8.5):
 *
 *  1. Migrate any legacy offsite host `backupPath` (single-destination model)
 *     into a single embedded storage pool named "Default", so schedules that
 *     referenced the host can be repaired by selecting that pool. The legacy
 *     `backupPath` is intentionally left in place for backward-compat
 *     readability (Req 8.5, 9.3).
 *
 *  2. Scan schedules for "offsite-selected" schedules that lack a resolvable
 *     per-host pool selection and flag them: enabled=false, invalid=true,
 *     invalidReason='Offsite pool selection required'. Schedules with no
 *     offsite selection at all are never touched.
 *
 * The pass is idempotent (re-running produces no further changes) and never
 * throws on normal data — all work is wrapped in try/catch and errors are
 * logged. Returns a small summary object for logging.
 */

const INVALID_REASON = 'Offsite pool selection required';

/**
 * Determine whether a schedule selects any offsite destination.
 * Considers new `offsiteTargets`, `offsiteHostIds`, and legacy `offsiteHostId`.
 */
function isOffsiteSelected(schedule) {
  if (!schedule || typeof schedule !== 'object') return false;
  const hasTargets = Array.isArray(schedule.offsiteTargets) && schedule.offsiteTargets.length > 0;
  const hasHostIds = Array.isArray(schedule.offsiteHostIds) && schedule.offsiteHostIds.length > 0;
  const hasLegacyHostId = typeof schedule.offsiteHostId === 'string' && schedule.offsiteHostId.trim() !== '';
  return hasTargets || hasHostIds || hasLegacyHostId;
}

/**
 * Determine whether an offsite-selected schedule is fully configured, i.e. it
 * has at least one `offsiteTargets` entry and every target resolves to an
 * existing host + existing pool within that host.
 *
 * `hostsById` is a Map of offsiteHostId -> host record (with storagePools).
 */
function hasResolvableTargets(schedule, hostsById) {
  const targets = Array.isArray(schedule.offsiteTargets) ? schedule.offsiteTargets : [];
  if (targets.length === 0) return false;

  for (const target of targets) {
    if (!target || typeof target !== 'object') return false;
    const host = hostsById.get(target.offsiteHostId);
    if (!host) return false;
    const pools = Array.isArray(host.storagePools) ? host.storagePools : [];
    const pool = pools.find((p) => p && p.id === target.offsitePoolId);
    if (!pool) return false;
  }
  return true;
}

async function runOffsiteMigration() {
  const summary = { poolsCreated: 0, schedulesInvalidated: 0, hostsUpdated: 0 };

  try {
    // --- 1. Migrate legacy offsite host backupPath -> "Default" pool ---
    let offsiteHosts = [];
    try {
      offsiteHosts = await getOffsiteHosts();
    } catch (err) {
      console.error('[offsiteMigration] Failed to read offsite hosts:', err.message);
      offsiteHosts = [];
    }

    let offsiteHostsChanged = false;

    if (Array.isArray(offsiteHosts)) {
      for (const host of offsiteHosts) {
        if (!host || typeof host !== 'object') continue;

        // Ensure storagePools is always an array.
        if (!Array.isArray(host.storagePools)) {
          host.storagePools = [];
          offsiteHostsChanged = true;
        }

        const legacyPath = typeof host.backupPath === 'string' ? host.backupPath.trim() : '';
        if (!legacyPath) {
          // No legacy path -> nothing to migrate for this host.
          continue;
        }

        // Idempotency: only create a Default pool if no pool already has that path.
        const alreadyHasPool = host.storagePools.some((p) => p && p.path === legacyPath);
        if (alreadyHasPool) {
          continue;
        }

        const now = new Date().toISOString();
        host.storagePools.push({
          id: uuidv4(),
          name: 'Default',
          path: legacyPath,
          totalGB: null,
          usedGB: null,
          availableGB: null,
          usagePercent: null,
          mounted: null,
          status: 'active',
          lastError: null,
          createdAt: now,
          updatedAt: now,
        });
        // Keep `backupPath` for backward-compat readability (Req 8.5).
        summary.poolsCreated += 1;
        summary.hostsUpdated += 1;
        offsiteHostsChanged = true;
      }
    }

    if (offsiteHostsChanged) {
      try {
        await saveOffsiteHosts(offsiteHosts);
      } catch (err) {
        console.error('[offsiteMigration] Failed to persist offsite host changes:', err.message);
      }
    }

    // Build a lookup for schedule resolution using the (possibly) migrated hosts.
    const hostsById = new Map();
    if (Array.isArray(offsiteHosts)) {
      for (const host of offsiteHosts) {
        if (host && typeof host === 'object' && host.id) {
          hostsById.set(host.id, host);
        }
      }
    }

    // --- 2. Flag unconfigured offsite-selected schedules ---
    let schedules = [];
    try {
      schedules = await getBackupSchedules();
    } catch (err) {
      console.error('[offsiteMigration] Failed to read backup schedules:', err.message);
      schedules = [];
    }

    let schedulesChanged = false;

    if (Array.isArray(schedules)) {
      for (const schedule of schedules) {
        if (!schedule || typeof schedule !== 'object') continue;

        // Never touch schedules with no offsite selection at all.
        if (!isOffsiteSelected(schedule)) continue;

        // Configured schedules (resolvable targets) are left as-is.
        if (hasResolvableTargets(schedule, hostsById)) continue;

        // Unconfigured offsite-selected schedule -> disable + flag.
        // Idempotency: only count/persist if something actually changed.
        const needsUpdate =
          schedule.enabled !== false ||
          schedule.invalid !== true ||
          schedule.invalidReason !== INVALID_REASON;

        if (needsUpdate) {
          schedule.enabled = false;
          schedule.invalid = true;
          schedule.invalidReason = INVALID_REASON;
          summary.schedulesInvalidated += 1;
          schedulesChanged = true;
        }
      }
    }

    if (schedulesChanged) {
      try {
        await saveBackupSchedules(schedules);
      } catch (err) {
        console.error('[offsiteMigration] Failed to persist schedule changes:', err.message);
      }
    }

    console.log(
      `[offsiteMigration] Migration pass complete: ${summary.poolsCreated} pool(s) created, ` +
        `${summary.schedulesInvalidated} schedule(s) invalidated.`
    );
  } catch (err) {
    // Must never throw on normal data — log and return whatever summary we have.
    console.error('[offsiteMigration] Migration pass failed:', err && err.message ? err.message : err);
  }

  return summary;
}

module.exports = {
  runOffsiteMigration,
};
