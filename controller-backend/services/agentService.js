const axios = require('axios');
const config = require('../config/config');
const { generateAgentToken } = require('./agentAuthService');

class AgentService {
  ensureProtocol(url) {
    if (!url) return url;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return 'http://' + url;
    }
    return url;
  }

  createAgentClient(agentUrl, agentId = 'controller', agentName = 'Controller') {
    const url = this.ensureProtocol(agentUrl);
    const token = generateAgentToken(agentId, agentName);
    
    return axios.create({
      baseURL: url,
      timeout: config.agentRequestTimeout,
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
    });
  }

  async healthCheck(agentUrl) {
    try {
      const client = this.createAgentClient(agentUrl);
      const response = await client.get('/api/health');
      return { success: true, data: response.data };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async addHypervisor(agentUrl, hypervisorData) {
    const client = this.createAgentClient(agentUrl);
    const response = await client.post('/api/hypervisors', hypervisorData);
    return response.data;
  }

  async testHypervisor(agentUrl, hypervisorId) {
    try {
      const client = this.createAgentClient(agentUrl);
      const response = await client.post(`/api/hypervisors/${hypervisorId}/test`);
      return response.data.data;
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  async listVMs(agentUrl, hypervisorId) {
    const client = this.createAgentClient(agentUrl);
    const response = await client.get(`/api/hypervisors/${hypervisorId}/vms`);
    return response.data;
  }

  async triggerBackup(agentUrl, backupData) {
    const client = this.createAgentClient(agentUrl);
    const response = await client.post('/api/backup/trigger', backupData);
    return response.data;
  }

  async triggerScheduledBackup(agentUrl, backupData) {
    // The agent only exposes /api/backup/trigger. This helper used to call
    // /api/backup/trigger-scheduled which never existed — every scheduled
    // backup, retry-from-skipped, and manual retry through this path 404'd.
    // Now it routes to the same /trigger endpoint as triggerBackup; the
    // payload differs only by carrying vmId + incrementalCount which the
    // agent-side cycle bookkeeping can use safely.
    const client = this.createAgentClient(agentUrl);
    const response = await client.post('/api/backup/trigger', backupData);
    return response.data;
  }

  async getBackupDirectories(agentUrl, vmName) {
    const client = this.createAgentClient(agentUrl);
    const response = await client.get(`/api/directories/${vmName}`);
    return response.data.data;
  }

  async archiveBackup(agentUrl, vmName) {
    const client = this.createAgentClient(agentUrl);
    const response = await client.post(`/api/directories/${vmName}/archive`);
    return response.data.data;
  }

  async deleteBackupDirectory(agentUrl, vmName, type) {
    const client = this.createAgentClient(agentUrl);
    const response = await client.delete(`/api/directories/${vmName}/${type}`);
    return response.data.data;
  }

  async initHost(agentUrl) {
    const client = this.createAgentClient(agentUrl);
    const response = await client.post('/api/init/host');
    return response.data;
  }

  async getInitLogs(agentUrl, initId) {
    const client = this.createAgentClient(agentUrl);
    const response = await client.get(`/api/init/${initId}/logs`);
    return response.data;
  }

  async getBackupReport(agentUrl) {
    const client = this.createAgentClient(agentUrl);
    const response = await client.get('/api/report');
    return response.data;
  }

  async getBackupReportStatus(agentUrl) {
    const client = this.createAgentClient(agentUrl);
    const response = await client.get('/api/report/status');
    return response.data;
  }

  async generateBackupReport(agentUrl) {
    const client = this.createAgentClient(agentUrl);
    const response = await client.post('/api/report/generate');
    return response.data;
  }

  /**
   * Trigger report generation bypassing the manual rate-limit. Used by
   * the controller's download flow so the user can grab a fresh report
   * on demand without hitting the 2-minute cooldown.
   */
  async generateBackupReportNow(agentUrl) {
    const client = this.createAgentClient(agentUrl);
    // Long timeout — full report generation can take several minutes.
    const response = await client.post('/api/report/generate-now', {}, { timeout: 10 * 60 * 1000 });
    return response.data;
  }

  async getMetrics(agentUrl) {
    try {
      const client = this.createAgentClient(agentUrl);
      const response = await client.get('/api/metrics');
      return response.data;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async getRemoteHypervisorMetrics(agentUrl, hypervisorData) {
    try {
      const client = this.createAgentClient(agentUrl);
      const response = await client.post('/api/remote-metrics/hypervisor', {
        ip: hypervisorData.ip,
        username: hypervisorData.username || 'root',
        port: hypervisorData.port || 22
      });
      return response.data;
    } catch (error) {
      return { success: false, error: error.message, data: { disks: [], status: 'offline' } };
    }
  }

  async getRemoteOffsiteMetrics(agentUrl, offsiteData) {
    try {
      const client = this.createAgentClient(agentUrl);
      const response = await client.post('/api/remote-metrics/offsite', {
        ip: offsiteData.ip,
        username: offsiteData.username || 'root',
        port: offsiteData.port || 22,
        storagePools: offsiteData.storagePools || []
      });
      return response.data;
    } catch (error) {
      return { success: false, error: error.message, data: { disks: [], status: 'offline' } };
    }
  }

  async validateStoragePool(agentUrl, path) {
    try {
      const client = this.createAgentClient(agentUrl);
      const response = await client.post('/api/storage-pools/validate', { path });
      return response.data;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async validateOffsiteStoragePool(agentUrl, path, offsiteIp, username = 'root') {
    try {
      const client = this.createAgentClient(agentUrl);
      const response = await client.post('/api/storage-pools/validate-offsite', { 
        path, 
        offsiteIp,
        username 
      });
      return response.data;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async validateRestoreStoragePool(agentUrl, path) {
    try {
      const client = this.createAgentClient(agentUrl);
      const response = await client.post('/api/restore-storage-pools/validate', { path });
      return response.data;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  // Offsite operations
  // NOTE: Offsite backup is handled by backup_manager.sh script
  // This only tests basic connectivity (ping)
  async testOffsiteConnection(agentUrl, offsiteData) {
    try {
      const client = this.createAgentClient(agentUrl);
      const response = await client.post('/api/offsite/test', { ip: offsiteData.ip });
      return response.data.data;
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  /**
   * Notify agent to sync storage pools
   */
  async notifyStoragePoolSync(agentUrl) {
    try {
      console.log(`[AgentService] Sending sync notification to agent: ${agentUrl}`);
      const client = this.createAgentClient(agentUrl);
      const response = await client.post('/api/storage-pool-sync/sync');
      console.log(`[AgentService] ✓ Agent responded:`, response.data);
      return { success: true, data: response.data };
    } catch (error) {
      console.error(`[AgentService] ✗ Failed to notify agent at ${agentUrl}:`, error.message);
      if (error.response) {
        console.error(`[AgentService] Response status: ${error.response.status}`);
        console.error(`[AgentService] Response data:`, error.response.data);
      }
      return { success: false, error: error.message };
    }
  }

  /**
   * Check if creating a schedule would conflict with existing backup directories
   */
  async checkScheduleConflict(agentUrl, vmName, scheduleType, storagePoolPath) {
    try {
      console.log(`[AgentService] Checking schedule conflict for ${vmName} (${scheduleType})`);
      const client = this.createAgentClient(agentUrl);
      const response = await client.post('/api/schedule-validation/check-conflict', {
        vmName,
        scheduleType,
        storagePoolPath
      });
      
      console.log(`[AgentService] Conflict check result:`, response.data);
      return response.data;
    } catch (error) {
      console.error(`[AgentService] Error checking schedule conflict:`, error.message);
      throw error;
    }
  }

  /**
   * Item 2: Get authoritative live status for one job from the agent.
   */
  async getJobLiveStatus(agentUrl, jobId) {
    try {
      const client = this.createAgentClient(agentUrl);
      const response = await client.get(`/api/jobs/${jobId}/live-status`);
      return response.data;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Item 2: Batched live-status lookup. Used after agent reconnect to
   * reconcile every job in a single round-trip.
   */
  async getJobsLiveStatusBatch(agentUrl, jobIds) {
    try {
      if (!jobIds || jobIds.length === 0) return { success: true, data: [] };
      const client = this.createAgentClient(agentUrl);
      const response = await client.get('/api/jobs/live-status/batch', {
        params: { ids: jobIds.join(',') },
      });
      return response.data;
    } catch (error) {
      return { success: false, error: error.message, data: [] };
    }
  }
}

const agentService = new AgentService();
module.exports = agentService;
