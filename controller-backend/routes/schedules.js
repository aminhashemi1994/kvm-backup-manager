const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { getBackupSchedules, saveBackupSchedules, getVirtualMachines } = require('../services/fileStorage');
const schedulerService = require('../services/schedulerService');
const auditService = require('../services/auditService');
const { validateSchedule } = require('../utils/validator');
const { generateCronExpression, parseCronToHuman } = require('../utils/helpers');
const { requireUser } = require('../middleware/rbac');

// Ensure an agent URL carries a protocol so axios can reach it. Mirrors the
// helper used in routes/offsiteHosts.js.
function ensureProtocol(url) {
  if (!url) return url;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return 'http://' + url;
  }
  return url;
}

// Disk-usage limit above which an offsite pool is considered too full to
// safely receive backups (Req 5.2).
const OFFSITE_USAGE_LIMIT = 80;

/**
 * Validate + normalize a schedule's offsite target selection at save time.
 *
 * Enforces the required per-offsite-host pool selection rules (Req 4.1, 4.2,
 * 4.3, 4.5, 4.6): when a schedule specifies offsite replication it must carry
 * exactly ONE destination pool per selected offsite host. The offsite pool is
 * chosen freely from that host's own `storagePools` and is not tied to the
 * source (backup-host) pool (Req 4.6).
 *
 * "Selected offsite hosts" are determined as follows:
 *   - If the request provides `offsiteTargets`, those are the selection and are
 *     validated per host+pool.
 *   - If the request provides only legacy `offsiteHostIds`/`offsiteHostId`
 *     (hosts selected, no pools), that is the missing-pool case and is rejected.
 *   - Empty/no offsite selection is allowed (no offsite replication).
 *
 * Rejection cases (returned as `{ ok: false, error }`, mapped to HTTP 400 by
 * the caller):
 *   - a selected offsite host lacks a pool selection,
 *   - more than one target references the same offsite host (exactly-one rule),
 *   - a referenced offsite host does not exist,
 *   - a referenced offsite pool does not exist within that host's storagePools.
 *
 * On success returns the normalized `offsiteTargets` (each `{ offsiteHostId,
 * offsitePoolId }`, deduped to one per host) plus a mirrored `offsiteHostIds`
 * derived from the targets so downstream enrichment/scheduler code keeps
 * working.
 *
 * The per-target loop resolves each target's host + pool object and then
 * performs live SSH validation of the selected pool via the offsite host's
 * owning online backup host (task 7.2):
 *   - the owning backup host must be online/reachable, else the host is
 *     reported as unreachable (Req 5.4),
 *   - the pool path must exist and be writable (Req 5.3),
 *   - the pool filesystem usage must be below the 80% limit (Req 5.2).
 * Any failure rejects the save (HTTP 400 via the caller) with an error naming
 * the offsite host, pool, path, and reason (Req 5.5).
 *
 * This is async because it issues SSH-backed validation calls through the
 * agent; both the create (POST) and update (PUT) call sites `await` it, so the
 * validation lives in exactly one place and cannot be bypassed on either path.
 *
 * @param {object} body - request body (may carry offsiteTargets and/or offsiteHostIds)
 * @param {Array} offsiteHosts - all offsite host records (with embedded storagePools)
 * @returns {Promise<{ ok: true, offsiteTargets: Array, offsiteHostIds: Array } | { ok: false, error: string }>}
 */
