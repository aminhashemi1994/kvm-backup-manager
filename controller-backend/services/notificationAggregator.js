const path = require('path');
const config = require('../config/config');
const { readJSON, writeJSON } = require('./fileStorage');

/**
 * Collapses a burst of per-VM notifications into one message per root cause.
 *
 * The problem this solves, measured from a real night: 15 VMs failed with the
 * identical libvirt error and produced 30 messages (one failure + one
 * "multiple failures" each); one unreachable offsite host produced ~60 more as
 * the resync retried every few minutes. Around 130 messages described four
 * incidents. Nobody reads that, which means the one genuinely new failure in
 * the middle of it gets missed — the exact outcome the alerts exist to prevent.
 *
 * Two mechanisms, and they are independent:
 *
 *  1. GROUPING. Events are bucketed by (kind, normalised cause) and flushed as
 *     a single message once the burst goes quiet. 15 VMs failing for one reason
 *     become one message naming all 15.
 *
 *  2. REPEAT SUPPRESSION. A VM that failed last night for reason X and failed
 *     again tonight for reason X is not news; it is the same open incident. It
 *     is counted ("still failing: 15") rather than announced. Only transitions
 *     — a NEW failure, or a RECOVERY — are announced. This is what stops a
 *     three-week-old breakage being re-reported as fresh every single night.
 *
 * State survives restarts, otherwise a controller bounce would re-announce
 * every open incident as new.
 */

const STATE_FILE = path.join(config.dataDir, 'notification-aggregator-state.json');

// Wait this long after the LAST event in a group before sending. Backup runs
// finish in bursts seconds apart, so a short quiet period captures the whole
// wave without delaying the alert meaningfully.
const DEFAULT_WINDOW_MS = 90 * 1000;
// ...but never hold a group longer than this, so a slow trickle of failures
// still reports within a predictable time.
const DEFAULT_MAX_WAIT_MS = 10 * 60 * 1000;

class NotificationAggregator {
  constructor() {
    this.groups = new Map();      // groupKey -> { kind, cause, events[], firstAt, timer, maxTimer }
    this.knownFailing = new Map(); // "kind|subject" -> { cause, since, count }
    this.loaded = false;
    this.settings = {
      enabled: true,
      windowMs: DEFAULT_WINDOW_MS,
      maxWaitMs: DEFAULT_MAX_WAIT_MS,
      suppressRepeats: true,
      // Suppression must not be permanent. Without this, a fault that recurs
      // every night is announced exactly once and then never again — the
      // operator sees a warning in the panel and no message anywhere, which is
      // precisely how a broken offsite destination goes unnoticed for days.
      // A standing incident re-announces on this interval.
      repeatRenotifyMs: 24 * 60 * 60 * 1000,
      // The counterweight to suppression — see sendDigest().
      digestEnabled: true,
      digestHour: 9,
      digestWhenClear: true,
    };
    this.lastDigestDate = null;   // 'YYYY-MM-DD' of the last digest sent
    this.digestTimer = null;
  }

  async initialize(settings = {}) {
    this.applySettings(settings);
    await this.loadState();
    console.log('✓ Notification aggregator initialized');
    console.log(`  Grouping: ${this.settings.enabled ? 'on' : 'off'} (window ${this.settings.windowMs / 1000}s, max wait ${this.settings.maxWaitMs / 60000}m)`);
    console.log(`  Repeat suppression: ${this.settings.suppressRepeats ? 'on' : 'off'}`);
    console.log(`  Daily digest: ${this.settings.digestEnabled ? `on at ${this.settings.digestHour}:00` : 'OFF — suppressed incidents will be silent'}`);
    console.log(`  Open incidents carried over: ${this.knownFailing.size}`);

    if (this.settings.suppressRepeats && !this.settings.digestEnabled) {
      console.warn('[NotifAgg] WARNING: repeat suppression is on but the daily digest is off.');
      console.warn('[NotifAgg]   A long-running failure will go completely silent after its first report.');
    }

    this.startDigestTimer();
  }

