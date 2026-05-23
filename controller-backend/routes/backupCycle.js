const express = require('express');
const router = express.Router();
const backupCycleService = require('../services/backupCycleService');

// GET /api/backup-cycle/:vmId/status - Get backup cycle status for a VM
router.get('/:vmId/status', async (req, res, next) => {
  try {
    const status = await backupCycleService.getBackupCycleStatus(req.params.vmId);
    res.json({ success: true, data: status });
  } catch (error) {
    next(error);
  }
});

// GET /api/backup-cycle/status - Get backup cycle status for all selected VMs
router.get('/status', async (req, res, next) => {
  try {
    const statuses = await backupCycleService.getAllBackupCycleStatus();
    res.json({ success: true, data: statuses });
  } catch (error) {
    next(error);
  }
});

// POST /api/backup-cycle/:vmId/increment - Increment backup counter
router.post('/:vmId/increment', async (req, res, next) => {
  try {
    const result = await backupCycleService.incrementBackupCounter(req.params.vmId);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// POST /api/backup-cycle/:vmId/reset - Reset backup counter
router.post('/:vmId/reset', async (req, res, next) => {
  try {
    const result = await backupCycleService.resetBackupCounter(req.params.vmId);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
