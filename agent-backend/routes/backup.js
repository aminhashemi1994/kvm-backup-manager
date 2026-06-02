const express = require('express');
const router = express.Router();
const backupExecutor = require('../services/backupExecutor');
const logService = require('../services/logService');

// POST /api/backup/trigger - Trigger backup
router.post('/trigger', async (req, res, next) => {
  try {
    const { 
      jobId, 
      vmName, 
      hypervisorId, 
      hypervisorIp, 
      method, 
      scheduleType,
      retention,
      keepArchive,
      compression, 
      noCompression, 
      noVerify,
      offsiteHosts,
      verbose,
      storagePoolPath,
      isRetry  // Extract isRetry flag
    } = req.body;

    // Support both 'method' (scheduled) and 'scheduleType' (manual) parameters
    const finalScheduleType = scheduleType || method || 'once';

    if (!jobId || !vmName || !hypervisorIp) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: jobId, vmName, hypervisorIp',
      });
    }

    // Validate storage pool path is provided
    if (!storagePoolPath) {
      return res.status(400).json({
        success: false,
        error: 'Storage pool path is required. Please select a storage pool for this backup.',
      });
    }

    // Validate scheduleType. The values accepted here must match what
    // Backup_Manager.sh accepts for its --schedule flag (once, monthly,
    // daily, weekly, custom). The legacy method-style values (full / inc
    // / copy) are kept for backwards compatibility with older controller
    // payloads; the executor maps them to a sensible script schedule.
    if (!['once', 'daily', 'weekly', 'monthly', 'custom', 'full', 'inc', 'copy'].includes(finalScheduleType)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid scheduleType/method. Must be: once, daily, weekly, monthly, custom, full, inc, or copy',
      });
    }

    // Queue backup
    const result = await backupExecutor.queueBackup({
      jobId,
      vmName,
      hypervisorId,
      hypervisorIp,
      scheduleType: finalScheduleType,
      retention: retention || 7,
      keepArchive: keepArchive || 2,
      compression: compression || 2,
      noCompression: noCompression || false,
      noVerify: noVerify || false,
      offsiteHosts: offsiteHosts || [],
      verbose: verbose || false,
      storagePoolPath: storagePoolPath,
      isRetry: isRetry || false,  // Pass isRetry flag to executor
    });

    // Check if backup was rejected due to VM lock
    if (!result.queued) {
      return res.status(409).json({
        success: false,
        error: result.error,
        existingJobId: result.existingJobId,
      });
    }

    res.status(202).json({
      success: true,
      data: {
        jobId,
        status: 'queued',
        queuePosition: result.position,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/backup/active - Get active backup jobs
router.get('/active', async (req, res, next) => {
  try {
    const activeJobs = backupExecutor.getActiveJobs();
    const queuedJobs = backupExecutor.getQueuedJobs();

    res.json({
      success: true,
      data: {
        active: activeJobs,
        queued: queuedJobs,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/backup/logs/:jobId - Get backup logs
router.get('/logs/:jobId', async (req, res, next) => {
  try {
    const logs = await backupExecutor.readLog(req.params.jobId);
    res.json({
      success: true,
      data: {
        jobId: req.params.jobId,
        logs,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/backup/logs/:jobId/stream - Stream backup logs (SSE)
router.get('/logs/:jobId/stream', async (req, res, next) => {
  try {
    const jobId = req.params.jobId;
    
    // Set headers for Server-Sent Events
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Send initial logs
    const initialLogs = await backupExecutor.readLog(jobId);
    if (initialLogs) {
      res.write(`data: ${JSON.stringify({ type: 'initial', content: initialLogs })}\n\n`);
    }

    // Watch for new log entries
    const watcher = backupExecutor.watchLog(jobId, (chunk) => {
      res.write(`data: ${JSON.stringify({ type: 'update', content: chunk })}\n\n`);
    });

    // Clean up on client disconnect
    req.on('close', () => {
      if (watcher) {
        watcher.close();
      }
      res.end();
    });

    // If job is not active, close after sending initial logs
    const activeJobs = backupExecutor.getActiveJobs();
    const isActive = activeJobs.some(job => job.jobId === jobId);
    
    if (!isActive && !watcher) {
      res.write(`data: ${JSON.stringify({ type: 'complete' })}\n\n`);
      res.end();
    }
  } catch (error) {
    next(error);
  }
});

// GET /api/backup/logs/:jobId/parsed - Get parsed backup logs
router.get('/logs/:jobId/parsed', async (req, res, next) => {
  try {
    const logs = await logService.getParsedLog(req.params.jobId);
    res.json({
      success: true,
      data: {
        jobId: req.params.jobId,
        logs,
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/backup/logs - List all log files
router.get('/logs', async (req, res, next) => {
  try {
    const logs = await logService.listLogs();
    res.json({ success: true, data: logs });
  } catch (error) {
    next(error);
  }
});

// POST /api/backup/kill/:jobId - Kill/cancel a backup job
router.post('/kill/:jobId', async (req, res, next) => {
  try {
    const result = await backupExecutor.killJob(req.params.jobId);
    
    if (result.success) {
      res.json({ success: true, message: result.message });
    } else {
      res.status(404).json({ success: false, error: result.message });
    }
  } catch (error) {
    next(error);
  }
});

// GET /api/backup/tmux/:jobId - Get tmux session info for a job
router.get('/tmux/:jobId', async (req, res, next) => {
  try {
    const result = backupExecutor.getTmuxSession(req.params.jobId);
    
    if (result.success) {
      res.json(result);
    } else {
      res.status(404).json(result);
    }
  } catch (error) {
    next(error);
  }
});

// GET /api/backup/test-progress/:vmName/:schedule - Test reading progress file
router.get('/test-progress/:vmName/:schedule', async (req, res, next) => {
  try {
    const { vmName, schedule } = req.params;
    const config = require('../config/config');
    const path = require('path');
    const fs = require('fs');
    
    const progressFile = path.join(
      config.backupPath,
      '.progress',
      `${vmName}_${schedule}.progress`
    );
    
    if (fs.existsSync(progressFile)) {
      const content = fs.readFileSync(progressFile, 'utf8');
      const data = JSON.parse(content);
      res.json({ 
        success: true, 
        file: progressFile, 
        data,
        backupPath: config.backupPath
      });
    } else {
      res.json({ 
        success: false, 
        file: progressFile, 
        error: 'File not found',
        backupPath: config.backupPath,
        directoryExists: fs.existsSync(path.dirname(progressFile)),
        filesInDirectory: fs.existsSync(path.dirname(progressFile)) 
          ? fs.readdirSync(path.dirname(progressFile))
          : []
      });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
