const express = require('express');
const router = express.Router();
const { getVirtualMachines, saveVirtualMachines, getHypervisors, getBackupHosts } = require('../services/fileStorage');

// GET /api/vms - List all VMs
router.get('/', async (req, res, next) => {
  try {
    const vms = await getVirtualMachines();
    res.json({ success: true, data: vms });
  } catch (error) {
    next(error);
  }
});

// GET /api/vms/hypervisor/:hypervisorId - Get VMs for a hypervisor
router.get('/hypervisor/:hypervisorId', async (req, res, next) => {
  try {
    const vms = await getVirtualMachines();
    const hypervisorVMs = vms.filter(v => v.hypervisorId === req.params.hypervisorId);
    res.json({ success: true, data: hypervisorVMs });
  } catch (error) {
    next(error);
  }
});

// GET /api/vms/backup-host/:backupHostId - Get VMs for a backup host
router.get('/backup-host/:backupHostId', async (req, res, next) => {
  try {
    const vms = await getVirtualMachines();
    const hostVMs = vms.filter(v => v.backupHostId === req.params.backupHostId);
    res.json({ success: true, data: hostVMs });
  } catch (error) {
    next(error);
  }
});

// GET /api/vms/selected - Get selected VMs
router.get('/selected', async (req, res, next) => {
  try {
    const vms = await getVirtualMachines();
    const hypervisors = await getHypervisors();
    const hosts = await getBackupHosts();
    
    const selectedVMs = vms
      .filter(v => v.selected === true)
      .map(vm => {
        const hypervisor = hypervisors.find(h => h.id === vm.hypervisorId);
        const host = hosts.find(h => h.id === vm.backupHostId);
        return {
          ...vm,
          hypervisorName: hypervisor?.name,
          hypervisorIp: hypervisor?.ip,
          backupHostName: host?.name,
        };
      });
      
    res.json({ success: true, data: selectedVMs });
  } catch (error) {
    next(error);
  }
});

// GET /api/vms/:id - Get single VM
router.get('/:id', async (req, res, next) => {
  try {
    const vms = await getVirtualMachines();
    const vm = vms.find(v => v.id === req.params.id);
    
    if (!vm) {
      return res.status(404).json({ success: false, error: 'VM not found' });
    }
    
    res.json({ success: true, data: vm });
  } catch (error) {
    next(error);
  }
});

// PUT /api/vms/:id - Update VM (selection state and retention settings)
router.put('/:id', async (req, res, next) => {
  try {
    const vms = await getVirtualMachines();
    const index = vms.findIndex(v => v.id === req.params.id);
    
    if (index === -1) {
      return res.status(404).json({ success: false, error: 'VM not found' });
    }

    vms[index] = {
      ...vms[index],
      selected: req.body.selected !== undefined ? req.body.selected : vms[index].selected,
      maxArchivedBackups: req.body.maxArchivedBackups !== undefined ? req.body.maxArchivedBackups : vms[index].maxArchivedBackups,
      maxMonthlyBackups: req.body.maxMonthlyBackups !== undefined ? req.body.maxMonthlyBackups : vms[index].maxMonthlyBackups,
      incrementalCycleCount: req.body.incrementalCycleCount !== undefined ? req.body.incrementalCycleCount : vms[index].incrementalCycleCount,
      currentIncrementalCount: req.body.currentIncrementalCount !== undefined ? req.body.currentIncrementalCount : vms[index].currentIncrementalCount,
      updatedAt: new Date().toISOString(),
    };

    await saveVirtualMachines(vms);
    res.json({ success: true, data: vms[index] });
  } catch (error) {
    next(error);
  }
});

// POST /api/vms/select-multiple - Select multiple VMs
router.post('/select-multiple', async (req, res, next) => {
  try {
    const { vmIds, selected } = req.body;
    
    if (!Array.isArray(vmIds)) {
      return res.status(400).json({ success: false, error: 'vmIds must be an array' });
    }

    const vms = await getVirtualMachines();
    
    for (const vm of vms) {
      if (vmIds.includes(vm.id)) {
        vm.selected = selected;
        vm.updatedAt = new Date().toISOString();
      }
    }

    await saveVirtualMachines(vms);
    res.json({ success: true, data: vms.filter(v => vmIds.includes(v.id)) });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
