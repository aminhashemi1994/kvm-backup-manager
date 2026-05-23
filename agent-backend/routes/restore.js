const express = require('express');
const router = express.Router();
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const restoreExecutor = require('../services/restoreExecutor');

const execAsync = promisify(exec);

/**
 * GET /api/restore/jobs - Get all restore jobs
 */
router.get('/jobs', async (req, res, next) => {
  try {
    const jobs = await restoreExecutor.getAllJobs();
    res.json({
      success: true,
      data: jobs
    });
  } catch (error) {
    console.error('[Restore] Get jobs error:', error);
    next(error);
  }
});

/**
 * GET /api/restore/active - Get active restore jobs
 */
router.get('/active', async (req, res, next) => {
  try {
    const activeJobs = restoreExecutor.getActiveJobs();
    res.json({
      success: true,
      data: activeJobs
    });
  } catch (error) {
    console.error('[Restore] Get active jobs error:', error);
    next(error);
  }
});

/**
 * GET /api/restore/history - Get restore history
 */
router.get('/history', async (req, res, next) => {
  try {
    const history = await restoreExecutor.getHistory();
    res.json({
      success: true,
      data: history
    });
  } catch (error) {
    console.error('[Restore] Get history error:', error);
    next(error);
  }
});

/**
 * GET /api/restore/status/:restoreId - Get restore job status
 */
router.get('/status/:restoreId', async (req, res, next) => {
  try {
    const { restoreId } = req.params;
    const job = await restoreExecutor.getJob(restoreId);
    
    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Restore job not found'
      });
    }

    res.json({
      success: true,
      data: job
    });
  } catch (error) {
    console.error('[Restore] Get status error:', error);
    next(error);
  }
});

/**
 * GET /api/restore/logs/:restoreId - Get restore logs
 */
router.get('/logs/:restoreId', async (req, res, next) => {
  try {
    const { restoreId } = req.params;
    
    try {
      const logs = await restoreExecutor.getJobLogs(restoreId);
      
      res.json({
        success: true,
        data: {
          logs: logs || 'No logs available yet...'
        }
      });
    } catch (error) {
      // If job not found or logs not available, return empty logs instead of error
      console.log(`[Restore] Logs not available for ${restoreId}:`, error.message);
      res.json({
        success: true,
        data: {
          logs: 'Logs not available yet...'
        }
      });
    }
  } catch (error) {
    console.error('[Restore] Get logs error:', error);
    // Return success with message instead of error
    res.json({
      success: true,
      data: {
        logs: 'Error loading logs'
      }
    });
  }
});

/**
 * POST /api/restore/kill/:restoreId - Cancel restore job
 */
