const path = require('path');
const config = require('../config/config');
const { getBackupSchedules, getBackupHosts, readJSON, writeJSON } = require('./fileStorage');
const { stripAnsi } = require('../utils/stripAnsi');

const NOTIFICATION_SETTINGS_FILE = path.join(config.dataDir, 'notification-settings.json');

/**
 * One Rocket.Chat message per "day" listing every VM with a backup problem
 * (failed backup, failed/partial offsite sync, skipped run) — edited in place
 * as issues come in, instead of a separate message per event. Successes never
 * appear here; see rocketChatService.notifyBackupCompleted for those and for
 * the separate "recovered" ping.
 *
 * The "day" is not a fixed clock hour: it's anchored to the earliest clock
 * time any enabled schedule is set to run at (recomputed from the live
 * schedule list on every call), so the board rolls over right before the
 * night's backups start rather than at an arbitrary hour. A period is never
 * held open past 24h regardless, in case the anchor shifts later mid-period.
 */

const STATE_FILE = path.join(config.dataDir, 'daily-incident-board-state.json');
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DETAIL_LEN = 200;

const SEVERITY_ICON = {
  'backup-failed': '🔴',
  offsite: '🟠',
  skipped: '⚪',
  // Independent replication. A sync no longer rides along with the backup that
  // asked for it, so it fails, falls behind and gets refused on its own — and
  // each of those is a distinct thing to say on the board.
  'offsite-failed': '🟠',        // the whole replication job failed
  'offsite-behind': '🟠',        // the check found the offsite copy out of date
  'offsite-unsupported': '🟠',   // the agent cannot replicate at all
  'source-unavailable': '🔴',    // the pool holding the backups is not mounted
};

/**
 * Which of the three counters on the summary line a kind belongs to.
 *
 * The icon map is the thing operators read; this is what keeps the header's
 * "🔴 n Failed · 🟠 n Warnings · ⚪ n Unknown" honest as kinds are added, rather
 * than the counts being hardcoded to three specific kind names.
 */
const SEVERITY_TIER = {
  'backup-failed': 'critical',
  'source-unavailable': 'critical',
  offsite: 'warning',
  'offsite-failed': 'warning',
  'offsite-behind': 'warning',
  'offsite-unsupported': 'warning',
  skipped: 'unknown',
};

/**
 * Kinds that describe a whole backup host rather than one VM.
 *
 * An unmounted pool or an agent that cannot replicate takes every VM on that
 * host down at once; one line per VM would bury the single fact that matters.
 * These are keyed per host so two hosts with the same problem stay two lines.
 */
const HOST_LEVEL_KINDS = new Set(['offsite-unsupported', 'source-unavailable']);

class DailyIncidentBoardService {
  initialize() {
    console.log('✓ Daily incident board initialized');
  }

  /**
   * The rollover instant: the earliest clock time any enabled schedule fires
   * at. Recomputed on every call (cheap — one file read) rather than cached,
   * so a schedule added/edited/removed is picked up immediately with no
   * separate invalidation path.
   */
  async computeAnchorMinuteOfDay() {
    let schedules = [];
    try {
      schedules = await getBackupSchedules();
    } catch (err) {
      console.error('[IncidentBoard] Failed to read schedules for anchor:', err.message);
    }

    const candidates = [];
    for (const schedule of schedules || []) {
      if (!schedule || schedule.enabled === false) continue;

      if (schedule.scheduleType === 'custom-days') {
        for (const cd of schedule.customDates || []) {
          const m = this._parseTimeOfDay(cd && cd.time);
          if (m !== null) candidates.push(m);
        }
        continue;
      }

      // interval and raw cron schedules have no single representative clock
      // time (e.g. "every 4 hours", or an arbitrary user expression) — they
      // don't define a meaningful "earliest start" anchor.
      if (!['daily', 'weekly', 'monthly', 'once'].includes(schedule.scheduleType)) continue;
      if (!schedule.cronExpression) continue;

      const parts = schedule.cronExpression.split(' ');
      if (parts.length !== 5) continue;
      const [minute, hour] = parts;
      if (hour.includes('/') || minute.includes('/')) continue;

      const h = parseInt(hour, 10);
      const m = parseInt(minute, 10);
      if (Number.isFinite(h) && Number.isFinite(m)) candidates.push(h * 60 + m);
    }

    if (candidates.length === 0) return 0; // midnight fallback when nothing qualifies
    return Math.min(...candidates);
  }

  _parseTimeOfDay(time) {
    if (!time || typeof time !== 'string') return null;
    const [h, m] = time.split(':');
    const hh = parseInt(h, 10);
    const mm = parseInt(m, 10);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
    return hh * 60 + mm;
  }

  _todayAnchor(now, anchorMinuteOfDay) {
    const d = new Date(now);
    d.setHours(Math.floor(anchorMinuteOfDay / 60), anchorMinuteOfDay % 60, 0, 0);
    return d;
  }

  _freshState(now) {
    return {
      periodStart: now.toISOString(),
      lastUpdatedAt: now.toISOString(),
      roomId: null,
      messageId: null,
      entries: [],
    };
  }

