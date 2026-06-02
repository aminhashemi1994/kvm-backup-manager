const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const { 
  getBackupJobs, 
  saveBackupJobs, 
  getBackupHosts, 
  getHypervisors, 
  getVirtualMachines,
  getBackupSchedules,
  getRestoreJobs,
  saveRestoreJobs,
  appendLog, 
  readLog 
} = require('../services/fileStorage');
const agentService = require('../services/agentService');
const backupCycleService = require('../services/backupCycleService');
const rocketChatService = require('../services/rocketChatService');
const auditService = require('../services/auditService');
const schedulerService = require('../services/schedulerService');
const { validateBackupTrigger } = require('../utils/validator');
const { requireUser, requireAdmin } = require('../middleware/rbac');

/**
 * Sync job status with agent
 * Returns true if status was updated
 */
async function syncJobStatusWithAgent(job, hosts) {
  if (job.status !== 'running' && job.status !== 'queued') {
    return false; // Already finished
  }
  
  const host = hosts.find(h => h.id === job.backupHostId);
  if (!host) return false;
  
  try {
    const client = agentService.createAgentClient(host.url, host.id, host.name);
    const response = await client.get('/api/backup/active', { timeout: 5000 });
    
    const agentActiveJobs = response.data.data.active || [];
    const agentQueuedJobs = response.data.data.queued || [];
    const isActiveOnAgent = [...agentActiveJobs, ...agentQueuedJobs].some(
      aj => aj.jobId === job.id
    );
    
    // If not active on agent, update status
    if (!isActiveOnAgent) {
      job.status = 'completed';
      job.endTime = job.endTime || new Date().toISOString();
      await appendLog(job.id, 'Job completed (verified with agent)');
      return true;
    }
  } catch (error) {
    // Agent unreachable - mark as failed if too old
    const jobAge = Date.now() - new Date(job.startTime).getTime();
    const maxAge = 2 * 60 * 60 * 1000; // 2 hours
    
    if (jobAge > maxAge) {
      job.status = 'failed';
      job.endTime = job.endTime || new Date().toISOString();
      job.error = job.error || 'Job timeout or agent unreachable';
      await appendLog(job.id, 'Job marked as failed (agent unreachable, timeout)');
      return true;
    }
  }
  
  return false;
}

// GET /api/backups/active - Get active backup jobs
router.get('/active', async (req, res, next) => {
  try {
    const jobs = await getBackupJobs();
    const hosts = await getBackupHosts();

    let activeJobs = jobs.filter(j => j.status === 'running' || j.status === 'queued' || j.status === 'retrying');
    let statusUpdated = false;

    if (activeJobs.length > 0) {
      const SYNC_BUDGET_MS = 6000;
      const results = await Promise.race([
        Promise.allSettled(activeJobs.map(j => syncJobStatusWithAgent(j, hosts))),
        new Promise(resolve => setTimeout(() => resolve(null), SYNC_BUDGET_MS)),
      ]);
      if (Array.isArray(results)) {
        statusUpdated = results.some(r => r.status === 'fulfilled' && r.value);
      } else {
        console.warn('[Active] Agent status sync exceeded budget; serving stale data');
      }
    }

    // Save if any status was updated
    if (statusUpdated) {
      await saveBackupJobs(jobs);
    }
    
    // Re-filter after sync
    activeJobs = jobs.filter(j => j.status === 'running' || j.status === 'queued' || j.status === 'retrying');
    
    // Add countdown for retrying jobs
    activeJobs = activeJobs.map(job => ({
      ...job,
      ...(job.status === 'retrying' && job.retryAt ? {
        retryCountdownSeconds: Math.max(0, Math.floor((new Date(job.retryAt) - new Date()) / 1000))
      } : {})
    }));
    
    res.json({ success: true, data: activeJobs });
  } catch (error) {
    next(error);
  }
});

