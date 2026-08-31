const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { 
  getHypervisors, 
  saveHypervisors, 
  getBackupHosts, 
  getVirtualMachines, 
  saveVirtualMachines 
} = require('../services/fileStorage');
const agentService = require('../services/agentService');
const rocketChatService = require('../services/rocketChatService');
const { validateHypervisor } = require('../utils/validator');

function ensureProtocol(url) {
  if (!url) return url;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return 'http://' + url;
  }
  return url;
}

// GET /api/hypervisors
router.get('/', async (req, res, next) => {
  try {
    const hypervisors = await getHypervisors();
    res.json({ success: true, data: hypervisors });
  } catch (error) {
    next(error);
  }
});

// How long a single hypervisor is allowed to hold up the live-status sweep
// below. Kept short and independent of `config.agentRequestTimeout` (which is
// minutes, sized for real backup/restore calls) so one unreachable
// hypervisor can't stall the others — each is probed in parallel and given
// this long to answer before it's reported unreachable.
const HYPERVISOR_STATUS_CHECK_TIMEOUT_MS = 10000;

// Probe every hypervisor's live status in the background and push results
// out as they land, instead of making the list request wait on all of them.
// Previously this loop ran serially, inline, before the response was sent —
// one unreachable hypervisor (each retried against the full multi-minute
// agent timeout) could hold up the entire backup host's hypervisor list.
function checkHypervisorStatusesInBackground(io, backupHostId, hostUrl, hostHypervisors) {
  hostHypervisors.forEach((hypervisor) => {
    agentService.testHypervisor(hostUrl, hypervisor.id, HYPERVISOR_STATUS_CHECK_TIMEOUT_MS)
      .then(async (result) => {
        const newStatus = result.success ? 'connected' : 'error';
        const newLastError = result.success ? null : result.message;

        const unchanged = hypervisor.status === newStatus && hypervisor.lastError === newLastError;

        if (!unchanged) {
          const allHypervisors = await getHypervisors();
          const index = allHypervisors.findIndex(h => h.id === hypervisor.id);
          if (index === -1) return; // deleted while the probe was in flight

          allHypervisors[index] = {
            ...allHypervisors[index],
            status: newStatus,
            lastError: newLastError,
            updatedAt: new Date().toISOString(),
          };
          await saveHypervisors(allHypervisors);

          if (!result.success) {
            rocketChatService.notifyHypervisorConnectionFailed(
              hypervisor.name,
              hypervisor.ip,
              result.message
            );
          }
        }

        // Always broadcast, even when nothing changed — the frontend re-arms
        // its "Connecting..." state on every poll (see the `checking: true`
        // overlay below) and relies on this event to clear it. Skipping the
        // emit for the common steady-state case (already connected, still
        // connected) left the card stuck showing "Connecting..." forever.
        if (io) {
          io.emit('hypervisor-status-updated', {
            backupHostId,
            hypervisorId: hypervisor.id,
            status: newStatus,
            lastError: newLastError,
          });
        }
      })
      .catch((error) => {
        console.error(`[Hypervisors] Background status check failed for ${hypervisor.id}: ${error.message}`);
      });
  });
}

