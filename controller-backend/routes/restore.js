const express = require('express');
const router = express.Router();
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const path = require('path');
const agentService = require('../services/agentService');
const rocketChatService = require('../services/rocketChatService');
const {
  getRestoreJobs,
  saveRestoreJobs,
} = require('../services/fileStorage');

// readRestoreJobs / writeRestoreJobs route through fileStorage's atomic
// helpers so a crash can never leave restore-jobs.json truncated. The
// returned shape is preserved for backwards compatibility with the rest
// of this file ({ jobs: [...] }).
async function readRestoreJobs() {
  const jobs = await getRestoreJobs();
  return { jobs };
}

async function writeRestoreJobs(data) {
  const jobs = (data && Array.isArray(data.jobs)) ? data.jobs : [];
  await saveRestoreJobs(jobs);
}

/**
 * GET /api/restore/options/:vmName/:backupHostId
 * Get all restore options for a VM
 */
router.get('/options/:vmName/:backupHostId', async (req, res, next) => {
  try {
    const { vmName, backupHostId } = req.params;

    console.log(`[Restore] Getting options for VM: ${vmName}, Backup Host: ${backupHostId}`);

    // Get backup host details
    const backupHostsData = await fs.readFile(
      path.join(__dirname, '../data/backup-hosts.json'),
      'utf8'
    );
    const backupHosts = JSON.parse(backupHostsData);
    
    console.log('[Restore] Backup hosts data:', backupHosts);
    
    if (!Array.isArray(backupHosts)) {
      return res.status(500).json({
        success: false,
        error: 'Invalid backup hosts data structure'
      });
    }
    
    const backupHost = backupHosts.find(h => h.id === backupHostId);

    if (!backupHost) {
      return res.status(404).json({
        success: false,
        error: 'Backup host not found'
      });
    }

    console.log('[Restore] Found backup host:', backupHost);

    // Get storage pool for this backup host
    const storagePoolsData = await fs.readFile(
      path.join(__dirname, '../data/storage-pools.json'),
      'utf8'
    );
    const storagePools = JSON.parse(storagePoolsData);
    
    console.log('[Restore] Storage pools data:', storagePools);
    
    if (!Array.isArray(storagePools)) {
      return res.status(500).json({
        success: false,
        error: 'Invalid storage pools data structure'
      });
    }
    
    const storagePool = storagePools.find(p => p.backupHostId === backupHostId);

    if (!storagePool) {
      return res.status(404).json({
        success: false,
        error: 'Storage pool not found for this backup host'
      });
    }

    console.log('[Restore] Found storage pool:', storagePool);

    // Get VM backup details from agent
    const client = agentService.createAgentClient(backupHost.url, backupHost.id, backupHost.name);
    const vmDetailsResponse = await client.get(`/api/backup-removal/vm/${encodeURIComponent(vmName)}/details`, { timeout: 600000 }); // 10 minute timeout

    if (!vmDetailsResponse.data.success) {
      return res.status(500).json({
        success: false,
        error: 'Failed to get VM backup details'
      });
    }

    const vmDetails = vmDetailsResponse.data.data;

    // Filter available methods (schedules)
    const availableMethods = vmDetails.schedules.filter(s => s.available);

    if (availableMethods.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No available backups found for this VM'
      });
    }

    // For each available schedule, analyze the backup
    const methodsWithDetails = [];

    for (const schedule of availableMethods) {
      let backupPath;
      let methodName;
      
      // Check if this is an archived backup
      if (schedule.schedule === 'archived') {
        // For archived backups, use the archive_name
        const archiveName = schedule.archive_name;
        if (!archiveName) {
          console.error(`[Restore] Archived schedule missing archive_name`);
          continue;
        }
        
        // Build path to archived backup
        backupPath = `${storagePool.path}/${vmName}/archived/${archiveName}`;
        // Use "archived_{archive_name}" as the method identifier
        methodName = `archived_${archiveName}`;
        
        console.log(`[Restore] Processing archived backup: ${archiveName}`);
      } else if (schedule.backup_location === 'current') {
        // For "current" directory backups (legacy-daily format)
        // Treat as "daily" method but use "current" directory path
        backupPath = `${storagePool.path}/${vmName}/current`;
        methodName = schedule.schedule; // Use "daily" as the method name
        
        console.log(`[Restore] Processing current directory backup (legacy-daily format)`);
      } else {
        // Regular schedule backup
        backupPath = `${storagePool.path}/${vmName}/${schedule.schedule}`;
        methodName = schedule.schedule;
      }

      try {
        console.log(`[Restore] Analyzing ${methodName} at ${backupPath}`);
        console.log(`[Restore] Agent URL: ${backupHost.url}/api/restore/analyze-backup`);
        
        // Call agent to analyze backup
        const client = agentService.createAgentClient(backupHost.url, backupHost.id, backupHost.name);
        const analyzeResponse = await client.post(
          '/api/restore/analyze-backup',
          { backupPath },
          { timeout: 30000 }
        );

        console.log(`[Restore] Analyze response for ${methodName}:`, analyzeResponse.data);

        if (analyzeResponse.data.success) {
          methodsWithDetails.push({
            method: methodName,
            backupPath,
            isArchived: schedule.schedule === 'archived',
            archiveName: schedule.archive_name || null,
            originalSchedule: schedule.original_schedule || null,
            isLegacyFormat: schedule.is_legacy_format || false,
            backupLocation: schedule.backup_location || null,
            ...analyzeResponse.data.data
          });
        } else {
          console.error(`[Restore] Failed to analyze ${methodName}: ${analyzeResponse.data.error}`);
        }
      } catch (error) {
        console.error(`[Restore] Failed to analyze ${methodName}:`, error.message);
        if (error.response) {
          console.error(`[Restore] Response status: ${error.response.status}`);
          console.error(`[Restore] Response data:`, error.response.data);
        }
        // Continue with other methods
      }
    }

    if (methodsWithDetails.length === 0) {
      return res.status(500).json({
        success: false,
        error: 'Failed to analyze any backup methods'
      });
    }

    // Get restore storage pools for this backup host
    const restorePoolsData = await fs.readFile(
      path.join(__dirname, '../data/restore-storage-pools.json'),
      'utf8'
    );
    const restorePools = JSON.parse(restorePoolsData);
    
    if (!Array.isArray(restorePools)) {
      return res.status(500).json({
        success: false,
        error: 'Invalid restore storage pools data structure'
      });
    }
    
    const restoreStoragePools = restorePools.filter(p => p.backupHostId === backupHostId);

    res.json({
      success: true,
      data: {
        vmName,
        backupHostId,
        availableMethods: methodsWithDetails,
        restoreStoragePools
      }
    });
  } catch (error) {
    console.error('[Restore] Get options error:', error);
    console.error('[Restore] Error stack:', error.stack);
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
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
      backupHostId,
      method,
      restoreStoragePoolId,
      depth,
      disk
    } = req.body;

    // Validate required parameters
    if (!vmName || !backupHostId || !method || !restoreStoragePoolId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters'
      });
    }

    console.log(`[Restore] Triggering restore for ${vmName}/${method}`);

    // Get backup host details
    const backupHostsData = await fs.readFile(
      path.join(__dirname, '../data/backup-hosts.json'),
      'utf8'
    );
    const backupHosts = JSON.parse(backupHostsData);
    const backupHost = backupHosts.find(h => h.id === backupHostId);

    if (!backupHost) {
      return res.status(404).json({
        success: false,
        error: 'Backup host not found'
      });
    }

    // Get storage pool (for backup location)
    const storagePoolsData = await fs.readFile(
      path.join(__dirname, '../data/storage-pools.json'),
      'utf8'
    );
    const storagePools = JSON.parse(storagePoolsData);
    const storagePool = storagePools.find(p => p.backupHostId === backupHostId);

    if (!storagePool) {
      return res.status(404).json({
        success: false,
        error: 'Storage pool not found'
      });
    }

    // Get restore storage pool
    const restorePoolsData = await fs.readFile(
      path.join(__dirname, '../data/restore-storage-pools.json'),
      'utf8'
    );
    const restorePools = JSON.parse(restorePoolsData);
    const restorePool = restorePools.find(p => p.id === restoreStoragePoolId);

    if (!restorePool) {
      return res.status(404).json({
        success: false,
        error: 'Restore storage pool not found'
      });
    }

    // Build paths
    // For "daily" method, check if it's in "current" directory (legacy format)
    // by checking the VM details from the agent
    let backupPath;
    
    // Get VM backup details to determine the actual backup location
    const client = agentService.createAgentClient(backupHost.url, backupHost.id, backupHost.name);
    const vmDetailsResponse = await client.get(`/api/backup-removal/vm/${encodeURIComponent(vmName)}/details`, { timeout: 60000 });
    
    if (vmDetailsResponse.data.success) {
      const vmDetails = vmDetailsResponse.data.data;
      const dailySchedule = vmDetails.schedules.find(s => s.schedule === 'daily' && s.available);
      
      // Check if this daily backup is in "current" directory (legacy format)
      if (dailySchedule && dailySchedule.backup_location === 'current' && method === 'daily') {
        backupPath = `${storagePool.path}/${vmName}/current`;
        console.log(`[Restore] Using current directory for daily backup (legacy format)`);
      } else {
        // Regular path
        backupPath = `${storagePool.path}/${vmName}/${method}`;
      }
    } else {
      // Fallback to regular path if we can't get VM details
      backupPath = `${storagePool.path}/${vmName}/${method}`;
    }
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const restorePath = `${restorePool.path}/${vmName}_${method}_${timestamp}`;

    // Generate restore ID
    const restoreId = uuidv4();

    // Create progress and events files in BASE storage pool's .progress directory
    // NOT in the VM's backup directory - use the base storage pool path
    const progressDir = `${storagePool.path}/.progress`;
    const progressFile = `${progressDir}/restore_${vmName}_${method}_${restoreId}.progress`;
    const eventsFile = `/tmp/restore-manager/events/restore_events_${restoreId}.jsonl`;

    console.log(`[Restore] Creating restore job for ${vmName}/${method}`);
    console.log(`[Restore] Backup path: ${backupPath}`);
    console.log(`[Restore] Restore path: ${restorePath}`);
    console.log(`[Restore] Progress file: ${progressFile}`);
    console.log(`[Restore] Restore ID: ${restoreId}`);

    // Create restore job record
    const restoreJob = {
      id: restoreId,
      vmName,
      backupHostId,
      backupHostName: backupHost.name, // Add backup host name for display
      method,
      restoreStoragePoolId,
      depth,
      disk,
      backupPath,
      restorePath,
      progressFile,
      eventsFile,
      status: 'queued',
      progress: 0,
      progressText: 'Initializing...',
      startTime: new Date().toISOString(),
      endTime: null,
      error: null,
      agentUrl: backupHost.url
    };

    // Save restore job
    const jobsData = await readRestoreJobs();
    jobsData.jobs.push(restoreJob);
    await writeRestoreJobs(jobsData);

    // Trigger restore on agent
    try {
      const client = agentService.createAgentClient(backupHost.url, backupHost.id, backupHost.name);
      const triggerResponse = await client.post(
        '/api/restore/trigger',
        {
          vmName,
          method,
          backupPath,
          restorePath,
          depth,
          disk,
          restoreId,
          progressFile,
          eventsFile
        },
        { timeout: 30000 }
      );

      if (!triggerResponse.data.success) {
        throw new Error(triggerResponse.data.error || 'Failed to trigger restore');
      }

      // Update job status
      restoreJob.status = 'running';
      await writeRestoreJobs(jobsData);

      // Notify RocketChat
      rocketChatService.notifyRestoreStarted(vmName, backupHost.name, restorePool.name);

      res.json({
        success: true,
        data: {
          restoreId,
          status: 'running',
          message: 'Restore operation started successfully'
        }
      });
    } catch (error) {
      console.error('[Restore] Failed to trigger on agent:', error.message);

      // Update job status to failed
      restoreJob.status = 'failed';
      restoreJob.error = error.message;
      restoreJob.endTime = new Date().toISOString();
      await writeRestoreJobs(jobsData);

      return res.status(500).json({
        success: false,
        error: `Failed to start restore: ${error.message}`
      });
    }
  } catch (error) {
    console.error('[Restore] Trigger error:', error);
    next(error);
  }
});

