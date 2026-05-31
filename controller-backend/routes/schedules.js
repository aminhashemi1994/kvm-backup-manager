const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { getBackupSchedules, saveBackupSchedules, getVirtualMachines } = require('../services/fileStorage');
const schedulerService = require('../services/schedulerService');
const auditService = require('../services/auditService');
const { validateSchedule } = require('../utils/validator');
const { generateCronExpression, parseCronToHuman } = require('../utils/helpers');
const { requireUser } = require('../middleware/rbac');

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
    
    res.json({ success: true, data: schedule });
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
      
      // Type-specific fields
      ...(req.body.scheduleType === 'daily' && {
        time: req.body.time,
        incrementalCount: req.body.incrementalCount,
        cronExpression,
      }),
      
      ...(req.body.scheduleType === 'weekly' && {
        time: req.body.time,
        daysOfWeek: req.body.daysOfWeek,
        fullBackupDay: req.body.fullBackupDay,
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
      
      // Type-specific updates
      ...(scheduleType === 'daily' && {
        time: req.body.time || existingSchedule.time,
        incrementalCount: req.body.incrementalCount || existingSchedule.incrementalCount,
        cronExpression,
      }),
      
      ...(scheduleType === 'weekly' && {
        time: req.body.time || existingSchedule.time,
        daysOfWeek: req.body.daysOfWeek || existingSchedule.daysOfWeek,
        fullBackupDay: req.body.fullBackupDay !== undefined ? req.body.fullBackupDay : existingSchedule.fullBackupDay,
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
