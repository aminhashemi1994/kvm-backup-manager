const express = require('express');
const router = express.Router();
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');

const execAsync = promisify(exec);

/**
 * GET /api/cleanup/scan
 * Scan for cleanable files (progress, logs, locks, temp files)
 */
router.get('/scan', async (req, res, next) => {
  try {
    const { olderThanHours = 6 } = req.query;
    const config = require('../config/config');
    const controllerAuthService = require('../services/controllerAuthService');
    
    console.log(`[Cleanup] Scanning for files older than ${olderThanHours} hours`);
    
    const results = {
      progressFiles: [],
      logFiles: [],
      lockFiles: [],
      tempFiles: [],
      totalCount: 0,
      totalSize: 0
    };
    
    // Get storage pools from sync service (cached)
    const storagePoolSyncService = require('../services/storagePoolSyncService');
    let storagePools = [];
    try {
      const pools = storagePoolSyncService.getStoragePools();
      storagePools = pools.map(p => p.path);
      console.log(`[Cleanup] Found ${storagePools.length} storage pools from sync service`);
      
      // If no cached pools, try to fetch from controller
      if (storagePools.length === 0) {
        console.log('[Cleanup] No cached storage pools, fetching from controller...');
        const controllerUrl = config.controllerUrl;
        const backupHostId = storagePoolSyncService.getBackupHostId();
        
        if (controllerUrl && backupHostId) {
          const endpoint = `/storage-pools/backup-host/${backupHostId}`;
          const response = await controllerAuthService.get(controllerUrl, endpoint);
          storagePools = (response.data.data || []).map(p => p.path);
          console.log(`[Cleanup] Fetched ${storagePools.length} storage pools from controller`);
        }
      }
    } catch (error) {
      console.error('[Cleanup] Error fetching storage pools:', error.message);
      // Fallback to config backup path
      if (config.backupPath) {
        storagePools = [config.backupPath];
      }
    }
    
    if (storagePools.length === 0) {
      return res.json({
        success: true,
        data: results
      });
    }
    
    const minutes = parseInt(olderThanHours) * 60;
    
    for (const pool of storagePools) {
      // Scan .progress directory
      const progressDir = path.join(pool, '.progress');
      try {
        const { stdout } = await execAsync(
          `find "${progressDir}" -name "restore_*.progress" -type f -mmin +${minutes} -exec stat -c '%n|%s|%Y' {} \\; 2>/dev/null || true`
        );
        
        if (stdout.trim()) {
          const files = stdout.trim().split('\n').map(line => {
            const [filePath, size, mtime] = line.split('|');
            return {
              path: filePath,
              name: path.basename(filePath),
              size: parseInt(size),
              age: Date.now() - (parseInt(mtime) * 1000),
              type: 'progress'
            };
          });
          results.progressFiles.push(...files);
        }
      } catch (err) {
        // Directory might not exist
      }
      
      // Scan .logs directory
      const logsDir = path.join(pool, '.logs');
      try {
        const { stdout } = await execAsync(
          `find "${logsDir}" -name "restore_*.log" -type f -mmin +${minutes} -exec stat -c '%n|%s|%Y' {} \\; 2>/dev/null || true`
        );
        
        if (stdout.trim()) {
          const files = stdout.trim().split('\n').map(line => {
            const [filePath, size, mtime] = line.split('|');
            return {
              path: filePath,
              name: path.basename(filePath),
              size: parseInt(size),
              age: Date.now() - (parseInt(mtime) * 1000),
              type: 'log'
            };
          });
          results.logFiles.push(...files);
        }
      } catch (err) {
        // Directory might not exist
      }
      
      // Scan in_progress_backups directory (lock files)
      const lockDir = path.join(pool, 'in_progress_backups');
      try {
        const { stdout } = await execAsync(
          `find "${lockDir}" -type f -mmin +${minutes} -exec stat -c '%n|%s|%Y' {} \\; 2>/dev/null || true`
        );
        
        if (stdout.trim()) {
          const files = stdout.trim().split('\n').map(line => {
            const [filePath, size, mtime] = line.split('|');
            return {
              path: filePath,
              name: path.basename(filePath),
              size: parseInt(size),
              age: Date.now() - (parseInt(mtime) * 1000),
              type: 'lock'
            };
          });
          results.lockFiles.push(...files);
        }
      } catch (err) {
        // Directory might not exist
      }
    }
    
    // Scan /tmp/restore-manager for restore event files
    try {
      const { stdout } = await execAsync(
        `find /tmp/restore-manager -type f \\( -name "restore_events_*.jsonl" -o -name "restore_*_detail.log" -o -name "restore_lock_*.txt" -o -name "restore_progress_*.txt" -o -name "restore_exit_*.code" \\) -mmin +${minutes} -exec stat -c '%n|%s|%Y' {} \\; 2>/dev/null || true`
      );
      
      if (stdout.trim()) {
        const files = stdout.trim().split('\n').map(line => {
          const [filePath, size, mtime] = line.split('|');
          return {
            path: filePath,
            name: path.basename(filePath),
            size: parseInt(size),
            age: Date.now() - (parseInt(mtime) * 1000),
            type: 'temp'
          };
        });
        results.tempFiles.push(...files);
      }
    } catch (err) {
      // Ignore errors
    }
    
    // Scan /tmp/backup-manager for backup temp files
    try {
      const { stdout } = await execAsync(
        `find /tmp/backup-manager -type f \\( -name "backup_info_debug_*.log" -o -name "qemu-img*.log" -o -name "qemu-nbd*.log" -o -name "qemu-nbd*.pid" -o -name "virtnbdbackup_*.log" -o -name ".rsync_*" -o -name ".virtnbd*" -o -name ".offsite_*" \\) -mmin +${minutes} -exec stat -c '%n|%s|%Y' {} \\; 2>/dev/null || true`
      );
      
      if (stdout.trim()) {
        const files = stdout.trim().split('\n').map(line => {
          const [filePath, size, mtime] = line.split('|');
          return {
            path: filePath,
            name: path.basename(filePath),
            size: parseInt(size),
            age: Date.now() - (parseInt(mtime) * 1000),
            type: 'temp'
          };
        });
        results.tempFiles.push(...files);
      }
    } catch (err) {
      // Ignore errors
    }
    
    // Also scan for old VM directories in /tmp/backup-manager/vm-data (from backups)
    try {
      const { stdout } = await execAsync(
        `find /tmp/backup-manager/vm-data -maxdepth 1 -type d -name "*_kakado" -o -name "*_*_*_*" -mmin +${minutes} 2>/dev/null | head -20 || true`
      );
      
      if (stdout.trim()) {
        const dirs = stdout.trim().split('\n');
        for (const dir of dirs) {
          try {
            const { stdout: sizeOut } = await execAsync(`du -sb "${dir}" 2>/dev/null || echo "0"`);
            const size = parseInt(sizeOut.split('\t')[0]) || 0;
            const { stdout: mtimeOut } = await execAsync(`stat -c %Y "${dir}" 2>/dev/null || echo "0"`);
            const mtime = parseInt(mtimeOut.trim()) || 0;
            
            results.tempFiles.push({
              path: dir,
              name: path.basename(dir),
              size: size,
              age: Date.now() - (mtime * 1000),
              type: 'temp'
            });
          } catch (err) {
            // Skip this directory
          }
        }
      }
    } catch (err) {
      // Ignore errors
    }
    
    // Calculate totals
    const allFiles = [
      ...results.progressFiles,
      ...results.logFiles,
      ...results.lockFiles,
      ...results.tempFiles
    ];
    
    results.totalCount = allFiles.length;
    results.totalSize = allFiles.reduce((sum, f) => sum + f.size, 0);
    
    console.log(`[Cleanup] Found ${results.totalCount} files (${formatBytes(results.totalSize)})`);
    
    res.json({
      success: true,
      data: results
    });
  } catch (error) {
    console.error('[Cleanup] Scan error:', error);
    next(error);
  }
});

