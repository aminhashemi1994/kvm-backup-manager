const express = require('express');
const path = require('path');
const router = express.Router();
const config = require('../config/config');
const { readJSON, writeJSON } = require('../services/fileStorage');
const rocketChatService = require('../services/rocketChatService');
const notificationPolicy = require('../services/notificationPolicyService');
const { requireAdmin } = require('../middleware/rbac');

const SETTINGS_FILE = path.join(config.dataDir, 'notification-settings.json');

/**
 * Default settings derived from environment variables. The persisted file
 * (when present) takes precedence over env vars so the user can manage
 * everything from the panel.
 */
function defaultsFromEnv() {
  return {
    rocketChat: {
      enabled: config.rocketChat?.enabled || false,
      mode: config.rocketChat?.webhookUrl ? 'webhook' : 'api',
      webhookUrl: config.rocketChat?.webhookUrl || '',
      url: config.rocketChat?.url || '',
      authToken: config.rocketChat?.authToken || '',
      userId: config.rocketChat?.userId || '',
      // API mode can authenticate either with the static token above or with
      // these credentials, exchanged for a session token at runtime and
      // refreshed automatically when it expires.
      username: config.rocketChat?.username || '',
      password: config.rocketChat?.password || '',
      channel: config.rocketChat?.channel || 'backup-notifications',
      // Optional message-template fields modelled on the user's bash script
      // (Image_Automation Update). Empty defaults — only included in the
      // payload when set.
      entity: '',
      version: '',
    },
    // RocketChat usernames to @-mention. `default` applies to any failure whose
    // schedule has no list of its own; `certificate` covers cert expiry, which
    // is not schedule-scoped and otherwise has nobody responsible for it.
    mentions: {
      // Applies only when no per-type and no per-schedule list names anyone.
      default: [],
      // Per notification type, keyed the same as `types` above. This is the
      // "who owns this alert" list edited next to each toggle in the panel.
      byType: {},
      // Legacy key, still honoured for certificate alerts.
      certificate: [],
    },
    // Per-notification-type switches. Defaults live in rocketChatService
    // (TYPE_DEFAULTS); anything absent here inherits them.
    types: { ...rocketChatService.TYPE_DEFAULTS },
    // Burst grouping and repeat suppression — see
    // services/notificationAggregator.js. On by default: without it, one fault
    // affecting N VMs sends N messages (plus N more once it starts repeating),
    // which is how a real night reached ~130 messages for four incidents.
    aggregation: {
      enabled: true,
      windowSeconds: 90,
      maxWaitSeconds: 600,
      suppressRepeats: true,
      // How long a standing incident stays suppressed before it is announced
      // again. 0 = suppress forever (the old behaviour, and the reason a
      // nightly offsite failure could be reported once and never again).
      repeatRenotifyHours: 24,
      // The digest is what keeps suppression honest: one message a day listing
      // everything still open. Turning it off while suppressRepeats is on
      // means a long-running failure goes permanently silent — don't.
      digestEnabled: true,
      digestHour: 9,
      digestWhenClear: true,
    },
    // Who to @-mention on the daily incident board (backupFailed/
    // offsiteSyncFailed/backupSkipped), keyed by backup host rather than by
    // notification type or schedule — those events always send now, with no
    // on/off switch; this only controls who gets pinged. A host absent from
    // this list still gets its entries on the board, just without a mention.
    // See services/dailyIncidentBoardService.js.
    hostMentions: [], // [{ backupHostId, mentions: string[] }]
  };
}

async function loadSettings() {
  const defaults = defaultsFromEnv();
  try {
    const stored = await readJSON(SETTINGS_FILE);
    // readJSON returns [] when missing/corrupt — that's not our shape
    if (!stored || Array.isArray(stored)) return defaults;
    return {
      ...defaults,
      ...stored,
      rocketChat: { ...defaults.rocketChat, ...(stored.rocketChat || {}) },
      aggregation: { ...defaults.aggregation, ...(stored.aggregation || {}) },
      mentions: { ...defaults.mentions, ...(stored.mentions || {}) },
      types: { ...defaults.types, ...(stored.types || {}) },
      hostMentions: Array.isArray(stored.hostMentions) ? stored.hostMentions : defaults.hostMentions,
    };
  } catch (_) {
    return defaults;
  }
}