// GET /api/backups/history - Get backup and restore job history
router.get('/history', async (req, res, next) => {
  try {
    const { limit = 100, status, vmId } = req.query;
    let backupJobs = await getBackupJobs();
    const hosts = await getBackupHosts();

    // Sync status for backup jobs marked as running/queued — but in parallel
    // and with a hard overall budget so unreachable agents can't block the
    // dashboard. Previously this loop ran serially with a 5s timeout per job;
    // a handful of hung jobs would freeze /history (and the dashboard's
    // Recent Activity card would spin forever).
    const runningBackupJobs = backupJobs.filter(j => j.status === 'running' || j.status === 'queued');
    let statusUpdated = false;

    if (runningBackupJobs.length > 0) {
      const SYNC_BUDGET_MS = 6000;
      const results = await Promise.race([
        Promise.allSettled(runningBackupJobs.map(j => syncJobStatusWithAgent(j, hosts))),
        new Promise(resolve => setTimeout(() => resolve(null), SYNC_BUDGET_MS)),
      ]);
      if (Array.isArray(results)) {
        statusUpdated = results.some(r => r.status === 'fulfilled' && r.value);
      } else {
        // Budget exceeded — skip the save and return what we already have on
        // disk. The next call (or background reconciler) can finish the job.
        console.warn('[History] Agent status sync exceeded budget; serving stale data');
      }
    }
    
    // Save updated backup jobs
    if (statusUpdated) {
      await saveBackupJobs(backupJobs);
    }
    
    // Get restore jobs
    const fs = require('fs').promises;
    const path = require('path');
    const RESTORE_JOBS_FILE = path.join(__dirname, '../data/restore-jobs.json');
    let restoreJobs = [];
    
    try {
      const restoreData = await fs.readFile(RESTORE_JOBS_FILE, 'utf8');
      const parsed = JSON.parse(restoreData);
      restoreJobs = parsed.jobs || [];
      
      // Add jobType field to distinguish restore jobs
      restoreJobs = restoreJobs.map(job => ({
        ...job,
        jobType: 'restore',
        // Map restore fields to match backup job structure
        scheduleType: job.method,
      }));
    } catch (error) {
      // Restore jobs file doesn't exist or is empty, continue with empty array
      console.log('[History] No restore jobs found:', error.message);
    }
    
    // Add jobType to backup jobs
    backupJobs = backupJobs.map(job => ({
      ...job,
      jobType: 'backup',
      // Calculate countdown for retrying jobs
      ...(job.status === 'retrying' && job.retryAt ? {
        retryCountdownSeconds: Math.max(0, Math.floor((new Date(job.retryAt) - new Date()) / 1000))
      } : {})
    }));
    
    // Combine backup and restore jobs
    let allJobs = [...backupJobs, ...restoreJobs];
    
    // Apply filters
    if (status) {
      allJobs = allJobs.filter(j => j.status === status);
    }
    
    if (vmId) {
      allJobs = allJobs.filter(j => j.vmId === vmId || j.vmName === vmId);
    }
    
    // Sort by start time (newest first)
    allJobs.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
    allJobs = allJobs.slice(0, parseInt(limit));
    
    res.json({ success: true, data: allJobs });
  } catch (error) {
    next(error);
  }
});

// GET /api/backups/jobs/:id - Get single job
router.get('/jobs/:id', async (req, res, next) => {
  try {
    const jobs = await getBackupJobs();
    const job = jobs.find(j => j.id === req.params.id);
    
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }
    
    // Verify status with agent if marked as running/queued
    const hosts = await getBackupHosts();
    const updated = await syncJobStatusWithAgent(job, hosts);
    
    if (updated) {
      await saveBackupJobs(jobs);
    }
    
    // Add countdown for retrying jobs
    const jobData = {
      ...job,
      ...(job.status === 'retrying' && job.retryAt ? {
        retryCountdownSeconds: Math.max(0, Math.floor((new Date(job.retryAt) - new Date()) / 1000))
      } : {})
    };
    
    res.json({ success: true, data: jobData });
  } catch (error) {
    next(error);
  }
});

// GET /api/backups/jobs/:id/logs - Get job logs
router.get('/jobs/:id/logs', async (req, res, next) => {
  try {
    const jobs = await getBackupJobs();
    const job = jobs.find(j => j.id === req.params.id);
    
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    // Get backup host
    const hosts = await getBackupHosts();
    const host = hosts.find(h => h.id === job.backupHostId);
    
    if (!host) {
      // Fallback to controller logs if host not found
      const logs = await readLog(req.params.id);
      return res.json({ success: true, data: { logs } });
    }

    // Fetch logs from agent
    try {
      const client = agentService.createAgentClient(host.url, host.id, host.name);
      const response = await client.get(`/api/backup/logs/${req.params.id}`, {
        timeout: 10000
      });
      
      res.json({ success: true, data: { logs: response.data.data.logs } });
    } catch (error) {
      console.error('Error fetching logs from agent:', error.message);
      
      // If 404, the job is no longer on agent (completed/failed)
      // Update job status if it's still showing as running
      if (error.response?.status === 404 && (job.status === 'running' || job.status === 'queued')) {
        job.status = 'completed';
        job.endTime = job.endTime || new Date().toISOString();
        await saveBackupJobs(jobs);
        await appendLog(req.params.id, 'Job completed (no longer active on agent)');
      }
      
      // Fallback to controller logs
      const logs = await readLog(req.params.id);
      res.json({ success: true, data: { logs } });
    }
  } catch (error) {
    next(error);
  }
});

// GET /api/backups/jobs/:id/logs/stream - Stream job logs (SSE proxy to agent)
router.get('/jobs/:id/logs/stream', async (req, res, next) => {
  try {
    const jobs = await getBackupJobs();
    const job = jobs.find(j => j.id === req.params.id);
    
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    // Get backup host
    const hosts = await getBackupHosts();
    const host = hosts.find(h => h.id === job.backupHostId);
    
    if (!host) {
      return res.status(404).json({ success: false, error: 'Backup host not found' });
    }

    // Proxy SSE stream from agent
    const client = agentService.createAgentClient(host.url, host.id, host.name);
    
    const response = await client.get(`/api/backup/logs/${req.params.id}/stream`, {
      responseType: 'stream',
      timeout: 0 // No timeout for streaming
    });

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Pipe the stream
    response.data.pipe(res);

    // Handle client disconnect
    req.on('close', () => {
      response.data.destroy();
      res.end();
    });
  } catch (error) {
    console.error('Error streaming logs from agent:', error.message);
    next(error);
  }
});