async function validateOffsiteSelection(body, offsiteHosts) {
  const { getBackupHosts } = require('../services/fileStorage');
  const agentService = require('../services/agentService');
  const rawTargets = Array.isArray(body.offsiteTargets) ? body.offsiteTargets : null;
  const legacyIds = Array.isArray(body.offsiteHostIds)
    ? body.offsiteHostIds
    : (body.offsiteHostId ? [body.offsiteHostId] : []);

  // No offsite selection at all -> allowed (schedule has no offsite replication).
  if ((!rawTargets || rawTargets.length === 0) && legacyIds.length === 0) {
    return { ok: true, offsiteTargets: [], offsiteHostIds: [] };
  }

  // Legacy offsite hosts selected but no per-pool targets => missing pool
  // selection. This is the reject-the-save case (Req 4.3).
  if (!rawTargets || rawTargets.length === 0) {
    return {
      ok: false,
      error: 'Offsite pool selection required: select one destination pool for each selected offsite host',
    };
  }

  // Owning backup hosts are needed to perform the SSH validation of each
  // selected offsite pool (each offsite host resolves its agent via
  // backupHostId). Fetched once up front since there is at least one target.
  const backupHosts = await getBackupHosts();

  const seenHosts = new Set();
  const normalized = [];

  for (const target of rawTargets) {
    if (!target || !target.offsiteHostId) {
      return { ok: false, error: 'Invalid offsite target: offsiteHostId is required' };
    }

    const host = (offsiteHosts || []).find(h => h.id === target.offsiteHostId);
    if (!host) {
      return { ok: false, error: `Offsite host not found: ${target.offsiteHostId}` };
    }

    // Exactly one target per offsite host (Req 4.1, 4.2).
    if (seenHosts.has(target.offsiteHostId)) {
      return {
        ok: false,
        error: `Only one destination pool may be selected per offsite host (duplicate selection for host "${host.name}")`,
      };
    }

    // A selected host must carry a pool selection (Req 4.3).
    if (!target.offsitePoolId) {
      return { ok: false, error: `Offsite pool selection required for host "${host.name}"` };
    }

    const pool = (host.storagePools || []).find(p => p.id === target.offsitePoolId);
    if (!pool) {
      return {
        ok: false,
        error: `Offsite pool not found on host "${host.name}": ${target.offsitePoolId}`,
      };
    }

    // Per-target SSH validation (task 7.2). Resolve the offsite host's owning
    // online backup host and validate the selected pool over SSH: path exists +
    // writable (Req 5.3) and filesystem usage below the 80% limit (Req 5.2).
    const owningBackupHost = backupHosts.find(h => h.id === host.backupHostId);
    if (!owningBackupHost || owningBackupHost.status !== 'online') {
      // The offsite host cannot be reached because its owning backup host is
      // offline/missing (Req 5.4).
      return {
        ok: false,
        error: `Offsite host "${host.name}" is unreachable: its owning backup host is offline, so pool "${pool.name}" (${pool.path}) could not be validated`,
      };
    }

    const hostUrl = ensureProtocol(owningBackupHost.url);
    const validation = await agentService.validateOffsiteStoragePool(
      hostUrl,
      pool.path,
      host.ip,
      host.username || 'root'
    );

    if (!validation || !validation.success) {
      // SSH failure / path missing / not writable / not mounted. Treat an
      // outright failure to reach the offsite host as unreachable (Req 5.4)
      // and surface the specific host/pool/path/reason (Req 5.5).
      const reason = (validation && validation.error) ||
        'path validation failed (missing, not writable, or not mounted)';
      return {
        ok: false,
        error: `Offsite pool validation failed for host "${host.name}", pool "${pool.name}" (${pool.path}): ${reason}`,
      };
    }

    // Enforce the disk-usage limit using the returned stats (Req 5.2). Uses the
    // same validation.data stats shape as the offsite pool CRUD (task 2.2).
    const stats = validation.data || {};
    const usagePercent = stats.usagePercent;
    if (usagePercent != null && usagePercent >= OFFSITE_USAGE_LIMIT) {
      return {
        ok: false,
        error: `Offsite pool is too full for host "${host.name}", pool "${pool.name}" (${pool.path}): filesystem usage ${usagePercent}% is at or above the ${OFFSITE_USAGE_LIMIT}% limit`,
      };
    }

    seenHosts.add(target.offsiteHostId);
    normalized.push({ offsiteHostId: host.id, offsitePoolId: pool.id });
  }

  return {
    ok: true,
    offsiteTargets: normalized,
    // Mirror offsiteHostIds from the targets so GET enrichment + legacy readers
    // keep working (Req 4.4 derivation).
    offsiteHostIds: normalized.map(t => t.offsiteHostId),
  };
}