  applySettings(settings = {}) {
    if (typeof settings.enabled === 'boolean') this.settings.enabled = settings.enabled;
    if (typeof settings.suppressRepeats === 'boolean') this.settings.suppressRepeats = settings.suppressRepeats;
    // 0 restores the old behaviour: suppress a standing incident forever.
    if (Number.isFinite(settings.repeatRenotifyHours) && settings.repeatRenotifyHours >= 0) {
      this.settings.repeatRenotifyMs = settings.repeatRenotifyHours * 60 * 60 * 1000;
    }
    if (Number.isFinite(settings.windowSeconds) && settings.windowSeconds > 0) {
      this.settings.windowMs = settings.windowSeconds * 1000;
    }
    if (Number.isFinite(settings.maxWaitSeconds) && settings.maxWaitSeconds > 0) {
      this.settings.maxWaitMs = settings.maxWaitSeconds * 1000;
    }
    if (typeof settings.digestEnabled === 'boolean') this.settings.digestEnabled = settings.digestEnabled;
    if (typeof settings.digestWhenClear === 'boolean') this.settings.digestWhenClear = settings.digestWhenClear;
    if (Number.isFinite(settings.digestHour) && settings.digestHour >= 0 && settings.digestHour <= 23) {
      this.settings.digestHour = settings.digestHour;
    }
  }

  /**
   * The daily digest exists because suppression alone is dangerous.
   *
   * Once an incident is known, every later occurrence is silenced — so a VM
   * broken for three weeks produces nothing at all after night one. That is
   * correct for noise, and catastrophic for trust: silence would mean both
   * "nothing new" and "the controller died / RocketChat broke / the webhook
   * expired", and there would be no way to tell which.
   *
   * So one message goes out every day no matter what. If incidents are open it
   * lists them with their age; if none are, it says so. Either way the message
   * arriving is proof the pipeline works, and a missing digest becomes a signal
   * in its own right.
   */
  startDigestTimer() {
    if (this.digestTimer) clearInterval(this.digestTimer);
    // Poll rather than schedule a single far-future timer: survives clock
    // changes and long suspends, and costs nothing.
    this.digestTimer = setInterval(() => {
      this.maybeSendDigest().catch(err => console.error('[NotifAgg] Digest failed:', err.message));
    }, 5 * 60 * 1000);
    if (this.digestTimer.unref) this.digestTimer.unref();
  }

  async maybeSendDigest(now = new Date()) {
    if (!this.settings.digestEnabled) return false;

    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    if (this.lastDigestDate === today) return false;
    if (now.getHours() < this.settings.digestHour) return false;

    this.lastDigestDate = today;
    await this.saveState();
    return this.sendDigest();
  }

  sendDigest() {
    const rocketChatService = require('./rocketChatService');
    if (!rocketChatService.isTypeEnabled('dailyDigest')) return false;
    const open = [...this.knownFailing.entries()];

    if (open.length === 0) {
      if (!this.settings.digestWhenClear) return false;
      rocketChatService.sendGrouped({
        entity: 'Backup',
        state: 'Daily Digest',
        status: 'All Clear',
        name: 'No open incidents',
        details: 'No backup or offsite failures are currently open.\nThis message also confirms the notification pipeline is working.',
      });
      console.log('[NotifAgg] Daily digest sent: all clear');
      return true;
    }

    // Re-group the open incidents by cause so the digest reads as a list of
    // problems, not a list of VMs.
    const byCause = new Map();
    for (const [key, value] of open) {
      const subject = key.split('::')[0];
      if (!byCause.has(value.cause)) byCause.set(value.cause, { subjects: [], oldest: value.since });
      const entry = byCause.get(value.cause);
      entry.subjects.push(subject);
      if (new Date(value.since) < new Date(entry.oldest)) entry.oldest = value.since;
    }

    const ageInDays = (iso) => {
      const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
      return days >= 1 ? `${days}d` : '<1d';
    };

    const lines = [];
    const sorted = [...byCause.entries()].sort((a, b) => b[1].subjects.length - a[1].subjects.length);
    for (const [cause, entry] of sorted) {
      const shown = entry.subjects.slice(0, 8);
      const more = entry.subjects.length - shown.length;
      lines.push(`• ${cause}`);
      lines.push(`   ${entry.subjects.length} VM${entry.subjects.length === 1 ? '' : 's'}, open ${ageInDays(entry.oldest)} — ${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`);
    }

    rocketChatService.sendGrouped({
      entity: 'Backup',
      state: 'Daily Digest',
      status: `${open.length} Still Failing`,
      name: `${byCause.size} open incident${byCause.size === 1 ? '' : 's'}`,
      details: lines.join('\n'),
    });

    console.log(`[NotifAgg] Daily digest sent: ${open.length} open across ${byCause.size} cause(s)`);
    return true;
  }

