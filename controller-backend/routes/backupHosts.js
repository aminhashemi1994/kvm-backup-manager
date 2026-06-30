const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { getBackupHosts, saveBackupHosts, getHypervisors, getVirtualMachines } = require('../services/fileStorage');
const agentService = require('../services/agentService');
const { validateBackupHost } = require('../utils/validator');

// GET /api/backup-hosts - List all backup hosts
router.get('/', async (req, res, next) => {
  try {
    const hosts = await getBackupHosts();
    const hypervisors = await getHypervisors();
    const vms = await getVirtualMachines();

    // Enrich with counts
    const enrichedHosts = hosts.map(host => {
      const hostHypervisors = hypervisors.filter(h => h.backupHostId === host.id);
      const hostVMs = vms.filter(vm => vm.backupHostId === host.id);
      return {
        ...host,
        hypervisorCount: hostHypervisors.length,
        vmCount: hostVMs.length,
      };
    });

    res.json({ success: true, data: enrichedHosts });
  } catch (error) {
    next(error);
  }
});

// GET /api/backup-hosts/:id - Get single backup host
router.get('/:id', async (req, res, next) => {
  try {
    const hosts = await getBackupHosts();
    const host = hosts.find(h => h.id === req.params.id);
    
    if (!host) {
      return res.status(404).json({ success: false, error: 'Backup host not found' });
    }
    
    res.json({ success: true, data: host });
  } catch (error) {
    next(error);
  }
});

