const express = require('express');
const router = express.Router();
const directoryManager = require('../services/directoryManager');

// GET /api/directories - List all VMs with backups
router.get('/', async (req, res, next) => {
  try {
    const vms = await directoryManager.getAllVMsWithBackups();
    res.json({ success: true, data: vms });
  } catch (error) {
    next(error);
  }
});

// GET /api/directories/:vmName - Get backup directories for a VM
router.get('/:vmName', async (req, res, next) => {
  try {
    const directories = await directoryManager.getBackupDirectories(req.params.vmName);
    res.json({ success: true, data: directories });
  } catch (error) {
    next(error);
  }
});

// POST /api/directories/:vmName/archive - Archive current backup
router.post('/:vmName/archive', async (req, res, next) => {
  try {
    const result = await directoryManager.archiveCurrentBackup(req.params.vmName);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/directories/:vmName/:type - Delete backup directory
router.delete('/:vmName/:type', async (req, res, next) => {
  try {
    const { vmName, type } = req.params;

    if (!['current', 'archived', 'monthly'].includes(type)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid type. Must be: current, archived, or monthly',
      });
    }

    const result = await directoryManager.deleteBackupDirectory(vmName, type);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/directories/:vmName/archived/:archiveName - Delete specific archive
router.delete('/:vmName/archived/:archiveName', async (req, res, next) => {
  try {
    const { vmName, archiveName } = req.params;
    const result = await directoryManager.deleteArchivedBackup(vmName, archiveName);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// POST /api/directories/:vmName/monthly/prepare - Prepare for monthly backup
router.post('/:vmName/monthly/prepare', async (req, res, next) => {
  try {
    const result = await directoryManager.createMonthlyBackup(req.params.vmName);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