  async loadState() {
    if (this.loaded) return;
    try {
      const stored = await readJSON(STATE_FILE);
      if (stored && !Array.isArray(stored)) {
        if (stored.knownFailing) this.knownFailing = new Map(Object.entries(stored.knownFailing));
        // Carried across restarts so a bouncing controller can't send the
        // digest repeatedly, nor skip it.
        if (stored.lastDigestDate) this.lastDigestDate = stored.lastDigestDate;
      }
    } catch (_) {
      this.knownFailing = new Map();
    }
    this.loaded = true;
  }

  async saveState() {
    try {
      await writeJSON(STATE_FILE, {
        knownFailing: Object.fromEntries(this.knownFailing),
        lastDigestDate: this.lastDigestDate,
        savedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[NotifAgg] Failed to persist state:', err.message);
    }
  }

  /**
   * Reduce an error string to something stable enough to group by.
   *
   * Two VMs failing with the same underlying fault must land in the same
   * bucket, so the volatile parts — ids, paths, timestamps, per-run suffixes
   * like "(all retries exhausted)" — have to come off first.
   */
  normalizeCause(reason) {
    if (!reason) return 'unspecified';
    let s = String(reason);
    s = s.replace(/\(all retries exhausted\)/gi, '');
    s = s.replace(/\(attempt \d+\/\d+\)/gi, '');
    s = s.replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?\b/g, '');       // timestamps
    s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, ''); // uuids
    s = s.replace(/\b\d{6,}\b/g, '');                                 // long numeric ids
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(/[.:;,\s]+$/, '');
    return s.slice(0, 160) || 'unspecified';
  }

  /**
   * Record an event. Failures and successes both come here; the aggregator
   * decides what is worth saying.
   *
   * @param {object} ev
   * @param {string} ev.kind      - 'backup-failed' | 'backup-completed' | 'offsite-failed' | ...
   * @param {string} ev.subject   - the VM (or host) the event is about
   * @param {string} [ev.cause]   - error text, for failures
   * @param {string} [ev.context] - extra detail shown on the grouped message
   * @param {function} ev.sendSingle - fallback that sends the original ungrouped message
   */
  submit(ev) {
    if (!this.settings.enabled) {
      return ev.sendSingle && Promise.resolve(ev.sendSingle())
        .catch(err => console.error('[NotifAgg] sendSingle failed:', err.message));
    }

    const isFailure = ev.kind.includes('failed') || ev.kind.includes('failure');
    const cause = this.normalizeCause(ev.cause);

    // An open incident is identified by (subject, cause) — deliberately NOT by
    // event kind. The same fault on the same VM arrives under several kinds:
    // 'backup-failed' when it happens, then 'backup-repeat-failure' from the
    // reliability monitor. Keying on kind would treat those as two separate
    // incidents and announce both, which is precisely the doubled-up
    // "Failed" + "Multiple Failures" pairing that made the real log twice as
    // long as it needed to be.
    const stateKey = `${ev.subject}::${cause}`;

    if (isFailure && this.settings.suppressRepeats) {
      const known = this.knownFailing.get(stateKey);
      if (known && known.cause === cause) {
        // Same VM, same fault, still broken.
        known.count = (known.count || 1) + 1;
        known.lastAt = new Date().toISOString();

        // Announce again once the re-notify interval has passed, so a fault
        // that keeps recurring keeps being reported — daily by default rather
        // than once and then silence. Older state files have no
        // lastAnnouncedAt; fall back to `since`, which is when the incident
        // was first announced.
        const lastAnnounced = Date.parse(known.lastAnnouncedAt || known.since || '') || 0;
        const due = this.settings.repeatRenotifyMs > 0
          && Date.now() - lastAnnounced >= this.settings.repeatRenotifyMs;

        if (!due) {
          this.enqueue(ev.kind, cause, { ...ev, repeat: true });
          return;
        }

        known.lastAnnouncedAt = new Date().toISOString();
        this.saveState().catch(() => {});
        // Fall through and treat it as fresh: it is still news, just not new.
      } else {
        this.knownFailing.set(stateKey, {
          cause,
          since: new Date().toISOString(),
          lastAt: new Date().toISOString(),
          lastAnnouncedAt: new Date().toISOString(),
          count: 1,
        });
        this.saveState().catch(() => {});
      }
    }

    // The daily incident board now owns the message for this event; we're
    // only here to keep knownFailing accurate so a later success still
    // triggers a recovery announcement.
    if (ev.trackOnly) return;

    if (!isFailure) {
      // A success clears any open incident for this subject, and that
      // transition IS worth reporting — a recovery is the thing an operator
      // waiting on a fix actually wants to hear.
      const failKeys = [...this.knownFailing.keys()].filter(k => k.startsWith(`${ev.subject}::`));
      if (failKeys.length > 0) {
        failKeys.forEach(k => this.knownFailing.delete(k));
        this.saveState().catch(() => {});
        // Explicitly NOT muted, whatever the incoming event carried. A
        // recovery is a different event from a routine success: switching off
        // "every backup completed" must not also switch off "the VM that has
        // been failing for three weeks just came back", which is the single
        // most useful message this system sends.
        this.enqueue('recovered', 'recovered', { ...ev, recovered: true, mute: false });
        return;
      }
    }

    this.enqueue(ev.kind, cause, ev);
  }