// POST /api/backup-hosts - Add new backup host
router.post('/', async (req, res, next) => {
  try {
    const validation = validateBackupHost(req.body);
    if (!validation.isValid) {
      return res.status(400).json({ success: false, errors: validation.errors });
    }

    const hosts = await getBackupHosts();
    
    // Check if host with same URL exists
    const exists = hosts.find(h => h.url === req.body.url);
    if (exists) {
      return res.status(400).json({ success: false, error: 'Backup host with this URL already exists' });
    }

    // Test connection before adding
    const healthResult = await agentService.healthCheck(req.body.url);

    // Default concurrency comes from system-wide settings (set in
    // Settings → General). The user can still override per host on
    // creation by sending maxConcurrentBackups in the body.
    let systemDefault = 20;
    try {
      const { loadSettings } = require('./settings');
      const sys = await loadSettings();
      if (Number.isFinite(sys?.defaultMaxConcurrentBackups)) {
        systemDefault = sys.defaultMaxConcurrentBackups;
      }
    } catch (_) { /* fall back to literal default */ }

    const newHost = {
      id: uuidv4(),
      name: req.body.name,
      url: req.body.url,
      description: req.body.description || '',
      // Allow 0 (= unlimited). Only fall back to the system default when the
      // field is genuinely absent.
      maxConcurrentBackups: (req.body.maxConcurrentBackups === undefined || req.body.maxConcurrentBackups === null)
        ? systemDefault
        : Number(req.body.maxConcurrentBackups),
      status: healthResult.success ? 'online' : 'offline',
      lastHealthCheck: new Date().toISOString(),
      hypervisorCount: 0,
      vmCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    hosts.push(newHost);
    await saveBackupHosts(hosts);

    res.status(201).json({ 
      success: true, 
      data: newHost,
      healthCheck: healthResult,
    });
  } catch (error) {
    next(error);
  }
});

// PUT /api/backup-hosts/:id - Update backup host
router.put('/:id', async (req, res, next) => {
  try {
    const hosts = await getBackupHosts();
    const index = hosts.findIndex(h => h.id === req.params.id);
    
    if (index === -1) {
      return res.status(404).json({ success: false, error: 'Backup host not found' });
    }

    const before = hosts[index];
    hosts[index] = {
      ...before,
      name: req.body.name || before.name,
      url: req.body.url || before.url,
      description: req.body.description !== undefined ? req.body.description : before.description,
      maxConcurrentBackups: req.body.maxConcurrentBackups !== undefined ? req.body.maxConcurrentBackups : before.maxConcurrentBackups,
      updatedAt: new Date().toISOString(),
    };

    await saveBackupHosts(hosts);

    // If the concurrency cap changed, push a refresh hint to the agent so
    // the change takes effect right away instead of waiting for the next
    // 60-second poll. Best-effort — the periodic poll is the authoritative
    // mechanism, so a failure here is non-fatal.
    if (req.body.maxConcurrentBackups !== undefined &&
        req.body.maxConcurrentBackups !== before.maxConcurrentBackups) {
      try {
        const client = agentService.createAgentClient(hosts[index].url, hosts[index].id, hosts[index].name);
        await client.post('/api/concurrency-config/refresh', {}, { timeout: 5000 });
      } catch (e) {
        console.log(`[backupHosts] Could not push concurrency refresh to agent ${hosts[index].name}: ${e.message}`);
      }
    }

    res.json({ success: true, data: hosts[index] });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/backup-hosts/:id - Delete backup host
router.delete('/:id', async (req, res, next) => {
  try {
    const hosts = await getBackupHosts();
    const index = hosts.findIndex(h => h.id === req.params.id);
    
    if (index === -1) {
      return res.status(404).json({ success: false, error: 'Backup host not found' });
    }

    // Also delete associated hypervisors and VMs
    const hypervisors = await getHypervisors();
    const vms = await getVirtualMachines();
    
    const remainingHypervisors = hypervisors.filter(h => h.backupHostId !== req.params.id);
    const remainingVMs = vms.filter(vm => vm.backupHostId !== req.params.id);
    
    const { saveHypervisors, saveVirtualMachines } = require('../services/fileStorage');
    await saveHypervisors(remainingHypervisors);
    await saveVirtualMachines(remainingVMs);

    const deleted = hosts.splice(index, 1)[0];
    await saveBackupHosts(hosts);

    res.json({ success: true, data: deleted });
  } catch (error) {
    next(error);
  }
});

// GET /api/backup-hosts/:id/concurrent-config - Return the concurrency
// configuration for this backup host. The agent polls this on a fixed
// interval (mirroring how it pulls storage pools) so the controller is
// the single source of truth for maxConcurrentBackups. Editing the host
// in the panel takes effect on the next agent poll automatically.
router.get('/:id/concurrent-config', async (req, res, next) => {
  try {
    const hosts = await getBackupHosts();
    const host = hosts.find(h => h.id === req.params.id);
    if (!host) {
      return res.status(404).json({ success: false, error: 'Backup host not found' });
    }
    res.json({
      success: true,
      data: {
        backupHostId: host.id,
        // Pass 0 through unchanged — 0 means "unlimited concurrency".
        maxConcurrentBackups: (host.maxConcurrentBackups === undefined || host.maxConcurrentBackups === null)
          ? 20
          : Number(host.maxConcurrentBackups),
        updatedAt: host.updatedAt || null,
      },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/backup-hosts/:id/health-check - Health check for backup host
router.post('/:id/health-check', async (req, res, next) => {
  try {
    const hosts = await getBackupHosts();
    const host = hosts.find(h => h.id === req.params.id);
    
    if (!host) {
      return res.status(404).json({ success: false, error: 'Backup host not found' });
    }

    const result = await agentService.healthCheck(host.url);
    
    // Update host status
    host.status = result.success ? 'online' : 'offline';
    host.lastHealthCheck = new Date().toISOString();
    await saveBackupHosts(hosts);

    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// POST /api/backup-hosts/:id/init - Initialize backup host with dependencies
router.post('/:id/init', async (req, res, next) => {
  try {
    const hosts = await getBackupHosts();
    const host = hosts.find(h => h.id === req.params.id);
    
    if (!host) {
      return res.status(404).json({ success: false, error: 'Backup host not found' });
    }

    // Extract IP from URL (e.g., "http://192.168.1.100:3002" -> "192.168.1.100")
    const urlMatch = host.url.match(/https?:\/\/([^:\/]+)/);
    if (!urlMatch) {
      return res.status(400).json({ success: false, error: 'Invalid host URL format' });
    }
    const hostIp = urlMatch[1];

    // Call agent's init endpoint
    const result = await agentService.initHost(host.url, hostIp);
    
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
