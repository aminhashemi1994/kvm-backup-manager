const { v4: uuidv4 } = require('uuid');
const { appendLog, getStoragePools } = require('./fileStorage');
const agentService = require('./agentService');

const ACTIVE_STATUSES = ['running', 'queued', 'retrying', 'initializing'];

/** Session names sanitize the VM name; mirror that to match jobs to sessions. */
const sanitizeVm = (name) => String(name || '').replace(/[^a-zA-Z0-9-]/g, '_');

/**
 * How stale `lastSyncedAt` may get before a live session refreshes it. A live
 * tmux session IS proof of life, and failStuckJobsOnHost uses lastSyncedAt to
 * decide a long-running job isn't stuck — without this refresh a genuinely
 * alive multi-day backup gets failed at the 24h mark, re-adopted here, failed
 * again two minutes later, and so on. Refreshing on a timer instead of every
 * pass keeps the jobs file from being rewritten every few seconds.
 */
const SYNC_REFRESH_MS = 5 * 60 * 1000;

/**
 * Did this session report a REAL progress snapshot, or is `phase: 'backup'`
 * just the agent's default for a session whose progress file it couldn't find?
 * Applying that default would overwrite a correct 'rsync' phase with 'backup'.
 * Newer agents say so explicitly; for older ones, any progress value is proof
 * the file was read.
 */
function _hasProgressEvidence(s) {
  if (!s) return false;
  if (typeof s.progressSeen === 'boolean') return s.progressSeen;
  return typeof s.progress === 'number' || !!s.progressText;
}

/**
 * Could `job` be the run behind a session created at `sessionCreatedMs`?
 *
 * A job cannot own a tmux session that existed before the job record did. The
 * check matters because the VM-level fallback below attributes an orphan
 * session to "any active job for this VM on this host" — and a scheduled fire
 * that never actually started (the agent refused it: "backup already in
 * progress") is exactly such a job. Without this, that brand-new record
 * absorbed the progress of the hours-old run it had just collided with, and
 * then sat in Active Jobs reporting someone else's 99%.
 *
 * The tolerance absorbs controller/host clock skew: the session is normally
 * created a moment AFTER the job record.
 */
const SESSION_START_TOLERANCE_MS = 5 * 60 * 1000;

function _couldOwnSession(job, sessionCreatedMs) {
  if (!Number.isFinite(sessionCreatedMs)) return true; // no evidence either way
  const jobMs = new Date(job.startTime).getTime();
  if (!Number.isFinite(jobMs)) return true;
  return sessionCreatedMs >= (jobMs - SESSION_START_TOLERANCE_MS);
}

function _needsSyncRefresh(job) {
  if (!job.lastSyncedAt) return true;
  const t = new Date(job.lastSyncedAt).getTime();
  if (!Number.isFinite(t)) return true;
  return (Date.now() - t) > SYNC_REFRESH_MS;
}

/**
 * Make the controller's job list mirror `tmux ls` on every host.
 *
 * The normal reconcilers only ever touch jobs the controller ALREADY knows
 * about. But a live backup tmux session can have no controller record at all —
 * the record was deleted, superseded, or the job was finalized into history
 * while the session kept running (a hung/long backup, or an agent restart that
 * dropped the job-state). Those sessions are invisible in the panel even though
 * the backup is genuinely alive on the host.
 *
 * This asks every host "what backup tmux sessions are alive right now?"
 * (GET /api/jobs/live-sessions) and reconciles each one:
 *   • matches a known job that isn't running -> flip it back to running
 *   • matches nothing -> ADOPT it as a real running job record (resolved to a
 *     VM by sanitized-name match) so it shows in Active now and lands in
 *     History when it finishes.
 *
 * `jobs` is mutated in place (adopted records pushed, matched records updated).
 * The caller is responsible for persisting when the return value is true.
 *
 * @param {Array} jobs  backup jobs array (mutated)
 * @param {Array} hosts backup hosts
 * @param {Array} vms   virtual machines (for VM resolution)
 * @returns {Promise<boolean>} true if any job was added/changed
 */
