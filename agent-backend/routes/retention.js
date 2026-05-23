const express = require('express');
const router = express.Router();
const RetentionService = require('../services/retentionService');

// POST /api/retention/:vmName/archive - Archive current backup
router.post('/:vmName/archive', async (req, res, next) => {
  try {
    const { maxArchivedBackups } = req.body;
    const retentionService = new RetentionService(req.app.get('config'));
    const result = await retentionService.archiveCurrentBackup(
      req.params.vmName, 
      maxArchivedBackups
    );
    
    if (result.success) {
      res.json({ success: true, data: result });
    } else {
      res.status(400).json({ success: false, error: result.message });
    }
  } catch (error) {
    next(error);
  }
});

// POST /api/retention/:vmName/monthly - Create monthly backup
router.post('/:vmName/monthly', async (req, res, next) => {
  try {
    const { maxMonthlyBackups } = req.body;
    const retentionService = new RetentionService(req.app.get('config'));
    const result = await retentionService.createMonthlyBackup(
      req.params.vmName,
      maxMonthlyBackups
    );
    
    if (result.success) {
      res.json({ success: true, data: result });
    } else {
      res.status(400).json({ success: false, error: result.message });
    }
  } catch (error) {
    next(error);
  }
});

// POST /api/retention/:vmName/apply - Apply retention policy manually
router.post('/:vmName/apply', async (req, res, next) => {
  try {
    const { type = 'archived', maxBackups } = req.body;
    const retentionService = new RetentionService(req.app.get('config'));
    const result = await retentionService.applyRetentionPolicy(
      req.params.vmName, 
      type,
      maxBackups
    );
    
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// GET /api/retention/:vmName/stats - Get backup statistics
router.get('/:vmName/stats', async (req, res, next) => {
  try {
    const retentionService = new RetentionService(req.app.get('config'));
    const stats = await retentionService.getBackupStats(req.params.vmName);
    
    res.json({ success: true, data: stats });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/retention/:vmName/:type - Delete backup
router.delete('/:vmName/:type', async (req, res, next) => {
  try {
    const { vmName, type } = req.params;
    const { backupName } = req.query;
    
    const retentionService = new RetentionService(req.app.get('config'));
    const result = await retentionService.deleteBackup(vmName, type, backupName);
    
    if (result.success) {
      res.json({ success: true, data: result });
    } else {
      res.status(400).json({ success: false, error: result.message });
    }
  } catch (error) {
    next(error);
  }
});

module.exports = router;
