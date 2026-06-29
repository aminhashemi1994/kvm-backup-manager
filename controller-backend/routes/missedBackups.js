const express = require('express');
const router = express.Router();
const scheduleAdherenceService = require('../services/scheduleAdherenceService');

/**
 * GET /api/missed-backups
 *
 * Returns expected scheduled runs that produced no successful backup
 * (gaps in the backup timeline) across enabled schedules.
 *
 * Query params:
 *   - days:         lookback window in days (default 30, max 365)
 *   - backupHostId: limit to a single backup host
 *   - vmId:         limit to a single VM
 */
router.get('/', async (req, res, next) => {
  try {
    const { days, backupHostId, vmId } = req.query;
    const result = await scheduleAdherenceService.getMissedBackups({
      days,
      backupHostId,
      vmId,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