// POST /api/backups/trigger - Trigger manual backup
router.post('/trigger', requireUser, async (req, res, next) => {
  try {
    const { 
      vmId, 
      vmName, 
      backupHostId, 
      hypervisorIp, 
      storagePoolId,
      scheduleType = 'once',
      retention = 7,
      keepArchive = 2,
      compression = 2,
      noCompression = false,
      noVerify = false,
      offsiteHostIds = [],
      verbose = false
    } = req.body;

    if (!vmId) {
      return res.status(400).json({ 
        success: false, 
        error: 'vmId is required' 
      });
    }

    if (!storagePoolId) {
      return res.status(400).json({ 
        success: false, 
        error: 'storagePoolId is required' 
      });
    }

    // Get backup host
    const hosts = await getBackupHosts();
    const host = hosts.find(h => h.id === backupHostId);
    if (!host) {
      return res.status(404).json({ success: false, error: 'Backup host not found' });
    }

    // Check host status
    if (host.status !== 'online') {
      return res.status(400).json({ success: false, error: 'Backup host is offline' });
    }

    // Check concurrent backup limit
    const jobs = await getBackupJobs();
    const runningJobsOnHost = jobs.filter(j => 
      j.backupHostId === backupHostId && 
      (j.status === 'running' || j.status === 'queued')
    );
    
    const maxConcurrent = host.maxConcurrentBackups || 20;
    if (runningJobsOnHost.length >= maxConcurrent) {
      return res.status(429).json({ 
        success: false, 
        error: `Maximum concurrent backups (${maxConcurrent}) reached for this backup host. Please wait for a backup to complete.`,
        currentRunning: runningJobsOnHost.length,
        maxAllowed: maxConcurrent
      });
    }

    // Validate storage pool exists and belongs to backup host
    const { getStoragePools } = require('../services/fileStorage');
    const pools = await getStoragePools();
    const pool = pools.find(p => p.id === storagePoolId && p.backupHostId === backupHostId);

    if (!pool) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid storage pool for this backup host' 
      });
    }

    // Get VM info if not provided
    let finalVmName = vmName;
    let finalHypervisorIp = hypervisorIp;

    if (!vmName || !hypervisorIp) {
      const vms = await getVirtualMachines();
      const vm = vms.find(v => v.id === vmId);
      if (!vm) {
        return res.status(404).json({ success: false, error: 'VM not found' });
      }
      finalVmName = vm.name;

      const hypervisors = await getHypervisors();
      const hypervisor = hypervisors.find(h => h.id === vm.hypervisorId);
      if (!hypervisor) {
        return res.status(404).json({ success: false, error: 'Hypervisor not found' });
      }
      finalHypervisorIp = hypervisor.ip;
    }

    // Get offsite host IPs
    const offsiteHosts = [];
    if (offsiteHostIds && offsiteHostIds.length > 0) {
      const { getOffsiteHosts } = require('../services/fileStorage');
      const allOffsiteHosts = await getOffsiteHosts();
      offsiteHostIds.forEach(id => {
        const offsiteHost = allOffsiteHosts.find(h => h.id === id);
        if (offsiteHost) {
          offsiteHosts.push(offsiteHost.ip);
        }
      });
    }

    // PRE-FLIGHT CHECK: Verify no backup is already in progress
    console.log(`[BackupTrigger] Checking if backup is already in progress for ${finalVmName}/${scheduleType}`);
    try {
      const statusCheck = await agentService.checkBackupStatus(
        host.url,
        finalVmName,
        scheduleType,
        pool.path
      );

      if (statusCheck.inProgress) {
        console.error(`[BackupTrigger] Backup already in progress for ${finalVmName}/${scheduleType}: ${statusCheck.details}`);
        return res.status(409).json({
          success: false,
          error: 'Backup already in progress',
          message: `Cannot start backup: ${statusCheck.details}`,
          details: {
            vmName: finalVmName,
            scheduleType: scheduleType,
            status: statusCheck.status,
            checks: statusCheck.checks
          }
        });
      }

      console.log(`[BackupTrigger] ✓ No backup in progress, proceeding with backup`);
    } catch (error) {
      // Log error but don't block backup if status check fails
      console.warn(`[BackupTrigger] Warning: Status check failed, proceeding anyway:`, error.message);
    }

    // Create job record
    const jobId = uuidv4();
    const job = {
      id: jobId,
      vmId,
      vmName: finalVmName,
      hypervisorIp: finalHypervisorIp,
      backupHostId,
      backupHostName: host.name,
      storagePoolId,
      storagePoolName: pool.name,
      scheduleType,
      retention,
      keepArchive,
      compression: compression || 2,
      noCompression: noCompression || false,
      noVerify: noVerify || false,
      offsiteHosts,
      status: 'queued',
      startTime: new Date().toISOString(),
      endTime: null,
      exitCode: null,
      error: null,
      scheduled: false,
      progress: 0,
      progressText: 'Queued...',
    };

    // Save job (jobs already loaded above for concurrent check)
    jobs.push(job);
    await saveBackupJobs(jobs);

    // Log start
    await appendLog(jobId, `Manual backup triggered for VM: ${finalVmName}`);
    await appendLog(jobId, `Storage Pool: ${pool.name} (${pool.path})`);
    await appendLog(jobId, `Schedule Type: ${scheduleType}`);
    await appendLog(jobId, `Retention: ${retention}, Keep Archive: ${keepArchive}`);
    await appendLog(jobId, `Compression: ${noCompression ? 'disabled' : compression || 2}`);
    if (offsiteHosts.length > 0) {
      await appendLog(jobId, `Offsite hosts: ${offsiteHosts.join(', ')}`);
    }

    // Get io from app
    const io = req.app.get('io');
    io.emit('backup-started', job);

    // Trigger backup on agent
    try {
      await agentService.triggerBackup(host.url, {
        jobId,
        vmName: finalVmName,
        hypervisorIp: finalHypervisorIp,
        storagePoolId,
        storagePoolPath: pool.path,
        scheduleType,
        retention,
        keepArchive,
        compression: compression || 2,
        noCompression: noCompression || false,
        noVerify: noVerify || false,
        offsiteHosts,
        verbose,
      });

      // Update job status
      job.status = 'running';
      await saveBackupJobs(jobs);

    } catch (error) {
      job.status = 'failed';
      job.error = error.message;
      job.endTime = new Date().toISOString();
      await saveBackupJobs(jobs);
      await appendLog(jobId, `Error triggering backup: ${error.message}`);
      io.emit('backup-error', job);
    }

    res.status(202).json({ success: true, data: job });
  } catch (error) {
    next(error);
  }
});