/**
 * POST /api/cleanup/execute
 * Execute cleanup of specified files
 */
router.post('/execute', async (req, res, next) => {
  try {
    const { files } = req.body;
    
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No files specified for cleanup'
      });
    }
    
    console.log(`[Cleanup] Executing cleanup for ${files.length} files`);
    
    const results = {
      deleted: [],
      failed: [],
      totalDeleted: 0,
      totalSize: 0
    };
    
    for (const filePath of files) {
      try {
        // Check if it's a file or directory
        const stats = await fs.stat(filePath);
        
        if (stats.isDirectory()) {
          // Delete directory recursively
          await execAsync(`rm -rf "${filePath}"`);
          
          results.deleted.push({
            path: filePath,
            name: path.basename(filePath),
            size: stats.size
          });
          
          results.totalSize += stats.size;
          results.totalDeleted++;
          
          console.log(`[Cleanup] Deleted directory: ${filePath}`);
        } else {
          // Delete file
          await fs.unlink(filePath);
          
          results.deleted.push({
            path: filePath,
            name: path.basename(filePath),
            size: stats.size
          });
          
          results.totalSize += stats.size;
          results.totalDeleted++;
          
          console.log(`[Cleanup] Deleted file: ${filePath}`);
        }
      } catch (error) {
        console.error(`[Cleanup] Failed to delete ${filePath}:`, error.message);
        results.failed.push({
          path: filePath,
          name: path.basename(filePath),
          error: error.message
        });
      }
    }
    
    console.log(`[Cleanup] Deleted ${results.totalDeleted} files (${formatBytes(results.totalSize)})`);
    
    res.json({
      success: true,
      data: results
    });
  } catch (error) {
    console.error('[Cleanup] Execute error:', error);
    next(error);
  }
});

