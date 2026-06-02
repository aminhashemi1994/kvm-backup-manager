const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// POST /api/cleanup-backup - Cleanup partial/failed backup files without starting backup
//
// This endpoint performs the same safety checks and cleanup as the --retry flag
// but does NOT start a new backup. It only removes partial files and the latest
// checkpoint to prepare for a retry.

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

router.post('/', async (req, res, next) => {
  try {
    const { vmName, storagePoolPath } = req.body;

    if (!vmName || !storagePoolPath) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: vmName, storagePoolPath',
      });
    }

    console.log(`[CleanupBackup] Cleaning up backup for VM ${vmName} (all schedules)`);

    // Verify the script exists on the agent
    const localScriptPath = path.join(__dirname, '..', 'scripts', 'Cleanup_Backup.sh');
    if (!fs.existsSync(localScriptPath)) {
      return res.status(500).json({
        success: false,
        error: 'Cleanup backup script not found on the agent',
        details: `Expected at: ${localScriptPath}`,
      });
    }

    // Execute the cleanup script (it will scan all schedule types)
    console.log(`[CleanupBackup] Executing cleanup script for ${vmName}...`);
    const execResult = await runCommand('bash', [
      localScriptPath,
      '--domain', vmName,
      '--backup-path', storagePoolPath,
    ], {
      timeout: 120000, // 2 minutes timeout
    });

    console.log(`[CleanupBackup] Script exited with code ${execResult.code}`);
    if (execResult.stdout) console.log(`[CleanupBackup] stdout: ${execResult.stdout}`);
    if (execResult.stderr) console.error(`[CleanupBackup] stderr: ${execResult.stderr}`);

    if (execResult.code === 0) {
      // Exit 0: Cleanup performed successfully (partial files were removed)
      return res.json({
        success: true,
        cleaned: true,
        message: `Backup cleanup completed successfully for ${vmName}. Partial files and latest checkpoint have been removed.`,
        output: execResult.stdout.trim(),
      });
    } else if (execResult.code === 10) {
      // Exit 10: No backups found for this VM in this storage pool
      return res.status(404).json({
        success: false,
        error: `No backups found for ${vmName} in this storage pool`,
        notFound: true,
        details: execResult.stdout.trim() || `No backup directory found for VM '${vmName}'`,
        output: execResult.stdout.trim(),
        exitCode: execResult.code,
      });
    } else if (execResult.code === 11) {
      // Exit 11: Backup is healthy, no cleanup needed
      return res.json({
        success: true,
        cleaned: false,
        healthy: true,
        message: `Backup is healthy for ${vmName}. No partial files found - no cleanup needed.`,
        output: execResult.stdout.trim(),
      });
    } else {
      // Other exit codes: errors
      return res.status(500).json({
        success: false,
        error: `Cleanup backup failed for ${vmName}`,
        details: execResult.stderr.trim() || execResult.stdout.trim() || `Script exited with code ${execResult.code}`,
        output: execResult.stdout.trim(),
        exitCode: execResult.code,
      });
    }
  } catch (error) {
    console.error('[CleanupBackup] Unexpected error:', error);
    next(error);
  }
});

module.exports = router;
