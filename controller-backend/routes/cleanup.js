const express = require('express');
const router = express.Router();
const agentService = require('../services/agentService');
const {
  getBackupHosts,
  getRestoreJobs,
  saveRestoreJobs,
} = require('../services/fileStorage');

/**
 * GET /api/cleanup/scan
 * Scan all agents for cleanable files
 */
router.get('/scan', async (req, res, next) => {
  try {
    const { olderThanHours = 6 } = req.query;
    
    console.log(`[Cleanup] Scanning all agents for files older than ${olderThanHours} hours`);
    
    // Get all backup hosts
    const backupHosts = await getBackupHosts();
    
    if (!Array.isArray(backupHosts)) {
      return res.status(500).json({
        success: false,
        error: 'Invalid backup hosts data'
      });
    }
    
    const results = {
      agents: [],
      totalFiles: 0,
      totalSize: 0,
      errors: []
    };
    
    // Scan each agent
    for (const host of backupHosts) {
      try {
        console.log(`[Cleanup] Scanning agent: ${host.name} (${host.url})`);
        
        const client = agentService.createAgentClient(host.url, host.id, host.name);
        const response = await client.get('/api/cleanup/scan', {
          params: { olderThanHours },
          timeout: 30000
        });
        
        if (response.data.success) {
          const agentData = {
            agentId: host.id,
            agentName: host.name,
            agentUrl: host.url,
            ...response.data.data
          };
          
          results.agents.push(agentData);
          results.totalFiles += agentData.totalCount;
          results.totalSize += agentData.totalSize;
          
          console.log(`[Cleanup] Agent ${host.name}: ${agentData.totalCount} files (${formatBytes(agentData.totalSize)})`);
        }
      } catch (error) {
        console.error(`[Cleanup] Failed to scan agent ${host.name}:`, error.message);
        results.errors.push({
          agentId: host.id,
          agentName: host.name,
          error: error.message
        });
      }
    }
    
    // Also scan controller's own restore jobs
    try {
      const jobs = { jobs: await getRestoreJobs() };
      
      const cutoffDate = new Date();
      cutoffDate.setHours(cutoffDate.getHours() - parseInt(olderThanHours));
      
      const oldJobs = jobs.jobs.filter(job => {
        if (job.status === 'running' || job.status === 'queued') {
          return false; // Don't clean active jobs
        }
        const jobDate = new Date(job.startTime);
        return jobDate < cutoffDate;
      });
      
      results.controllerJobs = {
        count: oldJobs.length,
        jobs: oldJobs.map(j => ({
          id: j.id,
          vmName: j.vmName,
          status: j.status,
          startTime: j.startTime
        }))
      };
      
      console.log(`[Cleanup] Controller: ${oldJobs.length} old restore jobs`);
    } catch (error) {
      console.error('[Cleanup] Failed to scan controller jobs:', error.message);
      results.controllerJobs = { count: 0, jobs: [] };
    }
    
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
 * Execute cleanup on specified agent
 */
router.post('/execute', async (req, res, next) => {
  try {
    const { agentId, files } = req.body;
    
    if (!agentId || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Missing agentId or files'
      });
    }
    
    console.log(`[Cleanup] Executing cleanup on agent ${agentId} for ${files.length} files`);
    
    // Get agent details
    const backupHosts = await getBackupHosts();
    const agent = backupHosts.find(h => h.id === agentId);
    
    if (!agent) {
      return res.status(404).json({
        success: false,
        error: 'Agent not found'
      });
    }
    
    // Execute cleanup on agent
    const client = agentService.createAgentClient(agent.url, agent.id, agent.name);
    const response = await client.post('/api/cleanup/execute', { files }, { timeout: 60000 });
    
    console.log(`[Cleanup] Agent ${agent.name}: Deleted ${response.data.data.totalDeleted} files`);
    
    res.json({
      success: true,
      data: {
        agentId: agent.id,
        agentName: agent.name,
        ...response.data.data
      }
    });
  } catch (error) {
    console.error('[Cleanup] Execute error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/cleanup/controller-jobs
 * Clean up old restore jobs from controller
 */
router.post('/controller-jobs', async (req, res, next) => {
  try {
    const { olderThanHours = 24 } = req.body;
    
    console.log(`[Cleanup] Cleaning controller jobs older than ${olderThanHours} hours`);
    
    const jobs = { jobs: await getRestoreJobs() };
    
    const cutoffDate = new Date();
    cutoffDate.setHours(cutoffDate.getHours() - parseInt(olderThanHours));
    
    const originalCount = jobs.jobs.length;
    
    // Keep only active jobs or recent completed/failed jobs
    jobs.jobs = jobs.jobs.filter(job => {
      // Keep active jobs
      if (job.status === 'running' || job.status === 'queued') {
        return true;
      }
      
      // Keep recent jobs
      const jobDate = new Date(job.startTime);
      return jobDate > cutoffDate;
    });
    
    const deletedCount = originalCount - jobs.jobs.length;
    
    await saveRestoreJobs(jobs.jobs);
    
    console.log(`[Cleanup] Deleted ${deletedCount} old controller jobs`);
    
    res.json({
      success: true,
      data: {
        deletedCount,
        remainingCount: jobs.jobs.length
      }
    });
  } catch (error) {
    console.error('[Cleanup] Controller jobs cleanup error:', error);
    next(error);
  }
});

/**
 * GET /api/cleanup/stats
 * Get cleanup statistics from all agents
 */
router.get('/stats', async (req, res, next) => {
  try {
    console.log('[Cleanup] Getting stats from all agents');
    
    // Get all backup hosts
    const backupHosts = await getBackupHosts();
    
    const results = {
      agents: [],
      totalFiles: 0,
      totalSize: 0,
      errors: []
    };
    
    // Get stats from each agent
    for (const host of backupHosts) {
      try {
        const client = agentService.createAgentClient(host.url, host.id, host.name);
        const response = await client.get('/api/cleanup/stats', { timeout: 10000 });
        
        if (response.data.success) {
          results.agents.push({
            agentId: host.id,
            agentName: host.name,
            ...response.data.data
          });
          
          results.totalFiles += response.data.data.totalFiles;
          results.totalSize += response.data.data.totalSize;
        }
      } catch (error) {
        console.error(`[Cleanup] Failed to get stats from ${host.name}:`, error.message);
        results.errors.push({
          agentId: host.id,
          agentName: host.name,
          error: error.message
        });
      }
    }
    
    res.json({
      success: true,
      data: results
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