/**
 * GET /api/cleanup/stats
 * Get cleanup statistics
 */
router.get('/stats', async (req, res, next) => {
  try {
    const config = require('../config/config');
    const controllerAuthService = require('../services/controllerAuthService');
    
    console.log('[Cleanup] Getting cleanup statistics');
    
    const stats = {
      storagePools: [],
      totalFiles: 0,
      totalSize: 0
    };
    
    // Get storage pools from sync service (cached)
    const storagePoolSyncService = require('../services/storagePoolSyncService');
    let storagePoolPaths = [];
    try {
      const pools = storagePoolSyncService.getStoragePools();
      storagePoolPaths = pools.map(p => p.path);
      console.log(`[Cleanup] Found ${storagePoolPaths.length} storage pools from sync service`);
      
      // If no cached pools, try to fetch from controller
      if (storagePoolPaths.length === 0) {
        console.log('[Cleanup] No cached storage pools, fetching from controller...');
        const controllerUrl = config.controllerUrl;
        const backupHostId = storagePoolSyncService.getBackupHostId();
        
        if (controllerUrl && backupHostId) {
          const endpoint = `/storage-pools/backup-host/${backupHostId}`;
          const response = await controllerAuthService.get(controllerUrl, endpoint);
          storagePoolPaths = (response.data.data || []).map(p => p.path);
          console.log(`[Cleanup] Fetched ${storagePoolPaths.length} storage pools from controller`);
        }
      }
    } catch (error) {
      console.error('[Cleanup] Error fetching storage pools:', error.message);
      // Fallback to config backup path
      if (config.backupPath) {
        storagePoolPaths = [config.backupPath];
      }
    }
    
    for (const pool of storagePoolPaths) {
      const poolStats = {
        path: pool,
        progressFiles: 0,
        logFiles: 0,
        lockFiles: 0,
        totalSize: 0
      };
      
      // Count progress files
      try {
        const { stdout } = await execAsync(
          `find "${pool}/.progress" -name "restore_*.progress" -type f 2>/dev/null | wc -l || echo 0`
        );
        poolStats.progressFiles = parseInt(stdout.trim());
      } catch (err) {}
      
      // Count log files
      try {
        const { stdout } = await execAsync(
          `find "${pool}/.logs" -name "restore_*.log" -type f 2>/dev/null | wc -l || echo 0`
        );
        poolStats.logFiles = parseInt(stdout.trim());
      } catch (err) {}
      
      // Count lock files
      try {
        const { stdout } = await execAsync(
          `find "${pool}/in_progress_backups" -type f 2>/dev/null | wc -l || echo 0`
        );
        poolStats.lockFiles = parseInt(stdout.trim());
      } catch (err) {}
      
      // Get total size
      try {
        const { stdout } = await execAsync(
          `du -sb "${pool}/.progress" "${pool}/.logs" "${pool}/in_progress_backups" 2>/dev/null | awk '{sum+=$1} END {print sum}' || echo 0`
        );
        poolStats.totalSize = parseInt(stdout.trim()) || 0;
      } catch (err) {}
      
      stats.storagePools.push(poolStats);
      stats.totalFiles += poolStats.progressFiles + poolStats.logFiles + poolStats.lockFiles;
      stats.totalSize += poolStats.totalSize;
    }
    
    // Count temp files in organized directories
    try {
      const { stdout } = await execAsync(
        'find /tmp/restore-manager /tmp/backup-manager -type f 2>/dev/null | wc -l || echo 0'
      );
      stats.tempFiles = parseInt(stdout.trim());
      stats.totalFiles += stats.tempFiles;
    } catch (err) {
      stats.tempFiles = 0;
    }
    
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('[Cleanup] Stats error:', error);
    next(error);
  }
});

// Helper function
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

module.exports = router;