/**
 * GET /api/restore/status/:restoreId
 * Get restore status
 */
router.get('/status/:restoreId', async (req, res, next) => {
  try {
    const { restoreId } = req.params;

    // Get restore job
    const jobsData = await readRestoreJobs();
    const job = jobsData.jobs.find(j => j.id === restoreId);

    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Restore job not found'
      });
    }

    // If job is running, get latest progress from agent
    if (job.status === 'running') {
      try {
        console.log(`[Restore] Fetching progress for ${restoreId}`);
        console.log(`[Restore] Agent URL: ${job.agentUrl}`);
        console.log(`[Restore] Progress file: ${job.progressFile}`);
        
        // Extract backup host info from job to create authenticated client
        const backupHostsData = await fs.readFile(
          path.join(__dirname, '../data/backup-hosts.json'),
          'utf8'
        );
        const backupHosts = JSON.parse(backupHostsData);
        const backupHost = backupHosts.find(h => h.id === job.backupHostId);
        
        if (backupHost) {
          const client = agentService.createAgentClient(backupHost.url, backupHost.id, backupHost.name);
          const progressResponse = await client.get(
            `/api/restore/progress/${restoreId}`,
            { 
              params: { progressFile: job.progressFile },
              timeout: 5000 
            }
          );

          console.log(`[Restore] Progress response:`, progressResponse.data);

          if (progressResponse.data.success) {
            const progress = progressResponse.data.data;
            job.progress = progress.percentage;
            job.progressText = progress.text;

            console.log(`[Restore] Updated progress: ${job.progress}% - ${job.progressText}`);

            // Check if restore completed
            if (progress.percentage >= 100 || progress.status === 'completed') {
              job.status = 'completed';
              job.endTime = new Date().toISOString();
            }

            // ✅ Save updated progress to disk so /jobs endpoint sees it
            await writeRestoreJobs(jobsData);
          }
        }
      } catch (error) {
        console.error('[Restore] Failed to get progress from agent:', error.message);
        // Continue with cached job data
      }
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
 * GET /api/restore/jobs
 * Get all restore jobs (with live progress updates)
 */
router.get('/jobs', async (req, res, next) => {
  try {
    const jobsData = await readRestoreJobs();

    // Filter active jobs (queued or running)
    const activeJobs = jobsData.jobs.filter(j => 
      j.status === 'queued' || j.status === 'running'
    );

    // Fetch latest progress for all running jobs
    const backupHostsData = await fs.readFile(
      path.join(__dirname, '../data/backup-hosts.json'),
      'utf8'
    );
    const backupHosts = JSON.parse(backupHostsData);
    
    const updatedJobs = await Promise.all(
      activeJobs.map(async (job) => {
        if (job.status === 'running') {
          try {
            const backupHost = backupHosts.find(h => h.id === job.backupHostId);
            if (backupHost) {
              const client = agentService.createAgentClient(backupHost.url, backupHost.id, backupHost.name);
              const progressResponse = await client.get(
                `/api/restore/progress/${job.id}`,
                { 
                  params: { progressFile: job.progressFile },
                  timeout: 3000 
                }
              );

              if (progressResponse.data.success) {
                const progress = progressResponse.data.data;
                job.progress = progress.percentage;
                job.progressText = progress.text;

                // Check if completed
                if (progress.percentage >= 100 || progress.status === 'completed') {
                  job.status = 'completed';
                  job.endTime = new Date().toISOString();
                }
              }
            }
          } catch (error) {
            // Continue with cached data on error
            console.error(`[Restore] Failed to fetch progress for ${job.id}:`, error.message);
          }
        }
        return job;
      })
    );

    // Save updated jobs back to disk
    jobsData.jobs = jobsData.jobs.map(j => {
      const updated = updatedJobs.find(uj => uj.id === j.id);
      return updated || j;
    });
    await writeRestoreJobs(jobsData);

    res.json({
      success: true,
      data: updatedJobs
    });
  } catch (error) {
    console.error('[Restore] Get jobs error:', error);
    next(error);
  }
});

/**
 * GET /api/restore/history
 * Get restore history
 */
router.get('/history', async (req, res, next) => {
  try {
    const jobsData = await readRestoreJobs();

    // Filter completed/failed jobs
    const history = jobsData.jobs.filter(j => 
      j.status === 'completed' || j.status === 'failed'
    );

    // Sort by start time (newest first)
    history.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));

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
 * GET /api/restore/logs/:restoreId
 * Get restore logs
 */
router.get('/logs/:restoreId', async (req, res, next) => {
  try {
    const { restoreId } = req.params;

    // Get restore job
    const jobsData = await readRestoreJobs();
    const job = jobsData.jobs.find(j => j.id === restoreId);

    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Restore job not found'
      });
    }

    // Get logs from agent
    try {
      const backupHostsData = await fs.readFile(
        path.join(__dirname, '../data/backup-hosts.json'),
        'utf8'
      );
      const backupHosts = JSON.parse(backupHostsData);
      const backupHost = backupHosts.find(h => h.id === job.backupHostId);
      
      if (!backupHost) {
        return res.status(404).json({
          success: false,
          error: 'Backup host not found'
        });
      }
      
      const client = agentService.createAgentClient(backupHost.url, backupHost.id, backupHost.name);
      const logsResponse = await client.get(
        `/api/restore/logs/${restoreId}`,
        { timeout: 10000 }
      );

      if (logsResponse.data.success) {
        res.json({
          success: true,
          data: {
            logs: logsResponse.data.data.logs || logsResponse.data.data || ''
          }
        });
      } else {
        res.json({
          success: true,
          data: {
            logs: 'Logs not available'
          }
        });
      }
    } catch (error) {
      console.error('[Restore] Failed to get logs from agent:', error.message);
      res.json({
        success: true,
        data: {
          logs: 'Logs not available'
        }
      });
    }
  } catch (error) {
    console.error('[Restore] Get logs error:', error);
    next(error);
  }
});

