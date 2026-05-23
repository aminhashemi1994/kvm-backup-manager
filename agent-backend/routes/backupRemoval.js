const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Non-VM directory names to exclude
const NON_VM_NAMES = [
  'in_progress_backups', 'offsite_locks', 'metrics', 'restore', 'logs',
  'archived', 'TPM', 'scheduler', 'current', 'Error.log', 'Execution.log',
  'backup_scheduler.run', 'backup_scheduler.sh', 'backup_manager.sh',
  'backup_info.sh', 'setting.sh', 'old_json'
];

// GET /api/backup-removal/vms - List all VM names (quick)
router.get('/vms', async (req, res, next) => {
  try {
    const axios = require('axios');
    const config = require('../config/config');
    const controllerAuthService = require('../services/controllerAuthService');
    
    console.log('Listing VMs from all storage pools');

    // Get storage pools from controller
    let storagePools = [];
    try {
      const controllerUrl = process.env.CONTROLLER_URL || 'http://localhost:3000';
      // If backupHostId is configured, fetch only storage pools for this backup host
      const endpoint = config.backupHostId 
        ? `/storage-pools/backup-host/${config.backupHostId}`
        : '/storage-pools';
      
      const response = await controllerAuthService.get(controllerUrl, endpoint);
      storagePools = response.data.data || [];
      console.log(`Found ${storagePools.length} storage pools`);
    } catch (error) {
      console.error('Error fetching storage pools:', error.message);
      // Fallback to old config.backupPath if storage pools not available
      const backupPath = config.backupPath;
      if (fs.existsSync(backupPath)) {
        console.log(`Fallback: Using config.backupPath: ${backupPath}`);
        storagePools = [{ path: backupPath }];
      } else {
        return res.json({ success: true, data: [] });
      }
    }

    // If no storage pools, return empty
    if (storagePools.length === 0) {
      console.log('No storage pools defined');
      return res.json({ success: true, data: [] });
    }

    // Collect VMs with their storage pool info
    const allVMs = [];
    const seenVMNames = new Set();

    for (const pool of storagePools) {
      const backupPath = pool.path;
      
      if (!fs.existsSync(backupPath)) {
        console.log(`Storage pool path does not exist: ${backupPath}`);
        continue;
      }

      console.log(`Scanning storage pool: ${backupPath}`);

      // Read all directories and filter out non-VM directories
      const allDirs = fs.readdirSync(backupPath, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

      const vmNames = allDirs.filter(name => {
        // Exclude non-VM directories
        if (NON_VM_NAMES.includes(name)) return false;
        if (name.startsWith('.')) return false;
        
        // Include if starts with 20YYXXX- pattern (VM naming convention)
        if (/^20[0-9]{2}[0-9]{3,6}[-_]/.test(name)) return true;
        
        // Include if has schedule subdirectories
        const vmPath = path.join(backupPath, name);
        const scheduleTypes = ['daily', 'weekly', 'monthly', 'once', 'custom'];
        for (const scheduleType of scheduleTypes) {
          if (fs.existsSync(path.join(vmPath, scheduleType))) {
            return true;
          }
        }
        
        return false;
      });

      // Add VMs with storage pool info (avoid duplicates)
      vmNames.forEach(name => {
        if (!seenVMNames.has(name)) {
          seenVMNames.add(name);
          allVMs.push({
            name: name,
            storagePoolPath: pool.path,
            storagePoolName: pool.name || pool.path
          });
        }
      });
    }

    // Sort by VM name
    allVMs.sort((a, b) => a.name.localeCompare(b.name));
    console.log(`Found ${allVMs.length} unique VMs across all storage pools`);

    res.json({ success: true, data: allVMs });
  } catch (error) {
    console.error('Error listing VMs:', error);
    next(error);
  }
});

// GET /api/backup-removal/vm/:vmName/details - Get detailed backup info for a VM using Backup_Reporter.sh
router.get('/vm/:vmName/details', async (req, res, next) => {
  try {
    const { vmName } = req.params;
    const { findVMInStoragePools } = require('../utils/storagePoolHelper');

    console.log(`Getting backup details for VM: ${vmName}`);

    // Find VM in storage pools
    const vmLocation = await findVMInStoragePools(vmName);
    
    if (!vmLocation) {
      return res.status(404).json({
        success: false,
        error: `VM not found: ${vmName}`,
      });
    }

    const { pool, vmPath } = vmLocation;
    console.log(`Found VM in storage pool: ${pool.path}`);

    // Run Backup_Reporter.sh script with the specific storage pool path
    const scriptPath = path.join(__dirname, '../scripts/Backup_Reporter.sh');
    
    if (!fs.existsSync(scriptPath)) {
      return res.status(500).json({
        success: false,
        error: 'Backup_Reporter.sh script not found',
      });
    }

    // Execute the script with --backup-paths flag pointing to the specific pool
    const reportProcess = spawn('bash', [scriptPath, '--backup-paths', pool.path], {
      cwd: path.dirname(scriptPath),
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    reportProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    reportProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    reportProcess.on('close', (code) => {
      if (code !== 0) {
        console.error(`Backup_Reporter.sh exited with code ${code}`);
        console.error('stderr:', stderr);
        return res.status(500).json({
          success: false,
          error: `Script failed with exit code ${code}`,
          stderr: stderr,
        });
      }

      try {
        // Parse the JSON output
        const report = JSON.parse(stdout);
        
        // Find the specific VM in the report
        const vmData = report.vms?.find(vm => vm.vm_name === vmName);
        
        if (!vmData) {
          return res.status(404).json({
            success: false,
            error: `VM ${vmName} not found in backup report`,
          });
        }

        res.json({
          success: true,
          data: vmData,
        });
      } catch (parseError) {
        console.error('Error parsing Backup_Reporter.sh output:', parseError);
        console.error('stdout:', stdout);
        return res.status(500).json({
          success: false,
          error: 'Failed to parse backup report',
          parseError: parseError.message,
        });
      }
    });

    reportProcess.on('error', (error) => {
      console.error('Error running Backup_Reporter.sh:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to execute backup report script',
        details: error.message,
      });
    });
  } catch (error) {
    console.error('Error getting VM details:', error);
    next(error);
  }
});

// DELETE /api/backup-removal/schedule - Remove specific schedule backup
router.delete('/schedule', async (req, res, next) => {
  try {
    const { vmName, scheduleType } = req.body;

    if (!vmName || !scheduleType) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: vmName, scheduleType',
      });
    }

    const { findScheduleInStoragePools } = require('../utils/storagePoolHelper');

    console.log(`Removing ${scheduleType} backup for VM ${vmName}`);

    // Find schedule in storage pools
    const scheduleLocation = await findScheduleInStoragePools(vmName, scheduleType);
    
    if (!scheduleLocation) {
      return res.status(404).json({
        success: false,
        error: `Backup not found: ${vmName}/${scheduleType}`,
      });
    }

    const { schedulePath } = scheduleLocation;
    console.log(`Found schedule at: ${schedulePath}`);

    // Remove the directory
    await removeDirectory(schedulePath);

    res.json({
      success: true,
      message: `Successfully removed ${scheduleType} backup for ${vmName}`,
    });
  } catch (error) {
    console.error('Error removing schedule backup:', error);
    next(error);
  }
});

