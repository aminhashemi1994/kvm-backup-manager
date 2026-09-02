const axios = require('axios');
const https = require('https');
const config = require('../config/config');
const { stripAnsi } = require('../utils/stripAnsi');

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


/**
 * Per-notification-type switches.
 *
 * Every template is individually addressable so noise can be turned down
 * without touching code. Defaults are the operator's decisions: routine
 * successes and lifecycle chatter are OFF, anything representing a problem
 * someone must act on is ON.
 */
const TYPE_DEFAULTS = Object.freeze({
  // Backup lifecycle
  backupCompleted: false,          // 15 messages a night saying things worked
  // backupFailed, offsiteSyncFailed, and backupSkipped have no switch: they
  // always route to the daily incident board (dailyIncidentBoardService.js),
  // unconditionally. Who gets @-mentioned is configured per backup host
  // (notification-settings.json `hostMentions`), not per type.
  scheduledBackupFailed: true,
  backupRetry: false,              // the outcome is what matters, not the attempt
  multipleBackupFailures: true,
  backupStuck: true,
  // Restore — driven by a human who is already watching the panel
  restoreStarted: false,
  restoreCompleted: false,
  restoreFailed: false,
  restoreStuck: false,
  // Infrastructure
  agentConnected: false,           // recovery of a host is not worth waking for
  agentDisconnected: true,
  agentDownExtended: true,
  hypervisorConnectionFailed: true,
  criticalError: true,
  missedRunsRecovered: true,
  // TLS
  certificateExpiring: true,
  certificateExpired: true,
  agentTlsDegraded: true,
  // Aggregator output
  groupedSummary: true,
  dailyDigest: true,
  // Failure templates that exist but are not wired to a trigger yet.
  storagePoolIssue: true,
  backupVerificationFailed: true,
  sshConnectionFailed: true,
  lowDiskSpace: true,
});

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

    this.types = { ...TYPE_DEFAULTS };
    // Who gets @-mentioned, as configured in Settings -> Notifications.
    // Held in memory so every template can resolve its own people without an
    // async settings read on the send path.
    this.mentions = { default: [], byType: {} };

    this.lastMessageId = null;
    this.lastRoomId = null;
  }

  applyConfig(rc) {
    this.enabled = !!rc.enabled;
    this.webhookUrl = rc.webhookUrl || '';
    this.url = (rc.url || '').replace(/\/+$/, ''); // trailing slash would double up in the path
    this.authToken = rc.authToken || '';
    this.userId = rc.userId || '';
    this.username = rc.username || '';
    this.password = rc.password || '';
    this.channel = rc.channel || 'backup-notifications';
    this.entity = rc.entity || '';
    this.version = rc.version || '';

    // A token obtained by logging in with username/password. Kept only in
    // memory: it is a session credential, not configuration, and re-login is
    // cheap. Dropped whenever the config it was derived from changes, so
    // pointing at a different server or account can't keep using the old one.
    this.sessionToken = null;
    this.sessionUserId = null;
    this._loginInFlight = null;

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

  /** Replace the per-type switches (called after a settings save). */
  setTypeSettings(types) {
    this.types = { ...TYPE_DEFAULTS };
    if (types && typeof types === 'object') {
      for (const key of Object.keys(TYPE_DEFAULTS)) {
        if (typeof types[key] === 'boolean') this.types[key] = types[key];
      }
    }
  }

  /**
   * Replace the mention lists (called after a settings save and at boot).
   * Shape: { default: string[], byType: { [typeKey]: string[] } }.
   */
  setMentionSettings(mentions) {
    const clean = (list) => (Array.isArray(list) ? list : [])
      .map(v => String(v).trim().replace(/^@+/, ''))
      .filter(Boolean);
    const src = mentions && typeof mentions === 'object' ? mentions : {};
    const byType = {};
    if (src.byType && typeof src.byType === 'object') {
      for (const [key, list] of Object.entries(src.byType)) {
        const people = clean(list);
        if (people.length > 0) byType[key] = people;
      }
    }
    this.mentions = { default: clean(src.default), byType };
  }

  /**
   * People to @-mention for a notification type. The type's own list wins;
   * the global default is a safety net used only when nobody was named for
   * that type, so setting it does not put the same person on every alert.
   */
  mentionsForType(key) {
    if (!key) return [];
    const own = this.mentions?.byType?.[key];
    if (own && own.length > 0) return own;
    return this.mentions?.default || [];
  }

  /**
   * Like mentionsForType(), but also unions in the people named on the
   * schedule itself ("Notify these people" on the schedule form) when the
   * message belongs to one. Async because that list lives in the schedules
   * file, so it is only used on paths that can await.
   */
  async resolveMentions(typeKey, scheduleId = null) {
    if (!scheduleId) return this.mentionsForType(typeKey);
    try {
      const people = await require('./notificationPolicyService')
        .getMentionsForSchedules([scheduleId], typeKey);
      if (people && people.length > 0) return people;
    } catch (err) {
      console.error('[RocketChat] Mention lookup failed:', err.message);
    }
    return this.mentionsForType(typeKey);
  }

  /** Is this notification type switched on? Unknown keys default to on. */
  isTypeEnabled(key) {
    if (!key) return true;
    return this.types[key] !== false;
  }

  /** Uniform "we deliberately said nothing" result. */
  _muted(key) {
    return { success: false, skipped: true, reason: `notification type "${key}" is off` };
  }

  isConfigured() {
    if (this.useWebhook) {
      return this.enabled && this.webhookUrl;
    }
    // API mode authenticates either with a static personal access token or
    // with a username/password we exchange for one at runtime.
    const hasStaticToken = !!(this.authToken && this.userId);
    const hasCredentials = !!(this.username && this.password);
    return !!(this.enabled && this.url && (hasStaticToken || hasCredentials));
  }

  /**
   * Exchange username/password for a session token via /api/v1/login.
   *
   * Concurrent callers share one in-flight request: a night's worth of
   * notifications can land at once, and without this a expired token would
   * trigger a dozen simultaneous logins (each invalidating the last on some
   * RocketChat configurations).
   */
  async _login() {
    if (this._loginInFlight) return this._loginInFlight;
    if (!this.username || !this.password) {
      return Promise.resolve({ success: false, error: 'No RocketChat username/password configured' });
    }

    this._loginInFlight = (async () => {
      try {
        const response = await axios.post(
          `${this.url}/api/v1/login`,
          { user: this.username, password: this.password },
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000,
            httpsAgent: insecureHttpsAgent,
          }
        );

        const data = response.data && response.data.data;
        if (response.data?.status === 'success' && data?.authToken && data?.userId) {
          this.sessionToken = data.authToken;
          this.sessionUserId = data.userId;
          console.log(`[RocketChat] Logged in as ${this.username} (userId=${data.userId})`);
          return { success: true };
        }

        const reason = response.data?.error || response.data?.message
          || JSON.stringify(response.data).slice(0, 300);
        console.error('[RocketChat] Login failed:', reason);
        return { success: false, error: `RocketChat login failed: ${reason}` };
      } catch (error) {
        const detail = describeAxiosError(error);
        console.error('[RocketChat] Login error:', detail);
        return { success: false, error: `RocketChat login failed: ${detail}` };
      } finally {
        this._loginInFlight = null;
      }
    })();

    return this._loginInFlight;
  }

  /** The credentials to sign the next API call with, logging in if needed. */
  async _ensureAuth() {
    if (this.sessionToken && this.sessionUserId) {
      return { token: this.sessionToken, userId: this.sessionUserId };
    }
    if (this.authToken && this.userId) {
      return { token: this.authToken, userId: this.userId };
    }
    const result = await this._login();
    if (!result.success) return null;
    return { token: this.sessionToken, userId: this.sessionUserId };
  }

  /**
   * POST to the RocketChat REST API with auth attached.
   *
   * A session token expires (or is revoked when the bot logs in elsewhere),
   * and the failure looks like a normal 401 — so on the first unauthorized
   * response we drop the cached token, log in again, and retry once. Only
   * once: if the retry is also rejected the credentials are genuinely wrong
   * and looping would just lock the account out.
   */
  async _authedPost(apiPath, body, { retryOnAuthFailure = true } = {}) {
    const auth = await this._ensureAuth();
    if (!auth) {
      return { success: false, error: 'RocketChat authentication failed — check the username and password' };
    }

    try {
      const response = await axios.post(
        `${this.url}${apiPath}`,
        body,
        {
          headers: {
            'Content-Type': 'application/json',
            'X-Auth-Token': auth.token,
            'X-User-Id': auth.userId,
          },
          timeout: 10000,
          httpsAgent: insecureHttpsAgent,
        }
      );
      return { success: true, data: response.data };
    } catch (error) {
      const status = error.response && error.response.status;
      const unauthorized = status === 401 || status === 403;

      if (unauthorized && retryOnAuthFailure && this.username && this.password) {
        console.log('[RocketChat] Token rejected — re-authenticating and retrying once');
        this.sessionToken = null;
        this.sessionUserId = null;
        const relogin = await this._login();
        if (!relogin.success) return { success: false, error: relogin.error };
        return this._authedPost(apiPath, body, { retryOnAuthFailure: false });
      }

      return { success: false, error: describeAxiosError(error) };
    }
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
    const result = await this._postMessageRaw(text);
    if (result.success) {
      this.lastMessageId = result.messageId;
      this.lastRoomId = result.roomId;
    }
    return result;
  }

  /**
   * Like sendMessage(), but for a caller (the daily incident board) that
   * tracks its own message/room id rather than sharing the single
   * lastMessageId/lastRoomId slot used by sendMessage()/updateMessage().
   * API mode only — the board requires editable messages, so it has no
   * webhook fallback.
   */
  async postNewMessage(text) {
    if (!this.isConfigured()) {
      console.log('[RocketChat] Not configured, skipping message');
      return { success: false, error: 'Not configured' };
    }
    if (this.useWebhook) {
      return { success: false, error: 'Webhook mode does not support editable messages' };
    }
    return this._postMessageRaw(text);
  }

  async _postMessageRaw(text) {
    const result = await this._authedPost('/api/v1/chat.postMessage', {
      channel: this.channel,
      text,
    });

    if (!result.success) {
      console.error('[RocketChat] Error sending message:', result.error);
      return result;
    }

    if (result.data.success) {
      const messageId = result.data.message._id;
      const roomId = result.data.message.rid;
      console.log(`[RocketChat] Message sent - msg_id=${messageId}`);
      return { success: true, messageId, roomId };
    }

    const reason = result.data?.error || JSON.stringify(result.data).slice(0, 300);
    console.error('[RocketChat] postMessage returned success=false:', reason);
    return { success: false, error: `RocketChat rejected message: ${reason}` };
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

    return this._updateMessageRaw(this.lastRoomId, this.lastMessageId, text);
  }

  /**
   * Like updateMessage(), but for a caller that tracks its own message/room
   * id (see postNewMessage()) instead of the shared lastMessageId slot.
   */
  async updateMessageById(roomId, messageId, text) {
    if (!this.isConfigured()) {
      console.log('[RocketChat] Not configured, skipping update');
      return { success: false, error: 'Not configured' };
    }
    if (this.useWebhook) {
      return { success: false, error: 'Webhook mode does not support editable messages' };
    }
    if (!roomId || !messageId) {
      return { success: false, error: 'No message to update' };
    }
    return this._updateMessageRaw(roomId, messageId, text);
  }

  async _updateMessageRaw(roomId, messageId, text) {
    const result = await this._authedPost('/api/v1/chat.update', {
      roomId,
      msgId: messageId,
      text,
    });

    if (!result.success) {
      console.error('[RocketChat] Error updating message:', result.error);
      return result;
    }

    if (result.data.success) {
      console.log(`[RocketChat] Message updated - msg_id=${messageId}`);
      return { success: true, messageId };
    }

    const reason = result.data?.error || JSON.stringify(result.data).slice(0, 300);
    return { success: false, error: `RocketChat rejected update: ${reason}` };
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
  formatUpdate(fields = {}) {
    // Single choke point for every RocketChat message, so scrub terminal escape
    // sequences here: error strings are scraped from colourised script logs and
    // would otherwise render literally as "[0;31m✗ Backup FAILED[0m". Details
    // are collapsed to one line to keep each message a tidy single bullet.
    const entity  = stripAnsi(fields.entity);
    const state   = stripAnsi(fields.state);
    const status  = stripAnsi(fields.status);
    const name    = stripAnsi(fields.name);
    const version = stripAnsi(fields.version);
    // Grouped and digest messages are deliberately multi-line — one line per
    // affected VM or open incident. Collapsing their whitespace turns the whole
    // summary into a single unreadable run-on, which defeats the point of
    // grouping in the first place. Per-VM messages stay single-line.
    const details = stripAnsi(fields.details, { singleLine: !fields.multiline });

    const ent = entity || this.entity || 'Backup Manager';
    const ver = version || this.version || '';

    const lines = [];
    lines.push(`✨ *${ent} Update* ✨`);
    lines.push('');

    // Put the people responsible at the very top, before anything else, so a
    // mention is visible in the notification preview rather than buried under
    // the detail block.
    // An explicit list wins (the aggregator and the certificate monitor resolve
    // their own, including per-schedule owners); otherwise the notification's
    // type decides who is on the hook.
    const explicit = Array.isArray(fields.mentions) ? fields.mentions : null;
    const mentions = (explicit || this.mentionsForType(fields.typeKey))
      .map(m => String(m).trim().replace(/^@+/, ''))
      .filter(Boolean);
    if (mentions.length > 0) {
      lines.push(mentions.map(m => `@${m}`).join(' '));
      lines.push('');
    }
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
  notify({ entity, state, status, name, version, details, typeKey, mentions }) {
    return this.sendMessage(this.formatUpdate({
      entity, state, status, name, version, details, typeKey, mentions,
    }));
  }

  /**
   * notify(), but with people @-mentioned at the top. Used where a human is
   * expected to act — certificate expiry above all, since nothing else in the
   * system will chase it.
   */
  notifyWithMentions(mentions, fields) {
    return this.sendMessage(this.formatUpdate({ ...fields, mentions }));
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
    if (!this.isTypeEnabled('agentConnected')) return this._muted('agentConnected');
    return this.notify({
        typeKey: 'agentConnected',
      entity: 'Agent',
      state: 'Connectivity',
      status: 'Online',
      name: agentName,
      details: 'Backup host is reachable and accepting requests',
    });
  }

  notifyAgentDisconnected(agentName) {
    if (!this.isTypeEnabled('agentDisconnected')) return this._muted('agentDisconnected');
    return this.notify({
        typeKey: 'agentDisconnected',
      entity: 'Agent',
      state: 'Connectivity',
      status: 'Offline',
      name: agentName,
      details: 'Backup host did not respond to recent health checks',
    });
  }


  /**
   * Send a message that the aggregator has already composed. Bypasses the
   * aggregator itself, or grouped messages would recurse straight back into it.
   */
  sendGrouped({ entity, state, status, name, details, mentions }) {
    return this.sendMessage(this.formatUpdate({
      entity, state, status, name, details, mentions,
      multiline: true,
    }));
  }

  /**
   * Hand an event to the aggregator, which decides whether it is worth saying
   * on its own, worth folding into a group, or a repeat of an open incident
   * that needs no message at all. See services/notificationAggregator.js.
   *
   * Lazily required: the aggregator calls back into this service to send.
   */
  _viaAggregator(ev) {
    try {
      return require('./notificationAggregator').submit(ev);
    } catch (err) {
      // Aggregation must never cost us an alert — fall back to sending direct.
      console.error('[RocketChat] Aggregator unavailable, sending directly:', err.message);
      return ev.sendSingle && ev.sendSingle();
    }
  }

  notifyBackupCompleted(vmName, method, duration, scheduleId = null) {
    // Successes are still handed to the aggregator even when this type is off:
    // it uses them to clear open incidents and to announce RECOVERIES, which
    // are worth hearing. `mute` suppresses only the routine "N VMs completed"
    // summary — dropping the event entirely would mean a VM that came back
    // after three weeks of failing did so silently.
    return this._viaAggregator({
      kind: 'backup-completed',
      subject: vmName,
      mute: !this.isTypeEnabled('backupCompleted'),
      context: `Duration: ${duration}`,
      scheduleId,
      sendSingle: async () => this.notify({
        mentions: await this.resolveMentions('backupCompleted', scheduleId),
        entity: 'Backup',
        state: (method || '').toUpperCase() || 'BACKUP',
        status: 'Completed',
        name: vmName,
        details: `Duration: ${duration}`,
      }),
    });
  }

  /**
   * Always routes to the daily incident board — no on/off switch, no legacy
   * per-message path. See services/dailyIncidentBoardService.js. Who gets
   * @-mentioned is decided there, from notification-settings.json's
   * `hostMentions` (keyed by backupHostId), not from a per-type setting.
   */
  notifyBackupFailed(vmName, method, error, scheduleId = null, backupHostId = null) {
    // Still feed the aggregator's incident bookkeeping (trackOnly: no
    // message of its own) so notifyBackupCompleted's recovery detection
    // keeps working even though the failure message itself lives on the
    // board.
    try {
      require('./notificationAggregator').submit({
        kind: 'backup-failed', subject: vmName, cause: error, scheduleId, trackOnly: true,
      });
    } catch (err) {
      console.error('[RocketChat] Aggregator tracking failed:', err.message);
    }
    return require('./dailyIncidentBoardService').recordIssue({
      vm: vmName, kind: 'backup-failed', detail: error, scheduleId, backupHostId,
    });
  }

  notifyOffsiteSyncFailed(vmName, offsiteHost, error, scheduleId = null, offsiteSuccessSeen = false, backupHostId = null) {
    try {
      require('./notificationAggregator').submit({
        kind: 'offsite-failed', subject: vmName, cause: `${offsiteHost}: ${error}`, scheduleId, trackOnly: true,
      });
    } catch (err) {
      console.error('[RocketChat] Aggregator tracking failed:', err.message);
    }
    return require('./dailyIncidentBoardService').recordIssue({
      vm: vmName, kind: 'offsite', offsiteHost, scheduleId, backupHostId,
    });
  }

  /**
   * A whole replication job failed — not one destination out of several, but
   * the job itself (could not start, refused, timed out, killed).
   *
   * Distinct from notifyOffsiteSyncFailed, which reports one target's outcome
   * when the sync itself ran. Both land on the board as warnings; only the
   * wording differs, because "Site3 failed" and "replication never ran" call
   * for different responses.
   */
  notifyOffsiteJobFailed(vmName, reason, scheduleId = null, backupHostId = null) {
    try {
      require('./notificationAggregator').submit({
        kind: 'offsite-failed', subject: vmName, cause: reason, scheduleId, trackOnly: true,
      });
    } catch (err) {
      console.error('[RocketChat] Aggregator tracking failed:', err.message);
    }
    return require('./dailyIncidentBoardService').recordIssue({
      vm: vmName, kind: 'offsite-failed', detail: reason, scheduleId, backupHostId,
    });
  }

  /**
   * The replication check found a VM's offsite copy out of date.
   *
   * Only reported when nothing is already being done about it — if the check
   * queued a sync, that sync's own outcome is the thing worth saying, and
   * announcing both would be two messages for one problem.
   */
  notifyOffsiteBehind(vmName, detail, scheduleId = null, backupHostId = null) {
    return require('./dailyIncidentBoardService').recordIssue({
      vm: vmName, kind: 'offsite-behind', detail, scheduleId, backupHostId,
    });
  }

  /**
   * An agent too old to run an independent replication job. Host-level: the
   * board keys this per backup host, so it is one line however many VMs are
   * affected.
   */
  notifyOffsiteUnsupported(backupHostName, detail, backupHostId = null) {
    return require('./dailyIncidentBoardService').recordIssue({
      vm: 'Offsite replication', kind: 'offsite-unsupported', detail, backupHostId,
    });
  }

  /**
   * The storage pool holding a host's backups is not mounted, or is not the
   * filesystem it was.
   *
   * Critical rather than a warning, and deliberately not filed as an offsite
   * problem: the LOCAL copy is the one that is missing. Replication is refused
   * for those VMs on purpose — syncing from an empty mount point would delete
   * the offsite copies, which may be all that is left. Host-level, so it is
   * one line per host rather than one per affected VM.
   */
  notifySourceUnavailable(backupHostName, detail, backupHostId = null) {
    return require('./dailyIncidentBoardService').recordIssue({
      vm: 'Backup pool', kind: 'source-unavailable', detail, backupHostId,
    });
  }

  notifyBackupSkipped(vmName, backupHost, reason, backupHostId = null) {
    // backupHost is which zone this lands under on the board — already shown
    // by the zone header, so it doesn't need repeating in the line itself.
    return require('./dailyIncidentBoardService').recordIssue({
      vm: vmName, kind: 'skipped', detail: reason, backupHostId,
    });
  }

  notifyBackupRetry(vmName, backupHost, originalJobId) {
    if (!this.isTypeEnabled('backupRetry')) return this._muted('backupRetry');
    return this.notify({
        typeKey: 'backupRetry',
      entity: 'Backup',
      state: 'Auto-Retry',
      status: 'Started',
      name: vmName,
      details: `Host: ${backupHost}, Original Job: ${originalJobId}`,
    });
  }

  notifyRestoreStarted(vmName, backupHost, restoreHost) {
    if (!this.isTypeEnabled('restoreStarted')) return this._muted('restoreStarted');
    return this.notify({
        typeKey: 'restoreStarted',
      entity: 'Restore',
      state: 'Transfer',
      status: 'Started',
      name: vmName,
      details: `From: ${backupHost} → To: ${restoreHost}`,
    });
  }

  notifyRestoreCompleted(vmName, duration) {
    if (!this.isTypeEnabled('restoreCompleted')) return this._muted('restoreCompleted');
    return this.notify({
        typeKey: 'restoreCompleted',
      entity: 'Restore',
      state: 'Transfer',
      status: 'Completed',
      name: vmName,
      details: `Duration: ${duration}`,
    });
  }

  notifyRestoreFailed(vmName, error) {
    if (!this.isTypeEnabled('restoreFailed')) return this._muted('restoreFailed');
    return this.notify({
        typeKey: 'restoreFailed',
      entity: 'Restore',
      state: 'Transfer',
      status: 'Failed',
      name: vmName,
      details: `Error: ${error}`,
    });
  }

  notifyCriticalError(component, error, details = '') {
    if (!this.isTypeEnabled('criticalError')) return this._muted('criticalError');
    return this.notify({
        typeKey: 'criticalError',
      entity: 'System',
      state: component,
      status: 'Critical Error',
      name: component,
      details: details ? `${error} | ${details}` : error,
    });
  }

  /**
   * A scheduled run could not even be triggered (agent unreachable, bad
   * payload, hypervisor refused). That is a failed backup like any other, so
   * it goes on the daily incident board rather than out as its own message —
   * otherwise the same night's problem is reported twice in two different
   * formats, and this path could never @-mention the host owner because
   * mentions for backup failures are configured per backup host, which only
   * the board reads.
   */
  notifyScheduledBackupFailed(vmName, scheduleType, error, scheduleId = null, backupHostId = null) {
    if (!this.isTypeEnabled('scheduledBackupFailed')) return this._muted('scheduledBackupFailed');
    try {
      require('./notificationAggregator').submit({
        kind: 'backup-failed', subject: vmName, cause: error, scheduleId, trackOnly: true,
      });
    } catch (err) {
      console.error('[RocketChat] Aggregator tracking failed:', err.message);
    }
    return require('./dailyIncidentBoardService').recordIssue({
      vm: vmName,
      kind: 'backup-failed',
      detail: `${scheduleType} schedule could not start: ${error}`,
      scheduleId,
      backupHostId,
    });
  }

  notifyHypervisorConnectionFailed(hypervisorName, hypervisorIp, error) {
    if (!this.isTypeEnabled('hypervisorConnectionFailed')) return this._muted('hypervisorConnectionFailed');
    return this.notify({
        typeKey: 'hypervisorConnectionFailed',
      entity: 'Hypervisor',
      state: 'Connectivity',
      status: 'Failed',
      name: hypervisorName,
      details: `IP: ${hypervisorIp}, Error: ${error}`,
    });
  }

  notifyStoragePoolIssue(poolName, issue, usage = '') {
    if (!this.isTypeEnabled('storagePoolIssue')) return this._muted('storagePoolIssue');
    return this.notify({
        typeKey: 'storagePoolIssue',
      entity: 'Storage Pool',
      state: 'Health',
      status: 'Warning',
      name: poolName,
      details: `Issue: ${issue}${usage ? `, Usage: ${usage}` : ''}`,
    });
  }

  /**
   * A running job has gone silent. Tonight's backup is very likely not
   * happening, so it belongs on the board next to the outright failures — and
   * it clears itself off there the moment the VM does back up successfully.
   */
  notifyBackupStuck(vmName, jobId, duration, scheduleId = null, backupHostId = null) {
    if (!this.isTypeEnabled('backupStuck')) return this._muted('backupStuck');
    return require('./dailyIncidentBoardService').recordIssue({
      vm: vmName,
      kind: 'stuck',
      detail: `stalled — ${duration}`,
      scheduleId,
      backupHostId,
    });
  }

  notifyRestoreStuck(vmName, restoreId, duration) {
    if (!this.isTypeEnabled('restoreStuck')) return this._muted('restoreStuck');
    return this.notify({
        typeKey: 'restoreStuck',
      entity: 'Restore',
      state: 'Job Health',
      status: 'Stuck',
      name: vmName,
      details: `Restore ID: ${restoreId}, Running for: ${duration}`,
    });
  }

  /**
   * A VM has now failed N times in a row. This is not a separate incident from
   * the failures themselves, so it does not get a message of its own: it
   * sharpens the VM's existing line on the daily incident board.
   *
   * It used to send a standalone "Reliability / Multiple Failures" message per
   * VM and, once several VMs shared a cause, a grouped "Failure Summary" — both
   * in the old per-message format, both bypassing the board, and neither able
   * to @-mention the host owner (mentions for backup failures are configured
   * per backup host, and only the board reads that list).
   */
  notifyMultipleBackupFailures(vmName, failureCount, lastError, scheduleId = null, backupHostId = null) {
    if (!this.isTypeEnabled('multipleBackupFailures')) return this._muted('multipleBackupFailures');

    // Bookkeeping only — keeps the aggregator's open-incident state accurate so
    // a later success still clears the board entry.
    try {
      require('./notificationAggregator').submit({
        kind: 'backup-repeat-failure', subject: vmName, cause: lastError, scheduleId, trackOnly: true,
      });
    } catch (err) {
      console.error('[RocketChat] Aggregator tracking failed:', err.message);
    }

    return require('./dailyIncidentBoardService').recordIssue({
      vm: vmName,
      kind: 'backup-failed',
      detail: `${lastError} (${failureCount} consecutive failures)`,
      scheduleId,
      backupHostId,
    });
  }

  notifyAgentDownExtended(agentName, downSince, missedBackups = 0) {
    if (!this.isTypeEnabled('agentDownExtended')) return this._muted('agentDownExtended');
    return this.notify({
        typeKey: 'agentDownExtended',
      entity: 'Agent',
      state: 'Connectivity',
      status: 'Extended Outage',
      name: agentName,
      details: `Down since: ${downSince}, Missed backups: ${missedBackups}`,
    });
  }

  notifyBackupVerificationFailed(vmName, backupPath, error) {
    if (!this.isTypeEnabled('backupVerificationFailed')) return this._muted('backupVerificationFailed');
    return this.notify({
        typeKey: 'backupVerificationFailed',
      entity: 'Backup',
      state: 'Verification',
      status: 'Failed',
      name: vmName,
      details: `Path: ${backupPath}, Error: ${error}`,
    });
  }

  notifySSHConnectionFailed(host, error) {
    if (!this.isTypeEnabled('sshConnectionFailed')) return this._muted('sshConnectionFailed');
    return this.notify({
        typeKey: 'sshConnectionFailed',
      entity: 'SSH',
      state: 'Connectivity',
      status: 'Failed',
      name: host,
      details: `Error: ${error}`,
    });
  }

  notifyLowDiskSpace(host, path, available, total, percentage) {
    if (!this.isTypeEnabled('lowDiskSpace')) return this._muted('lowDiskSpace');
    return this.notify({
        typeKey: 'lowDiskSpace',
      entity: 'Storage',
      state: 'Disk Space',
      status: 'Low',
      name: host,
      details: `Path: ${path}, Available: ${available}/${total} (${percentage}% used)`,
    });
  }

  /**
   * Certificate is still valid but the clock is running. Every one of these
   * says outright that backups are unaffected — an operator who reads "TLS
   * problem" at 3am should not go looking for a backup outage that isn't there.
   */
  notifyCertificateExpiring(cert, mentions = []) {
    if (!this.isTypeEnabled('certificateExpiring')) return this._muted('certificateExpiring');
    return this.notifyWithMentions(
      mentions && mentions.length > 0 ? mentions : this.mentionsForType('certificateExpiring'),
      {
      entity: 'TLS Certificate',
      state: cert.label,
      status: cert.daysRemaining <= 7 ? 'Expiring Soon (Critical)' : 'Expiring Soon',
      name: cert.subject || cert.label,
      details: `Expires in ${cert.daysRemaining} day(s) on ${cert.validTo}. Issuer: ${cert.issuer || 'unknown'}. Backups are NOT affected — renew before expiry to restore full verification.`,
    });
  }

  notifyCertificateExpired(cert, mentions = []) {
    if (!this.isTypeEnabled('certificateExpired')) return this._muted('certificateExpired');
    return this.notifyWithMentions(
      mentions && mentions.length > 0 ? mentions : this.mentionsForType('certificateExpired'),
      {
      entity: 'TLS Certificate',
      state: cert.label,
      status: 'EXPIRED',
      name: cert.subject || cert.label,
      details: `Expired on ${cert.validTo} (${Math.abs(cert.daysRemaining)} day(s) ago). Backups and agent sync are STILL RUNNING on the pinned-key fallback, but browser access will be blocked and certificate verification is degraded. Renew and reload nginx, then restart the controller.`,
    });
  }

  notifyAgentTlsDegraded(agentName, tlsState, mentions = []) {
    if (!this.isTypeEnabled('agentTlsDegraded')) return this._muted('agentTlsDegraded');
    const blocked = tlsState.mode === 'blocked';
    return this.notifyWithMentions(
      mentions && mentions.length > 0 ? mentions : this.mentionsForType('agentTlsDegraded'),
      {
      entity: 'TLS Certificate',
      state: 'Agent → Controller link',
      status: blocked ? 'BLOCKED' : 'Degraded (still working)',
      name: agentName,
      details: `${tlsState.reason || tlsState.mode}${tlsState.cert && tlsState.cert.validTo ? ` Cert valid_to: ${tlsState.cert.validTo}.` : ''}`,
    });
  }

  notifyMissedRunsRecovered({ downtimeMinutes, lastSeenAt, bootedAt, replayed, skippedByPolicy, skippedTooOld }) {
    if (!this.isTypeEnabled('missedRunsRecovered')) return this._muted('missedRunsRecovered');
    return this.notify({
      typeKey: 'missedRunsRecovered',
      entity: 'Controller',
      state: 'Missed-Run Recovery',
      status: replayed > 0 ? 'Replaying' : 'Idle',
      name: 'Backup Controller',
      details: `Downtime: ${downtimeMinutes}min (${lastSeenAt} → ${bootedAt}), Replayed: ${replayed}, SkippedByPolicy: ${skippedByPolicy}, SkippedTooOld: ${skippedTooOld}`,
    });
  }
}

const rocketChatService = new RocketChatService();
// Exposed so the settings route can enumerate and validate the switches
// without duplicating the list.
rocketChatService.TYPE_DEFAULTS = TYPE_DEFAULTS;
module.exports = rocketChatService;