/**
 * POST /api/restore/kill/:restoreId
 * Cancel restore job
 */
router.post('/kill/:restoreId', async (req, res, next) => {
  try {
    const { restoreId } = req.params;

    // Get restore job
    const jobsData = await readRestoreJobs();
    const job = jobsData.jobs.find(j => j.id === restoreId);

    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Restore job not found'
      });
    }

    // Can only kill running or queued jobs
    if (job.status !== 'running' && job.status !== 'queued') {
      return res.status(400).json({
        success: false,
        error: 'Can only cancel running or queued jobs'
      });
    }

    // Kill job on agent
    try {
      // Get backup host details to create authenticated client
      const backupHostsData = await fs.readFile(
        path.join(__dirname, '../data/backup-hosts.json'),
        'utf8'
      );
      const backupHosts = JSON.parse(backupHostsData);
      const backupHost = backupHosts.find(h => h.id === job.backupHostId);
      
      if (!backupHost) {
        // If backup host not found, just update job status locally
        console.log(`[Restore] Backup host not found for job ${restoreId}, updating status locally`);
        job.status = 'failed';
        job.error = 'Cancelled by user (backup host not found)';
        job.endTime = new Date().toISOString();
        await writeRestoreJobs(jobsData);

        return res.json({
          success: true,
          data: {
            message: 'Restore job cancelled (backup host not found)'
          }
        });
      }
      
      const client = agentService.createAgentClient(backupHost.url, backupHost.id, backupHost.name);
      const killResponse = await client.post(
        `/api/restore/kill/${restoreId}`,
        {},
        { timeout: 10000 }
      );

      if (killResponse.data.success) {
        // Update job status
        job.status = 'failed';
        job.error = 'Cancelled by user';
        job.endTime = new Date().toISOString();
        await writeRestoreJobs(jobsData);

        res.json({
          success: true,
          data: {
            message: 'Restore job cancelled successfully'
          }
        });
      } else if (killResponse.data.notFound) {
        // Job not found on agent - update status locally and allow removal
        console.log(`[Restore] Job ${restoreId} not found on agent, updating status locally`);
        job.status = 'failed';
        job.error = 'Cancelled by user (job not found on agent)';
        job.endTime = new Date().toISOString();
        await writeRestoreJobs(jobsData);

        res.json({
          success: true,
          data: {
            message: 'Restore job cancelled (not found on agent)'
          }
        });
      } else if (killResponse.data.alreadyCompleted) {
        // Job already completed - just update status locally
        console.log(`[Restore] Job ${restoreId} already completed on agent`);
        if (job.status === 'running' || job.status === 'queued') {
          job.status = 'completed';
          job.endTime = new Date().toISOString();
          await writeRestoreJobs(jobsData);
        }

        res.json({
          success: true,
          data: {
            message: 'Restore job already completed'
          }
        });
      } else {
        throw new Error(killResponse.data.message || 'Failed to cancel restore');
      }
    } catch (error) {
      console.error('[Restore] Failed to kill job on agent:', error.message);
      
      // Update job status anyway so it can be removed from UI
      job.status = 'failed';
      job.error = 'Cancelled by user (agent may still be running)';
      job.endTime = new Date().toISOString();
      await writeRestoreJobs(jobsData);

      res.json({
        success: true,
        data: {
          message: 'Restore job cancelled locally (agent communication failed)',
          warning: error.message
        }
      });
    }
  } catch (error) {
    console.error('[Restore] Kill job error:', error);
    next(error);
  }
});

