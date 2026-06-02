const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// GET /api/backup-status - Check if a backup is in progress for a VM and schedule
//
// Query parameters:
//   - vmName: Name of the virtual machine
//   - scheduleType: Schedule type (daily, weekly, monthly, once, custom)
//   - storagePoolPath: Path to the storage pool
//
// Returns:
//   - inProgress: boolean - Is backup currently running?
//   - tmuxSession: object - Tmux session info
//   - lockFile: object - Lock file info
//   - details: string - Human-readable status message

/**
 * Run a command and capture output. Returns { code, stdout, stderr }.
 */
function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, opts);
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
    proc.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }));
  });
}

/**
 * Sanitize VM name for tmux session (same logic as Backup_Manager.sh)
 */
function sanitizeVmName(vmName) {
  return vmName.replace(/[^a-zA-Z0-9-]/g, '_');
}

/**
 * Check if tmux session exists for this VM and schedule
 */
async function checkTmuxSession(vmName, scheduleType) {
  const sanitizedVm = sanitizeVmName(vmName);
  const tmuxSessionPattern = `${sanitizedVm}_${scheduleType}_`;
  
  try {
    // List all tmux sessions
    const result = await runCommand('tmux', ['list-sessions', '-F', '#{session_name}']);
    
    if (result.code !== 0) {
      // No tmux server running or no sessions
      return {
        exists: false,
        sessionName: null,
      };
    }
    
    // Check if any session matches our pattern
    const sessions = result.stdout.trim().split('\n').filter(s => s);
    const matchingSession = sessions.find(s => s.startsWith(tmuxSessionPattern));
    
    if (matchingSession) {
      return {
        exists: true,
        sessionName: matchingSession,
      };
    }
    
    return {
      exists: false,
      sessionName: null,
    };
  } catch (error) {
    console.error('Error checking tmux session:', error.message);
    return {
      exists: false,
      sessionName: null,
      error: error.message,
    };
  }
}

/**
 * Check if lock file exists for this VM and schedule
 */
function checkLockFile(vmName, scheduleType, storagePoolPath) {
  const lockDir = path.join(storagePoolPath, 'in_progress_backups');
  const lockFile = path.join(lockDir, `${vmName}_${scheduleType}_backup`);
  
  try {
    const exists = fs.existsSync(lockFile);
    
    if (exists) {
      // Try to read lock file metadata
      const stats = fs.statSync(lockFile);
      return {
        exists: true,
        path: lockFile,
        createdAt: stats.birthtime.toISOString(),
        modifiedAt: stats.mtime.toISOString(),
      };
    }
    
    return {
      exists: false,
      path: lockFile,
    };
  } catch (error) {
    console.error('Error checking lock file:', error.message);
    return {
      exists: false,
      path: lockFile,
      error: error.message,
    };
  }
}

/**
 * Check for partial files in backup directory
 */
function checkPartialFiles(vmName, scheduleType, storagePoolPath) {
  const backupDir = path.join(storagePoolPath, vmName, scheduleType);
  
  try {
    if (!fs.existsSync(backupDir)) {
      return {
        hasPartialFiles: false,
        count: 0,
        files: [],
      };
    }
    
    const files = fs.readdirSync(backupDir);
    const partialFiles = files.filter(f => f.endsWith('.partial'));
    
    return {
      hasPartialFiles: partialFiles.length > 0,
      count: partialFiles.length,
      files: partialFiles,
    };
  } catch (error) {
    console.error('Error checking partial files:', error.message);
    return {
      hasPartialFiles: false,
      count: 0,
      files: [],
      error: error.message,
    };
  }
}

/**
 * Check progress file for current backup progress
 */
function checkProgressFile(vmName, scheduleType, storagePoolPath) {
  const progressFile = path.join(storagePoolPath, '.progress', `${vmName}_${scheduleType}.progress`);
  
  try {
    if (!fs.existsSync(progressFile)) {
      return {
        exists: false,
        path: progressFile,
      };
    }
    
    const content = fs.readFileSync(progressFile, 'utf8').trim();
    const progress = JSON.parse(content);
    
    return {
      exists: true,
      path: progressFile,
      data: progress,
    };
  } catch (error) {
    return {
      exists: false,
      path: progressFile,
      error: error.message,
    };
  }
}

