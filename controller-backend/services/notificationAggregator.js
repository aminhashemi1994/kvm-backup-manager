const path = require('path');
const config = require('../config/config');
const { readJSON, writeJSON, getBackupHosts, getBackupJobs } = require('./fileStorage');

// How many VMs one cause lists in the daily digest before collapsing the rest
// into a "+N more" line, and how much of an error sentence its heading carries.
// Both exist to keep the card scannable when a whole host is down.
const DIGEST_ZONE_LIMIT = 12;
const DIGEST_CAUSE_CHARS = 100;

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
    return await this.sendDigest();
  }

  /**
   * Fill in the backup host for incidents that don't carry one.
   *
   * Incidents opened before backupHostId was tracked have none, and without it
   * every one of them would pile up under "UNKNOWN HOST" in the digest. The job
   * history knows which host each VM actually ran on, so resolve it from the
   * most recent job for that VM. Read once per digest, not once per incident.
   */
  async _resolveHostIds(incidents) {
    if (incidents.every(i => i.backupHostId)) return;
    let jobs = [];
    try {
      jobs = await getBackupJobs();
    } catch (err) {
      console.error('[NotifAgg] Job history lookup failed:', err.message);
      return;
    }
    // Latest job per VM wins — a VM moved between hosts should show where it
    // runs now, not where it ran a year ago.
    const latest = new Map();
    for (const job of jobs) {
      if (!job || !job.vmName || !job.backupHostId) continue;
      const at = Date.parse(job.startTime || job.endTime || '') || 0;
      const seen = latest.get(job.vmName);
      if (!seen || at >= seen.at) latest.set(job.vmName, { at, hostId: job.backupHostId });
    }
    for (const incident of incidents) {
      if (incident.backupHostId) continue;
      const hit = latest.get(incident.subject);
      if (hit) incident.backupHostId = hit.hostId;
    }
  }

  /**
   * The once-a-day summary of everything still open.
   *
   * Deliberately grouped by backup host, in the same fixed-width card as the
   * daily incident board, because the two are read together: the board is
   * tonight, this is what is still broken and for how long. The age column is
   * the thing the board cannot show — it resets each day, while these
   * incidents persist until the VM actually backs up.
   *
   * Mentions come from the 'dailyDigest' type (the Summaries section), NOT
   * from hostMentions. That is on purpose: the board already pages the host
   * owners the moment something breaks, and this message is a daily review,
   * not a page.
   */
  async sendDigest() {
    const rocketChatService = require('./rocketChatService');
    if (!rocketChatService.isTypeEnabled('dailyDigest')) return false;

    const incidents = [...this.knownFailing.entries()].map(([key, value]) => ({
      subject: key.split('::')[0],
      cause: value.cause,
      since: value.since,
      backupHostId: value.backupHostId || null,
    }));

    const card = [];
    if (incidents.length === 0) {
      if (!this.settings.digestWhenClear) return false;
      card.push('✅ BACKUP DIGEST — ALL CLEAR');
      card.push('');
      card.push('No backup or offsite failures are open.');
      card.push(`Reported ${this._hhmm(new Date())} · this message also confirms notifications are working.`);
    } else {
      await this._resolveHostIds(incidents);

      let hosts = [];
      try {
        hosts = await getBackupHosts();
      } catch (err) {
        console.error('[NotifAgg] Backup host lookup failed:', err.message);
      }
      const hostName = (id) => {
        const host = id && hosts.find(h => h && h.id === id);
        return host ? host.name : null;
      };

      // One VM failing for two causes is ONE failing VM. The old header added
      // the per-cause counts together and reported 22 for 15 machines.
      const distinctVms = new Set(incidents.map(i => i.subject));
      const oldest = incidents.reduce(
        (acc, i) => (Date.parse(i.since) < Date.parse(acc) ? i.since : acc),
        incidents[0].since
      );

      const zones = new Map();
      for (const incident of incidents) {
        const zoneKey = incident.backupHostId || '';
        if (!zones.has(zoneKey)) {
          zones.set(zoneKey, {
            label: (hostName(incident.backupHostId) || 'UNKNOWN HOST').toUpperCase(),
            incidents: [],
          });
        }
        zones.get(zoneKey).incidents.push(incident);
      }
      // Worst zone first, so the host needing attention is at the top.
      const zoneList = [...zones.values()].sort((a, b) => b.incidents.length - a.incidents.length);

      card.push(`📋 BACKUP DIGEST — ${distinctVms.size} VM${distinctVms.size === 1 ? '' : 's'} STILL FAILING`);
      card.push('');
      card.push(`🔴 ${distinctVms.size} failing · ${zoneList.length} zone${zoneList.length === 1 ? '' : 's'} · oldest open ${this._ageInDays(oldest)}`);
      card.push(`Reported ${this._hhmm(new Date())} · everything still open, not just today`);

      for (const zone of zoneList) {
        card.push('');
        card.push(zone.label);

        // Within a zone, group by cause. Printing the cause on every VM line
        // repeated the same error sentence fifteen times and buried the VM
        // names; as a sub-heading it is stated once and the machines under it
        // read as a list.
        const byCause = new Map();
        for (const incident of zone.incidents) {
          if (!byCause.has(incident.cause)) byCause.set(incident.cause, []);
          byCause.get(incident.cause).push(incident);
        }
        const causeList = [...byCause.entries()].sort((a, b) => b[1].length - a[1].length);

        for (const [cause, group] of causeList) {
          // Oldest first: the longest-broken VM has been ignored longest.
          group.sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
          const oldestHere = group[0].since;
          card.push(`🔴 ${this._shortCause(cause)}`);
          card.push(`   ${group.length} VM${group.length === 1 ? '' : 's'} · oldest ${this._ageInDays(oldestHere)}`);
          for (const incident of group.slice(0, DIGEST_ZONE_LIMIT)) {
            card.push(`   ${incident.subject}  (${this._ageInDays(incident.since)})`);
          }
          const more = group.length - DIGEST_ZONE_LIMIT;
          if (more > 0) card.push(`   +${more} more`);
        }
      }
    }

    card.push('');
    card.push(`🤖 ${rocketChatService.entity || 'Backup Manager'}`);

    // Same shape as the incident board: mentions outside the fence (inside it
    // they render as literal text and notify nobody), card inside.
    const lines = [];
    const mentioned = (rocketChatService.mentionsForType('dailyDigest') || [])
      .map(m => String(m).trim().replace(/^@+/, ''))
      .filter(Boolean);
    if (mentioned.length > 0) {
      lines.push(mentioned.map(m => `@${m}`).join(' '));
      lines.push('');
    }
    lines.push('```');
    lines.push(...card);
    lines.push('```');

    await rocketChatService.sendMessage(lines.join('\n'));
    console.log(
      incidents.length === 0
        ? '[NotifAgg] Daily digest sent: all clear'
        : `[NotifAgg] Daily digest sent: ${incidents.length} open incident(s)`
    );
    return true;
  }

  /** Causes are whole error sentences; a zone line has room for the gist. */
  _shortCause(cause) {
    const text = String(cause || 'unknown error').replace(/\s+/g, ' ').trim();
    return text.length > DIGEST_CAUSE_CHARS ? `${text.slice(0, DIGEST_CAUSE_CHARS - 1)}…` : text;
  }

  _ageInDays(iso) {
    const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
    return days >= 1 ? `${days}d` : '<1d';
  }

  _hhmm(date) {
    const d = new Date(date);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
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
    const succeeded = !(ev.kind.includes('failed') || ev.kind.includes('failure'));

    // Successes are handled before anything else, and identically whether or
    // not grouping is enabled: clear the open incident, take the VM off the
    // board, say nothing. Doing this inside the grouping path meant that with
    // grouping switched off a successful backup neither cleared the board nor
    // was suppressed — it just fell through to sendSingle and announced itself.
    if (succeeded && !ev.trackOnly) {
      const done = [...this.knownFailing.keys()].filter(k => k.startsWith(`${ev.subject}::`));
      if (done.length > 0) {
        done.forEach(k => this.knownFailing.delete(k));
        this.saveState().catch(() => {});
      }
      try {
        require('./dailyIncidentBoardService').resolveIssues(ev.subject);
      } catch (err) {
        console.error('[NotifAgg] Board resolve failed:', err.message);
      }
      return;
    }

    if (!this.settings.enabled) {
      // Grouping off still means "send each event as it comes", NOT "ignore
      // every other rule". A trackOnly event has no message of its own (the
      // daily incident board owns it), and a muted one is switched off — both
      // used to slip straight through this shortcut and send the very messages
      // the settings say not to send, simply because grouping was disabled.
      if (ev.trackOnly || ev.mute) return;
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
        if (ev.backupHostId && !known.backupHostId) known.backupHostId = ev.backupHostId;

        // Announce again once the re-notify interval has passed, so a fault
        // that keeps recurring keeps being reported — daily by default rather
        // than once and then silence. Older state files have no
        // lastAnnouncedAt; fall back to `since`, which is when the incident
        // was first announced.
        const lastAnnounced = Date.parse(known.lastAnnouncedAt || known.since || '') || 0;
        const due = this.settings.repeatRenotifyMs > 0
          && Date.now() - lastAnnounced >= this.settings.repeatRenotifyMs;

        if (!due) {
          // trackOnly events have no message to group, so don't open a group
          // for them — it would only ever flush as "suppressed 1 repeat".
          if (!ev.trackOnly) this.enqueue(ev.kind, cause, { ...ev, repeat: true });
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
          // Which backup host this VM lives on, so the daily digest can group
          // by zone the way the incident board does. Incidents opened before
          // this field existed are backfilled from the job history at render
          // time — see _resolveHostIds().
          backupHostId: ev.backupHostId || null,
        });
        this.saveState().catch(() => {});
      }
    }

    // The daily incident board now owns the message for this event; we're
    // only here to keep knownFailing accurate so a later success still
    // triggers a recovery announcement.
    if (ev.trackOnly) return;

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
    if (fresh.length === 1 && repeats.length === 0 && !fresh[0].mute && typeof fresh[0].sendSingle === 'function') {
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
