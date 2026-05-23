const axios = require('axios');
const config = require('../config/config');

class RocketChatService {
  constructor() {
    this.enabled = config.rocketChat?.enabled || false;
    this.webhookUrl = config.rocketChat?.webhookUrl;
    this.url = config.rocketChat?.url;
    this.authToken = config.rocketChat?.authToken;
    this.userId = config.rocketChat?.userId;
    this.channel = config.rocketChat?.channel || 'backup-notifications';
    this.lastMessageId = null;
    this.lastRoomId = null;
    
    // Determine which method to use
    this.useWebhook = !!this.webhookUrl;
  }

  isConfigured() {
    if (this.useWebhook) {
      return this.enabled && this.webhookUrl;
    }
    return this.enabled && this.url && this.authToken && this.userId;
  }

  async sendMessage(text) {
    if (!this.isConfigured()) {
      console.log('[RocketChat] Not configured, skipping message');
      return { success: false, error: 'Not configured' };
    }

    // Use webhook if configured (simpler method)
    if (this.useWebhook) {
      return this.sendWebhookMessage(text);
    }

    // Use API method (allows message updates)
    try {
      const response = await axios.post(
        `${this.url}/api/v1/chat.postMessage`,
        {
          channel: this.channel,
          text,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Auth-Token': this.authToken,
            'X-User-Id': this.userId,
          },
          timeout: 10000,
        }
      );

      if (response.data.success) {
        this.lastMessageId = response.data.message._id;
        this.lastRoomId = response.data.message.rid;
        console.log(`[RocketChat] Message sent - msg_id=${this.lastMessageId}`);
        return { success: true, messageId: this.lastMessageId };
      }

      return { success: false, error: 'Failed to send message' };
    } catch (error) {
      console.error('[RocketChat] Error sending message:', error.message);
      return { success: false, error: error.message };
    }
  }

  async sendWebhookMessage(text) {
    try {
      const response = await axios.post(
        this.webhookUrl,
        {
          bot: true,
          text,
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
          timeout: 2000,
        }
      );

      console.log('[RocketChat] Webhook message sent');
      return { success: true };
    } catch (error) {
      console.error('[RocketChat] Error sending webhook message:', error.message);
      return { success: false, error: error.message };
    }
  }

  async updateMessage(text) {
    if (!this.isConfigured()) {
      console.log('[RocketChat] Not configured, skipping update');
      return { success: false, error: 'Not configured' };
    }

    // Webhooks don't support message updates, send new message instead
    if (this.useWebhook) {
      console.log('[RocketChat] Webhook mode does not support updates, sending new message');
      return await this.sendMessage(text);
    }

    if (!this.lastMessageId || !this.lastRoomId) {
      console.log('[RocketChat] No previous message to update');
      return await this.sendMessage(text);
    }

    try {
      const response = await axios.post(
        `${this.url}/api/v1/chat.update`,
        {
          roomId: this.lastRoomId,
          msgId: this.lastMessageId,
          text,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Auth-Token': this.authToken,
            'X-User-Id': this.userId,
          },
          timeout: 10000,
        }
      );

      if (response.data.success) {
        console.log(`[RocketChat] Message updated - msg_id=${this.lastMessageId}`);
        return { success: true, messageId: this.lastMessageId };
      }

      return { success: false, error: 'Failed to update message' };
    } catch (error) {
      console.error('[RocketChat] Error updating message:', error.message);
      return { success: false, error: error.message };
    }
  }

  // Notification templates
  notifyAgentConnected(agentName) {
    const text = `✅ *Agent Connected*\n*Agent:* ${agentName}\n*Status:* Online\n*Time:* ${new Date().toISOString()}`;
    return this.sendMessage(text);
  }

  notifyAgentDisconnected(agentName) {
    const text = `❌ *Agent Disconnected*\n*Agent:* ${agentName}\n*Status:* Offline\n*Time:* ${new Date().toISOString()}`;
    return this.sendMessage(text);
  }

  notifyBackupStarted(vmName, method, backupHost) {
    const text = `🚀 *Backup Started*\n*VM:* ${vmName}\n*Method:* ${method.toUpperCase()}\n*Host:* ${backupHost}\n*Time:* ${new Date().toISOString()}`;
    return this.sendMessage(text);
  }

  notifyBackupCompleted(vmName, method, duration) {
    const text = `✅ *Backup Completed*\n*VM:* ${vmName}\n*Method:* ${method.toUpperCase()}\n*Duration:* ${duration}\n*Time:* ${new Date().toISOString()}`;
    return this.sendMessage(text);
  }

  notifyBackupFailed(vmName, method, error) {
    const text = `❌ *Backup Failed*\n*VM:* ${vmName}\n*Method:* ${method.toUpperCase()}\n*Error:* ${error}\n*Time:* ${new Date().toISOString()}`;
    return this.sendMessage(text);
  }

  notifyOffsiteSyncStarted(vmName, offsiteHost) {
    const text = `📤 *Offsite Sync Started*\n*VM:* ${vmName}\n*Destination:* ${offsiteHost}\n*Time:* ${new Date().toISOString()}`;
    return this.sendMessage(text);
  }

  notifyOffsiteSyncCompleted(vmName, offsiteHost, size) {
    const text = `✅ *Offsite Sync Completed*\n*VM:* ${vmName}\n*Destination:* ${offsiteHost}\n*Size:* ${size}\n*Time:* ${new Date().toISOString()}`;
    return this.sendMessage(text);
  }

  notifyOffsiteSyncFailed(vmName, offsiteHost, error) {
    const text = `❌ *Offsite Sync Failed*\n*VM:* ${vmName}\n*Destination:* ${offsiteHost}\n*Error:* ${error}\n*Time:* ${new Date().toISOString()}`;
    return this.sendMessage(text);
  }

  /**
   * Generic notification method matching bash script format
   * @param {string} entity - Entity name (e.g., 'remote_backup', 'local_backup', 'restore')
   * @param {string} state - State (e.g., 'ssh', 'backup', 'restore')
   * @param {string} status - Status (e.g., 'started', 'completed', 'failed')
   * @param {string} message - Detailed message
   */
  notify(entity, state, status, message) {
    const statusEmoji = {
      started: '🚀',
      running: '⏳',
      completed: '✅',
      success: '✅',
      failed: '❌',
      error: '❌',
      warning: '⚠️',
      skipped: '⏭️',
    };

    const emoji = statusEmoji[status.toLowerCase()] || '📢';
    
    const text = `\`\`\`
${emoji} Entity: ${entity}
State: ${state}
Status: ${status}
Message: ${message}
Time: ${new Date().toISOString()}
\`\`\``;
    
    return this.sendMessage(text);
  }

  /**
   * Notify backup skipped due to agent offline
   */
  notifyBackupSkipped(vmName, backupHost, reason) {
    const text = `⏭️ *Backup Skipped*\n*VM:* ${vmName}\n*Host:* ${backupHost}\n*Reason:* ${reason}\n*Time:* ${new Date().toISOString()}`;
    return this.sendMessage(text);
  }

  /**
   * Notify backup auto-retry
   */
  notifyBackupRetry(vmName, backupHost, originalJobId) {
    const text = `🔄 *Backup Auto-Retry*\n*VM:* ${vmName}\n*Host:* ${backupHost}\n*Original Job:* ${originalJobId}\n*Time:* ${new Date().toISOString()}`;
    return this.sendMessage(text);
  }

  /**
   * Notify restore started
   */
  notifyRestoreStarted(vmName, backupHost, restoreHost) {
    const text = `🔄 *Restore Started*\n*VM:* ${vmName}\n*From:* ${backupHost}\n*To:* ${restoreHost}\n*Time:* ${new Date().toISOString()}`;
    return this.sendMessage(text);
  }

  /**
   * Notify restore completed
   */
  notifyRestoreCompleted(vmName, duration) {
    const text = `✅ *Restore Completed*\n*VM:* ${vmName}\n*Duration:* ${duration}\n*Time:* ${new Date().toISOString()}`;
    return this.sendMessage(text);
  }

  /**
   * Notify restore failed
   */
  notifyRestoreFailed(vmName, error) {
    const text = `❌ *Restore Failed*\n*VM:* ${vmName}\n*Error:* ${error}\n*Time:* ${new Date().toISOString()}`;
    return this.sendMessage(text);
  }

  /**
   * Critical alert for system errors
   */
  notifyCriticalError(component, error, details = '') {
    const text = `🚨 *CRITICAL ERROR*\n*Component:* ${component}\n*Error:* ${error}\n*Details:* ${details}\n*Time:* ${new Date().toISOString()}\n\n⚠️ Immediate attention required!`;
    return this.sendMessage(text);
  }

  /**
   * Notify when scheduled backup fails to execute
   */
  notifyScheduledBackupFailed(vmName, scheduleType, error) {
    const text = `❌ *Scheduled Backup Failed*\n*VM:* ${vmName}\n*Schedule:* ${scheduleType}\n*Error:* ${error}\n*Time:* ${new Date().toISOString()}`;
    return this.sendMessage(text);
  }

  /**
   * Notify when hypervisor connection fails
   */
  notifyHypervisorConnectionFailed(hypervisorName, hypervisorIp, error) {
    const text = `⚠️ *Hypervisor Connection Failed*\n*Hypervisor:* ${hypervisorName}\n*IP:* ${hypervisorIp}\n*Error:* ${error}\n*Time:* ${new Date().toISOString()}`;
    return this.sendMessage(text);
  }

  /**
   * Notify when storage pool is full or has issues
   */
  notifyStoragePoolIssue(poolName, issue, usage = '') {
    const text = `⚠️ *Storage Pool Issue*\n*Pool:* ${poolName}\n*Issue:* ${issue}\n*Usage:* ${usage}\n*Time:* ${new Date().toISOString()}`;
    return this.sendMessage(text);
  }

  /**
   * Notify when backup job is stuck
   */
  notifyBackupStuck(vmName, jobId, duration) {
    const text = `⚠️ *Backup Job Stuck*\n*VM:* ${vmName}\n*Job ID:* ${jobId}\n*Running for:* ${duration}\n*Time:* ${new Date().toISOString()}\n\n⚠️ Job may need manual intervention`;
    return this.sendMessage(text);
  }

  /**
   * Notify when restore job is stuck
   */
  notifyRestoreStuck(vmName, restoreId, duration) {
    const text = `⚠️ *Restore Job Stuck*\n*VM:* ${vmName}\n*Restore ID:* ${restoreId}\n*Running for:* ${duration}\n*Time:* ${new Date().toISOString()}\n\n⚠️ Job may need manual intervention`;
    return this.sendMessage(text);
  }

  /**
   * Notify when multiple backups fail in a row
   */
  notifyMultipleBackupFailures(vmName, failureCount, lastError) {
    const text = `🚨 *Multiple Backup Failures*\n*VM:* ${vmName}\n*Consecutive Failures:* ${failureCount}\n*Last Error:* ${lastError}\n*Time:* ${new Date().toISOString()}\n\n⚠️ VM may have persistent issues`;
    return this.sendMessage(text);
  }

  /**
   * Notify when agent is down for extended period
   */
  notifyAgentDownExtended(agentName, downSince, missedBackups = 0) {
    const text = `🚨 *Agent Down - Extended Outage*\n*Agent:* ${agentName}\n*Down Since:* ${downSince}\n*Missed Backups:* ${missedBackups}\n*Time:* ${new Date().toISOString()}\n\n⚠️ Critical: Agent requires immediate attention`;
    return this.sendMessage(text);
  }

  /**
   * Notify when backup verification fails
   */
  notifyBackupVerificationFailed(vmName, backupPath, error) {
    const text = `❌ *Backup Verification Failed*\n*VM:* ${vmName}\n*Path:* ${backupPath}\n*Error:* ${error}\n*Time:* ${new Date().toISOString()}\n\n⚠️ Backup may be corrupted`;
    return this.sendMessage(text);
  }

  /**
   * Notify when SSH connection fails
   */
  notifySSHConnectionFailed(host, error) {
    const text = `⚠️ *SSH Connection Failed*\n*Host:* ${host}\n*Error:* ${error}\n*Time:* ${new Date().toISOString()}`;
    return this.sendMessage(text);
  }

  /**
   * Notify when disk space is low
   */
  notifyLowDiskSpace(host, path, available, total, percentage) {
    const text = `⚠️ *Low Disk Space Warning*\n*Host:* ${host}\n*Path:* ${path}\n*Available:* ${available}\n*Total:* ${total}\n*Usage:* ${percentage}%\n*Time:* ${new Date().toISOString()}\n\n⚠️ Action required to prevent backup failures`;
    return this.sendMessage(text);
  }

  /**
   * Notify about missed-run recovery after controller downtime
   */
  notifyMissedRunsRecovered({ downtimeMinutes, lastSeenAt, bootedAt, replayed, skippedByPolicy, skippedTooOld }) {
    const text = `🔄 *Missed-Run Recovery*\n` +
      `*Controller Downtime:* ${downtimeMinutes} minute(s)\n` +
      `*Down From:* ${lastSeenAt}\n` +
      `*Back At:* ${bootedAt}\n` +
      `*Replayed:* ${replayed} backup(s)\n` +
      `*Skipped (policy):* ${skippedByPolicy}\n` +
      `*Skipped (too old):* ${skippedTooOld}\n` +
      `*Time:* ${new Date().toISOString()}\n\n` +
      (replayed > 0 ? '✅ Missed backups are being replayed now' : '📋 No backups needed replay');
    return this.sendMessage(text);
  }
}

const rocketChatService = new RocketChatService();
module.exports = rocketChatService;