  enqueue(kind, cause, ev) {
    const groupKey = `${kind}::${cause}`;
    let group = this.groups.get(groupKey);

    if (!group) {
      group = { kind, cause, events: [], firstAt: Date.now(), timer: null, maxTimer: null };
      this.groups.set(groupKey, group);
      // Hard ceiling on how long a group may accumulate.
      group.maxTimer = setTimeout(() => this.flush(groupKey), this.settings.maxWaitMs);
      if (group.maxTimer.unref) group.maxTimer.unref();
    }

    group.events.push(ev);

    // Debounce: each new event pushes the send out, so the whole burst lands
    // in one message.
    if (group.timer) clearTimeout(group.timer);
    group.timer = setTimeout(() => this.flush(groupKey), this.settings.windowMs);
    if (group.timer.unref) group.timer.unref();
  }

  flush(groupKey) {
    const group = this.groups.get(groupKey);
    if (!group) return;
    this.groups.delete(groupKey);
    if (group.timer) clearTimeout(group.timer);
    if (group.maxTimer) clearTimeout(group.maxTimer);

    const fresh = group.events.filter(e => !e.repeat);
    const repeats = group.events.filter(e => e.repeat);

    // Everything in this group is an already-known open incident — say
    // nothing. This is the case that removes the nightly re-announcement.
    if (fresh.length === 0) {
      console.log(`[NotifAgg] Suppressed ${repeats.length} repeat notification(s): ${group.cause.slice(0, 80)}`);
      return;
    }

    // Every event here is muted (its notification type is switched off). It was
    // still processed — incidents cleared, recoveries detected — but there is
    // nothing to announce.
    if (fresh.every(e => e.mute)) {
      return;
    }

    // A single new event with nothing to group it with keeps its original,
    // more detailed message — grouping should never make one failure harder
    // to read than it was before.
    if (fresh.length === 1 && repeats.length === 0 && typeof fresh[0].sendSingle === 'function') {
      // sendSingle resolves its own mentions, so it may be async — catch both
      // a synchronous throw and a rejected promise.
      try {
        Promise.resolve(fresh[0].sendSingle())
          .catch(err => console.error('[NotifAgg] sendSingle failed:', err.message));
      } catch (err) {
        console.error('[NotifAgg] sendSingle failed:', err.message);
      }
      return;
    }

    this.send(group, fresh, repeats).catch(err => {
      console.error('[NotifAgg] Failed to send grouped message:', err.message);
    });
  }

