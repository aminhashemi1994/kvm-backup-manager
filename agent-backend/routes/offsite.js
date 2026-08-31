const express = require('express');
const router = express.Router();
const rsyncExecutor = require('../services/rsyncExecutor');

/**
 * Offsite replication endpoints.
 *
 * The transfer itself still lives in Backup_Manager.sh — SSH keys and
 * destination paths are configured on the backup host, not here — but it is now
 * driven as its own job rather than as the tail of a backup run, so it needs
 * its own trigger, cancel and status.
 */

// POST /api/offsite/sync — start an offsite sync for one VM.
router.post('/sync', async (req, res, next) => {
  try {
    const {
      jobId,
      vmName,
      storagePoolPath,
      offsiteHosts,
      offsiteRetryAttempts,
      offsiteRetryBackoffSeconds,
      offsiteRsyncTimeoutSeconds,
      diskUsageThreshold,
      verbose,
      resetSourceGuard,
    } = req.body;

    if (!jobId || !vmName || !storagePoolPath) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: jobId, vmName, storagePoolPath',
      });
    }

    // A sync with no destination would report success having moved nothing.
    if (!Array.isArray(offsiteHosts) || offsiteHosts.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'offsiteHosts must contain at least one target',
      });
    }

    const result = await rsyncExecutor.executeRsync({
      jobId,
      vmName,
      storagePoolPath,
      offsiteHosts,
      offsiteRetryAttempts: offsiteRetryAttempts || 3,
      offsiteRetryBackoffSeconds: offsiteRetryBackoffSeconds || 15,
      offsiteRsyncTimeoutSeconds: offsiteRsyncTimeoutSeconds || 1800,
      diskUsageThreshold: diskUsageThreshold != null ? diskUsageThreshold : 80,
      verbose: verbose || false,
      // Disarms the guard that stops an unmounted pool from deleting the
      // offsite copies. Only meaningful for a pool that has genuinely moved.
      resetSourceGuard: resetSourceGuard === true,
    });

    if (!result.success) {
      return res.status(500).json({ success: false, error: result.error });
    }

    res.status(202).json({
      success: true,
      data: { jobId, status: 'running', tmuxSession: result.tmuxSession },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/offsite/logs/:jobId — the sync's tmux log.
//
// The same shape as /api/backup/logs/:jobId, deliberately: the controller
// serves a replication log to the panel through the same path it serves a
// backup log, so the live viewer behaves identically for both. ?tail=N keeps
// the payload small on a long transfer; omit it for the whole file.
router.get('/logs/:jobId', async (req, res, next) => {
  try {
    const logs = await rsyncExecutor.readLog(req.params.jobId, req.query.tail);
    res.json({ success: true, data: { jobId: req.params.jobId, logs } });
  } catch (error) {
    next(error);
  }
});

// POST /api/offsite/sync/:jobId/cancel — stop a running sync.
router.post('/sync/:jobId/cancel', async (req, res, next) => {
  try {
    const result = await rsyncExecutor.cancelRsync(req.params.jobId);
    if (!result.success) {
      return res.status(404).json({ success: false, error: result.error });
    }
    res.json({ success: true, data: { jobId: req.params.jobId, status: 'cancelled' } });
  } catch (error) {
    next(error);
  }
});

// POST /api/offsite/check — is this VM's replication up to date?
//
// Reads only: no transfer, no lock. Runs in the foreground because it is
// metadata work measured in seconds and the caller wants the answer, not a job.
router.post('/check', async (req, res, next) => {
  try {
    const { vmName, storagePoolPath, offsiteHosts, diskUsageThreshold, timeoutMs } = req.body;

    if (!vmName || !storagePoolPath) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: vmName, storagePoolPath',
      });
    }
    if (!Array.isArray(offsiteHosts) || offsiteHosts.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'offsiteHosts must contain at least one target',
      });
    }

    const result = await rsyncExecutor.checkReplication({
      vmName,
      storagePoolPath,
      offsiteHosts,
      diskUsageThreshold,
      timeoutMs: timeoutMs || 300000,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// GET /api/offsite/sync — what this agent is replicating right now.
router.get('/sync', (req, res, next) => {
  try {
    const jobs = [];
    for (const [jobId, state] of rsyncExecutor.activeJobs.entries()) {
      jobs.push({
        jobId,
        vmName: state.vmName,
        tmuxSession: state.tmuxSession,
        progress: state.progress || 0,
        progressText: state.progressText || '',
        startedAt: state.startedAt ? new Date(state.startedAt).toISOString() : null,
        offsiteHosts: state.offsiteHosts || [],
      });
    }
    res.json({ success: true, data: jobs });
  } catch (error) {
    next(error);
  }
});

// POST /api/offsite/test - Test offsite connection (basic ping test)
router.post('/test', async (req, res, next) => {
  try {
    const { ip } = req.body;

    if (!ip) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: ip',
      });
    }

    // Simple ping test to check if host is reachable
    const { spawn } = require('child_process');
    const ping = spawn('ping', ['-c', '1', '-W', '2', ip]);

    const success = await new Promise((resolve) => {
      ping.on('close', (code) => resolve(code === 0));
      ping.on('error', () => resolve(false));
    });

    res.json({
      success: true,
      data: {
        success,
        message: success ? 'Host is reachable' : 'Host is not reachable',
      },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
