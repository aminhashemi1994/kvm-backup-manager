const express = require('express');
const router = express.Router();
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

/**
 * POST /api/remote-metrics/hypervisor - Get metrics for a hypervisor via SSH
 */
router.post('/hypervisor', async (req, res, next) => {
  try {
    const { ip, username = 'root', port = 22 } = req.body;

    if (!ip) {
      return res.status(400).json({
        success: false,
        error: 'IP address is required'
      });
    }

    console.log(`[RemoteMetrics] Collecting metrics for hypervisor: ${ip}`);

    // Get disk usage for all mount points via SSH
    const diskCommand = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${port} ${username}@${ip} "df -BG | grep -E '^/dev/' | awk '{print \\$1,\\$2,\\$3,\\$4,\\$5,\\$6}'"`;

    const { stdout, stderr } = await execAsync(diskCommand, { timeout: 15000 });
    
    if (stderr && stderr.trim()) {
      console.warn(`[RemoteMetrics] SSH stderr for ${ip}:`, stderr);
    }

    const lines = stdout.trim().split('\n');
    const disks = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      
      const parts = line.split(/\s+/);
      if (parts.length >= 6) {
        disks.push({
          device: parts[0],
          mountPoint: parts[5],
          total: parseInt(parts[1].replace('G', '')) || 0,
          used: parseInt(parts[2].replace('G', '')) || 0,
          available: parseInt(parts[3].replace('G', '')) || 0,
          usage: parseInt(parts[4].replace('%', '')) || 0
        });
      }
    }

    console.log(`[RemoteMetrics] ✓ Collected ${disks.length} disk(s) for ${ip}`);

    res.json({
      success: true,
      data: {
        ip,
        disks,
        timestamp: new Date().toISOString(),
        status: 'online'
      }
    });
  } catch (error) {
    console.error('[RemoteMetrics] Error collecting hypervisor metrics:', error.message);
    
    res.json({
      success: false,
      data: {
        ip: req.body.ip,
        disks: [],
        timestamp: new Date().toISOString(),
        status: 'offline',
        error: error.message
      }
    });
  }
});

/**
 * POST /api/remote-metrics/offsite - Get metrics for an offsite host via SSH
 */
router.post('/offsite', async (req, res, next) => {
  try {
    const { ip, username = 'root', port = 22, storagePools = [] } = req.body;

    if (!ip) {
      return res.status(400).json({
        success: false,
        error: 'IP address is required'
      });
    }

    console.log(`[RemoteMetrics] Collecting metrics for offsite: ${ip}`);
    console.log(`[RemoteMetrics] Storage pools to check:`, storagePools);

    const disks = [];

    // For offsite hosts, check storage pool paths directly using df
    // We don't require them to be mounted as separate filesystems
    if (storagePools && storagePools.length > 0) {
      for (const pool of storagePools) {
        const poolPath = pool.offsitePath || pool.mountPoint;
        
        try {
          // Ensure the directory exists first
          const mkdirCommand = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${port} ${username}@${ip} "mkdir -p '${poolPath}' 2>/dev/null"`;
          await execAsync(mkdirCommand, { timeout: 10000 }).catch(() => {
            console.log(`[RemoteMetrics] Directory ${poolPath} might already exist or cannot be created`);
          });
          
          // Get the filesystem that contains this path
          const dfCommand = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${port} ${username}@${ip} "df -BG '${poolPath}' 2>/dev/null | tail -1 | awk '{print \\$1,\\$2,\\$3,\\$4,\\$5,\\$6}'"`;
          const { stdout: dfOutput } = await execAsync(dfCommand, { timeout: 15000 });
          
          if (dfOutput && dfOutput.trim()) {
            const parts = dfOutput.trim().split(/\s+/);
            if (parts.length >= 6) {
              disks.push({
                device: parts[0],
                mountPoint: poolPath,
                total: parseInt(parts[1].replace('G', '')) || 0,
                used: parseInt(parts[2].replace('G', '')) || 0,
                available: parseInt(parts[3].replace('G', '')) || 0,
                usage: parseInt(parts[4].replace('%', '')) || 0,
                poolName: pool.name,
                poolId: pool.id
              });
              console.log(`[RemoteMetrics] ✓ Got metrics for storage pool ${pool.name} at ${poolPath}`);
            }
          }
        } catch (error) {
          console.warn(`[RemoteMetrics] Could not get metrics for pool ${pool.name} at ${poolPath}:`, error.message);
        }
      }
    }

    console.log(`[RemoteMetrics] ✓ Collected ${disks.length} storage pool disk(s) for ${ip}`);

    res.json({
      success: true,
      data: {
        ip,
        disks,
        timestamp: new Date().toISOString(),
        status: 'online'
      }
    });
  } catch (error) {
    console.error('[RemoteMetrics] Error collecting offsite metrics:', error.message);
    
    res.json({
      success: false,
      data: {
        ip: req.body.ip,
        disks: [],
        timestamp: new Date().toISOString(),
        status: 'offline',
        error: error.message
      }
    });
  }
});

module.exports = router;