  async send(group, fresh, repeats) {
    // Lazy require: rocketChatService routes into this module, so requiring it
    // at load time would be circular.
    const rocketChatService = require('./rocketChatService');

    // Who is on the hook. Resolved at send time from the schedules involved,
    // unioned across the whole group — one grouped message can span VMs owned
    // by different people, and dropping one of them leaves an incident with
    // nobody assigned.
    let mentions = [];
    try {
      const scheduleIds = fresh.map(e => e.scheduleId).filter(Boolean);
      // Map the aggregator's internal kind back to the settings type key.
      // 'backup-failed'/'offsite-failed' never reach here: rocketChatService
      // submits those with trackOnly:true (the daily incident board owns
      // their messaging), so submit() returns before enqueue(). Successes and
      // recoveries are mentioned too: they are grouped messages a person
      // asked to be named on, and staying silent on them is exactly the bug
      // where configured people never appeared.
      const TYPE_BY_KIND = {
        'backup-repeat-failure': 'multipleBackupFailures',
        'backup-completed': 'backupCompleted',
        'recovered': 'backupCompleted',
      };
      mentions = await require('./notificationPolicyService')
        .getMentionsForSchedules(scheduleIds, TYPE_BY_KIND[group.kind] || null);
    } catch (err) {
      console.error('[NotifAgg] Mention lookup failed:', err.message);
    }

    const subjects = fresh.map(e => e.subject).filter(Boolean);
    const shown = subjects.slice(0, 12);
    const more = subjects.length - shown.length;

    const recovered = group.kind === 'recovered';
    const isFailure = !recovered && (group.kind.includes('failed') || group.kind.includes('failure'));

    const lines = [];
    if (!recovered && group.cause && group.cause !== 'unspecified') {
      lines.push(`Cause: ${group.cause}`);
    }
    lines.push(`Affected: ${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`);
    if (repeats.length > 0) {
      lines.push(`Also still failing (already reported): ${repeats.length}`);
    }
    const contexts = [...new Set(fresh.map(e => e.context).filter(Boolean))];
    if (contexts.length === 1) {
      lines.push(contexts[0]);
    } else if (contexts.length > 1) {
      lines.push(`Destinations: ${contexts.slice(0, 4).join(', ')}${contexts.length > 4 ? ` (+${contexts.length - 4})` : ''}`);
    }

    const entity = recovered ? 'Backup'
      : group.kind.startsWith('offsite') ? 'Offsite Sync'
      : 'Backup';

    if (!rocketChatService.isTypeEnabled('groupedSummary')) return;

    rocketChatService.sendGrouped({
      entity,
      state: recovered ? 'Recovery' : (isFailure ? 'Failure Summary' : 'Summary'),
      status: recovered
        ? `${fresh.length} Recovered`
        : `${fresh.length} ${isFailure ? 'Failed' : 'Affected'}`,
      name: `${fresh.length} VM${fresh.length === 1 ? '' : 's'}`,
      details: lines.join('\n'),
      mentions,
    });

    console.log(`[NotifAgg] Sent grouped message: ${group.kind} × ${fresh.length} (${repeats.length} repeats folded in)`);
  }

  /** Flush everything immediately — used on shutdown so nothing is lost. */
  flushAll() {
    for (const key of [...this.groups.keys()]) this.flush(key);
  }

  getStatus() {
    return {
      settings: { ...this.settings },
      pendingGroups: this.groups.size,
      openIncidents: this.knownFailing.size,
      incidents: [...this.knownFailing.entries()].slice(0, 50).map(([key, v]) => ({
        key, cause: v.cause, since: v.since, occurrences: v.count,
      })),
    };
  }

  /** Forget an open incident so the next failure reports as new again. */
  clearIncidents() {
    this.knownFailing.clear();
    return this.saveState();
  }

  shutdown() {
    if (this.digestTimer) {
      clearInterval(this.digestTimer);
      this.digestTimer = null;
    }
    this.flushAll();
  }
}

module.exports = new NotificationAggregator();