/** Strip secrets before returning to the client. */
function redact(settings) {
  const out = JSON.parse(JSON.stringify(settings));
  if (out.rocketChat) {
    out.rocketChat.authTokenSet = !!out.rocketChat.authToken;
    delete out.rocketChat.authToken;
    out.rocketChat.passwordSet = !!out.rocketChat.password;
    delete out.rocketChat.password;
  }
  return out;
}

// GET /api/notifications/settings
router.get('/settings', async (req, res, next) => {
  try {
    const settings = await loadSettings();
    res.json({ success: true, data: redact(settings) });
  } catch (err) {
    next(err);
  }
});

// PUT /api/notifications/settings  (admin only — secrets)
router.put('/settings', requireAdmin, async (req, res, next) => {
  try {
    const current = await loadSettings();
    const incoming = req.body || {};
    const incomingRC = incoming.rocketChat || {};

    // Two supported modes: 'webhook' (fire-only, no editable messages) and
    // 'api' (chat.postMessage/chat.update against a personal access token —
    // required for anything that edits a message in place, e.g. the daily
    // incident board). Explicit mode wins; falling back to 'webhook' keeps
    // old configs that never set mode behaving as before.
    const mode = incomingRC.mode === 'api' ? 'api' : 'webhook';
    const merged = {
      ...current,
      ...incoming,
      rocketChat: {
        ...current.rocketChat,
        ...incomingRC,
        mode,
        // Preserve the stored authToken unless the request actually sends a
        // new one — GET redacts it (authTokenSet flag, no real value), so an
        // unmodified round-trip through the settings form must not wipe it.
        authToken: incomingRC.authToken && incomingRC.authToken.length > 0
          ? incomingRC.authToken
          : current.rocketChat.authToken,
        // Same "blank means unchanged" rule as authToken — GET redacts it.
        password: incomingRC.password && incomingRC.password.length > 0
          ? incomingRC.password
          : current.rocketChat.password,
      },
      aggregation: { ...current.aggregation, ...(incoming.aggregation || {}) },
      // Usernames are stored without a leading @ and de-duplicated, so the
      // formatter can add exactly one @ per name.
      // Only known type keys with real booleans, so a malformed payload can't
      // introduce a key that silently swallows a whole class of alert.
      types: (() => {
        const merged = { ...current.types, ...(incoming.types || {}) };
        const out = {};
        for (const k of Object.keys(rocketChatService.TYPE_DEFAULTS)) {
          out[k] = typeof merged[k] === 'boolean' ? merged[k] : rocketChatService.TYPE_DEFAULTS[k];
        }
        return out;
      })(),
      mentions: {
        default: notificationPolicy.sanitizeMentions(incoming.mentions?.default)
          ?? current.mentions?.default ?? [],
        certificate: notificationPolicy.sanitizeMentions(incoming.mentions?.certificate)
          ?? current.mentions?.certificate ?? [],
        // Only known type keys survive, and every name is stored without its
        // leading @ so the formatter adds exactly one.
        byType: (() => {
          const incomingByType = incoming.mentions?.byType;
          const base = { ...(current.mentions?.byType || {}) };
          if (incomingByType && typeof incomingByType === 'object') {
            for (const k of Object.keys(rocketChatService.TYPE_DEFAULTS)) {
              if (k in incomingByType) {
                const cleaned = notificationPolicy.sanitizeMentions(incomingByType[k]) || [];
                if (cleaned.length > 0) base[k] = cleaned;
                else delete base[k];
              }
            }
          }
          return base;
        })(),
      },
      // Who to @-mention per backup host on the daily incident board. Only
      // entries with a real backupHostId and at least one cleaned mention
      // survive; a host can appear at most once (last one in the incoming
      // list wins), so a malformed payload can't produce duplicate or
      // empty-mention rows that would silently never notify anyone.
      hostMentions: (() => {
        const incomingList = Array.isArray(incoming.hostMentions) ? incoming.hostMentions : current.hostMentions || [];
        const byHost = new Map();
        for (const row of incomingList) {
          const backupHostId = row && typeof row.backupHostId === 'string' ? row.backupHostId.trim() : '';
          if (!backupHostId) continue;
          const mentions = notificationPolicy.sanitizeMentions(row.mentions) || [];
          if (mentions.length === 0) continue;
          byHost.set(backupHostId, mentions);
        }
        return [...byHost.entries()].map(([backupHostId, mentions]) => ({ backupHostId, mentions }));
      })(),
    };

    // Validation: the fields required to actually send depend on the mode,
    // and only matter once notifications are switched on.
    if (merged.rocketChat.enabled) {
      if (mode === 'webhook' && !merged.rocketChat.webhookUrl) {
        return res.status(400).json({
          success: false,
          error: 'Webhook URL is required when RocketChat notifications are enabled',
        });
      }
      if (mode === 'api') {
        const rcm = merged.rocketChat;
        const hasStaticToken = !!(rcm.authToken && rcm.userId);
        const hasCredentials = !!(rcm.username && rcm.password);
        if (!rcm.url || (!hasStaticToken && !hasCredentials)) {
          return res.status(400).json({
            success: false,
            error: 'API mode needs the server URL plus either a username and password, or a personal access token and user ID',
          });
        }
      }
    }

    await writeJSON(SETTINGS_FILE, merged);
    rocketChatService.reloadConfig(merged.rocketChat);
    rocketChatService.setTypeSettings(merged.types);
    rocketChatService.setMentionSettings(merged.mentions);
    // Grouping/suppression changes take effect without a restart.
    require('../services/notificationAggregator').applySettings(merged.aggregation || {});

    res.json({ success: true, data: redact(merged) });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/notifications/incidents — what the aggregator currently considers
 * open, i.e. the failures it is deliberately NOT re-announcing. Without this
 * the suppression is invisible, and invisible suppression is indistinguishable
 * from a broken alerting pipeline.
 */
router.get('/incidents', async (req, res, next) => {
  try {
    res.json({ success: true, data: require('../services/notificationAggregator').getStatus() });
  } catch (err) {
    next(err);
  }
});

// POST /api/notifications/digest — send the daily digest right now, so the
// format and the webhook can be verified without waiting for the scheduled hour.
router.post('/digest', requireAdmin, async (req, res, next) => {
  try {
    const settings = await loadSettings();
    rocketChatService.reloadConfig(settings.rocketChat);
    const sent = require('../services/notificationAggregator').sendDigest();
    res.json({ success: true, data: { sent } });
  } catch (err) {
    next(err);
  }
});

// POST /api/notifications/incidents/clear — forget open incidents so the next
// occurrence reports as new again (use after fixing an underlying fault).
router.post('/incidents/clear', requireAdmin, async (req, res, next) => {
  try {
    await require('../services/notificationAggregator').clearIncidents();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/notifications/test  — fire a test message using current settings
router.post('/test', requireAdmin, async (req, res, next) => {
  try {
    const settings = await loadSettings();
    rocketChatService.reloadConfig(settings.rocketChat);

    if (!rocketChatService.isConfigured()) {
      return res.status(400).json({
        success: false,
        error: 'RocketChat is not configured or disabled',
      });
    }

    const result = await rocketChatService.notifyTest({
      entity: settings.rocketChat.entity || 'Backup Manager',
      version: settings.rocketChat.version || '',
    });

    if (!result.success) {
      return res.status(502).json({ success: false, error: result.error || 'Failed to send' });
    }
    res.json({ success: true, data: { messageId: result.messageId || null } });
  } catch (err) {
    next(err);
  }
});

module.exports = {
  router,
  loadSettings,
};
