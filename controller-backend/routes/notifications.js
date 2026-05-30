const express = require('express');
const path = require('path');
const router = express.Router();
const config = require('../config/config');
const { readJSON, writeJSON } = require('../services/fileStorage');
const rocketChatService = require('../services/rocketChatService');
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
      channel: config.rocketChat?.channel || 'backup-notifications',
      // Optional message-template fields modelled on the user's bash script
      // (Image_Automation Update). Empty defaults — only included in the
      // payload when set.
      entity: '',
      version: '',
    },
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

    // Preserve the current authToken if the client didn't send one (since we
    // never echo it back, the UI submits an empty string when "unchanged").
    const merged = {
      ...current,
      ...incoming,
      rocketChat: {
        ...current.rocketChat,
        ...incomingRC,
        authToken: incomingRC.authToken && incomingRC.authToken.length > 0
          ? incomingRC.authToken
          : current.rocketChat.authToken,
      },
    };

    // Light validation
    if (merged.rocketChat.enabled) {
      const m = merged.rocketChat.mode || (merged.rocketChat.webhookUrl ? 'webhook' : 'api');
      merged.rocketChat.mode = m;
      if (m === 'webhook' && !merged.rocketChat.webhookUrl) {
        return res.status(400).json({ success: false, error: 'webhookUrl is required when mode is webhook' });
      }
      if (m === 'api') {
        const missing = [];
        if (!merged.rocketChat.url) missing.push('url');
        if (!merged.rocketChat.authToken) missing.push('authToken');
        if (!merged.rocketChat.userId) missing.push('userId');
        if (!merged.rocketChat.channel) missing.push('channel');
        if (missing.length) {
          return res.status(400).json({
            success: false,
            error: `Missing required fields: ${missing.join(', ')}`,
          });
        }
      }
    }

    await writeJSON(SETTINGS_FILE, merged);
    rocketChatService.reloadConfig(merged.rocketChat);

    res.json({ success: true, data: redact(merged) });
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