// GET /api/schedules - List all schedules
router.get('/', async (req, res, next) => {
  try {
    const { getBackupHosts, getHypervisors, getOffsiteHosts, getStoragePools } = require('../services/fileStorage');
    const schedules = await getBackupSchedules();
    const vms = await getVirtualMachines();
    const hosts = await getBackupHosts();
    const hypervisors = await getHypervisors();
    const offsiteHosts = await getOffsiteHosts();
    const pools = await getStoragePools();
    
    // Add VM info, hypervisor, backup host, and human-readable cron — enables
    // frontend filtering by any of these dimensions.
    const enrichedSchedules = schedules.map(s => {
      const vm = vms.find(v => v.id === s.vmId);
      const hypervisor = vm ? hypervisors.find(h => h.id === vm.hypervisorId) : null;
      const host = vm ? hosts.find(h => h.id === vm.backupHostId) : null;
      const pool = pools.find(p => p.id === s.storagePoolId);
      const offsiteIds = Array.isArray(s.offsiteHostIds) ? s.offsiteHostIds : (s.offsiteHostId ? [s.offsiteHostId] : []);
      const offsiteNames = offsiteIds
        .map(id => offsiteHosts.find(o => o.id === id))
        .filter(Boolean)
        .map(o => o.name);

      // Resolve each offsite target to its display names (Req 4.4). Each target
      // is `{ offsiteHostId, offsitePoolId }`; look up the offsite host and then
      // the pool within that host's embedded storagePools. Unresolvable
      // hosts/pools are surfaced with null names so the UI can flag them rather
      // than silently dropping the target.
      const offsiteTargets = Array.isArray(s.offsiteTargets) ? s.offsiteTargets : [];
      const offsiteTargetNames = offsiteTargets.map(t => {
        const oh = offsiteHosts.find(o => o.id === t.offsiteHostId);
        const op = oh && Array.isArray(oh.storagePools)
          ? oh.storagePools.find(p => p.id === t.offsitePoolId)
          : null;
        return {
          offsiteHostName: oh ? oh.name : null,
          offsitePoolName: op ? op.name : null,
        };
      });

      return {
        ...s,
        vmName: vm ? vm.name : 'Unknown',
        hypervisorId: hypervisor ? hypervisor.id : null,
        hypervisorName: hypervisor ? hypervisor.name : null,
        hypervisorIp: hypervisor ? hypervisor.ip : null,
        backupHostId: host ? host.id : null,
        backupHostName: host ? host.name : null,
        storagePoolName: pool ? pool.name : null,
        offsiteHostIds: offsiteIds,
        offsiteHostNames: offsiteNames,
        offsiteTargetNames,
        // Migration/validation state (Req 8.3): normalize to a boolean and a
        // string|null so the UI can reliably render invalid schedules red.
        invalid: s.invalid === true,
        invalidReason: s.invalid === true ? (s.invalidReason || null) : null,
        cronHuman: parseCronToHuman(s.cronExpression),
      };
    });
    
    res.json({ success: true, data: enrichedSchedules });
  } catch (error) {
    next(error);
  }
});

// GET /api/schedules/vm/:vmId - Get schedules for a VM
router.get('/vm/:vmId', async (req, res, next) => {
  try {
    const schedules = await getBackupSchedules();
    const vmSchedules = schedules.filter(s => s.vmId === req.params.vmId);
    res.json({ success: true, data: vmSchedules });
  } catch (error) {
    next(error);
  }
});

// GET /api/schedules/:id - Get single schedule
router.get('/:id', async (req, res, next) => {
  try {
    const schedules = await getBackupSchedules();
    const schedule = schedules.find(s => s.id === req.params.id);
    
    if (!schedule) {
      return res.status(404).json({ success: false, error: 'Schedule not found' });
    }

    // Lightweight enrichment for consistency with the list route (Req 4.4, 8.3):
    // resolve offsite target display names and normalize the invalid state.
    const { getOffsiteHosts } = require('../services/fileStorage');
    const offsiteHosts = await getOffsiteHosts();

    const offsiteTargets = Array.isArray(schedule.offsiteTargets) ? schedule.offsiteTargets : [];
    const offsiteTargetNames = offsiteTargets.map(t => {
      const oh = offsiteHosts.find(o => o.id === t.offsiteHostId);
      const op = oh && Array.isArray(oh.storagePools)
        ? oh.storagePools.find(p => p.id === t.offsitePoolId)
        : null;
      return {
        offsiteHostName: oh ? oh.name : null,
        offsitePoolName: op ? op.name : null,
      };
    });

    const enriched = {
      ...schedule,
      offsiteTargetNames,
      invalid: schedule.invalid === true,
      invalidReason: schedule.invalid === true ? (schedule.invalidReason || null) : null,
    };

    res.json({ success: true, data: enriched });
  } catch (error) {
    next(error);
  }
});

