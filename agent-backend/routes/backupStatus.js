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
    // List all tmux sessions, with their creation time — a session that was
    // created seconds ago is a backup still setting up, which reads exactly
    // like a long-dead one if you only look at the name.
    const result = await runCommand('tmux', ['list-sessions', '-F', '#{session_name}|#{session_created}']);

    if (result.code !== 0) {
      // No tmux server running or no sessions
      return {
        exists: false,
        sessionName: null,
      };
    }

    // Check if any session matches our pattern
    const rows = result.stdout.trim().split('\n').filter(s => s);
    const matching = rows.find(r => r.split('|')[0].startsWith(tmuxSessionPattern));

    if (matching) {
      const [name, createdEpoch] = matching.split('|');
      const createdMs = /^\d+$/.test(createdEpoch || '') ? parseInt(createdEpoch, 10) * 1000 : null;
      return {
        exists: true,
        sessionName: name,
        createdAt: createdMs ? new Date(createdMs).toISOString() : null,
        ageMs: createdMs ? Date.now() - createdMs : null,
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
 * Is a backup worker for this VM actually ALIVE right now?
 *
 * `Backup_Manager.sh --domain <vm>` is the parent script and stays alive for
 * the whole run — including the offsite rsync stage, whose own command line
 * carries the pool path rather than the VM name. So this one probe covers
 * every phase of a healthy backup.
 */
async function checkLiveWorker(vmName) {
  const escaped = String(vmName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    const result = await runCommand('sh', [
      '-c',
      `pgrep -af "(virtnbdbackup|Backup_Manager.sh).*${escaped}" 2>/dev/null || true`,
    ]);
    const lines = (result.stdout || '').trim().split('\n').filter(Boolean);
    return { alive: lines.length > 0, processes: lines.slice(0, 5) };
  } catch (error) {
    // Can't tell — assume alive rather than risk waving through a double start.
    console.error('Error checking backup processes:', error.message);
    return { alive: true, error: error.message };
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

/** A session younger than this is a backup still setting up. */
const RECENT_SESSION_MS = 2 * 60 * 1000;
/** The script rewrites its progress file every few seconds while it runs. */
const FRESH_PROGRESS_MS = 5 * 60 * 1000;

/**
 * Decide whether a backup is genuinely IN PROGRESS, or whether the lock/session
 * are just leftovers.
 *
 * This used to be `tmuxSession exists || lockFile exists` — pure artifact
 * existence. Both artifacts outlive the run that made them: a killed script (or
 * a host that lost power) leaves its lock behind, and a tmux session survives
 * the death of the command it was running. So a VM with nothing running at all
 * reported "Backup is running", the scheduled backup was refused, and the
 * operator saw a failure for a backup that was never attempted — while a manual
 * retry of the same job worked, because the retry path goes straight to the
 * executor, which verifies liveness and clears the stale lock.
 *
 * Liveness needs real evidence: a live worker process, a progress file the
 * script is still writing, or a session too young to have started up yet.
 *
 * @returns {{inProgress: boolean, stale: boolean, workerStatus: object, proof: string|null}}
 */
async function resolveInProgress({ vmName, tmuxStatus, lockStatus, progressStatus }) {
  const hasArtifacts = tmuxStatus.exists || lockStatus.exists;
  const workerStatus = hasArtifacts ? await checkLiveWorker(vmName) : { alive: false };

  const sessionIsYoung = tmuxStatus.exists &&
    typeof tmuxStatus.ageMs === 'number' && tmuxStatus.ageMs < RECENT_SESSION_MS;
  const progressIsFresh = progressStatus.exists &&
    typeof progressStatus.ageMs === 'number' && progressStatus.ageMs < FRESH_PROGRESS_MS;

  const isAlive = workerStatus.alive || sessionIsYoung || progressIsFresh;
  const proof = !isAlive ? null
    : workerStatus.alive ? 'backup process alive'
      : progressIsFresh ? `progress file updated ${Math.round((progressStatus.ageMs || 0) / 1000)}s ago`
        : 'session just started';

  return {
    inProgress: hasArtifacts && isAlive,
    stale: hasArtifacts && !isAlive,
    workerStatus,
    proof,
  };
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
    // The script rewrites this file every few seconds while it runs, so its
    // mtime is the cheapest proof that a worker is still going — and the only
    // one that survives a process name the pattern above can't match.
    const stats = fs.statSync(progressFile);

    return {
      exists: true,
      path: progressFile,
      data: progress,
      updatedAt: stats.mtime.toISOString(),
      ageMs: Date.now() - stats.mtimeMs,
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
    
    // Is a worker actually alive, or are these just leftovers?
    //
    // This used to answer "is a backup in progress?" with `tmuxSession exists
    // || lockFile exists` — pure ARTIFACT existence. Both artifacts outlive the
    // run that made them: a script that is killed (or whose host loses power)
    // leaves its lock behind, and a tmux session survives the death of the
    // command it was running. So a VM with nothing at all running reported
    // "Backup is running", the controller refused to start the scheduled
    // backup, and the operator saw a failure for a backup that was never
    // attempted — while retrying it later worked, because the retry path goes
    // straight to the executor, which DOES verify liveness and clears the
    // stale lock.
    //
    // Liveness now needs real evidence: a live worker process, a progress file
    // the script is still writing, or a session too young to have finished
    // starting up. Artifacts with none of that are reported as `stale`, which
    // lets the caller proceed — the executor's own per-VM lock remains the
    // authority on whether a start is actually allowed.
    const { inProgress, stale, workerStatus, proof } = await resolveInProgress({
      vmName, tmuxStatus, lockStatus, progressStatus,
    });
    const hasArtifacts = tmuxStatus.exists || lockStatus.exists;

    // Generate status details
    let statusDetails = '';
    let statusSummary = '';

    if (inProgress) {
      if (tmuxStatus.exists && lockStatus.exists) {
        statusSummary = 'running';
        statusDetails = `Backup is running (tmux: ${tmuxStatus.sessionName}, lock: active, ${proof})`;
      } else if (tmuxStatus.exists) {
        statusSummary = 'running';
        statusDetails = `Backup is running (tmux session: ${tmuxStatus.sessionName}, ${proof})`;
      } else {
        statusSummary = 'running';
        statusDetails = `Backup is running (lock: active, ${proof})`;
      }
    } else if (hasArtifacts) {
      // Leftovers with nothing alive behind them. NOT in progress.
      const leftovers = [
        tmuxStatus.exists ? `tmux session ${tmuxStatus.sessionName}` : null,
        lockStatus.exists ? 'lock file' : null,
      ].filter(Boolean).join(' + ');
      statusSummary = 'stale';
      statusDetails =
        `No backup is running for ${vmName}/${scheduleType}, but ${leftovers} was left behind ` +
        `by an earlier run (no live process, progress file not being updated). ` +
        `A new backup can start — the executor clears the stale lock.`;
      console.warn(`[BackupStatus] Stale in-progress artifacts for ${vmName}/${scheduleType}: ${leftovers}`);
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
      // Whether the artifacts have a live worker behind them. `stale: true`
      // means the caller may proceed despite the lock/session.
      stale,
      checks: {
        tmuxSession: tmuxStatus,
        lockFile: lockStatus,
        partialFiles: partialStatus,
        progress: progressStatus,
        liveWorker: workerStatus,
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

// POST /api/backup-status/clear-in-progress - Force-clear a stuck "in progress" state
//
// Removes the lock file and progress file for a VM/schedule so a backup that
// is no longer actually running stops showing as in-progress. Refuses when a
// live tmux session or backup process is found (the backup IS running).
//
// Body: { vmName, scheduleType, storagePoolPath }
router.post('/clear-in-progress', async (req, res, next) => {
  try {
    const { vmName, scheduleType, storagePoolPath } = req.body;

    if (!vmName || !scheduleType || !storagePoolPath) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: vmName, scheduleType, storagePoolPath',
      });
    }

    console.log(`[BackupStatus] Clear in-progress requested for ${vmName}/${scheduleType}`);

    // cleanupForVm verifies no live Backup_Manager.sh process and no tmux
    // session before deleting the lock + progress file (no age threshold).
    const cleanupService = require('../services/cleanupService');
    const result = await cleanupService.cleanupForVm(vmName, scheduleType, storagePoolPath);

    if (!result.cleaned && (result.reason === 'process_alive' || result.reason === 'tmux_alive')) {
      return res.status(409).json({
        success: false,
        error: `A backup for ${vmName} (${scheduleType}) is actually running (${result.reason === 'tmux_alive' ? 'tmux session active' : 'backup process alive'}). Refusing to clear its in-progress state.`,
        reason: result.reason,
      });
    }

    // If there was no lock, an orphaned progress file may still make the VM
    // look busy — remove it too.
    const clearedFiles = result.files ? [...result.files] : [];
    if (!result.cleaned) {
      const progressFile = path.join(storagePoolPath, '.progress', `${vmName}_${scheduleType}.progress`);
      try {
        if (fs.existsSync(progressFile)) {
          fs.unlinkSync(progressFile);
          clearedFiles.push(progressFile);
          console.log(`[BackupStatus] Removed orphaned progress file: ${progressFile}`);
        }
      } catch (e) {
        if (e.code !== 'ENOENT') console.error(`[BackupStatus] Failed to remove progress file: ${e.message}`);
      }
    }

    const message = clearedFiles.length > 0
      ? `Cleared in-progress state for ${vmName} (${scheduleType}): removed ${clearedFiles.length} file(s)`
      : `Nothing to clear for ${vmName} (${scheduleType}) — no lock or progress file found`;

    console.log(`[BackupStatus] ${message}`);
    res.json({
      success: true,
      cleared: clearedFiles.length > 0,
      files: clearedFiles,
      message,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[BackupStatus] Clear in-progress error:', error);
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

        // Same liveness rule as the single check above — artifacts alone do
        // not mean a backup is running (see the long comment there).
        const { inProgress, stale } = await resolveInProgress({
          vmName, tmuxStatus, lockStatus, progressStatus,
        });

        let statusSummary = '';
        let statusDetails = '';

        if (inProgress) {
          statusSummary = 'running';
          statusDetails = `Backup is running`;
        } else if (stale) {
          statusSummary = 'stale';
          statusDetails = 'Lock/session left behind by an earlier run — no live worker';
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