  _truncate(text, len = MAX_DETAIL_LEN) {
    const s = (text === undefined || text === null) ? '' : String(text);
    return s.length > len ? `${s.slice(0, len)}…` : s;
  }

  /**
   * Serialized read-modify-write for the board's state file.
   *
   * fileStorage.mutateJSON deliberately writes back the SAME reference it
   * read, and readJSON returns `[]` for a missing file — so on first run we'd
   * Object.assign onto an array and JSON.stringify would silently drop every
   * property, losing messageId and posting a brand-new message forever
   * instead of editing one. Chaining here gives the same no-interleaving
   * guarantee (one controller process — see fileStorage's own reasoning)
   * while letting us swap in a fresh object.
   */
  _withState(fn) {
    const run = async () => {
      let state = await readJSON(STATE_FILE);
      if (!state || Array.isArray(state) || typeof state !== 'object') {
        state = this._freshState(new Date());
      }
      await fn(state);
      await writeJSON(STATE_FILE, state);
    };
    const next = (this._queue || Promise.resolve()).then(run, run);
    // Keep the chain alive but swallow errors, so one failure doesn't poison
    // every later call.
    this._queue = next.catch(() => {});
    return next;
  }

  /**
   * Record one failed/partial/skipped backup outcome onto today's card,
   * posting a new Rocket.Chat message if none is open yet, or editing the
   * existing one in place.
   *
   * @param {object} ev
   * @param {string} ev.vm
   * @param {'backup-failed'|'offsite'|'skipped'|'offsite-failed'|'offsite-behind'|'offsite-unsupported'|'source-unavailable'} ev.kind
   * @param {string} [ev.detail]               - error/reason text
   * @param {string} [ev.scheduleId]
   * @param {string} [ev.offsiteHost]          - for kind 'offsite': the failed destination's name
   * @param {string} [ev.backupHostId]         - which backup host this VM's job ran on; drives
   *   both which zone it's grouped under and whether a new entry gets a mention, via
   *   notification-settings.json's `hostMentions`
   */
  async recordIssue({ vm, kind, detail, scheduleId, offsiteHost, backupHostId }) {
    if (!vm || !kind) return;

    const rocketChatService = require('./rocketChatService');

    const anchorMinuteOfDay = await this.computeAnchorMinuteOfDay();

    await this._withState(async (state) => {
      const now = new Date();

      if (!state.periodStart) {
        Object.assign(state, this._freshState(now));
      } else {
        const periodStart = new Date(state.periodStart);
        const todayAnchor = this._todayAnchor(now, anchorMinuteOfDay);
        const anchorCrossed = periodStart < todayAnchor && todayAnchor <= now;
        const tooOld = (now - periodStart) >= DAY_MS;
        if (anchorCrossed || tooOld) {
          Object.assign(state, this._freshState(now));
        }
      }
      state.lastUpdatedAt = now.toISOString();

      // Host-level kinds dedupe per host, not per subject: their subject is a
      // fixed label ("Backup pool"), so without the host id two hosts with the
      // same problem would collapse into one line.
      const key = HOST_LEVEL_KINDS.has(kind)
        ? `${kind}::${backupHostId || ''}`
        : `${vm}::${kind}`;
      let entry = state.entries.find(e => e.key === key);
      const isNewEntry = !entry;
      const nowIso = now.toISOString();

      if (!entry) {
        entry = {
          key, vm, kind, detail: '', targets: [],
          scheduleId: scheduleId || null, backupHostId: backupHostId || null,
          firstAt: nowIso, lastAt: nowIso, updateCount: 0,
        };
        state.entries.push(entry);
      }

      entry.scheduleId = scheduleId || entry.scheduleId || null;
      entry.backupHostId = backupHostId || entry.backupHostId || null;
      entry.lastAt = nowIso;
      entry.updateCount += 1;

      if (kind === 'offsite') {
        const name = this._truncate(offsiteHost, 60);
        if (name && !entry.targets.includes(name)) entry.targets.push(name);
      } else {
        // Every other kind just shows its reason text.
        entry.detail = this._truncate(detail);
      }

      const text = await this._render(state, { isNewEntry, backupHostId: entry.backupHostId });

      if (!state.messageId) {
        const result = await rocketChatService.postNewMessage(text);
        if (result && result.success) {
          state.roomId = result.roomId;
          state.messageId = result.messageId;
        } else {
          console.error('[IncidentBoard] Failed to post board message:', result && result.error);
        }
      } else {
        const result = await rocketChatService.updateMessageById(state.roomId, state.messageId, text);
        if (!result || !result.success) {
          console.error('[IncidentBoard] Failed to update board message:', result && result.error);
        }
      }
    });
  }

