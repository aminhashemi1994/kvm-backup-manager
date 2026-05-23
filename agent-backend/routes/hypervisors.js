const express = require('express');
const router = express.Router();
const sshService = require('../services/sshService');

// GET /api/hypervisors - List all hypervisors (stored in memory)
router.get('/', async (req, res, next) => {
  try {
    const hypervisors = req.app.get('hypervisors');
    const list = Array.from(hypervisors.values()).map(h => ({
      id: h.id,
      name: h.name,
      ip: h.ip,
      port: h.port,
      username: h.username,
      status: h.status,
    }));
    
    res.json({ success: true, data: list });
  } catch (error) {
    next(error);
  }
});

// POST /api/hypervisors - Add hypervisor
// NOTE: SSH keys should be configured manually on the backup host server
router.post('/', async (req, res, next) => {
  try {
    const { id, name, ip, port, username } = req.body;
    
    if (!id || !name || !ip) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: id, name, ip',
      });
    }

    const hypervisors = req.app.get('hypervisors');

    // Simple connectivity test (ping)
    console.log(`Testing connectivity to ${ip}...`);
    
    let testResult = { success: false, message: 'Connectivity test not performed' };
    try {
      const { spawn } = require('child_process');
      const ping = spawn('ping', ['-c', '1', '-W', '2', ip]);
      
      await new Promise((resolve) => {
        ping.on('close', (code) => {
          testResult = {
            success: code === 0,
            message: code === 0 ? 'Host is reachable' : 'Host is not reachable'
          };
          resolve();
        });
      });
      
      console.log('Connectivity test result:', testResult);
    } catch (error) {
      console.error('Connectivity test error:', error);
      testResult = {
        success: false,
        message: error.message || 'Connectivity test failed'
      };
    }

    const hypervisor = {
      id,
      name,
      ip,
      port: port || 22,
      username: username || 'root',
      status: testResult.success ? 'connected' : 'error',
      lastError: testResult.success ? null : testResult.message,
      addedAt: new Date().toISOString(),
    };

    hypervisors.set(id, hypervisor);

    res.status(201).json({
      success: true,
      data: {
        id: hypervisor.id,
        name: hypervisor.name,
        ip: hypervisor.ip,
        status: hypervisor.status,
        lastError: hypervisor.lastError,
      },
      connectionTest: testResult,
    });
  } catch (error) {
    console.error('Error adding hypervisor:', error);
    next(error);
  }
});

// GET /api/hypervisors/:id - Get single hypervisor
router.get('/:id', async (req, res, next) => {
  try {
    const hypervisors = req.app.get('hypervisors');
    const hypervisor = hypervisors.get(req.params.id);
    
    if (!hypervisor) {
      return res.status(404).json({ success: false, error: 'Hypervisor not found' });
    }

    res.json({
      success: true,
      data: {
        id: hypervisor.id,
        name: hypervisor.name,
        ip: hypervisor.ip,
        port: hypervisor.port,
        username: hypervisor.username,
        status: hypervisor.status,
      },
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/hypervisors/:id - Remove hypervisor
router.delete('/:id', async (req, res, next) => {
  try {
    const hypervisors = req.app.get('hypervisors');
    
    if (!hypervisors.has(req.params.id)) {
      return res.status(404).json({ success: false, error: 'Hypervisor not found' });
    }

    hypervisors.delete(req.params.id);
    res.json({ success: true, data: { id: req.params.id } });
  } catch (error) {
    next(error);
  }
});

// GET /api/hypervisors/:id/vms - List VMs from hypervisor
// NOTE: Uses SSH keys configured on the backup host server
router.get('/:id/vms', async (req, res, next) => {
  try {
    const hypervisors = req.app.get('hypervisors');
    const hypervisor = hypervisors.get(req.params.id);
    
    if (!hypervisor) {
      return res.status(404).json({ success: false, error: 'Hypervisor not found' });
    }

    console.log(`Listing VMs from hypervisor ${hypervisor.ip}...`);
    
    try {
      // Use SSH without explicit key (relies on ~/.ssh/config or ssh-agent)
      const { spawn } = require('child_process');
      const ssh = spawn('ssh', [
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'ConnectTimeout=10',
        `${hypervisor.username}@${hypervisor.ip}`,
        "virsh list --all | awk 'NR>2 {print $2,$3,$4}'"
      ]);

      let stdout = '';
      let stderr = '';

      ssh.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      ssh.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          ssh.kill();
          reject(new Error('VM listing timeout after 60 seconds'));
        }, 60000);

        ssh.on('close', (code) => {
          clearTimeout(timeout);
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`SSH command failed with code ${code}: ${stderr}`));
          }
        });

        ssh.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });

      // Parse VM list with state
      // Format: "vmname running" or "vmname shut off"
      const vms = stdout
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(line => {
          const parts = line.split(/\s+/);
          const name = parts[0];
          // State can be "running", "shut", "paused", etc.
          // If it's "shut off", combine them
          let state = parts[1] || 'unknown';
          if (state === 'shut' && parts[2] === 'off') {
            state = 'shut off';
          }
          return { name, state };
        });
      
      console.log(`Found ${vms.length} VMs`);
      res.json({ success: true, data: vms });
    } catch (error) {
      console.error('Error listing VMs:', error.message);
      res.status(500).json({ 
        success: false, 
        error: error.message 
      });
    }
  } catch (error) {
    next(error);
  }
});

// POST /api/hypervisors/:id/test - Test connection
// NOTE: Uses SSH keys configured on the backup host server
router.post('/:id/test', async (req, res, next) => {
  try {
    const hypervisors = req.app.get('hypervisors');
    const hypervisor = hypervisors.get(req.params.id);
    
    if (!hypervisor) {
      return res.status(404).json({ success: false, error: 'Hypervisor not found' });
    }

    try {
      // Simple SSH test without explicit key
      const { spawn } = require('child_process');
      const ssh = spawn('ssh', [
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'ConnectTimeout=10',
        `${hypervisor.username}@${hypervisor.ip}`,
        'echo "Connection OK"'
      ]);

      let success = false;

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          ssh.kill();
          reject(new Error('Connection test timeout after 45 seconds'));
        }, 45000);

        ssh.on('close', (code) => {
          clearTimeout(timeout);
          success = code === 0;
          resolve();
        });

        ssh.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });

      const result = {
        success,
        message: success ? 'Connection successful' : 'Connection failed'
      };

      // Update status
      hypervisor.status = result.success ? 'connected' : 'error';
      hypervisor.lastError = result.success ? null : result.message;

      res.json({ success: true, data: result });
    } catch (error) {
      hypervisor.status = 'error';
      hypervisor.lastError = error.message;
      res.json({ 
        success: true, 
        data: { 
          success: false, 
          message: error.message 
        } 
      });
    }
  } catch (error) {
    next(error);
  }
});

module.exports = router;