async function adoptLiveTmuxSessions(jobs, hosts, vms) {
  let changed = false;

  // Pools are only needed to name the pool an adopted run is writing into.
  let pools = [];
  try {
    pools = await getStoragePools();
  } catch (_) {
    pools = [];
  }

  await Promise.allSettled((hosts || []).map(async (host) => {
    if (!host || !host.url) return;
    if (host.status && host.status !== 'online') return;

    let sessions = [];
    try {
      const client = agentService.createAgentClient(host.url, host.id, host.name);
      const r = await client.get('/api/jobs/live-sessions', { timeout: 5000 });
      sessions = (r.data && r.data.data) || [];
    } catch (e) {
      return; // host slow/unreachable — next pass retries
    }
    if (!Array.isArray(sessions) || sessions.length === 0) return;

    // VMs whose backups land on this host, pre-sanitized for session matching.
    const hostVms = (vms || [])
      .filter(v => v.backupHostId === host.id)
      .map(v => ({ vm: v, sanitized: String(v.name).replace(/[^a-zA-Z0-9-]/g, '_') }));

    for (const s of sessions) {
      if (!s || !s.shortJobId) continue;

      // 1) Does a known job own this session? Prefer the agent-resolved full
      // jobId (exact), else fall back to the 8-char short id.
      const known = (s.jobId && jobs.find(j => j.id === s.jobId))
        || jobs.find(j => j.id && j.id.substring(0, 8).toLowerCase() === s.shortJobId);
      if (known) {
        // Only resurrect a job that was wrongly marked FAILED while its session
        // is in fact alive. Deliberately do NOT touch 'completed' — a session
        // lingers for a moment after the script writes its exit code and calls
        // `exit`, and flipping a just-completed job back to running would make
        // it flicker. running/queued/retrying are already correct; skipped is
        // the scheduler's domain.
        //
        // Crucially, NEVER resurrect a job dedupe deliberately superseded
        // (supersededBy set): dedupe removed it as a duplicate of the real run,
        // and resurrecting it here would just make dedupe supersede it again on
        // the next pass — an endless flip-flop that shows as the job blinking in
        // and out of the Active list.
        //
        // Same for a job whose exit code the shell recorded: that IS the
        // outcome, and the session that outlives it by a few seconds is not
        // evidence against it. Reviving those made a correctly-failed backup
        // blink through the Active list on every poll.
        if (known.status === 'failed' && !known.supersededBy && typeof known.exitCode !== 'number') {
          known.status = 'running';
          known.endTime = null;
          known.exitCode = null;
          known.error = null;
          known.failureReason = null;
          if (s.phase) known.phase = s.phase;
          if (typeof s.progress === 'number') known.progress = s.progress;
          if (s.progressText) known.progressText = s.progressText;
          known.adoptedFromTmux = true;
          known.lastSyncedAt = new Date().toISOString();
          changed = true;
          try { await appendLog(known.id, `Restored to running — live tmux session ${s.session} found on ${host.name}`); } catch {}
        } else if (ACTIVE_STATUSES.includes(known.status)) {
          // Alive and already shown correctly. Still refresh what the host just
          // told us about it: the session's progress file is the same one the
          // backup script writes, and it is the only thing that knows the run
          // moved from the backup phase to the offsite rsync. Without this the
          // badge kept saying "Backing up" while the progress text underneath
          // it already read "Offsite sync (...)" — the phase only ever moved
          // when the agent happened to attach progressType to an update.
          if (_hasProgressEvidence(s)) {
            if (s.phase && s.phase !== known.phase) {
              known.phase = s.phase;
              known.progressType = s.phase;
              changed = true;
            }
            if (typeof s.progress === 'number' && s.progress !== known.progress) {
              known.progress = s.progress;
              changed = true;
            }
            if (s.progressText && s.progressText !== known.progressText) {
              known.progressText = s.progressText;
              changed = true;
            }
          }
          // Record that the host confirmed it, so the stuck-job sweep never
          // fails a live backup.
          if (changed || _needsSyncRefresh(known)) {
            known.lastSyncedAt = new Date().toISOString();
            changed = true;
          }
        }
        continue;
      }

      // 2) No record by id. Before adopting, make sure there isn't ALREADY an
      // active job for this VM+schedule on this host — otherwise we'd create a
      // duplicate that dedupeActiveBackupJobs immediately supersedes, and the
      // pair would blink in and out of the list. If one exists, it already
      // represents this session; just refresh its progress.
      // Match by VM only (not VM+schedule): the agent holds a per-VM lock, so at
      // most one backup runs for a VM at a time — any active job for this VM on
      // this host owns the live session. Matching on schedule too would miss
      // cases where the controller type (e.g. "interval"/"cron") maps to the
      // agent's "daily" session name, letting a duplicate slip through.
      // ...and that could actually be this session's run: a job created after
      // the session started never launched it, so it must not inherit its
      // progress (see _couldOwnSession).
      const sessionCreatedMs = s.createdAt ? new Date(s.createdAt).getTime() : NaN;
      const existingActive = jobs.find(j =>
        j.backupHostId === host.id &&
        ACTIVE_STATUSES.includes(j.status) &&
        sanitizeVm(j.vmName) === s.sanitizedVm &&
        _couldOwnSession(j, sessionCreatedMs)
      );
      if (existingActive) {
        if (typeof s.progress === 'number' && s.progress !== existingActive.progress) {
          existingActive.progress = s.progress;
          if (s.progressText) existingActive.progressText = s.progressText;
          if (s.phase) existingActive.phase = s.phase;
          existingActive.lastSyncedAt = new Date().toISOString();
          changed = true;
        } else if (_needsSyncRefresh(existingActive)) {
          existingActive.lastSyncedAt = new Date().toISOString();
          changed = true;
        }
        continue;
      }

      const match = hostVms.find(hv => hv.sanitized === s.sanitizedVm)
        || hostVms.find(hv => s.sanitizedVm.startsWith(hv.sanitized));
      // Prefer the REAL full jobId the agent recovered from on-disk artifacts —
      // then the shell-written <jobId>.exitcode finalizes this job correctly when
      // the session ends. Only when nothing was recoverable do we mint a
      // short-id-prefixed synthetic id (keeps future matches aligned; it will
      // finalize as indeterminate, still visible in history).
      const adoptedId = s.jobId || `${s.shortJobId}${uuidv4().slice(8)}`;
      const poolForSession = s.storagePoolPath
        ? pools.find(p => p.backupHostId === host.id && p.path === s.storagePoolPath) || null
        : null;
      const adopted = {
        id: adoptedId,
        vmId: match ? match.vm.id : null,
        vmName: match ? match.vm.name : s.sanitizedVm,
        hypervisorIp: match ? (match.vm.hypervisorIp || null) : null,
        backupHostId: host.id,
        backupHostName: host.name,
        scheduleType: s.scheduleType,
        method: null,
        status: 'running',
        phase: s.phase || 'backup',
        progress: typeof s.progress === 'number' ? s.progress : 0,
        progressText: s.progressText || 'Recovered from live tmux session',
        startTime: s.createdAt || new Date().toISOString(),
        endTime: null,
        exitCode: null,
        error: null,
        scheduled: true,
        adoptedFromTmux: true,
        tmuxSession: s.session,
        // The pool the run is actually writing into, straight from the host.
        // Without it the log viewer has no way to reach this backup's output —
        // there is no flat per-job log for a run the agent never registered,
        // and the durable script log can only be found via the pool path.
        storagePoolPath: s.storagePoolPath || null,
        storagePoolId: poolForSession ? poolForSession.id : null,
        storagePoolName: poolForSession ? poolForSession.name : null,
        // The host itself just confirmed this session is alive — record it so
        // the stuck-job sweep doesn't fail a long backup we adopted.
        lastSyncedAt: new Date().toISOString(),
      };
      jobs.push(adopted);
      changed = true;
      try { await appendLog(adoptedId, `Adopted live tmux session ${s.session} on ${host.name} (no prior job record — recovered so it is tracked and finalized).`); } catch {}
    }
  }));

  return changed;
}