// POST /api/schedules - Create new schedule
router.post('/', requireUser, async (req, res, next) => {
  try {
    const validation = validateSchedule(req.body);
    if (!validation.isValid) {
      return res.status(400).json({ success: false, errors: validation.errors });
    }

    // Verify VM exists
    const vms = await getVirtualMachines();
    const vm = vms.find(v => v.id === req.body.vmId);
    if (!vm) {
      return res.status(400).json({ success: false, error: 'VM not found' });
    }

    // Validate storagePoolId is provided
    if (!req.body.storagePoolId) {
      return res.status(400).json({ success: false, error: 'storagePoolId is required' });
    }

    // Validate storage pool exists
    const { getStoragePools, getBackupHosts } = require('../services/fileStorage');
    const pools = await getStoragePools();
    const pool = pools.find(p => p.id === req.body.storagePoolId);
    
    if (!pool) {
      return res.status(400).json({ success: false, error: 'Storage pool not found' });
    }

    // Verify storage pool belongs to the VM's backup host
    const hosts = await getBackupHosts();
    const vmBackupHost = hosts.find(h => h.id === vm.backupHostId);
    
    if (!vmBackupHost || pool.backupHostId !== vmBackupHost.id) {
      return res.status(400).json({ 
        success: false, 
        error: 'Storage pool must belong to the VM\'s backup host' 
      });
    }

    // Offsite replication: enforce required per-host pool selection (Req 4).
    // When offsiteTargets/offsiteHostIds are present, require exactly one
    // destination pool per selected offsite host and reject unresolvable
    // hosts/pools. No offsite selection is allowed (no offsite replication).
    const { getOffsiteHosts } = require('../services/fileStorage');
    const offsiteHosts = await getOffsiteHosts();
    const offsiteSelection = await validateOffsiteSelection(req.body, offsiteHosts);
    if (!offsiteSelection.ok) {
      return res.status(400).json({ success: false, error: offsiteSelection.error });
    }

    // Controller-side schedule conflict check:
    // Prevent creating conflicting schedules for the same VM. The chain-based
    // schedule types (daily/interval/cron/weekly/custom-days) all share the
    // same full/inc backup chain, so only ONE can exist per VM at a time.
    // The copy-based schedule types (once/monthly) are independent and can
    // coexist freely.
    const CHAIN_SCHEDULE_TYPES = ['daily', 'weekly', 'interval', 'cron', 'custom-days'];
    if (CHAIN_SCHEDULE_TYPES.includes(req.body.scheduleType)) {
      const existingSchedules = await getBackupSchedules();
      const conflictingSchedule = existingSchedules.find(s =>
        s.vmId === req.body.vmId &&
        CHAIN_SCHEDULE_TYPES.includes(s.scheduleType) &&
        s.scheduleType !== req.body.scheduleType
      );

      if (conflictingSchedule) {
        return res.status(409).json({
          success: false,
          error: `Cannot create ${req.body.scheduleType} schedule. VM already has a ${conflictingSchedule.scheduleType} schedule. Only one chain-based schedule (daily/weekly/interval/cron/custom-days) is allowed per VM. Delete the existing schedule first or use 'once' or 'monthly' which can coexist.`,
          conflictDetails: {
            existingScheduleId: conflictingSchedule.id,
            existingScheduleType: conflictingSchedule.scheduleType,
            existingScheduleName: conflictingSchedule.name,
            requestedScheduleType: req.body.scheduleType,
          }
        });
      }
    }

    // Check for schedule type conflicts (daily/interval/custom vs weekly)
    const agentService = require('../services/agentService');
    try {
      const conflictCheck = await agentService.checkScheduleConflict(
        vmBackupHost.url,
        vm.name,
        req.body.scheduleType,
        pool.path
      );

      if (conflictCheck.hasConflict) {
        return res.status(409).json({
          success: false,
          error: conflictCheck.message,
          conflictDetails: {
            conflictingMethod: conflictCheck.conflictingMethod,
            conflictingPath: conflictCheck.conflictingPath,
            targetDirectory: conflictCheck.targetDirectory,
            oppositeDirectory: conflictCheck.oppositeDirectory
          }
        });
      }
    } catch (error) {
      console.error('Error checking schedule conflict:', error.message);
      // Continue if conflict check fails (agent might be down)
      // But log the error
    }

    // Generate cron expression for non-custom-days schedules
    let cronExpression = null;
    if (req.body.scheduleType !== 'custom-days') {
      cronExpression = generateCronExpression({
        type: req.body.scheduleType,
        time: req.body.time,
        daysOfWeek: req.body.daysOfWeek,
        intervalValue: req.body.intervalValue,
        intervalUnit: req.body.intervalUnit,
        cronExpression: req.body.cronExpression,
      });
    }

    const schedules = await getBackupSchedules();
    
    const newSchedule = {
      id: uuidv4(),
      vmId: req.body.vmId,
      storagePoolId: req.body.storagePoolId,
      name: req.body.name || `Backup for ${vm.name}`,
      scheduleType: req.body.scheduleType,
      
      // Common fields
      enabled: req.body.enabled !== false,
      noCompression: req.body.noCompression || false,
      noVerify: req.body.noVerify || false,
      
      // Missed-run policy (Item 1)
      missedRunPolicy: req.body.missedRunPolicy || 'immediate',
      missedRunGracePeriodMinutes: typeof req.body.missedRunGracePeriodMinutes === 'number'
        ? req.body.missedRunGracePeriodMinutes
        : 360,

      // Auto-retry on failure (per-schedule). When a scheduled backup
      // fails, the scheduler retries up to `retryCount` times, waiting
      // `retryDelayMinutes` between attempts. The schedule itself stays
      // intact regardless of the outcome.
      retryCount: typeof req.body.retryCount === 'number' ? req.body.retryCount : 3,
      retryDelayMinutes: typeof req.body.retryDelayMinutes === 'number' ? req.body.retryDelayMinutes : 5,

      // Retention / archive settings for chain backups (daily/weekly/interval/
      // cron). Stored for all types for simplicity; copy-based types
      // (once/monthly) ignore them at backup time. These are read by the
      // scheduler when triggering the agent — if they aren't persisted here
      // the agent silently falls back to 7/2.
      retention: typeof req.body.retention === 'number' ? req.body.retention : 7,
      keepArchive: typeof req.body.keepArchive === 'number' ? req.body.keepArchive : 2,

      // Offsite replication targets (Req 4.4): one destination pool per
      // selected offsite host. offsiteHostIds is mirrored from the targets.
      offsiteTargets: offsiteSelection.offsiteTargets,
      offsiteHostIds: offsiteSelection.offsiteHostIds,

      // Type-specific fields
      ...(req.body.scheduleType === 'daily' && {
        time: req.body.time,
        incrementalCount: req.body.incrementalCount,
        cronExpression,
      }),
      
      ...(req.body.scheduleType === 'weekly' && {
        time: req.body.time,
        daysOfWeek: req.body.daysOfWeek,
        incrementalCount: req.body.incrementalCount,
        cronExpression,
      }),
      
      ...(req.body.scheduleType === 'custom-days' && {
        customDates: req.body.customDates,
        retentionCount: req.body.retentionCount,
      }),
      
      ...(req.body.scheduleType === 'interval' && {
        intervalValue: req.body.intervalValue,
        intervalUnit: req.body.intervalUnit,
        incrementalCount: req.body.incrementalCount,
        cronExpression,
      }),
      
      ...(req.body.scheduleType === 'cron' && {
        cronExpression: req.body.cronExpression,
        incrementalCount: req.body.incrementalCount,
      }),
      
      ...(req.body.scheduleType === 'once' && {
        time: req.body.time,
        cronExpression,
      }),
      
      ...(req.body.scheduleType === 'monthly' && {
        time: req.body.time,
        cronExpression,
      }),
      
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    schedules.push(newSchedule);
    await saveBackupSchedules(schedules);

    // Add to scheduler
    await schedulerService.addSchedule(newSchedule);

    res.status(201).json({ success: true, data: newSchedule });
  } catch (error) {
    next(error);
  }
});

// PUT /api/schedules/:id - Update schedule
router.put('/:id', requireUser, async (req, res, next) => {
  try {
    const schedules = await getBackupSchedules();
    const index = schedules.findIndex(s => s.id === req.params.id);
    
    if (index === -1) {
      return res.status(404).json({ success: false, error: 'Schedule not found' });
    }

    const existingSchedule = schedules[index];
    const scheduleType = req.body.scheduleType || existingSchedule.scheduleType;

    // If schedule type is changing, check for conflicts
    if (req.body.scheduleType && req.body.scheduleType !== existingSchedule.scheduleType) {
      // Controller-side conflict check: prevent changing to a chain-based
      // schedule type when another chain-based schedule already exists for
      // the same VM (excluding the schedule being edited).
      const CHAIN_SCHEDULE_TYPES = ['daily', 'weekly', 'interval', 'cron', 'custom-days'];
      if (CHAIN_SCHEDULE_TYPES.includes(req.body.scheduleType)) {
        const conflictingSchedule = schedules.find(s =>
          s.id !== existingSchedule.id &&
          s.vmId === existingSchedule.vmId &&
          CHAIN_SCHEDULE_TYPES.includes(s.scheduleType) &&
          s.scheduleType !== req.body.scheduleType
        );

        if (conflictingSchedule) {
          return res.status(409).json({
            success: false,
            error: `Cannot change schedule to ${req.body.scheduleType}. VM already has a ${conflictingSchedule.scheduleType} schedule. Only one chain-based schedule (daily/weekly/interval/cron/custom-days) is allowed per VM.`,
            conflictDetails: {
              existingScheduleId: conflictingSchedule.id,
              existingScheduleType: conflictingSchedule.scheduleType,
              existingScheduleName: conflictingSchedule.name,
              requestedScheduleType: req.body.scheduleType,
            }
          });
        }
      }

      const vms = await getVirtualMachines();
      const vm = vms.find(v => v.id === existingSchedule.vmId);
      
      if (vm) {
        const { getStoragePools, getBackupHosts } = require('../services/fileStorage');
        const pools = await getStoragePools();
        const pool = pools.find(p => p.id === existingSchedule.storagePoolId);
        
        if (pool) {
          const hosts = await getBackupHosts();
          const vmBackupHost = hosts.find(h => h.id === vm.backupHostId);
          
          if (vmBackupHost) {
            const agentService = require('../services/agentService');
            try {
              const conflictCheck = await agentService.checkScheduleConflict(
                vmBackupHost.url,
                vm.name,
                req.body.scheduleType,
                pool.path
              );

              if (conflictCheck.hasConflict) {
                return res.status(409).json({
                  success: false,
                  error: conflictCheck.message,
                  conflictDetails: {
                    conflictingMethod: conflictCheck.conflictingMethod,
                    conflictingPath: conflictCheck.conflictingPath,
                    targetDirectory: conflictCheck.targetDirectory,
                    oppositeDirectory: conflictCheck.oppositeDirectory
                  }
                });
              }
            } catch (error) {
              console.error('Error checking schedule conflict:', error.message);
              // Continue if conflict check fails
            }
          }
        }
      }
    }

    // Validate updated schedule
    const validation = validateSchedule({ ...existingSchedule, ...req.body, scheduleType });
    if (!validation.isValid) {
      return res.status(400).json({ success: false, errors: validation.errors });
    }

    // Offsite replication: enforce required per-host pool selection (Req 4.5).
    // Only re-validate when the request carries offsite fields; otherwise the
    // existing selection is preserved unchanged. When present, the same
    // required-selection rule as create applies (exactly one pool per host).
    const offsiteFieldsProvided =
      Object.prototype.hasOwnProperty.call(req.body, 'offsiteTargets') ||
      Object.prototype.hasOwnProperty.call(req.body, 'offsiteHostIds') ||
      Object.prototype.hasOwnProperty.call(req.body, 'offsiteHostId');

    let offsiteTargetsToPersist;
    let offsiteHostIdsToPersist;
    if (offsiteFieldsProvided) {
      const { getOffsiteHosts } = require('../services/fileStorage');
      const offsiteHosts = await getOffsiteHosts();
      const offsiteSelection = await validateOffsiteSelection(req.body, offsiteHosts);
      if (!offsiteSelection.ok) {
        return res.status(400).json({ success: false, error: offsiteSelection.error });
      }
      offsiteTargetsToPersist = offsiteSelection.offsiteTargets;
      offsiteHostIdsToPersist = offsiteSelection.offsiteHostIds;
    } else {
      offsiteTargetsToPersist = Array.isArray(existingSchedule.offsiteTargets)
        ? existingSchedule.offsiteTargets
        : [];
      offsiteHostIdsToPersist = Array.isArray(existingSchedule.offsiteHostIds)
        ? existingSchedule.offsiteHostIds
        : (existingSchedule.offsiteHostId ? [existingSchedule.offsiteHostId] : []);
    }

    // Generate cron expression for non-custom-days schedules
    let cronExpression = existingSchedule.cronExpression;
    if (scheduleType !== 'custom-days') {
      cronExpression = generateCronExpression({
        type: scheduleType,
        time: req.body.time || existingSchedule.time,
        daysOfWeek: req.body.daysOfWeek || existingSchedule.daysOfWeek,
        intervalValue: req.body.intervalValue || existingSchedule.intervalValue,
        intervalUnit: req.body.intervalUnit || existingSchedule.intervalUnit,
        cronExpression: req.body.cronExpression || existingSchedule.cronExpression,
      });
    }

    schedules[index] = {
      ...existingSchedule,
      name: req.body.name || existingSchedule.name,
      scheduleType,
      enabled: req.body.enabled !== undefined ? req.body.enabled : existingSchedule.enabled,
      noCompression: req.body.noCompression !== undefined ? req.body.noCompression : existingSchedule.noCompression,
      noVerify: req.body.noVerify !== undefined ? req.body.noVerify : existingSchedule.noVerify,
      
      // Missed-run policy (Item 1)
      missedRunPolicy: req.body.missedRunPolicy !== undefined
        ? req.body.missedRunPolicy
        : (existingSchedule.missedRunPolicy || 'immediate'),
      missedRunGracePeriodMinutes: typeof req.body.missedRunGracePeriodMinutes === 'number'
        ? req.body.missedRunGracePeriodMinutes
        : (existingSchedule.missedRunGracePeriodMinutes ?? 360),

      // Auto-retry on failure (per-schedule)
      retryCount: typeof req.body.retryCount === 'number'
        ? req.body.retryCount
        : (existingSchedule.retryCount ?? 3),
      retryDelayMinutes: typeof req.body.retryDelayMinutes === 'number'
        ? req.body.retryDelayMinutes
        : (existingSchedule.retryDelayMinutes ?? 5),

      // Retention / archive settings (updatable for chain backups). Without
      // these the bulk/edit changes were silently dropped and the agent
      // always used the 7/2 defaults.
      retention: typeof req.body.retention === 'number'
        ? req.body.retention
        : (existingSchedule.retention ?? 7),
      keepArchive: typeof req.body.keepArchive === 'number'
        ? req.body.keepArchive
        : (existingSchedule.keepArchive ?? 2),

      // Offsite replication targets (Req 4.4, 4.5): one destination pool per
      // selected offsite host. offsiteHostIds is mirrored from the targets.
      offsiteTargets: offsiteTargetsToPersist,
      offsiteHostIds: offsiteHostIdsToPersist,

      // Clear the migration/validation invalid flag (Req 8.4) when offsite
      // fields were provided and passed validateOffsiteSelection above (a
      // failed validation would have returned 400 before reaching here). This
      // lets a corrected schedule be re-enabled and armed normally.
      ...(offsiteFieldsProvided && { invalid: false, invalidReason: null }),

      // Type-specific updates
      ...(scheduleType === 'daily' && {
        time: req.body.time || existingSchedule.time,
        incrementalCount: req.body.incrementalCount || existingSchedule.incrementalCount,
        cronExpression,
      }),
      
      ...(scheduleType === 'weekly' && {
        time: req.body.time || existingSchedule.time,
        daysOfWeek: req.body.daysOfWeek || existingSchedule.daysOfWeek,
        incrementalCount: req.body.incrementalCount || existingSchedule.incrementalCount,
        cronExpression,
      }),
      
      ...(scheduleType === 'custom-days' && {
        customDates: req.body.customDates || existingSchedule.customDates,
        retentionCount: req.body.retentionCount || existingSchedule.retentionCount,
      }),
      
      ...(scheduleType === 'interval' && {
        intervalValue: req.body.intervalValue || existingSchedule.intervalValue,
        intervalUnit: req.body.intervalUnit || existingSchedule.intervalUnit,
        incrementalCount: req.body.incrementalCount || existingSchedule.incrementalCount,
        cronExpression,
      }),
      
      ...(scheduleType === 'cron' && {
        cronExpression: req.body.cronExpression || existingSchedule.cronExpression,
        incrementalCount: req.body.incrementalCount || existingSchedule.incrementalCount,
      }),
      
      ...(scheduleType === 'once' && {
        time: req.body.time || existingSchedule.time,
        cronExpression,
      }),
      
      ...(scheduleType === 'monthly' && {
        time: req.body.time || existingSchedule.time,
        cronExpression,
      }),
      
      updatedAt: new Date().toISOString(),
    };

    await saveBackupSchedules(schedules);

    // Update scheduler
    await schedulerService.updateSchedule(schedules[index]);

    res.json({ success: true, data: schedules[index] });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/schedules/:id - Delete schedule
router.delete('/:id', requireUser, async (req, res, next) => {
  try {
    const schedules = await getBackupSchedules();
    const index = schedules.findIndex(s => s.id === req.params.id);
    
    if (index === -1) {
      return res.status(404).json({ success: false, error: 'Schedule not found' });
    }

    const deleted = schedules.splice(index, 1)[0];
    await saveBackupSchedules(schedules);

    // Remove from scheduler
    await schedulerService.removeSchedule(deleted.id);

    res.json({ success: true, data: { id: deleted.id } });
  } catch (error) {
    next(error);
  }
});

// POST /api/schedules/:id/toggle - Toggle schedule enabled/disabled
router.post('/:id/toggle', requireUser, async (req, res, next) => {
  try {
    const schedules = await getBackupSchedules();
    const schedule = schedules.find(s => s.id === req.params.id);
    
    if (!schedule) {
      return res.status(404).json({ success: false, error: 'Schedule not found' });
    }

    schedule.enabled = !schedule.enabled;
    schedule.updatedAt = new Date().toISOString();
    await saveBackupSchedules(schedules);

    // Update scheduler
    await schedulerService.updateSchedule(schedule);

    res.json({ success: true, data: schedule });
  } catch (error) {
    next(error);
  }
});

// POST /api/schedules/:id/run - Run a schedule immediately, ignoring cron
router.post('/:id/run', requireUser, async (req, res, next) => {
  try {
    const schedules = await getBackupSchedules();
    const schedule = schedules.find(s => s.id === req.params.id);

    if (!schedule) {
      return res.status(404).json({ success: false, error: 'Schedule not found' });
    }

    // We deliberately don't require the schedule to be enabled — "run now"
    // should work even on disabled schedules so operators can fire a one-off
    // backup with the schedule's saved configuration without flipping the
    // toggle. The next cron tick still respects the enabled flag.

    // Fire-and-forget: kick off the same execution path the cron tick uses,
    // returning 202 immediately so the UI can update without waiting for
    // the (potentially long-running) trigger to land on the agent. We
    // pass no replay metadata so the resulting job record looks like a
    // normal scheduled run rather than a missed-run replay.
    schedulerService.executeScheduledBackup(schedule).catch(err => {
      console.error(`[Schedules] run-now failed for ${schedule.id}:`, err.message);
    });

    res.status(202).json({
      success: true,
      message: `Schedule "${schedule.name}" triggered`,
      data: { id: schedule.id, name: schedule.name },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/schedules/upcoming - Get upcoming scheduled backups
router.get('/upcoming/list', async (req, res, next) => {
  try {
    const upcoming = await schedulerService.getUpcomingBackups(10);
    res.json({ success: true, data: upcoming });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