// POST /api/backups/trigger-scheduled - Trigger scheduled backup with cycle management
router.post('/trigger-scheduled', async (req, res, next) => {
  try {
    const { vmId, backupHostId, compression, noCompression, noVerify } = req.body;

    if (!vmId) {
      return res.status(400).json({ 
        success: false, 
        error: 'vmId is required' 
      });
    }

    // Get VM
    const vms = await getVirtualMachines();
    const vm = vms.find(v => v.id === vmId);
    if (!vm) {
      return res.status(404).json({ success: false, error: 'VM not found' });
    }

    // Get backup host
    const hosts = await getBackupHosts();
    const host = hosts.find(h => h.id === backupHostId || h.id === vm.backupHostId);
    if (!host) {
      return res.status(404).json({ success: false, error: 'Backup host not found' });
    }

    // Check host status
    if (host.status !== 'online') {
      return res.status(400).json({ success: false, error: 'Backup host is offline' });
    }

    // Get hypervisor info
    const hypervisors = await getHypervisors();
    const hypervisor = hypervisors.find(h => h.id === vm.hypervisorId);
    if (!hypervisor) {
      return res.status(404).json({ success: false, error: 'Hypervisor not found' });
    }

    // Determine backup method and handle archiving
    const cycleConfig = await backupCycleService.executeBackupWithCycle(vmId, host.url);
    
    console.log(`Scheduled backup for ${vm.name}: method=${cycleConfig.method}, cycle=${cycleConfig.cycleInfo.current}/${cycleConfig.cycleInfo.total}`);

    // Create job record
    const jobId = uuidv4();
    const job = {
      id: jobId,
      vmId,
      vmName: vm.name,
      hypervisorIp: hypervisor.ip,
      backupHostId: host.id,
      backupHostName: host.name,
      method: cycleConfig.method,
      compression: compression || 2,
      noCompression: noCompression || false,
      noVerify: noVerify || false,
      status: 'queued',
      startTime: new Date().toISOString(),
      endTime: null,
      exitCode: null,
      error: null,
      scheduled: true,
      cycleInfo: cycleConfig.cycleInfo,
      progress: 0,
      progressText: 'Queued...',
    };

    // Save job
    const jobs = await getBackupJobs();
    jobs.push(job);
    await saveBackupJobs(jobs);

    // Log start
    await appendLog(jobId, `Scheduled backup triggered for VM: ${vm.name}`);
    await appendLog(jobId, `Method: ${cycleConfig.method} (cycle: ${cycleConfig.cycleInfo.current}/${cycleConfig.cycleInfo.total})`);
    if (cycleConfig.cycleInfo.archived) {
      await appendLog(jobId, `Previous backup archived before starting new cycle`);
    }
    await appendLog(jobId, `Compression: ${noCompression ? 'disabled' : compression || 2}`);

    // Get io from app
    const io = req.app.get('io');
    io.emit('backup-started', job);

    // Trigger backup on agent
    try {
      await agentService.triggerBackup(host.url, {
        jobId,
        vmName: vm.name,
        hypervisorIp: hypervisor.ip,
        method: cycleConfig.method,
        compression: compression || 2,
        noCompression: noCompression || false,
        noVerify: noVerify || false,
      });

      // Update job status
      job.status = 'running';
      await saveBackupJobs(jobs);

      // Increment backup counter after successful trigger
      await backupCycleService.incrementBackupCounter(vmId);

    } catch (error) {
      job.status = 'failed';
      job.error = error.message;
      job.endTime = new Date().toISOString();
      await saveBackupJobs(jobs);
      await appendLog(jobId, `Error triggering backup: ${error.message}`);
      io.emit('backup-error', job);
    }

    res.status(202).json({ success: true, data: job });
  } catch (error) {
    next(error);
  }
});
// POST /api/backups/jobs/:id/update - Update job status (called by agent)
router.post('/jobs/:id/update', async (req, res, next) => {
  try {
    const { status, exitCode, error, logLine, progress, progressText, failureReason } = req.body;
    
    const jobs = await getBackupJobs();
    const job = jobs.find(j => j.id === req.params.id);
    
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    // Handle status updates
    if (status) {
      console.log(`[Backups] Job ${job.id} received status update: ${status}, current status: ${job.status}`);
      
      // For scheduled backups with retry capability, check if we should mark as "retrying" instead of "failed"
      if (status === 'failed' && job.scheduled && job.scheduleId) {
        const attempt = job.attemptNumber || 1;
        const maxAttempts = job.maxAttempts || 1;
        
        console.log(`[Backups] Job ${job.id} failed - checking retry eligibility:`);
        console.log(`  - scheduled: ${job.scheduled}`);
        console.log(`  - scheduleId: ${job.scheduleId}`);
        console.log(`  - attempt: ${attempt}/${maxAttempts}`);
        console.log(`  - retryCount from schedule: ${maxAttempts - 1}`);
        
        // If we have retries remaining, mark as "retrying" instead of "failed"
        if (attempt < maxAttempts) {
          job.status = 'retrying';
          job.retryScheduled = true;
          // Set retry timestamp for countdown
          const retryDelayMinutes = job.retryDelayMinutes || 5;
          job.retryAt = new Date(Date.now() + (retryDelayMinutes * 60 * 1000)).toISOString();
          console.log(`[Backups] ✓ Job ${job.id} marked as 'retrying' (attempt ${attempt}/${maxAttempts})`);
          console.log(`[Backups] ✓ Retry scheduled at ${job.retryAt} (in ${retryDelayMinutes} minutes)`);
          console.log(`[Backups] ✓ Job will NOT have endTime set (stays in active)`);
        } else {
          // All retries exhausted, mark as failed
          job.status = 'failed';
          job.retriesExhausted = true;
          job.retryAt = null; // Clear retry timestamp
          console.log(`[Backups] ✗ Job ${job.id} marked as 'failed' - all ${maxAttempts} attempts exhausted`);
        }
      } else {
        job.status = status;
        if (status === 'failed') {
          console.log(`[Backups] Job ${job.id} marked as failed (no retry - scheduled:${job.scheduled}, scheduleId:${job.scheduleId})`);
        }
      }
      
      // Treat cancelled as failed
      if (status === 'cancelled') {
        job.status = 'failed';
        if (!error) {
          job.error = 'Cancelled by user';
        }
        if (exitCode === undefined || exitCode === null) {
          job.exitCode = 1;
        }
      }
    }
    
    if (exitCode !== undefined) job.exitCode = exitCode;
    if (error) job.error = error;
    if (failureReason) job.failureReason = failureReason;
    if (progress !== undefined) job.progress = progress;
    if (progressText !== undefined) job.progressText = progressText;
    
    // Set end time for terminal states
    if (status === 'completed' || status === 'cancelled' || 
        (status === 'failed' && job.status === 'failed')) { // Only set endTime if actually failed (not retrying)
      job.endTime = new Date().toISOString();
      if (status === 'completed') {
        job.progress = 100;
        // Mark if this was a successful retry
        if (job.attemptNumber && job.attemptNumber > 1) {
          job.wasRetried = true;
          job.succeededOnAttempt = job.attemptNumber;
          console.log(`[Backups] Job ${job.id} completed successfully on retry attempt ${job.attemptNumber}`);
        }
      }
    }

    await saveBackupJobs(jobs);

    if (logLine) {
      await appendLog(req.params.id, logLine);
    }

    const io = req.app.get('io');
    io.to(`job-${req.params.id}`).emit('backup-progress', {
      jobId: req.params.id,
      status: job.status,
      message: logLine,
      progress: job.progress,
      progressText: job.progressText,
    });

    if (status === 'completed') {
      io.emit('backup-complete', job);
      
      // Notify RocketChat
      const duration = job.endTime && job.startTime 
        ? `${Math.round((new Date(job.endTime) - new Date(job.startTime)) / 1000 / 60)}m`
        : 'unknown';
      
      // Include retry information in notification
      const retryInfo = job.wasRetried ? ` (succeeded on attempt ${job.succeededOnAttempt})` : '';
      rocketChatService.notifyBackupCompleted(job.vmName, job.method || 'unknown', duration + retryInfo);
    } else if (job.status === 'failed' || status === 'cancelled') {
      // Only emit backup-error if truly failed (not retrying)
      io.emit('backup-error', job);
      
      // Notify RocketChat
      const retryInfo = job.retriesExhausted ? ' (all retries exhausted)' : '';
      rocketChatService.notifyBackupFailed(job.vmName, job.method || 'unknown', (job.error || 'Unknown error') + retryInfo);
    } else if (job.status === 'retrying') {
      // Emit a special event for retrying status
      io.emit('backup-retrying', job);
    }

    // Auto-retry scheduled backups that failed (not user-cancelled).
    // The scheduler decides whether attempts remain and schedules the
    // next one after the configured delay. The schedule stays intact
    // regardless of the outcome.
    if (status === 'failed' && job.scheduled && job.scheduleId && job.status === 'retrying') {
      schedulerService.handleScheduledBackupFailure(job).catch(err => {
        console.error('[Backups] Failed to schedule auto-retry:', err.message);
      });
    }

    // A slot just freed up on this host — release any backups that were
    // skipped earlier because the concurrent_limit was hit. Without this
    // step, jobs skipped during a burst would never re-queue: the
    // existing retry logic only fires when an agent transitions
    // offline → online, not when a regular slot frees up.
    if (status === 'completed' || job.status === 'failed' || status === 'cancelled') {
      schedulerService.releaseConcurrentSlotsOnHost(job.backupHostId).catch(err => {
        console.error('[Backups] Failed to release concurrent slots:', err.message);
      });
    }

    res.json({ success: true, data: job });
  } catch (error) {
    next(error);
  }
});

