const express = require('express');
const router = express.Router();
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execAsync = promisify(exec);

/**
 * POST /api/restore-storage-pools/validate - Validate a restore storage pool path
 * 
 * Checks:
 * 1. Path exists
 * 2. Path is a directory
 * 3. Gets storage information (size, usage, etc.)
 */
router.post('/validate', async (req, res, next) => {
  try {
    const { path: storagePath } = req.body;

    if (!storagePath) {
      return res.status(400).json({
        success: false,
        error: 'path is required'
      });
    }

    // Check if path exists
    if (!fs.existsSync(storagePath)) {
      return res.json({
        success: false,
        error: `Path does not exist: ${storagePath}`
      });
    }

    // Check if it's a directory
    const stats = fs.statSync(storagePath);
    if (!stats.isDirectory()) {
      return res.json({
        success: false,
        error: `Path is not a directory: ${storagePath}`
      });
    }

    console.log(`Restore storage pool path validation: ${storagePath}`);

    // Get storage information
    const storageInfo = await getStorageInfo(storagePath);
    
    if (!storageInfo) {
      return res.json({
        success: false,
        error: `Failed to get storage information for: ${storagePath}`
      });
    }

    res.json({
      success: true,
      data: storageInfo
    });
  } catch (error) {
    console.error('Error validating restore storage pool:', error);
    next(error);
  }
});

/**
 * Get storage information for a path using df command
 */
async function getStorageInfo(targetPath) {
  try {
    // Use df to get storage info for the path
    const { stdout } = await execAsync(`df -BG "${targetPath}" | tail -1`);
    const parts = stdout.trim().split(/\s+/);
    
    if (parts.length < 6) {
      throw new Error('Unexpected df output format');
    }

    const device = parts[0];
    const totalGB = parseInt(parts[1].replace('G', '')) || 0;
    const usedGB = parseInt(parts[2].replace('G', '')) || 0;
    const availableGB = parseInt(parts[3].replace('G', '')) || 0;
    const usagePercent = parseInt(parts[4].replace('%', '')) || 0;
    const mountPoint = parts[5];

    return {
      device,
      mountPoint,
      totalGB,
      usedGB,
      availableGB,
      usagePercent
    };
  } catch (error) {
    console.error('Error getting storage info:', error);
    return null;
  }
}

module.exports = router;
