const path = require('path');
const config = require('../config/config');
const { readJSON } = require('./fileStorage');

const SETTINGS_FILE = path.join(config.dataDir, 'notification-settings.json');

/** Strip a leading @ and whitespace so stored names are canonical. */
function normalizeMention(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim().replace(/^@+/, '');
  return trimmed.length > 0 ? trimmed : null;
}

/** Clean an incoming list of usernames: unique, non-empty, no stray @. */
function sanitizeMentions(input) {
  if (!Array.isArray(input)) return undefined;
  const out = [];
  for (const raw of input) {
    const name = normalizeMention(raw);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Read the global mention lists from the settings file. */
async function loadGlobalMentions() {
  try {
    const stored = await readJSON(SETTINGS_FILE);
    if (!stored || Array.isArray(stored)) return {};
    return stored.mentions && typeof stored.mentions === 'object' ? stored.mentions : {};
  } catch (_) {
    return {};
  }
}

/**
 * Who should be @-mentioned for a notification.
 *
 * Two sources:
 *   1. `mentions.byType[typeKey]` — the person who owns this KIND of alert
 *      (set per section in Settings -> Notifications).
 *   2. `mentions.default` — a safety net used ONLY when 1 is empty, so
 *      configuring it does not put the same person on every alert.
 *
 * `scheduleIds` is accepted and ignored: mentions are no longer configured
 * per schedule. Kept so existing callers need no change.
 *
 * @param {Array<string>} scheduleIds - unused
 * @param {string|null} typeKey - notification type (see rocketChatService TYPE_DEFAULTS)
 * @returns {Promise<string[]>}
 */
async function getMentionsForSchedules(scheduleIds = [], typeKey = null) {
  try {
    const globals = await loadGlobalMentions();
    const byType = (globals.byType && typeof globals.byType === 'object') ? globals.byType : {};
    const perType = sanitizeMentions(typeKey ? byType[typeKey] : null) || [];
    const fallback = sanitizeMentions(globals.default) || [];

    const out = [];
    const add = (list) => list.forEach(n => { if (!out.includes(n)) out.push(n); });

    // Whoever owns the notification TYPE is always on the hook.
    add(perType);

    // The global default is a safety net, not an addition: it applies only when
    // nobody more specific has been named, so setting it does not spam every
    // person on every alert.
    if (out.length === 0) add(fallback);
    return out;
  } catch (err) {
    console.error(`[NotificationPolicy] Mention lookup failed: ${err.message}`);
    return [];
  }
}

/**
 * Mentions for a notification type that is not tied to any schedule
 * (certificates, agent connectivity, and so on).
 */
async function getMentionsForType(typeKey) {
  return getMentionsForSchedules([], typeKey);
}

/**
 * Certificate mentions. Reads the per-type list for the specific certificate
 * event, falling back to the legacy `mentions.certificate` key so an existing
 * settings file keeps working.
 */
async function getCertificateMentions(typeKey = 'certificateExpiring') {
  const globals = await loadGlobalMentions();
  const byType = (globals.byType && typeof globals.byType === 'object') ? globals.byType : {};

  // Read the per-type list DIRECTLY rather than through getMentionsForType:
  // that helper already substitutes the global default when a type has no
  // owner, which would shadow the legacy key below and silently ignore an
  // existing mentions.certificate setting on upgrade.
  const perType = sanitizeMentions(byType[typeKey]) || [];
  if (perType.length > 0) return perType;

  const legacy = sanitizeMentions(globals.certificate) || [];
  if (legacy.length > 0) return legacy;

  return sanitizeMentions(globals.default) || [];
}

module.exports = {
  getMentionsForSchedules,
  getMentionsForType,
  getCertificateMentions,
  sanitizeMentions,
};