// DELETE /api/backup-removal/vm - Remove entire VM backup directory
router.delete('/vm', async (req, res, next) => {
  try {
    const { vmName } = req.body;

    if (!vmName) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: vmName',
      });
    }

    const { findAllVMInstances } = require('../utils/storagePoolHelper');

    console.log(`Removing all backups for VM ${vmName}`);

    // Find all instances of this VM across all storage pools
    const vmInstances = await findAllVMInstances(vmName);
    
    if (vmInstances.length === 0) {
      return res.status(404).json({
        success: false,
        error: `VM backup not found: ${vmName}`,
      });
    }

    console.log(`Found ${vmInstances.length} instance(s) of VM ${vmName}`);

    // Remove all instances
    const removePromises = vmInstances.map(({ vmPath }) => {
      console.log(`Removing: ${vmPath}`);
      return removeDirectory(vmPath);
    });

    await Promise.all(removePromises);

    res.json({
      success: true,
      message: `Successfully removed all backups for ${vmName} (${vmInstances.length} instance(s))`,
    });
  } catch (error) {
    console.error('Error removing VM backup:', error);
    next(error);
  }
});

// Helper function to remove directory
async function removeDirectory(dirPath) {
  return new Promise((resolve, reject) => {
    const rmProcess = spawn('rm', ['-rf', dirPath]);
    
    rmProcess.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Failed to remove directory: ${dirPath}`));
      }
    });
    
    rmProcess.on('error', (error) => {
      reject(error);
    });
  });
}

module.exports = router;
