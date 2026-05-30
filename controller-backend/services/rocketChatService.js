const axios = require('axios');
const https = require('https');
const config = require('../config/config');

// Allow self-signed / internal-CA RocketChat servers — same effect as
// curl's `-k` flag. Toggleable per call so we can turn strict TLS back on
// later if the user wants it.
const insecureHttpsAgent = new https.Agent({ rejectUnauthorized: false });

/** Extract the most useful error message we can from an axios failure. */
function describeAxiosError(err) {
  if (!err) return 'Unknown error';
  if (err.response) {
    // Server responded with non-2xx
    const status = err.response.status;
    const body = err.response.data;
    let detail = '';
    if (body) {
      if (typeof body === 'string') {
        detail = body.slice(0, 300);
      } else {
        try { detail = JSON.stringify(body).slice(0, 300); } catch (_) { /* ignore */ }
      }
    }
    return `HTTP ${status}${detail ? ` — ${detail}` : ''}`;
  }
  if (err.code) {
    // Network-level error: ECONNREFUSED, ETIMEDOUT, ENOTFOUND, ECONNABORTED, etc.
    return `${err.code}: ${err.message}`;
  }
  return err.message || String(err);
}

class RocketChatService {
  constructor() {
    // Initial config is taken from env. The notifications route calls
    // reloadConfig() with the persisted JSON settings as soon as the server
    // boots, so by the time anything sends a message the user-managed
    // values are in effect.
    this.applyConfig({
      enabled: config.rocketChat?.enabled || false,
      mode: config.rocketChat?.webhookUrl ? 'webhook' : 'api',
      webhookUrl: config.rocketChat?.webhookUrl || '',
      url: config.rocketChat?.url || '',
      authToken: config.rocketChat?.authToken || '',
      userId: config.rocketChat?.userId || '',
      channel: config.rocketChat?.channel || 'backup-notifications',
      entity: '',
      version: '',
    });

    this.lastMessageId = null;
    this.lastRoomId = null;
  }

  applyConfig(rc) {
    this.enabled = !!rc.enabled;
    this.webhookUrl = rc.webhookUrl || '';
    this.url = rc.url || '';
    this.authToken = rc.authToken || '';
    this.userId = rc.userId || '';
    this.channel = rc.channel || 'backup-notifications';
    this.entity = rc.entity || '';
    this.version = rc.version || '';

    // Mode preference: explicit > webhook URL > API
    this.useWebhook = rc.mode
      ? rc.mode === 'webhook'
      : !!this.webhookUrl;
  }

