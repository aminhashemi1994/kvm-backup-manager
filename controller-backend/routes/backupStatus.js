const express = require('express');
const router = express.Router();
const agentService = require('../services/agentService');
const auditService = require('../services/auditService');
const { getBackupHosts, getVirtualMachines, getStoragePools, getBackupSchedules } = require('../services/fileStorage');

// Map controller schedule types to the agent's on-disk schedule directories
function toAgentScheduleType(scheduleType) {
  switch (scheduleType) {
    case 'once':
    case 'monthly':
    case 'daily':
    case 'weekly':
    case 'custom': return scheduleType;
    case 'interval':
    case 'cron': return 'daily';
    case 'custom-days': return 'custom';
    default: return scheduleType;
  }
}

// GET /api/backup-status - Check backup status for a VM
router.get('/', async (req, res, next) => {
  try {
    const { vmId, scheduleType } = req.query;

    console.log('Backup status request:', { vmId, scheduleType });

    if (!vmId || !scheduleType) {
      return res.status(400).json({
        success: false,
        error: 'Missing required query parameters: vmId, scheduleType',
      });
    }

    // Get VM details
    const vms = await getVirtualMachines();
    const vm = vms.find(v => v.id === vmId);

    if (!vm) {
      console.error('VM not found:', vmId);
      return res.status(404).json({
        success: false,
        error: 'VM not found',
      });
    }

    // Get backup host
    const backupHosts = await getBackupHosts();
    const backupHost = backupHosts.find(h => h.id === vm.backupHostId);

    if (!backupHost) {
      console.error('Backup host not found:', vm.backupHostId);
      return res.status(404).json({
        success: false,
        error: 'Backup host not found',
      });
    }

    // Find a schedule for this VM to determine storage pool
    const schedules = await getBackupSchedules();
    const schedule = schedules.find(s => s.vmId === vmId && s.enabled !== false);

    if (!schedule) {
      console.error('No active schedule found for VM:', vmId);
      return res.status(404).json({
        success: false,
        error: 'No active schedule found for this VM. Cannot determine storage pool.',
      });
    }

    // Get storage pool
    const storagePools = await getStoragePools();
    const pool = storagePools.find(p => p.id === schedule.storagePoolId && p.backupHostId === backupHost.id);

    if (!pool) {
      console.error('Storage pool not found:', schedule.storagePoolId);
      return res.status(404).json({
        success: false,
        error: 'Storage pool not found',
      });
    }

    // Map schedule type to agent schedule type
    const agentScheduleType = toAgentScheduleType(scheduleType);

    // Forward request to agent
    console.log('Forwarding to agent:', backupHost.url);
    
    const client = agentService.createAgentClient(backupHost.url, backupHost.id, backupHost.name);
    const response = await client.get('/api/backup-status', {
      params: {
        vmName: vm.name,
        scheduleType: agentScheduleType,
        storagePoolPath: pool.path,
      },
      timeout: 10000, // 10 seconds timeout
    });

    console.log('Agent response:', response.data);
    res.json(response.data);
  } catch (error) {
    console.error('Backup status check error:', error.message);
    if (error.response) {
      console.error('Agent error response:', error.response.data);
      return res.status(error.response.status).json(error.response.data);
    }
    console.error('Error details:', error);
    next(error);
  }
});