  /**
   * Mentions for a backup host, from notification-settings.json's
   * `hostMentions` (an array of `{ backupHostId, mentions }`, managed in
   * Settings -> Notifications -> "Notify by backup host"). A host that isn't
   * on the list gets no mention — the entry still appears on the board, just
   * silently.
   */
  async _mentionsForHost(backupHostId) {
    if (!backupHostId) return [];
    try {
      const settings = await readJSON(NOTIFICATION_SETTINGS_FILE);
      const list = settings && !Array.isArray(settings) && Array.isArray(settings.hostMentions)
        ? settings.hostMentions
        : [];
      const match = list.find(h => h && h.backupHostId === backupHostId);
      return (match && Array.isArray(match.mentions)) ? match.mentions : [];
    } catch (err) {
      console.error('[IncidentBoard] hostMentions lookup failed:', err.message);
      return [];
    }
  }

  _hhmm(iso) {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  /** One line for an entry, in the plain (non-markdown) style — see _render(). */
  _entryLine(entry) {
    const icon = SEVERITY_ICON[entry.kind] || '⚪';
    const vm = stripAnsi(entry.vm);
    const detail = stripAnsi(entry.detail, { singleLine: true });

    if (entry.kind === 'offsite') {
      const names = entry.targets.map(t => stripAnsi(t)).filter(Boolean).join(', ');
      return names
        ? `${icon} ${vm} — ❌ ${names} (Offsite Backup)`
        : `${icon} ${vm} — ❌ offsite sync failed`;
    }

    // The replication kinds each say what state the offsite copy is actually
    // in, because "offsite sync failed" covers three situations an operator
    // would respond to completely differently.
    if (entry.kind === 'offsite-failed') {
      return `${icon} ${vm} — ❌ replication failed${detail ? ` (${detail})` : ''}`;
    }
    if (entry.kind === 'offsite-behind') {
      return `${icon} ${vm} — ⏳ offsite copy is behind${detail ? ` (${detail})` : ''}`;
    }
    if (entry.kind === 'offsite-unsupported') {
      return `${icon} ${vm} — ⚠️ ${detail || 'agent cannot replicate — update it'}`;
    }
    if (entry.kind === 'source-unavailable') {
      return `${icon} ${vm} — ⛔ ${detail || 'not mounted — replication refused'}`;
    }

    return `${icon} ${vm}${detail ? ` — ${detail}` : ''}`;
  }

  /**
   * Everything except the mention line is wrapped in a fenced code block —
   * Rocket.Chat (like most chat platforms) renders text inside ``` literally
   * rather than parsing markdown or @mentions, which is exactly what keeps
   * this a clean fixed-width card. The mention line has to stay OUTSIDE the
   * fence, or it would never actually notify anyone.
   */
  async _render(state, { isNewEntry, backupHostId }) {
    let hosts = [];
    try {
      hosts = await getBackupHosts();
    } catch (err) {
      console.error('[IncidentBoard] Failed to read backup hosts for zone names:', err.message);
    }
    const hostName = (id) => {
      const host = id && hosts.find(h => h && h.id === id);
      return host ? host.name : null;
    };

    // Counted by severity tier rather than by kind name, so the header stays
    // correct as new kinds are added instead of silently omitting them.
    const counts = { critical: 0, warning: 0, unknown: 0 };
    for (const entry of state.entries) {
      const tier = SEVERITY_TIER[entry.kind] || 'unknown';
      counts[tier] += 1;
    }
    const total = state.entries.length;
    const severityWord = counts.critical > 0 ? 'CRITICAL' : counts.warning > 0 ? 'WARNING' : 'NOTICE';

    // Group by zone (backup host), preserving each zone's first-appearance
    // order and each entry's insertion order within it.
    const zoneOrder = [];
    const zones = new Map();
    for (const entry of state.entries) {
      const zoneKey = entry.backupHostId || '';
      if (!zones.has(zoneKey)) {
        zoneOrder.push(zoneKey);
        zones.set(zoneKey, { label: (hostName(entry.backupHostId) || 'UNKNOWN HOST').toUpperCase(), entries: [] });
      }
      zones.get(zoneKey).entries.push(entry);
    }

    const card = [];
    card.push(`🚨 BACKUP HEALTH — ${severityWord}`);
    card.push('');
    card.push(`🔴 ${counts.critical} Failed · 🟠 ${counts.warning} Warnings · ⚪ ${counts.unknown} Unknown`);
    card.push(`${total} issue${total === 1 ? '' : 's'} · Created ${this._hhmm(state.periodStart)} · Updated ${this._hhmm(state.lastUpdatedAt)}`);

    for (const zoneKey of zoneOrder) {
      const zone = zones.get(zoneKey);
      card.push('');
      card.push(zone.label);
      for (const entry of zone.entries) card.push(this._entryLine(entry));
    }

    card.push('');
    card.push(`🤖 ${require('./rocketChatService').entity || 'Backup Manager'}`);

    const lines = [];
    if (isNewEntry) {
      const mentions = await this._mentionsForHost(backupHostId);
      if (mentions.length > 0) {
        lines.push(mentions.map(m => `@${m}`).join(' '));
        lines.push('');
      }
    }
    lines.push('```');
    lines.push(...card);
    lines.push('```');

    return lines.join('\n');
  }
}

module.exports = new DailyIncidentBoardService();
