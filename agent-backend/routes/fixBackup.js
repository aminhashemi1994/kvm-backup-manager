const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// POST /api/fix-backup - Fix backup for a VM using KVM_Fix_Backup.sh script
//
// Strategy:
//   1. Read the script from agent-backend/scripts/KVM_Fix_Backup.sh
//   2. Copy it to the hypervisor via scp (always — ensures latest version)
//   3. Execute it via ssh
//   4. Return the output

const REMOTE_SCRIPT_DIR = '/opt/backup-manager/scripts';
const REMOTE_SCRIPT_PATH = `${REMOTE_SCRIPT_DIR}/KVM_Fix_Backup.sh`;

const SSH_OPTS = [
  '-o', 'StrictHostKeyChecking=no',
  '-o', 'UserKnownHostsFile=/dev/null',
  '-o', 'ConnectTimeout=10',
  '-o', 'BatchMode=yes',
];

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
    const { vmName, hypervisorIp } = req.body;

    if (!vmName || !hypervisorIp) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: vmName, hypervisorIp',
      });
    }

    console.log(`[FixBackup] Fixing backup for VM ${vmName} on hypervisor ${hypervisorIp}`);

    // Step 1: Verify the script exists on the agent
    const localScriptPath = path.join(__dirname, '..', 'scripts', 'KVM_Fix_Backup.sh');
    if (!fs.existsSync(localScriptPath)) {
      return res.status(500).json({
        success: false,
        error: 'Fix backup script not found on the agent',
        details: `Expected at: ${localScriptPath}`,
      });
    }

    // Step 2: Ensure remote directory exists
    console.log(`[FixBackup] Ensuring remote directory ${REMOTE_SCRIPT_DIR} exists on ${hypervisorIp}`);
    const mkdirResult = await runCommand('ssh', [
      ...SSH_OPTS,
      `root@${hypervisorIp}`,
      `mkdir -p ${REMOTE_SCRIPT_DIR}`,
    ]);

    if (mkdirResult.code === 255) {
      return res.status(500).json({
        success: false,
        error: `SSH connection failed to hypervisor ${hypervisorIp}`,
        details: mkdirResult.stderr.trim() || 'Could not establish SSH connection. Check SSH keys and network.',
        exitCode: mkdirResult.code,
      });
    }
    if (mkdirResult.code !== 0) {
      return res.status(500).json({
        success: false,
        error: `Failed to create remote directory ${REMOTE_SCRIPT_DIR}`,
        details: mkdirResult.stderr.trim() || `Exit code ${mkdirResult.code}`,
        exitCode: mkdirResult.code,
      });
    }

    // Step 3: Copy the script to the hypervisor via scp
    console.log(`[FixBackup] Copying script to ${hypervisorIp}:${REMOTE_SCRIPT_PATH}`);
    const scpResult = await runCommand('scp', [
      ...SSH_OPTS,
      localScriptPath,
      `root@${hypervisorIp}:${REMOTE_SCRIPT_PATH}`,
    ]);

    if (scpResult.code !== 0) {
      return res.status(500).json({
        success: false,
        error: `Failed to copy script to hypervisor ${hypervisorIp}`,
        details: scpResult.stderr.trim() || `scp exited with code ${scpResult.code}`,
        exitCode: scpResult.code,
      });
    }

    // Step 4: Make script executable
    const chmodResult = await runCommand('ssh', [
      ...SSH_OPTS,
      `root@${hypervisorIp}`,
      `chmod +x ${REMOTE_SCRIPT_PATH}`,
    ]);

    if (chmodResult.code !== 0) {
      return res.status(500).json({
        success: false,
        error: `Failed to make script executable on ${hypervisorIp}`,
        details: chmodResult.stderr.trim(),
        exitCode: chmodResult.code,
      });
    }

    // Step 5: Execute the script
    console.log(`[FixBackup] Executing script on ${hypervisorIp} for VM ${vmName}`);
    const execResult = await runCommand('ssh', [
      ...SSH_OPTS,
      `root@${hypervisorIp}`,
      `bash ${REMOTE_SCRIPT_PATH} ${vmName}`,
    ]);

    console.log(`[FixBackup] Script exited with code ${execResult.code}`);
    if (execResult.stdout) console.log(`[FixBackup:${hypervisorIp}] stdout: ${execResult.stdout}`);
    if (execResult.stderr) console.error(`[FixBackup:${hypervisorIp}] stderr: ${execResult.stderr}`);

    if (execResult.code === 0) {
      return res.json({
        success: true,
        message: `Backup fixed successfully for ${vmName}. Checkpoint metadata has been reset.`,
        output: execResult.stdout.trim(),
      });
    } else if (execResult.code === 255) {
      return res.status(500).json({
        success: false,
        error: `SSH connection failed to hypervisor ${hypervisorIp}`,
        details: execResult.stderr.trim() || 'Could not establish SSH connection',
        exitCode: execResult.code,
      });
    } else {
      return res.status(500).json({
        success: false,
        error: `Fix backup failed for ${vmName}`,
        details: execResult.stderr.trim() || execResult.stdout.trim() || `Script exited with code ${execResult.code}`,
        exitCode: execResult.code,
      });
    }
  } catch (error) {
    console.error('[FixBackup] Unexpected error:', error);
    next(error);
  }
});

module.exports = router;