/**
 * Insert guard for commitJobChanges: re-run the "is this run already tracked?"
 * check against the CURRENT store before an adopted record is written.
 *
 * Adoption decides on a snapshot, but the commit happens seconds later — by
 * then the scheduler (or the agent's first update) may have created the real
 * record for the very session we adopted. Inserting anyway would produce a
 * duplicate that dedupe immediately supersedes, i.e. exactly the blinking pair
 * adoption is meant to avoid.
 *
 * @param {Array} freshJobs current store contents
 * @param {object} job      the adopted record about to be inserted
 * @returns {boolean} true when it is safe to insert
 */
function canInsertAdoptedJob(freshJobs, job) {
  if (!job || !job.adoptedFromTmux) return true;
  const shortId = String(job.id || '').substring(0, 8).toLowerCase();
  const sanitized = sanitizeVm(job.vmName);
  // An adopted record's startTime IS the session's creation time.
  const sessionCreatedMs = new Date(job.startTime).getTime();
  return !freshJobs.some(j =>
    j.id !== job.id && (
      // Same run, recorded under its real id while we were reconciling.
      (shortId && String(j.id || '').substring(0, 8).toLowerCase() === shortId) ||
      // Or another active job for this VM on this host that could actually be
      // this run — the agent holds a per-VM lock, so it already owns the
      // session. A job that started after the session did could not have
      // launched it, and must not suppress the adoption.
      (j.backupHostId === job.backupHostId &&
        ACTIVE_STATUSES.includes(j.status) &&
        sanitizeVm(j.vmName) === sanitized &&
        _couldOwnSession(j, sessionCreatedMs))
    )
  );
}

module.exports = { adoptLiveTmuxSessions, canInsertAdoptedJob };