// GET /api/backups/stats - Get backup statistics
router.get('/stats', async (req, res, next) => {
  try {
    const jobs = await getBackupJobs();
    
    const stats = {
      total: jobs.length,
      completed: jobs.filter(j => j.status === 'completed').length,
      failed: jobs.filter(j => j.status === 'failed').length,
      running: jobs.filter(j => j.status === 'running').length,
      queued: jobs.filter(j => j.status === 'queued').length,
    };

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentJobs = jobs.filter(j => new Date(j.startTime) > oneDayAgo);
    
    stats.last24h = {
      total: recentJobs.length,
      completed: recentJobs.filter(j => j.status === 'completed').length,
      failed: recentJobs.filter(j => j.status === 'failed').length,
    };

    res.json({ success: true, data: stats });
  } catch (error) {
    next(error);
  }
});

// POST /api/backups/kill/:jobId - Kill/cancel a backup job
router.post('/kill/:jobId', requireUser, async (req, res, next) => {
  try {
    const jobs = await getBackupJobs();
    const job = jobs.find(j => j.id === req.params.jobId);
    
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    // If job is in 'retrying' status, it's not running on the agent yet
    // Just cancel it locally without calling the agent
    if (job.status === 'retrying') {
      // Cancel the scheduled retry timer
      schedulerService.cancelRetry(req.params.jobId);
      
      job.status = 'failed';
      job.endTime = new Date().toISOString();
      job.error = 'Cancelled by user during retry wait';
      job.retryAt = null; // Clear retry timestamp
      await saveBackupJobs(jobs);
      await appendLog(req.params.jobId, 'Retry cancelled by user');
      
      const io = req.app.get('io');
      if (io) {
        io.emit('backup-cancelled', job);
      }
      
      // Audit log
      try {
        const username = req.user?.username || 'unknown';
        auditService.logCancelBackup(username, req.params.jobId, job.vmName);
      } catch (auditError) {
        console.error('[Kill] Audit log failed:', auditError.message);
      }
      
      return res.json({ success: true, message: 'Retry cancelled successfully' });
    }

    // Get backup host
    const hosts = await getBackupHosts();
    const host = hosts.find(h => h.id === job.backupHostId);
    
    if (!host) {
      return res.status(404).json({ success: false, error: 'Backup host not found' });
    }

    // Forward kill request to agent for running/queued jobs
    try {
      const client = agentService.createAgentClient(host.url, host.id, host.name);
      await client.post(`/api/backup/kill/${req.params.jobId}`);
      
      // Update job status
      job.status = 'cancelled';
      job.endTime = new Date().toISOString();
      job.error = 'Cancelled by user';
      await saveBackupJobs(jobs);
      await appendLog(req.params.jobId, 'Backup cancelled by user');
      
      const io = req.app.get('io');
      if (io) {
        io.emit('backup-cancelled', job);
      }
      
      // Audit log
      try {
        const username = req.user?.username || 'unknown';
        auditService.logCancelBackup(username, req.params.jobId, job.vmName);
      } catch (auditError) {
        console.error('[Kill] Audit log failed:', auditError.message);
      }
      
      res.json({ success: true, message: 'Backup job cancelled' });
    } catch (error) {
      console.error('[Kill] Failed to cancel job on agent:', error.message);
      res.status(500).json({ 
        success: false, 
        error: `Failed to cancel job: ${error.message}` 
      });
    }
  } catch (error) {
    console.error('[Kill] Unexpected error:', error);
    next(error);
  }
});

