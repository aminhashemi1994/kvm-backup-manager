const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const authMiddleware = require('../middleware/auth');

/**
 * POST /api/schedule-validation/check-conflict
 * Check if creating a schedule would conflict with existing backup directories
 * 
 * Directory structure:
 * - daily → /daily directory
 * - custom → /custom directory
 * - weekly → /weekly directory
 * - interval → /daily directory (shares with daily)
 * - once → /once directory (NO CONFLICT)
 * - monthly → /monthly directory (NO CONFLICT)
 * 
 * Conflict rules:
 * - daily, custom, weekly conflict with each other
 * - interval shares /daily with daily, so conflicts with custom and weekly
 * - once and monthly never conflict with anything
 * 
 * Request body:
 * {
 *   vmName: string,
 *   scheduleType: 'daily' | 'weekly' | 'interval' | 'custom' | 'once' | 'monthly',
 *   storagePoolPath: string
 * }
 */
router.post('/check-conflict', authMiddleware, async (req, res, next) => {
  try {
    const { vmName, scheduleType, storagePoolPath } = req.body;

    if (!vmName || !scheduleType || !storagePoolPath) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: vmName, scheduleType, storagePoolPath'
      });
    }

    // once and monthly NEVER conflict with anything
    if (scheduleType === 'once' || scheduleType === 'monthly') {
      console.log(`[ScheduleValidation] ${scheduleType} schedule - no conflict check needed`);
      return res.json({
        success: true,
        hasConflict: false,
        message: `${scheduleType} schedules do not conflict with other schedule types.`
      });
    }

    const vmBaseDir = path.join(storagePoolPath, vmName);

    // Map schedule types to their directories
    const scheduleToDir = {
      'daily': 'daily',
      'interval': 'daily',  // interval shares daily directory
      'custom': 'custom',
      'weekly': 'weekly',
      'once': 'once',
      'monthly': 'monthly'
    };

    const targetDir = scheduleToDir[scheduleType];
    
    // Directories that conflict with this schedule type
    const conflictingDirs = [];
    if (scheduleType === 'daily' || scheduleType === 'interval') {
      conflictingDirs.push('custom', 'weekly');
    } else if (scheduleType === 'custom') {
      conflictingDirs.push('daily', 'weekly');
    } else if (scheduleType === 'weekly') {
      conflictingDirs.push('daily', 'custom');
    }

    console.log(`[ScheduleValidation] Checking conflict for ${vmName}:`);
    console.log(`  Schedule type: ${scheduleType}`);
    console.log(`  Target directory: ${targetDir}`);
    console.log(`  Checking directories: ${conflictingDirs.join(', ')}`);

    // Check each conflicting directory for backup data
    const conflicts = [];

    for (const dir of conflictingDirs) {
      const dirPath = path.join(vmBaseDir, dir);
      
      try {
        const stats = await fs.stat(dirPath);
        
        if (stats.isDirectory()) {
          const files = await fs.readdir(dirPath);
          
          // Filter backup files
          const backupFiles = files.filter(file => {
            const lower = file.toLowerCase();
            return (
              lower.endsWith('.data') ||
              lower.endsWith('.qcow2') ||
              lower.includes('.full.') ||
              lower.includes('.inc.') ||
              lower.includes('.copy.') ||
              lower.endsWith('.vmdk') ||
              lower.endsWith('.vdi')
            );
          });

          if (backupFiles.length > 0) {
            conflicts.push({
              method: dir,
              path: dirPath,
              fileCount: backupFiles.length
            });
            console.log(`[ScheduleValidation] ✗ Conflict: ${backupFiles.length} backup files in /${dir}`);
          }
        }
      } catch (error) {
        if (error.code === 'ENOENT') {
          console.log(`[ScheduleValidation] ✓ /${dir} directory does not exist`);
        } else {
          console.error(`[ScheduleValidation] Error checking ${dirPath}:`, error.message);
        }
      }
    }

    const hasConflict = conflicts.length > 0;

    const response = {
      success: true,
      hasConflict,
      targetDirectory: targetDir,
      checkedDirectories: conflictingDirs
    };

    if (hasConflict) {
      response.conflicts = conflicts;
      response.conflictingMethod = conflicts[0].method;
      response.conflictingPath = conflicts[0].path;
      
      const conflictList = conflicts.map(c => c.method).join(', ');
      response.message = `Cannot create ${scheduleType} schedule. VM "${vmName}" already has backups in: ${conflictList}. Please remove existing backups before creating a ${scheduleType} schedule.`;
    } else {
      response.message = `No conflict detected. Safe to create ${scheduleType} schedule for VM "${vmName}".`;
    }

    res.json(response);
  } catch (error) {
    console.error('[ScheduleValidation] Error:', error);
    next(error);
  }
});

module.exports = router;