  /**
   * Hot-reload config from the persisted notification-settings file.
   * Called by the notifications route after a successful PUT.
   */
  reloadConfig(rc) {
    if (!rc) return;
    this.applyConfig(rc);
    console.log('[RocketChat] Config reloaded (enabled=%s, mode=%s)', this.enabled, this.useWebhook ? 'webhook' : 'api');
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
          httpsAgent: insecureHttpsAgent,
        }
      );

      if (response.data.success) {
        this.lastMessageId = response.data.message._id;
        this.lastRoomId = response.data.message.rid;
        console.log(`[RocketChat] Message sent - msg_id=${this.lastMessageId}`);
        return { success: true, messageId: this.lastMessageId };
      }

      const reason = response.data?.error || JSON.stringify(response.data).slice(0, 300);
      console.error('[RocketChat] postMessage returned success=false:', reason);
      return { success: false, error: `RocketChat rejected message: ${reason}` };
    } catch (error) {
      const detail = describeAxiosError(error);
      console.error('[RocketChat] Error sending message:', detail);
      return { success: false, error: detail };
    }
  }

  async sendWebhookMessage(text) {
    try {
      await axios.post(
        this.webhookUrl,
        {
          bot: true,
          text,
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
          // 2s was too tight for RocketChat behind reverse proxies; the
          // working bash example also uses 2s but `curl -k` succeeds in
          // ms because it skips TLS handshake validation. With axios we
          // were timing out before the response came back.
          timeout: 10000,
          httpsAgent: insecureHttpsAgent,
        }
      );

      console.log('[RocketChat] Webhook message sent');
      return { success: true };
    } catch (error) {
      const detail = describeAxiosError(error);
      console.error('[RocketChat] Error sending webhook message:', detail);
      return { success: false, error: detail };
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
          httpsAgent: insecureHttpsAgent,
        }
      );

      if (response.data.success) {
        console.log(`[RocketChat] Message updated - msg_id=${this.lastMessageId}`);
        return { success: true, messageId: this.lastMessageId };
      }

      const reason = response.data?.error || JSON.stringify(response.data).slice(0, 300);
      return { success: false, error: `RocketChat rejected update: ${reason}` };
    } catch (error) {
      const detail = describeAxiosError(error);
      console.error('[RocketChat] Error updating message:', detail);
      return { success: false, error: detail };
    }
  }

  // ============================================================================
  // Message templates
  //
  // All notifications now share a single formatter modelled on the user's
  // bash script ("Image_Automation Update"). The formatter produces a
  // RocketChat-compatible message of the form:
  //
  //   ✨ *<Entity> Update* ✨
  //   *🧩 Entity:* <entity>
  //   *⚙️ State:* <state>
  //   *📊 Status:* <status>
  //   *💾 Image:* <name>
  //   *🏷️ Version:* <version>
  //   *📘 Details:* <details>
  //
  // For non-image domains (backup, restore, agent, …) the "Image" line
  // uses the relevant entity (VM name, agent name, …) so the layout
  // remains consistent everywhere.
  // ============================================================================

  /**
   * Build the standard message body. Any field can be omitted by passing
   * an empty string; that line is dropped so the message stays readable.
   */
  formatUpdate({ entity, state, status, name, version, details }) {
    const ent = entity || this.entity || 'Backup Manager';
    const ver = version || this.version || '';

    const lines = [];
    lines.push(`✨ *${ent} Update* ✨`);
    lines.push('');
    lines.push(`*🧩 Entity:* ${ent}`);
    if (state)   lines.push(`*⚙️ State:* ${state}`);
    if (status)  lines.push(`*📊 Status:* ${status}`);
    if (name)    lines.push(`*💾 Image:* ${name}`);
    if (ver)     lines.push(`*🏷️ Version:* ${ver}`);
    if (details) lines.push(`*📘 Details:* ${details}`);
    lines.push(`*🕒 Time:* ${new Date().toISOString()}`);
    return lines.join('\n');
  }

  /** Generic notify shortcut used by callers that want full control. */
  notify({ entity, state, status, name, version, details }) {
    return this.sendMessage(this.formatUpdate({ entity, state, status, name, version, details }));
  }

  /** Used by /api/notifications/test */
  notifyTest({ entity, version }) {
    return this.sendMessage(this.formatUpdate({
      entity,
      state: 'Configuration',
      status: 'Test',
      name: 'Backup Manager',
      version,
      details: 'This is a test notification from the Backup Manager panel.',
    }));
  }

  // Notification templates
  notifyAgentConnected(agentName) {
    return this.notify({
      entity: 'Agent',
      state: 'Connectivity',
      status: 'Online',
      name: agentName,
      details: 'Backup host is reachable and accepting requests',
    });
  }

  notifyAgentDisconnected(agentName) {
    return this.notify({
      entity: 'Agent',
      state: 'Connectivity',
      status: 'Offline',
      name: agentName,
      details: 'Backup host did not respond to recent health checks',
    });
  }

  notifyBackupStarted(vmName, method, backupHost) {
    return this.notify({
      entity: 'Backup',
      state: (method || '').toUpperCase() || 'BACKUP',
      status: 'Started',
      name: vmName,
      details: `Host: ${backupHost}`,
    });
  }

  notifyBackupCompleted(vmName, method, duration) {
    return this.notify({
      entity: 'Backup',
      state: (method || '').toUpperCase() || 'BACKUP',
      status: 'Completed',
      name: vmName,
      details: `Duration: ${duration}`,
    });
  }

  notifyBackupFailed(vmName, method, error) {
    return this.notify({
      entity: 'Backup',
      state: (method || '').toUpperCase() || 'BACKUP',
      status: 'Failed',
      name: vmName,
      details: `Error: ${error}`,
    });
  }

  notifyOffsiteSyncStarted(vmName, offsiteHost) {
    return this.notify({
      entity: 'Offsite Sync',
      state: 'Transfer',
      status: 'Started',
      name: vmName,
      details: `Destination: ${offsiteHost}`,
    });
  }

  notifyOffsiteSyncCompleted(vmName, offsiteHost, size) {
    return this.notify({
      entity: 'Offsite Sync',
      state: 'Transfer',
      status: 'Completed',
      name: vmName,
      details: `Destination: ${offsiteHost}, Size: ${size}`,
    });
  }

  notifyOffsiteSyncFailed(vmName, offsiteHost, error) {
    return this.notify({
      entity: 'Offsite Sync',
      state: 'Transfer',
      status: 'Failed',
      name: vmName,
      details: `Destination: ${offsiteHost}, Error: ${error}`,
    });
  }

  notifyBackupSkipped(vmName, backupHost, reason) {
    return this.notify({
      entity: 'Backup',
      state: 'Schedule',
      status: 'Skipped',
      name: vmName,
      details: `Host: ${backupHost}, Reason: ${reason}`,
    });
  }

  notifyBackupRetry(vmName, backupHost, originalJobId) {
    return this.notify({
      entity: 'Backup',
      state: 'Auto-Retry',
      status: 'Started',
      name: vmName,
      details: `Host: ${backupHost}, Original Job: ${originalJobId}`,
    });
  }

  notifyRestoreStarted(vmName, backupHost, restoreHost) {
    return this.notify({
      entity: 'Restore',
      state: 'Transfer',
      status: 'Started',
      name: vmName,
      details: `From: ${backupHost} → To: ${restoreHost}`,
    });
  }

  notifyRestoreCompleted(vmName, duration) {
    return this.notify({
      entity: 'Restore',
      state: 'Transfer',
      status: 'Completed',
      name: vmName,
      details: `Duration: ${duration}`,
    });
  }

  notifyRestoreFailed(vmName, error) {
    return this.notify({
      entity: 'Restore',
      state: 'Transfer',
      status: 'Failed',
      name: vmName,
      details: `Error: ${error}`,
    });
  }

  notifyCriticalError(component, error, details = '') {
    return this.notify({
      entity: 'System',
      state: component,
      status: 'Critical Error',
      name: component,
      details: details ? `${error} | ${details}` : error,
    });
  }

  notifyScheduledBackupFailed(vmName, scheduleType, error) {
    return this.notify({
      entity: 'Backup',
      state: `${scheduleType} schedule`,
      status: 'Failed',
      name: vmName,
      details: `Error: ${error}`,
    });
  }

  notifyHypervisorConnectionFailed(hypervisorName, hypervisorIp, error) {
    return this.notify({
      entity: 'Hypervisor',
      state: 'Connectivity',
      status: 'Failed',
      name: hypervisorName,
      details: `IP: ${hypervisorIp}, Error: ${error}`,
    });
  }

  notifyStoragePoolIssue(poolName, issue, usage = '') {
    return this.notify({
      entity: 'Storage Pool',
      state: 'Health',
      status: 'Warning',
      name: poolName,
      details: `Issue: ${issue}${usage ? `, Usage: ${usage}` : ''}`,
    });
  }

  notifyBackupStuck(vmName, jobId, duration) {
    return this.notify({
      entity: 'Backup',
      state: 'Job Health',
      status: 'Stuck',
      name: vmName,
      details: `Job ID: ${jobId}, Running for: ${duration}`,
    });
  }

  notifyRestoreStuck(vmName, restoreId, duration) {
    return this.notify({
      entity: 'Restore',
      state: 'Job Health',
      status: 'Stuck',
      name: vmName,
      details: `Restore ID: ${restoreId}, Running for: ${duration}`,
    });
  }

  notifyMultipleBackupFailures(vmName, failureCount, lastError) {
    return this.notify({
      entity: 'Backup',
      state: 'Reliability',
      status: 'Multiple Failures',
      name: vmName,
      details: `Consecutive failures: ${failureCount}, Last error: ${lastError}`,
    });
  }

  notifyAgentDownExtended(agentName, downSince, missedBackups = 0) {
    return this.notify({
      entity: 'Agent',
      state: 'Connectivity',
      status: 'Extended Outage',
      name: agentName,
      details: `Down since: ${downSince}, Missed backups: ${missedBackups}`,
    });
  }

  notifyBackupVerificationFailed(vmName, backupPath, error) {
    return this.notify({
      entity: 'Backup',
      state: 'Verification',
      status: 'Failed',
      name: vmName,
      details: `Path: ${backupPath}, Error: ${error}`,
    });
  }

  notifySSHConnectionFailed(host, error) {
    return this.notify({
      entity: 'SSH',
      state: 'Connectivity',
      status: 'Failed',
      name: host,
      details: `Error: ${error}`,
    });
  }

  notifyLowDiskSpace(host, path, available, total, percentage) {
    return this.notify({
      entity: 'Storage',
      state: 'Disk Space',
      status: 'Low',
      name: host,
      details: `Path: ${path}, Available: ${available}/${total} (${percentage}% used)`,
    });
  }

  notifyMissedRunsRecovered({ downtimeMinutes, lastSeenAt, bootedAt, replayed, skippedByPolicy, skippedTooOld }) {
    return this.notify({
      entity: 'Controller',
      state: 'Missed-Run Recovery',
      status: replayed > 0 ? 'Replaying' : 'Idle',
      name: 'Backup Controller',
      details: `Downtime: ${downtimeMinutes}min (${lastSeenAt} → ${bootedAt}), Replayed: ${replayed}, SkippedByPolicy: ${skippedByPolicy}, SkippedTooOld: ${skippedTooOld}`,
    });
  }
}

const rocketChatService = new RocketChatService();
module.exports = rocketChatService;