// GET /api/backups/:vmName/directories - Get backup directories
router.get('/:vmName/directories', async (req, res, next) => {
  try {
    const { vmName } = req.params;
    const { backupHostId } = req.query;

    if (!backupHostId) {
      return res.status(400).json({ success: false, error: 'backupHostId is required' });
    }

    const hosts = await getBackupHosts();
    const host = hosts.find(h => h.id === backupHostId);
    
    if (!host) {
      return res.status(404).json({ success: false, error: 'Backup host not found' });
    }

    const directories = await agentService.getBackupDirectories(host.url, vmName);
    res.json({ success: true, data: directories });
  } catch (error) {
    next(error);
  }
});

// POST /api/backups/:vmName/archive - Archive current backup
router.post('/:vmName/archive', async (req, res, next) => {
  try {
    const { vmName } = req.params;
    const { backupHostId } = req.body;

    if (!backupHostId) {
      return res.status(400).json({ success: false, error: 'backupHostId is required' });
    }

    const hosts = await getBackupHosts();
    const host = hosts.find(h => h.id === backupHostId);
    
    if (!host) {
      return res.status(404).json({ success: false, error: 'Backup host not found' });
    }

    const result = await agentService.archiveBackup(host.url, vmName);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/backups/:vmName/:type - Delete backup directory
router.delete('/:vmName/:type', async (req, res, next) => {
  try {
    const { vmName, type } = req.params;
    const { backupHostId } = req.query;

    if (!['current', 'archived', 'monthly'].includes(type)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid type. Must be: current, archived, or monthly' 
      });
    }

    if (!backupHostId) {
      return res.status(400).json({ success: false, error: 'backupHostId is required' });
    }

    const hosts = await getBackupHosts();
    const host = hosts.find(h => h.id === backupHostId);
    
    if (!host) {
      return res.status(404).json({ success: false, error: 'Backup host not found' });
    }

    const result = await agentService.deleteBackupDirectory(host.url, vmName, type);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// POST /api/backups/jobs/:jobId/retry - Retry a skipped or failed backup
router.post('/jobs/:jobId/retry', async (req, res, next) => {
  try {
    const jobs = await getBackupJobs();
    const originalJob = jobs.find(j => j.id === req.params.jobId);
    
    if (!originalJob) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    // Only allow retry for skipped or failed jobs
    if (originalJob.status !== 'skipped' && originalJob.status !== 'failed') {
      return res.status(400).json({ 
        success: false, 
        error: 'Only skipped or failed jobs can be retried' 
      });
    }

    // Get backup host
    const hosts = await getBackupHosts();
    const host = hosts.find(h => h.id === originalJob.backupHostId);
    
    if (!host) {
      return res.status(404).json({ success: false, error: 'Backup host not found' });
    }

    // Check host status
    if (host.status !== 'online') {
      return res.status(400).json({ 
        success: false, 
        error: 'Backup host is still offline. Cannot retry backup.' 
      });
    }

    // Don't push the host past its concurrent limit on a retry — the user
    // would just get a fresh "skipped" job and a confusing UI loop. The
    // releaseConcurrentSlotsOnHost flow will pick this VM up automatically
    // as soon as a slot frees up.
    const runningOnHost = jobs.filter(j =>
      j.backupHostId === host.id && (j.status === 'running' || j.status === 'queued')
    );
    const maxConcurrent = host.maxConcurrentBackups || 20;
    if (runningOnHost.length >= maxConcurrent) {
      return res.status(429).json({
        success: false,
        error: `Backup host is at concurrent limit (${runningOnHost.length}/${maxConcurrent}). The retry will run automatically when a slot frees up.`,
        currentRunning: runningOnHost.length,
        maxAllowed: maxConcurrent,
      });
    }

    // Get VM and hypervisor info
    const vms = await getVirtualMachines();
    const vm = vms.find(v => v.id === originalJob.vmId);
    if (!vm) {
      return res.status(404).json({ success: false, error: 'VM not found' });
    }

    const hypervisors = await getHypervisors();
    const hypervisor = hypervisors.find(h => h.id === vm.hypervisorId);
    if (!hypervisor) {
      return res.status(404).json({ success: false, error: 'Hypervisor not found' });
    }

    // Look up the schedule (if any) so we can rebuild the same payload
    // executeScheduledBackup uses. The agent rejects without storagePoolPath.
    let schedule = null;
    if (originalJob.scheduleId) {
      const schedules = await getBackupSchedules();
      schedule = schedules.find(s => s.id === originalJob.scheduleId) || null;
    }

    // Resolve storage pool. Prefer the schedule's pool, then the original
    // job's pool id (manual triggers store storagePoolId on the job
    // record), otherwise refuse — without it the agent returns 400.
    const { getStoragePools, getOffsiteHosts } = require('../services/fileStorage');
    const pools = await getStoragePools();
    const poolId = schedule?.storagePoolId || originalJob.storagePoolId;
    const pool = poolId
      ? pools.find(p => p.id === poolId && p.backupHostId === host.id)
      : null;
    if (!pool) {
      return res.status(400).json({
        success: false,
        error: poolId
          ? `Storage pool ${poolId} not found on this backup host`
          : 'Original job has no storage pool on record; cannot retry. Edit the schedule and trigger a fresh backup instead.',
      });
    }

    // Resolve offsite hosts (optional)
    const offsiteIds = Array.isArray(schedule?.offsiteHostIds)
      ? schedule.offsiteHostIds
      : (schedule?.offsiteHostId ? [schedule.offsiteHostId]
        : (Array.isArray(originalJob.offsiteHosts) ? [] : [])); // originalJob.offsiteHosts already holds IPs
    let offsiteHostIps = [];
    if (offsiteIds.length > 0) {
      const allOffsiteHosts = await getOffsiteHosts();
      offsiteHostIps = offsiteIds
        .map(id => allOffsiteHosts.find(h => h.id === id))
        .filter(Boolean)
        .map(h => h.ip);
    } else if (Array.isArray(originalJob.offsiteHosts)) {
      // Manual jobs persist resolved IPs directly
      offsiteHostIps = originalJob.offsiteHosts;
    }

    // Translate the controller's scheduleType to one the bash script
    // accepts (once / monthly / daily / weekly / custom). interval and
    // cron behave like daily chains for the script.
    const sourceScheduleType = schedule?.scheduleType || originalJob.scheduleType || 'once';
    const agentScheduleType = (() => {
      switch (sourceScheduleType) {
        case 'once':
        case 'monthly':
        case 'daily':
        case 'weekly': return sourceScheduleType;
        case 'interval':
        case 'cron': return 'daily';
        case 'custom-days': return 'custom';
        default: return 'once';
      }
    })();

    // Create new job for retry
    const newJobId = uuidv4();
    const retryJob = {
      id: newJobId,
      scheduleId: originalJob.scheduleId,
      vmId: originalJob.vmId,
      vmName: originalJob.vmName,
      hypervisorIp: hypervisor.ip,
      backupHostId: originalJob.backupHostId,
      backupHostName: originalJob.backupHostName,
      method: originalJob.method,
      scheduleType: sourceScheduleType,
      storagePoolId: pool.id,
      storagePoolName: pool.name,
      retention: schedule?.retention ?? originalJob.retention ?? 7,
      keepArchive: schedule?.keepArchive ?? originalJob.keepArchive ?? 2,
      compression: schedule?.compression ?? originalJob.compression ?? 2,
      noCompression: originalJob.noCompression || false,
      noVerify: originalJob.noVerify || false,
      offsiteHosts: offsiteHostIps,
      status: 'queued',
      startTime: new Date().toISOString(),
      endTime: null,
      exitCode: null,
      error: null,
      scheduled: originalJob.scheduled || false,
      retryOf: originalJob.id,
      progress: 0,
      progressText: 'Queued (retry)...',
    };

    jobs.push(retryJob);
    await saveBackupJobs(jobs);

    await appendLog(newJobId, `Retry of job ${originalJob.id} (${originalJob.status})`);
    await appendLog(newJobId, `Original job: ${originalJob.vmName} - ${originalJob.error || 'No error message'}`);
    await appendLog(newJobId, `Storage pool: ${pool.name} (${pool.path})`);

    // Get io from app
    const io = req.app.get('io');
    io.emit('backup-started', retryJob);

    // Trigger backup on agent with the full payload
    try {
      let url = host.url;
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'http://' + url;
      }

      await agentService.triggerBackup(url, {
        jobId: newJobId,
        vmName: originalJob.vmName,
        hypervisorId: hypervisor.id,
        hypervisorIp: hypervisor.ip,
        scheduleType: agentScheduleType,
        method: originalJob.method,
        storagePoolId: pool.id,
        storagePoolPath: pool.path,
        retention: retryJob.retention,
        keepArchive: retryJob.keepArchive,
        compression: retryJob.compression,
        noCompression: retryJob.noCompression,
        noVerify: retryJob.noVerify,
        offsiteHosts: offsiteHostIps,
        verbose: schedule?.verbose || false,
        ...(sourceScheduleType === 'daily' || sourceScheduleType === 'interval' || sourceScheduleType === 'cron'
          ? { vmId: originalJob.vmId, incrementalCount: schedule?.incrementalCount }
          : {}),
      });

      // Update job status
      retryJob.status = 'running';
      await saveBackupJobs(jobs);

    } catch (error) {
      const detail = error.response?.data?.error || error.message;
      retryJob.status = 'failed';
      retryJob.error = `Retry trigger failed: ${detail}`;
      retryJob.endTime = new Date().toISOString();
      await saveBackupJobs(jobs);
      await appendLog(newJobId, `Error triggering retry: ${detail}`);
      io.emit('backup-error', retryJob);
    }

    res.status(202).json({ 
      success: true, 
      data: retryJob,
      message: 'Backup retry initiated'
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/backups/jobs/:jobId/force - Force remove a job from history
router.delete('/jobs/:jobId/force', requireAdmin, async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const jobs = await getBackupJobs();
    const jobIndex = jobs.findIndex(j => j.id === jobId);

    // First try backup jobs
    if (jobIndex !== -1) {
      const job = jobs[jobIndex];

      // Try to kill the job on the agent if it's running
      if (job.status === 'running' || job.status === 'queued') {
        const hosts = await getBackupHosts();
        const host = hosts.find(h => h.id === job.backupHostId);

        if (host) {
          try {
            const client = agentService.createAgentClient(host.url, host.id, host.name);
            await client.post(`/api/backup/kill/${jobId}`, {}, { timeout: 5000 });
            console.log(`Killed backup job ${jobId} on agent`);
          } catch (error) {
            console.log(`Could not kill backup job on agent: ${error.message}`);
            // Continue with removal even if kill fails
          }
        }
      }

      jobs.splice(jobIndex, 1);
      await saveBackupJobs(jobs);

      await appendLog(jobId, 'Job force removed from history');

      const io = req.app.get('io');
      io.emit('job-removed', { jobId });

      return res.json({
        success: true,
        message: 'Backup job removed from history',
        data: { id: jobId, jobType: 'backup' }
      });
    }

    // Not a backup job — check restore jobs (the unified /jobs endpoint
    // exposes both, so the same force-remove route must handle both).
    const restoreJobs = await getRestoreJobs();
    const restoreIndex = restoreJobs.findIndex(j => j.id === jobId);

    if (restoreIndex !== -1) {
      const restoreJob = restoreJobs[restoreIndex];

      // Try to kill on the agent if still active
      if (restoreJob.status === 'running' || restoreJob.status === 'queued') {
        const hosts = await getBackupHosts();
        const host = hosts.find(h => h.id === restoreJob.backupHostId);

        if (host) {
          try {
            const client = agentService.createAgentClient(host.url, host.id, host.name);
            await client.post(`/api/restore/kill/${jobId}`, {}, { timeout: 5000 });
            console.log(`Killed restore job ${jobId} on agent`);
          } catch (error) {
            console.log(`Could not kill restore job on agent: ${error.message}`);
            // Continue with removal even if kill fails
          }
        }
      }

      restoreJobs.splice(restoreIndex, 1);
      await saveRestoreJobs(restoreJobs);

      const io = req.app.get('io');
      io.emit('job-removed', { jobId });

      return res.json({
        success: true,
        message: 'Restore job removed from history',
        data: { id: jobId, jobType: 'restore' }
      });
    }

    // Neither store has it — treat as already deleted (idempotent)
    console.log(`Job ${jobId} not found in backup or restore stores - considering it already deleted`);
    const io = req.app.get('io');
    io.emit('job-removed', { jobId });

    return res.json({
      success: true,
      message: 'Job not found in database (already deleted or never existed)',
      data: { id: jobId, alreadyDeleted: true }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