// POST /api/backup-status/clear-in-progress - Force-clear a stuck in-progress state
//
// Body: { vmId, scheduleType, storagePoolId?, schedulePath? }
// Resolves the VM's backup host + storage pool and asks the agent to remove
// the stale lock/progress files. The agent refuses if the backup is really
// running, so this is safe to expose as a UI button.
// schedulePath (the backup dir from the report, "<pool>/<vm>/<schedule>") can
// be passed to pick the right pool when a VM spans multiple pools.
router.post('/clear-in-progress', async (req, res, next) => {
  try {
    const { vmId, scheduleType, storagePoolId, schedulePath } = req.body;

    if (!vmId || !scheduleType) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: vmId, scheduleType',
      });
    }

    const vms = await getVirtualMachines();
    const vm = vms.find(v => v.id === vmId);
    if (!vm) {
      return res.status(404).json({ success: false, error: 'VM not found' });
    }

    const backupHosts = await getBackupHosts();
    const backupHost = backupHosts.find(h => h.id === vm.backupHostId);
    if (!backupHost) {
      return res.status(404).json({ success: false, error: 'Backup host not found' });
    }

    // Determine the storage pool: explicit id wins, then the report's backup
    // path (matched against known pool paths), then the VM's schedule.
    const storagePools = await getStoragePools();
    const hostPools = storagePools.filter(p => p.backupHostId === backupHost.id);
    let pool = null;
    if (storagePoolId) {
      pool = hostPools.find(p => p.id === storagePoolId);
    }
    if (!pool && schedulePath) {
      pool = hostPools.find(p => p.path && schedulePath.startsWith(p.path));
    }
    if (!pool) {
      const schedules = await getBackupSchedules();
      const schedule = schedules.find(s => s.vmId === vmId && s.enabled !== false)
        || schedules.find(s => s.vmId === vmId);
      if (schedule) {
        pool = hostPools.find(p => p.id === schedule.storagePoolId);
      }
    }
    if (!pool) {
      return res.status(404).json({
        success: false,
        error: 'Storage pool not found for this VM. Pass storagePoolId explicitly.',
      });
    }

    const agentScheduleType = toAgentScheduleType(scheduleType);

    console.log(`[BackupStatus] Clear in-progress: ${vm.name}/${agentScheduleType} on ${backupHost.name}`);
    const client = agentService.createAgentClient(backupHost.url, backupHost.id, backupHost.name);
    const response = await client.post('/api/backup-status/clear-in-progress', {
      vmName: vm.name,
      scheduleType: agentScheduleType,
      storagePoolPath: pool.path,
    }, {
      timeout: 30000,
    });

    // Audit the action
    try {
      await auditService.log('backup.clear_in_progress', {
        actor: req.user?.username,
        actorId: req.user?.id,
        actorRole: req.user?.role,
        targetType: 'vm',
        targetId: vm.id,
        targetName: vm.name,
        details: { scheduleType: agentScheduleType, storagePool: pool.name, result: response.data?.message },
        ip: req.ip,
      });
    } catch (e) {
      console.error('[BackupStatus] Audit log failed:', e.message);
    }

    res.json(response.data);
  } catch (error) {
    console.error('Clear in-progress error:', error.message);
    if (error.response) {
      return res.status(error.response.status).json(error.response.data);
    }
    next(error);
  }
});

// POST /api/backup-status/bulk - Check status for multiple VMs
router.post('/bulk', async (req, res, next) => {
  try {
    const { vmChecks } = req.body;

    if (!Array.isArray(vmChecks) || vmChecks.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: vmChecks (array of {vmId, scheduleType})',
      });
    }

    console.log('Bulk backup status request for', vmChecks.length, 'VMs');

    const vms = await getVirtualMachines();
    const backupHosts = await getBackupHosts();
    const schedules = await getBackupSchedules();
    const storagePools = await getStoragePools();

    // Group checks by backup host
    const checksByHost = new Map();

    for (const check of vmChecks) {
      const { vmId, scheduleType } = check;

      const vm = vms.find(v => v.id === vmId);
      if (!vm) {
        continue;
      }

      const backupHost = backupHosts.find(h => h.id === vm.backupHostId);
      if (!backupHost) {
        continue;
      }

      const schedule = schedules.find(s => s.vmId === vmId && s.enabled !== false);
      if (!schedule) {
        continue;
      }

      const pool = storagePools.find(p => p.id === schedule.storagePoolId && p.backupHostId === backupHost.id);
      if (!pool) {
        continue;
      }

      const agentScheduleType = toAgentScheduleType(scheduleType);

      if (!checksByHost.has(backupHost.id)) {
        checksByHost.set(backupHost.id, {
          host: backupHost,
          checks: [],
        });
      }

      checksByHost.get(backupHost.id).checks.push({
        vmName: vm.name,
        scheduleType: agentScheduleType,
        storagePoolPath: pool.path,
      });
    }

    // Query each agent
    const allResults = [];

    for (const [hostId, { host, checks }] of checksByHost) {
      try {
        const client = agentService.createAgentClient(host.url, host.id, host.name);
        const response = await client.post('/api/backup-status/bulk', {
          checks,
        }, {
          timeout: 15000, // 15 seconds timeout
        });

        if (response.data.success) {
          allResults.push(...response.data.results);
        }
      } catch (error) {
        console.error(`Error checking backup status on host ${host.name}:`, error.message);
      }
    }

    res.json({
      success: true,
      count: allResults.length,
      results: allResults,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Bulk backup status check error:', error.message);
    next(error);
  }
});

module.exports = router;
