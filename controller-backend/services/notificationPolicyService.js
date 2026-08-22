const path = require('path');
const config = require('../config/config');
const { readJSON, getBackupSchedules } = require('./fileStorage');

const SETTINGS_FILE = path.join(config.dataDir, 'notification-settings.json');

/**
 * Which notification events exist, and what they mean when nobody has said
 * otherwise. Failures default ON and routine successes default OFF: an alert
 * you never asked for is noise, but a missed failure is a backup you think you
 * have and don't.
 */
const EVENT_DEFAULTS = Object.freeze({
  backupSuccess: false,
  backupFailure: true,
  offsiteSuccess: false,
  offsitePartial: true,
  offsiteFailure: true,
  retry: false,
  missed: true,
  // Defaults ON: the agents deliberately keep running through an expired
  // certificate, so this alert is the only thing standing between a survivable
  // degradation and one nobody notices until the browser locks everyone out.
  certificateExpiry: true,
});

const EVENT_KEYS = Object.freeze(Object.keys(EVENT_DEFAULTS));

// Settings live in a JSON file that changes rarely and is read on every
// notification decision, so hold a short-lived cache rather than hitting disk
// each time a job posts a status update.
let _cache = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 10000;

async function loadGlobalEvents() {
  const now = Date.now();
  if (_cache && now - _cacheAt < CACHE_TTL_MS) return _cache;
  let events = {};
  try {
    const stored = await readJSON(SETTINGS_FILE);
    if (stored && !Array.isArray(stored) && stored.events && typeof stored.events === 'object') {
      events = stored.events;
    }
  } catch (_) {
    events = {};
  }
  _cache = { ...EVENT_DEFAULTS, ...events };
  _cacheAt = now;
  return _cache;
}

/** Drop the cache so a settings save takes effect immediately. */
function invalidateCache() {
  _cache = null;
  _cacheAt = 0;
}

/**
 * Should `eventKey` be announced for this schedule?
 *
 * Resolution order: the schedule's own toggle → the global default → the
 * built-in default. A schedule value of null/undefined means "inherit", which
 * is what every pre-existing schedule has, so behaviour is unchanged until
 * someone opts in.
 *
 * @param {object|string|null} scheduleOrId - schedule record, schedule id, or null for a
 *   non-schedule-scoped event (falls through to the global setting).
 * @param {string} eventKey - one of EVENT_KEYS.
 * @returns {Promise<boolean>}
 */
async function shouldNotify(scheduleOrId, eventKey) {
  // Fail OPEN. If the policy lookup breaks for any reason we would rather send
  // a redundant message than swallow a failure alert.
  try {
    if (!EVENT_KEYS.includes(eventKey)) return true;

    const globals = await loadGlobalEvents();
    const globalValue = typeof globals[eventKey] === 'boolean'
      ? globals[eventKey]
      : EVENT_DEFAULTS[eventKey];

    let schedule = null;
    if (scheduleOrId && typeof scheduleOrId === 'object') {
      schedule = scheduleOrId;
    } else if (typeof scheduleOrId === 'string' && scheduleOrId) {
      const schedules = await getBackupSchedules();
      schedule = schedules.find(s => s.id === scheduleOrId) || null;
    }

    const perSchedule = schedule && schedule.notifications
      ? schedule.notifications[eventKey]
      : undefined;

    return typeof perSchedule === 'boolean' ? perSchedule : globalValue;
  } catch (err) {
    console.error(`[NotificationPolicy] ${eventKey} lookup failed, notifying anyway: ${err.message}`);
    return true;
  }
}

/**
 * Should `eventKey` be announced for something scoped to a backup host rather
 * than to one schedule?
 *
 * TLS degradation is the case this exists for: a certificate problem on the
 * agent link belongs to a backup host, and a host carries many schedules. So we
 * ask every schedule bound to that host and let the most cautious answer win —
 * one schedule opting in is enough to send the alert, and we only stay quiet
 * when every schedule that expressed an opinion opted out. Schedules left on
 * "Inherit" don't vote; if nobody voted, the global default decides.
 *
 * @param {string|null} backupHostId - host the event is attributable to, or
 *   null when it isn't attributable to one (falls through to the global value).
 * @param {string} eventKey - one of EVENT_KEYS.
 * @returns {Promise<boolean>}
 */
async function shouldNotifyForBackupHost(backupHostId, eventKey) {
  // Fail OPEN, same reasoning as shouldNotify.
  try {
    if (!EVENT_KEYS.includes(eventKey)) return true;

    const globals = await loadGlobalEvents();
    const globalValue = typeof globals[eventKey] === 'boolean'
      ? globals[eventKey]
      : EVENT_DEFAULTS[eventKey];

    if (!backupHostId) return globalValue;

    const schedules = await getBackupSchedules();
    const votes = (schedules || [])
      .filter(s => s && s.backupHostId === backupHostId)
      .map(s => s.notifications && s.notifications[eventKey])
      .filter(v => typeof v === 'boolean');

    if (votes.length === 0) return globalValue;
    return votes.some(v => v === true);
  } catch (err) {
    console.error(`[NotificationPolicy] ${eventKey} host lookup failed, notifying anyway: ${err.message}`);
    return true;
  }
}

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
 * Three sources, combined rather than ranked:
 *   1. `mentions.byType[typeKey]` — the person who owns this KIND of alert
 *      (set per toggle in Settings -> Notifications). Always included.
 *   2. Each involved schedule's own `notifyMentions`. Unioned in, because a
 *      grouped message can span VMs owned by different people and dropping one
 *      of them is how an incident ends up with nobody on it.
 *   3. `mentions.default` — a safety net used ONLY when 1 and 2 are both empty,
 *      so configuring it does not put the same person on every alert.
 *
 * @param {Array<string>} scheduleIds
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

    const ids = [...new Set((scheduleIds || []).filter(Boolean))];
    if (ids.length > 0) {
      const schedules = await getBackupSchedules();
      for (const id of ids) {
        const schedule = (schedules || []).find(s => s && s.id === id);
        const own = schedule ? sanitizeMentions(schedule.notifyMentions) : undefined;
        if (own && own.length > 0) add(own);
      }
    }

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

/**
 * Normalize a `notifications` object coming from the API: keep only known
 * keys, keep only real booleans, and drop everything else so "inherit" is
 * represented by absence rather than by a null we have to keep re-checking.
 */
function sanitizeScheduleNotifications(input) {
  if (!input || typeof input !== 'object') return undefined;
  const out = {};
  for (const key of EVENT_KEYS) {
    if (typeof input[key] === 'boolean') out[key] = input[key];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

module.exports = {
  shouldNotify,
  shouldNotifyForBackupHost,
  getMentionsForSchedules,
  getMentionsForType,
  getCertificateMentions,
  sanitizeMentions,
  sanitizeScheduleNotifications,
  invalidateCache,
  EVENT_DEFAULTS,
  EVENT_KEYS,
};