router.post('/kill/:restoreId', async (req, res, next) => {
  try {
    const { restoreId } = req.params;
    const result = await restoreExecutor.killJob(restoreId);
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('[Restore] Kill job error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/restore/analyze-backup
 * Analyze a backup directory to get checkpoints and disks
 */
router.post('/analyze-backup', async (req, res, next) => {
  try {
    const { backupPath } = req.body;

    if (!backupPath) {
      return res.status(400).json({
        success: false,
        error: 'backupPath is required'
      });
    }

    console.log(`[Restore] Analyzing backup: ${backupPath}`);

    // Check if backup path exists
    try {
      await fs.access(backupPath);
    } catch (error) {
      return res.status(404).json({
        success: false,
        error: `Backup path not found: ${backupPath}`
      });
    }

    // Run virtnbdrestore -o dump to get backup information
    const dumpCommand = `virtnbdrestore -i "${backupPath}" -o dump 2>&1`;
    
    let stdout, stderr;
    try {
      const result = await execAsync(dumpCommand, { timeout: 30000 });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      console.error('[Restore] virtnbdrestore dump failed:', error.message);
      return res.status(500).json({
        success: false,
        error: `Failed to analyze backup: ${error.message}`,
        stderr: error.stderr || ''
      });
    }

    // Extract JSON from output (virtnbdrestore outputs JSON array)
    // The output may contain ANSI color codes and log messages before the JSON
    // First, remove all ANSI color codes from the entire output
    const cleanOutput = stdout.replace(/\u001b\[[0-9;]*m/g, '');
    
    // Look for the start of a JSON array ([ followed by whitespace and {)
    const jsonArrayPattern = /\[\s*\{/;
    const match = cleanOutput.match(jsonArrayPattern);
    
    if (!match) {
      return res.status(500).json({
        success: false,
        error: 'No JSON array found in virtnbdrestore output',
        output: cleanOutput
      });
    }
    
    const jsonStart = match.index;
    
    // Find the last occurrence of ']' to get the complete JSON array
    let jsonEnd = cleanOutput.lastIndexOf(']');
    if (jsonEnd === -1 || jsonEnd < jsonStart) {
      return res.status(500).json({
        success: false,
        error: 'Invalid JSON structure in virtnbdrestore output',
        output: cleanOutput
      });
    }

    const jsonData = cleanOutput.substring(jsonStart, jsonEnd + 1);
    let checkpoints;
    
    try {
      checkpoints = JSON.parse(jsonData);
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: 'Failed to parse virtnbdrestore JSON output',
        parseError: error.message,
        output: jsonData
      });
    }

    // Extract unique disks
    const disks = [...new Set(checkpoints.map(cp => cp.diskName))];

    // Group checkpoints by checkpoint name to get unique checkpoints
    const checkpointMap = new Map();
    checkpoints.forEach(cp => {
      if (!checkpointMap.has(cp.checkpointName)) {
        checkpointMap.set(cp.checkpointName, []);
      }
      checkpointMap.get(cp.checkpointName).push(cp);
    });

    // Get unique checkpoint names and sort them
    const uniqueCheckpointNames = Array.from(checkpointMap.keys()).sort();
    
    // Calculate max depth based on unique checkpoints
    const maxDepth = uniqueCheckpointNames.length - 1;

    // Format checkpoints for frontend - one entry per disk per checkpoint
    const formattedCheckpoints = checkpoints.map(cp => {
      // Extract depth from checkpoint name (e.g., "virtnbdbackup.0" -> 0)
      const depthMatch = cp.checkpointName.match(/\.(\d+)$/);
      const depth = depthMatch ? parseInt(depthMatch[1]) : 0;
      
      return {
        name: cp.checkpointName,
        depth: depth,
        date: cp.date,
        incremental: cp.incremental,
        size: formatBytes(cp.dataSize),
        sizeBytes: cp.dataSize,
        diskName: cp.diskName,
        parentCheckpoint: cp.parentCheckpoint || null
      };
    });

    console.log(`[Restore] Analysis complete: ${uniqueCheckpointNames.length} unique checkpoints, ${disks.length} disks, max depth: ${maxDepth}`);

    res.json({
      success: true,
      data: {
        backupPath,
        checkpoints: formattedCheckpoints,
        disks,
        maxDepth,
        totalCheckpoints: uniqueCheckpointNames.length
      }
    });
  } catch (error) {
    console.error('[Restore] Analyze backup error:', error);
    next(error);
  }
});

/**
 * POST /api/restore/check-status
 * Check if a restore job completed or is still running
 */
router.post('/check-status', async (req, res, next) => {
  try {
    const { jobId, progressFile, restorePath } = req.body;

    if (!jobId || !progressFile || !restorePath) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: jobId, progressFile, restorePath'
      });
    }

    console.log(`[Restore] Checking status for job ${jobId}`);
    console.log(`  Progress file: ${progressFile}`);
    console.log(`  Restore path: ${restorePath}`);

    // Check if progress file exists
    let progressExists = false;
    try {
      await fs.access(progressFile);
      progressExists = true;
      console.log(`[Restore] Progress file exists`);
    } catch (error) {
      console.log(`[Restore] Progress file does not exist`);
    }

    // Check if restore path exists and has files
    let hasFiles = false;
    let fileCount = 0;
    try {
      const stats = await fs.stat(restorePath);
      if (stats.isDirectory()) {
        const files = await fs.readdir(restorePath);
        fileCount = files.length;
        hasFiles = fileCount > 0;
        console.log(`[Restore] Restore path has ${fileCount} files`);
      }
    } catch (error) {
      console.log(`[Restore] Restore path does not exist or is not accessible`);
    }

    // Check for tmux session
    let tmuxRunning = false;
    try {
      const { stdout } = await execAsync(`tmux list-sessions 2>/dev/null | grep -c "restore_${jobId}" || true`);
      tmuxRunning = parseInt(stdout.trim()) > 0;
      console.log(`[Restore] Tmux session running: ${tmuxRunning}`);
    } catch (error) {
      console.log(`[Restore] Could not check tmux sessions`);
    }

    // Determine status
    let completed = false;
    if (!progressExists && !tmuxRunning && hasFiles) {
      // Progress file gone, no tmux session, but files exist = completed
      completed = true;
    }

    res.json({
      success: true,
      data: {
        jobId,
        exists: progressExists,
        completed,
        hasFiles,
        fileCount,
        tmuxRunning
      }
    });
  } catch (error) {
    console.error('[Restore] Check status error:', error);
    next(error);
  }
});

/**
 * POST /api/restore/trigger
 * Trigger a restore operation
 */
router.post('/trigger', async (req, res, next) => {
  try {
    const {
      vmName,
      method,
      backupHostId,
      restoreStoragePoolId,
      backupPath: providedBackupPath,
      restorePath: providedRestorePath,
      restoreId: providedRestoreId,
      progressFile: providedProgressFile,
      eventsFile: providedEventsFile,
      depth,
      disk
    } = req.body;

    // Support two modes:
    // 1. Direct mode (from controller): backupPath, restorePath, restoreId provided
    // 2. Config mode (from frontend): backupHostId, restoreStoragePoolId provided

    let backupPath, restorePath, restoreId, progressFile, eventsFile;

    if (providedBackupPath && providedRestorePath) {
      // Direct mode - paths provided by controller
      console.log(`[Restore] Triggering restore (direct mode) for ${vmName}/${method}`);
      backupPath = providedBackupPath;
      restorePath = providedRestorePath;
      restoreId = providedRestoreId || uuidv4();
      progressFile = providedProgressFile;
      eventsFile = providedEventsFile;
    } else {
      // Config mode - build paths from config
      if (!backupHostId || !restoreStoragePoolId) {
        return res.status(400).json({
          success: false,
          error: 'Missing required parameters: either (backupPath, restorePath) or (backupHostId, restoreStoragePoolId)'
        });
      }

      console.log(`[Restore] Triggering restore (config mode) for ${vmName}/${method}`);

      // Get config to build paths
      const config = req.app.get('config');
      
      // Get backup host
      const backupHost = config.backupHosts.find(h => h.id === backupHostId);
      if (!backupHost) {
        return res.status(404).json({
          success: false,
          error: `Backup host not found: ${backupHostId}`
        });
      }

      // Get restore storage pool
      const restorePool = config.storagePools.find(p => p.id === restoreStoragePoolId);
      if (!restorePool) {
        return res.status(404).json({
          success: false,
          error: `Restore storage pool not found: ${restoreStoragePoolId}`
        });
      }

      // Build backup path
      backupPath = path.join(backupHost.backupPath, vmName, method);
      
      // Build restore path
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      restorePath = path.join(restorePool.path, `restore_${vmName}_${timestamp}`);
      
      restoreId = uuidv4();
    }

    // Validate required parameters
    if (!vmName || !method) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: vmName, method'
      });
    }

    // Trigger restore using restoreExecutor
    const result = await restoreExecutor.triggerRestore({
      vmName,
      method,
      backupPath,
      restorePath,
      depth,
      disk,
      backupHostId: backupHostId || 'direct',
      restoreStoragePoolId: restoreStoragePoolId || 'direct',
      restoreId,
      progressFile,
      eventsFile
    });

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('[Restore] Trigger error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/restore/progress/:restoreId
 * Get restore progress
 */
router.get('/progress/:restoreId', async (req, res, next) => {
  try {
    const { restoreId } = req.params;
    const { progressFile } = req.query;

    // Use provided progress file path or fall back to organized directory
    const progressFilePath = progressFile || `/tmp/restore-manager/progress/restore_progress_${restoreId}.txt`;

    console.log(`[Restore] Checking progress for ${restoreId}`);
    console.log(`[Restore] Progress file path: ${progressFilePath}`);

    // Check if progress file exists
    try {
      await fs.access(progressFilePath);
      console.log(`[Restore] Progress file exists: ${progressFilePath}`);
    } catch (error) {
      console.log(`[Restore] Progress file NOT found: ${progressFilePath}`);
      console.log(`[Restore] Error: ${error.message}`);
      return res.json({
        success: true,
        data: {
          percentage: 0,
          text: 'Initializing...',
          type: 'restore',
          timestamp: new Date().toISOString()
        }
      });
    }

    // Read progress file
    const content = await fs.readFile(progressFilePath, 'utf8');
    
    try {
      const progress = JSON.parse(content.trim());
      console.log(`[Restore] Progress data:`, progress);
      res.json({
        success: true,
        data: progress
      });
    } catch (error) {
      // If JSON parse fails, return default
      res.json({
        success: true,
        data: {
          percentage: 0,
          text: 'Processing...',
          type: 'restore',
          timestamp: new Date().toISOString()
        }
      });
    }
  } catch (error) {
    console.error('[Restore] Progress error:', error);
    next(error);
  }
});

/**
 * GET /api/restore/events/:restoreId
 * Get restore events
 */
router.get('/events/:restoreId', async (req, res, next) => {
  try {
    const { restoreId } = req.params;
    const eventsFile = `/tmp/restore-manager/events/restore_events_${restoreId}.jsonl`;

    // Check if events file exists
    try {
      await fs.access(eventsFile);
    } catch (error) {
      return res.json({
        success: true,
        data: []
      });
    }

    // Read events file (JSONL format)
    const content = await fs.readFile(eventsFile, 'utf8');
    const lines = content.trim().split('\n').filter(line => line.length > 0);
    
    const events = lines.map(line => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return null;
      }
    }).filter(event => event !== null);

    res.json({
      success: true,
      data: events
    });
  } catch (error) {
    console.error('[Restore] Events error:', error);
    next(error);
  }
});

/**
 * GET /api/restore/tmux-status/:restoreId
 * Check if tmux session is still running
 */
router.get('/tmux-status/:restoreId', async (req, res, next) => {
  try {
    const { restoreId } = req.params;
    
    // Get job data to find the actual tmux session name
    const job = await restoreExecutor.getJob(restoreId);
    
    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Restore job not found'
      });
    }
    
    const tmuxSessionName = job.tmuxSession;
    
    if (!tmuxSessionName) {
      return res.json({
        success: true,
        data: {
          running: false,
          sessionName: null,
          error: 'No tmux session associated with this job'
        }
      });
    }

    try {
      await execAsync(`tmux has-session -t "${tmuxSessionName}" 2>/dev/null`);
      // Session exists
      res.json({
        success: true,
        data: {
          running: true,
          sessionName: tmuxSessionName
        }
      });
    } catch (error) {
      // Session doesn't exist
      res.json({
        success: true,
        data: {
          running: false,
          sessionName: tmuxSessionName
        }
      });
    }
  } catch (error) {
    console.error('[Restore] Tmux status error:', error);
    next(error);
  }
});

// Helper function to format bytes
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

module.exports = router;
