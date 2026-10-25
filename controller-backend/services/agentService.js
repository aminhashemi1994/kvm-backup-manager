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

  createAgentClient(agentUrl, agentId = 'controller', agentName = 'Controller', timeoutMs = config.agentRequestTimeout) {
    const url = this.ensureProtocol(agentUrl);
    const token = generateAgentToken(agentId, agentName);

    return axios.create({
      baseURL: url,
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
    });
  }

  async healthCheck(agentUrl, timeoutMs) {
    try {
      const client = this.createAgentClient(agentUrl, 'controller', 'Controller', timeoutMs);
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

  // `timeoutMs` lets callers that probe many hypervisors in the background
  // (e.g. the backup-host card's live status sweep) cap how long a single
  // unreachable one can hold things up, instead of inheriting the multi-
  // minute default meant for real backup/restore calls.
  async testHypervisor(agentUrl, hypervisorId, timeoutMs) {
    try {
      const client = this.createAgentClient(agentUrl, 'controller', 'Controller', timeoutMs);
      const response = await client.post(`/api/hypervisors/${hypervisorId}/test`);
      return response.data.data;
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  // Callers branch on `success`, so an agent-side failure has to come back as a
  // value rather than a thrown axios error - otherwise it escapes to the global
  // error handler and the agent's real message (SSH refused, virsh failed, disk
  // full on the hypervisor) is lost behind a generic 500.
  async listVMs(agentUrl, hypervisorId) {
    try {
      const client = this.createAgentClient(agentUrl);
      const response = await client.get(`/api/hypervisors/${hypervisorId}/vms`);
      return response.data;
    } catch (error) {
      const agentError = error.response?.data?.error;
      const message = typeof agentError === 'string'
        ? agentError
        : agentError?.message || error.message;
      return { success: false, error: message };
    }
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

  /**
   * Start an offsite sync on the agent.
   *
   * A 404 here is meaningful rather than incidental: it means the agent predates
   * the split and has no offsite endpoint, so it is not going to replicate
   * anything no matter what the controller does. Callers surface that as an
   * upgrade prompt instead of a generic failure.
   */
  async triggerOffsiteSync(agentUrl, syncData) {
    const client = this.createAgentClient(agentUrl);
    const response = await client.post('/api/offsite/sync', syncData);
    return response.data;
  }

  async cancelOffsiteSync(agentUrl, jobId) {
    const client = this.createAgentClient(agentUrl);
    const response = await client.post(`/api/offsite/sync/${jobId}/cancel`, {});
    return response.data;
  }

  /**
   * Ask the agent whether a VM's offsite copies match its backup directory.
   * Reads only; the agent takes no lock and transfers nothing.
   */
  async checkOffsiteReplication(agentUrl, checkData, timeoutMs = 330000) {
    const client = this.createAgentClient(agentUrl);
    const response = await client.post('/api/offsite/check', checkData, { timeout: timeoutMs });
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
    // The agent replies only once generation finishes. A host with many VMs
    // or large chains can take longer than the 5-minute default, which surfaced
    // as a bare "status code 500" for that one host.
    const response = await client.post('/api/report/generate', {}, { timeout: 30 * 60 * 1000 });
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
  async testOffsiteConnection(agentUrl, offsiteData, timeoutMs) {
    try {
      const client = this.createAgentClient(agentUrl, 'controller', 'Controller', timeoutMs);
      const response = await client.post('/api/offsite/test', { ip: offsiteData.ip });
      return response.data.data;
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  /**
   * Notify agent to sync storage pools
   */
  async notifyStoragePoolSync(agentUrl, backupHostId = null) {
    try {
      console.log(`[AgentService] Sending sync notification to agent: ${agentUrl}`);
      const client = this.createAgentClient(agentUrl);
      // Tell the agent which backup host it is. Its own record of that is
      // discovered once and cached, so after the backup host was re-added
      // (new id) it kept asking for the old id's pools and got none.
      const response = await client.post('/api/storage-pool-sync/sync', backupHostId ? { backupHostId } : {});
      console.log(`[AgentService] ✓ Agent responded:`, response.data);
      return { success: true, data: response.data };
    } catch (error) {
      console.error(`[AgentService] ✗ Failed to notify agent at ${agentUrl}:`, error.message);
      if (error.response) {
        console.error(`[AgentService] Response status: ${error.response.status}`);
        console.error(`[AgentService] Response data:`, error.response.data);
        // The agent answered: surface its reason, not axios's status line.
        const d = error.response.data || {};
        return {
          success: false,
          reachable: true,
          status: error.response.status,
          error: (typeof d.error === 'string' && d.error) || d.message || error.message,
        };
      }
      return { success: false, reachable: false, error: error.message };
    }
  }

  /**
   * Check if creating a schedule would conflict with existing backup directories
   */
  async checkScheduleConflict(agentUrl, vmName, scheduleType, storagePoolPath) {
    try {
      console.log(`[AgentService] Checking schedule conflict for ${vmName} (${scheduleType})`);
      const client = this.createAgentClient(agentUrl);
      // Bound this call hard. It is a best-effort UX guard (the caller catches
      // failures and proceeds), so it must never dominate schedule creation —
      // the default agent client timeout is minutes. A short cap keeps "add
      // schedule" snappy even when the agent is briefly slow/unreachable.
      const response = await client.post('/api/schedule-validation/check-conflict', {
        vmName,
        scheduleType,
        storagePoolPath
      }, { timeout: 4000 });
      
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
  /**
   * What this agent is replicating right now.
   *
   * Used to reconcile replication jobs the controller believes are running.
   * A failure is reported rather than thrown: "we could not ask" must never be
   * mistaken for "the agent is not running it", or a brief network blip would
   * finalize live transfers as failed.
   */
  async getActiveOffsiteSyncs(agentUrl) {
    try {
      const client = this.createAgentClient(agentUrl);
      const response = await client.get('/api/offsite/sync', { timeout: 10000 });
      const data = (response.data && response.data.data) || [];
      return { success: true, data: Array.isArray(data) ? data : (data.jobs || []) };
    } catch (error) {
      return { success: false, error: error.message, data: [] };
    }
  }

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

  /**
   * Check if a backup is currently in progress for a VM and schedule type
   * Returns: { success, inProgress, status, details, checks }
   */
  async checkBackupStatus(agentUrl, vmName, scheduleType, storagePoolPath) {
    try {
      const client = this.createAgentClient(agentUrl);
      const response = await client.get('/api/backup-status', {
        params: {
          vmName,
          scheduleType,
          storagePoolPath
        }
      });
      return response.data;
    } catch (error) {
      console.error(`[AgentService] Error checking backup status:`, error.message);
      return { 
        success: false, 
        error: error.message,
        inProgress: false  // Assume not in progress if check fails
      };
    }
  }
}

const agentService = new AgentService();
module.exports = agentService;