// GET /api/backup-status
router.get('/', async (req, res, next) => {
  try {
    const { vmName, scheduleType, storagePoolPath } = req.query;

    if (!vmName || !scheduleType || !storagePoolPath) {
      return res.status(400).json({
        success: false,
        error: 'Missing required query parameters: vmName, scheduleType, storagePoolPath',
      });
    }

    console.log(`[BackupStatus] Checking status for VM ${vmName}, schedule ${scheduleType}`);

    // Validate schedule type
    const validSchedules = ['daily', 'weekly', 'monthly', 'once', 'custom'];
    if (!validSchedules.includes(scheduleType)) {
      return res.status(400).json({
        success: false,
        error: `Invalid schedule type. Must be one of: ${validSchedules.join(', ')}`,
      });
    }

    // Check tmux session
    const tmuxStatus = await checkTmuxSession(vmName, scheduleType);
    
    // Check lock file
    const lockStatus = checkLockFile(vmName, scheduleType, storagePoolPath);
    
    // Check partial files
    const partialStatus = checkPartialFiles(vmName, scheduleType, storagePoolPath);
    
    // Check progress file
    const progressStatus = checkProgressFile(vmName, scheduleType, storagePoolPath);
    
    // Determine if backup is in progress
    const inProgress = tmuxStatus.exists || lockStatus.exists;
    
    // Generate status details
    let statusDetails = '';
    let statusSummary = '';
    
    if (inProgress) {
      if (tmuxStatus.exists && lockStatus.exists) {
        statusSummary = 'running';
        statusDetails = `Backup is running (tmux: ${tmuxStatus.sessionName}, lock: active)`;
      } else if (tmuxStatus.exists) {
        statusSummary = 'running';
        statusDetails = `Backup is running (tmux session: ${tmuxStatus.sessionName})`;
      } else if (lockStatus.exists) {
        statusSummary = 'locked';
        statusDetails = `Lock file exists (possible stale lock or starting up)`;
      }
    } else {
      if (partialStatus.hasPartialFiles) {
        statusSummary = 'failed';
        statusDetails = `No backup running, but ${partialStatus.count} partial file(s) found (previous backup failed)`;
      } else {
        statusSummary = 'idle';
        statusDetails = 'No backup in progress';
      }
    }
    
    // Build response
    const response = {
      success: true,
      vmName,
      scheduleType,
      inProgress,
      status: statusSummary,
      details: statusDetails,
      checks: {
        tmuxSession: tmuxStatus,
        lockFile: lockStatus,
        partialFiles: partialStatus,
        progress: progressStatus,
      },
      timestamp: new Date().toISOString(),
    };

    console.log(`[BackupStatus] ${vmName}/${scheduleType}: ${statusSummary} - ${statusDetails}`);
    res.json(response);
  } catch (error) {
    console.error('[BackupStatus] Unexpected error:', error);
    next(error);
  }
});

// POST /api/backup-status/bulk - Check status for multiple VMs/schedules at once
router.post('/bulk', async (req, res, next) => {
  try {
    const { checks } = req.body;

    if (!Array.isArray(checks) || checks.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: checks (array of {vmName, scheduleType, storagePoolPath})',
      });
    }

    console.log(`[BackupStatus] Bulk check for ${checks.length} VM(s)`);

    const results = [];

    for (const check of checks) {
      const { vmName, scheduleType, storagePoolPath } = check;

      if (!vmName || !scheduleType || !storagePoolPath) {
        results.push({
          vmName,
          scheduleType,
          success: false,
          error: 'Missing required fields',
        });
        continue;
      }

      try {
        const tmuxStatus = await checkTmuxSession(vmName, scheduleType);
        const lockStatus = checkLockFile(vmName, scheduleType, storagePoolPath);
        const partialStatus = checkPartialFiles(vmName, scheduleType, storagePoolPath);
        const progressStatus = checkProgressFile(vmName, scheduleType, storagePoolPath);

        const inProgress = tmuxStatus.exists || lockStatus.exists;

        let statusSummary = '';
        let statusDetails = '';

        if (inProgress) {
          if (tmuxStatus.exists && lockStatus.exists) {
            statusSummary = 'running';
            statusDetails = `Backup is running`;
          } else if (tmuxStatus.exists) {
            statusSummary = 'running';
            statusDetails = `Backup is running`;
          } else if (lockStatus.exists) {
            statusSummary = 'locked';
            statusDetails = `Lock file exists`;
          }
        } else {
          if (partialStatus.hasPartialFiles) {
            statusSummary = 'failed';
            statusDetails = `${partialStatus.count} partial file(s) found`;
          } else {
            statusSummary = 'idle';
            statusDetails = 'No backup in progress';
          }
        }

        results.push({
          vmName,
          scheduleType,
          success: true,
          inProgress,
          status: statusSummary,
          details: statusDetails,
          checks: {
            tmuxSession: tmuxStatus,
            lockFile: lockStatus,
            partialFiles: partialStatus,
            progress: progressStatus,
          },
        });
      } catch (error) {
        results.push({
          vmName,
          scheduleType,
          success: false,
          error: error.message,
        });
      }
    }

    res.json({
      success: true,
      count: results.length,
      results,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[BackupStatus] Bulk check error:', error);
    next(error);
  }
});

module.exports = router;