/**
 * POST /api/restore/jobs/:restoreId/update
 * Update restore job status (called by agent)
 */
router.post('/jobs/:restoreId/update', async (req, res, next) => {
  try {
    const { restoreId } = req.params;
    const { status, exitCode, progress, progressText, endTime } = req.body;

    console.log(`[Restore] Received update for ${restoreId}: ${status} (${progress}%)`);

    // Get restore job
    const jobsData = await readRestoreJobs();
    const job = jobsData.jobs.find(j => j.id === restoreId);

    if (!job) {
      console.error(`[Restore] Job ${restoreId} not found for update`);
      return res.status(404).json({
        success: false,
        error: 'Restore job not found'
      });
    }

    // Update job fields
    if (status) {
      job.status = status;
    }
    if (exitCode !== undefined && exitCode !== null) {
      job.exitCode = exitCode;
    }
    if (progress !== undefined && progress !== null) {
      job.progress = progress;
    }
    if (progressText) {
      job.progressText = progressText;
    }
    if (endTime) {
      job.endTime = endTime;
    }

    // Save updated jobs
    await writeRestoreJobs(jobsData);

    console.log(`[Restore] Updated job ${restoreId}: ${job.status} (${job.progress}%)`);

    // Notify RocketChat on status changes
    if (status === 'completed') {
      const duration = job.endTime && job.startTime 
        ? `${Math.round((new Date(job.endTime) - new Date(job.startTime)) / 1000 / 60)}m`
        : 'unknown';
      rocketChatService.notifyRestoreCompleted(job.vmName, duration);
    } else if (status === 'failed') {
      rocketChatService.notifyRestoreFailed(job.vmName, job.error || 'Unknown error');
    }

    res.json({
      success: true,
      data: job
    });
  } catch (error) {
    console.error('[Restore] Update job error:', error);
    next(error);
  }
});

