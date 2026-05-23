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

module.exports = router;