// GET /api/hypervisors/backup-host/:backupHostId
router.get('/backup-host/:backupHostId', async (req, res, next) => {
  try {
    const hypervisors = await getHypervisors();
    const vms = await getVirtualMachines();
    const hosts = await getBackupHosts();
    const host = hosts.find(h => h.id === req.params.backupHostId);

    const hostHypervisors = hypervisors
      .filter(h => h.backupHostId === req.params.backupHostId)
      .map(h => {
        const hypervisorVMs = vms.filter(vm => vm.hypervisorId === h.id);
        return { ...h, vmCount: hypervisorVMs.length };
      });

    // Respond immediately with what's already known — do not make the whole
    // list wait on live connectivity checks. If the backup host is online,
    // kick off a live status sweep in the background; the frontend shows a
    // "checking" state per hypervisor until a `hypervisor-status-updated`
    // socket event (or its own timeout) resolves it.
    let checking = false;
    if (host && host.status === 'online' && hostHypervisors.length > 0) {
      const hostUrl = ensureProtocol(host.url);
      checkHypervisorStatusesInBackground(req.app.get('io'), host.id, hostUrl, hostHypervisors);
      checking = true;
    }

    res.json({
      success: true,
      data: checking ? hostHypervisors.map(h => ({ ...h, checking: true })) : hostHypervisors,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/hypervisors/:id
router.get('/:id', async (req, res, next) => {
  try {
    const hypervisors = await getHypervisors();
    const hypervisor = hypervisors.find(h => h.id === req.params.id);
    
    if (!hypervisor) {
      return res.status(404).json({ success: false, error: 'Hypervisor not found' });
    }
    
    res.json({ success: true, data: hypervisor });
  } catch (error) {
    next(error);
  }
});

// POST /api/hypervisors - Add new hypervisor
// NOTE: SSH keys should be configured manually on the backup host server
router.post('/', async (req, res, next) => {
  try {
    const validation = validateHypervisor(req.body);
    if (!validation.isValid) {
      return res.status(400).json({ success: false, errors: validation.errors });
    }

    const hosts = await getBackupHosts();
    const host = hosts.find(h => h.id === req.body.backupHostId);
    if (!host) {
      return res.status(400).json({ success: false, error: 'Backup host not found' });
    }

    if (host.status !== 'online') {
      return res.status(400).json({ success: false, error: 'Backup host is offline' });
    }

    const hypervisors = await getHypervisors();
    
    const newHypervisor = {
      id: uuidv4(),
      backupHostId: req.body.backupHostId,
      name: req.body.name,
      ip: req.body.ip,
      port: req.body.port || 22,
      username: req.body.username || 'root',
      status: 'pending',
      vmCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const hostUrl = ensureProtocol(host.url);

    // Send hypervisor to agent and test connection
    try {
      const result = await agentService.addHypervisor(hostUrl, {
        id: newHypervisor.id,
        name: newHypervisor.name,
        ip: newHypervisor.ip,
        port: newHypervisor.port,
        username: newHypervisor.username,
      });
      
      newHypervisor.status = result.connectionTest?.success ? 'connected' : 'error';
      if (!result.connectionTest?.success) {
        newHypervisor.lastError = result.connectionTest?.message || 'Connection failed';
      }
    } catch (error) {
      newHypervisor.status = 'error';
      newHypervisor.lastError = error.message;
    }

    hypervisors.push(newHypervisor);
    await saveHypervisors(hypervisors);

    // Auto-refresh VMs if connected
    if (newHypervisor.status === 'connected') {
      try {
        const vmList = await agentService.listVMs(hostUrl, newHypervisor.id);
        if (vmList.success && vmList.data) {
          const vms = await getVirtualMachines();
          const newVMs = vmList.data.map(vm => ({
            id: uuidv4(),
            hypervisorId: newHypervisor.id,
            backupHostId: req.body.backupHostId,
            name: vm.name,
            state: vm.state || 'unknown',
            selected: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }));
          
          await saveVirtualMachines([...vms, ...newVMs]);
          newHypervisor.vmCount = newVMs.length;
          await saveHypervisors(hypervisors);
        }
      } catch (error) {
        console.log('Auto-refresh VMs failed:', error.message);
      }
    }
    
    // Always return 201 with the hypervisor data
    res.status(201).json({ 
      success: true, 
      data: newHypervisor,
      message: newHypervisor.status === 'connected' 
        ? 'Hypervisor added successfully' 
        : `Hypervisor added but connection failed: ${newHypervisor.lastError}`
    });
  } catch (error) {
    next(error);
  }
});

// PUT /api/hypervisors/:id - Update hypervisor
router.put('/:id', async (req, res, next) => {
  try {
    const hypervisors = await getHypervisors();
    const index = hypervisors.findIndex(h => h.id === req.params.id);
    
    if (index === -1) {
      return res.status(404).json({ success: false, error: 'Hypervisor not found' });
    }

    const hypervisor = hypervisors[index];
    
    // Update fields
    if (req.body.name !== undefined) hypervisor.name = req.body.name;
    if (req.body.ip !== undefined) hypervisor.ip = req.body.ip;
    if (req.body.port !== undefined) hypervisor.port = req.body.port;
    if (req.body.username !== undefined) hypervisor.username = req.body.username;
    hypervisor.updatedAt = new Date().toISOString();

    await saveHypervisors(hypervisors);
    
    // Update on agent if backup host is online
    const hosts = await getBackupHosts();
    const host = hosts.find(h => h.id === hypervisor.backupHostId);
    if (host && host.status === 'online') {
      try {
        const hostUrl = ensureProtocol(host.url);
        await agentService.addHypervisor(hostUrl, {
          id: hypervisor.id,
          name: hypervisor.name,
          ip: hypervisor.ip,
          port: hypervisor.port,
          username: hypervisor.username,
        });
      } catch (error) {
        console.log('Failed to update hypervisor on agent:', error.message);
      }
    }

    res.json({ success: true, data: hypervisor });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/hypervisors/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const hypervisors = await getHypervisors();
    const index = hypervisors.findIndex(h => h.id === req.params.id);
    
    if (index === -1) {
      return res.status(404).json({ success: false, error: 'Hypervisor not found' });
    }

    const vms = await getVirtualMachines();
    const remainingVMs = vms.filter(v => v.hypervisorId !== req.params.id);
    await saveVirtualMachines(remainingVMs);

    const deleted = hypervisors.splice(index, 1)[0];
    await saveHypervisors(hypervisors);

    res.json({ success: true, data: { id: deleted.id } });
  } catch (error) {
    next(error);
  }
});

// POST /api/hypervisors/:id/refresh-vms
router.post('/:id/refresh-vms', async (req, res, next) => {
  try {
    const hypervisors = await getHypervisors();
    const hypervisor = hypervisors.find(h => h.id === req.params.id);
    
    if (!hypervisor) {
      return res.status(404).json({ success: false, error: 'Hypervisor not found' });
    }

    const hosts = await getBackupHosts();
    const host = hosts.find(h => h.id === hypervisor.backupHostId);
    
    if (!host) {
      return res.status(400).json({ success: false, error: 'Backup host not found' });
    }

    const hostUrl = ensureProtocol(host.url);
    
    // First, ensure the hypervisor exists on the agent
    // (it might have been lost if agent restarted)
    try {
      await agentService.addHypervisor(hostUrl, {
        id: hypervisor.id,
        name: hypervisor.name,
        ip: hypervisor.ip,
        port: hypervisor.port,
        username: hypervisor.username,
      });
    } catch (error) {
      console.log('Note: Could not re-add hypervisor to agent:', error.message);
      // Continue anyway, it might already exist
    }
    
    // Now list VMs
    const vmList = await agentService.listVMs(hostUrl, hypervisor.id);

    if (!vmList.success) {
      return res.status(500).json({ success: false, error: vmList.error || 'Failed to list VMs' });
    }

    const vms = await getVirtualMachines();
    const otherVMs = vms.filter(v => v.hypervisorId !== hypervisor.id);
    const existingVMs = vms.filter(v => v.hypervisorId === hypervisor.id);
    const existingVMMap = new Map(existingVMs.map(vm => [vm.name, vm]));

    const newVMs = vmList.data.map(vm => {
      const existing = existingVMMap.get(vm.name);
      return {
        id: existing?.id || uuidv4(),
        hypervisorId: hypervisor.id,
        backupHostId: hypervisor.backupHostId,
        name: vm.name,
        state: vm.state || 'unknown',
        selected: existing?.selected || false,
        createdAt: existing?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    });

    await saveVirtualMachines([...otherVMs, ...newVMs]);

    hypervisor.vmCount = newVMs.length;
    hypervisor.status = 'connected';
    hypervisor.updatedAt = new Date().toISOString();
    await saveHypervisors(hypervisors);

    res.json({ success: true, data: newVMs });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