/**
 * POST /api/restore/cleanup
 * Clean up old completed/failed restore jobs from history
 */
router.post('/cleanup', async (req, res, next) => {
  try {
    const { olderThanDays = 7 } = req.body;
    
    const jobsData = await readRestoreJobs();
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);
    
    const originalCount = jobsData.jobs.length;
    
    // Keep only jobs that are:
    // 1. Active (running or queued), OR
    // 2. Completed/failed within the retention period
    jobsData.jobs = jobsData.jobs.filter(job => {
      // Keep active jobs
      if (job.status === 'running' || job.status === 'queued') {
        return true;
      }
      
      // Keep recent completed/failed jobs
      const jobDate = new Date(job.startTime);
      return jobDate > cutoffDate;
    });
    
    const deletedCount = originalCount - jobsData.jobs.length;
    
    await writeRestoreJobs(jobsData);
    
    console.log(`[Restore] Cleaned up ${deletedCount} old jobs (older than ${olderThanDays} days)`);
    
    res.json({
      success: true,
      data: {
        deletedCount,
        remainingCount: jobsData.jobs.length,
        message: `Cleaned up ${deletedCount} old restore jobs`
      }
    });
  } catch (error) {
    console.error('[Restore] Cleanup error:', error);
    next(error);
  }
});

module.exports = router;
