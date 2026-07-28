const express = require('express');
const router = express.Router();
const liveStatusService = require('../services/liveStatusService');

/**
 * GET /api/jobs/:jobId/live-status
 *
 * Authoritative status for any backup or restore job. Inspects tmux,
 * processes, lock files, and progress files on the agent host. Used by the
 * controller to reconcile its view after disconnect/reconnect or restart.
 */
router.get('/:jobId/live-status', async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const result = await liveStatusService.getJobLiveStatus(jobId);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/jobs/live-status/batch?ids=a,b,c
 *
 * Batched lookup for many jobs at once. Used after agent reconnect when the
 * controller wants to reconcile every running job in one round-trip.
 */
router.get('/live-status/batch', async (req, res, next) => {
  try {
    const idsParam = (req.query.ids || '').toString();
    const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean);
    if (ids.length === 0) {
      return res.json({ success: true, data: [] });
    }
    const out = await Promise.all(
      ids.map(async (id) => {
        try {
          return await liveStatusService.getJobLiveStatus(id);
        } catch (e) {
          return {
            jobId: id,
            kind: 'unknown',
            phase: 'unknown',
            status: 'unknown',
            reason: `lookup error: ${e.message}`,
            checkedAt: new Date().toISOString(),
          };
        }
      })
    );
    res.json({ success: true, data: out });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/jobs/active-sessions
 *
 * Body: { jobs: [{ jobId, vmName, scheduleType }, ...] }
 *
 * Cheap host-side liveness grep for the history/active reconciler: returns the
 * subset of the given jobs that still have a live tmux session on this host
 * (matched by jobId containment, with VM+schedule as fallback), plus progress
 * where a progress file is found. One `tmux ls` for the whole batch.
 *
 * This is what lets the panel correct a job that was wrongly marked "failed"
 * while its backup is in fact still running in tmux — the lock file may be
 * gone, but the session and progress file prove it is alive.
 */
router.post('/active-sessions', async (req, res, next) => {
  try {
    const jobs = Array.isArray(req.body?.jobs) ? req.body.jobs : [];
    const data = await liveStatusService.checkActiveSessions(jobs);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/jobs/live-sessions
 *
 * Discover EVERY live backup tmux session on this host (no input needed),
 * parsed with progress. The controller uses this to make the Active Jobs panel
 * mirror `tmux ls` — adopting/resurrecting sessions whose job record was lost,
 * superseded, or wrongly finalized.
 */
router.get('/live-sessions', async (req, res, next) => {
  try {
    const data = await liveStatusService.discoverBackupSessions();
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
