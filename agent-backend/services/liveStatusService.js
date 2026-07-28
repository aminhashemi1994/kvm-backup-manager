const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

/**
 * LiveStatusService
 *
 * Computes the *real* state of a backup or restore job by inspecting the
 * primary sources of truth on the agent:
 *   1. The job-state file (what the agent thinks it knows)
 *   2. tmux session existence (sanitized name match)
 *   3. virtnbdbackup / virtnbdrestore / rsync / Backup_Manager.sh process state
 *   4. Lock file existence under <pool>/in_progress_backups/
 *   5. Progress file contents under <pool>/.progress/
 *
 * Returns a single object the controller can rely on to reconcile its view.
 */
class LiveStatusService {
  constructor() {
    this.config = null;
    this.backupExecutor = null;
    this.restoreExecutor = null;
  }

  initialize({ config, backupExecutor, restoreExecutor }) {
    this.config = config;
    this.backupExecutor = backupExecutor;
    this.restoreExecutor = restoreExecutor;
  }

  /**
   * Read the exit code the shell recorded for this job, if it's still on disk.
   *
   * This is the ONE piece of hard evidence about whether a backup succeeded:
   * the tmux command ends with `echo $? > <jobId>.exitcode`, so the file is
   * written by the shell itself and outlives the agent, its in-memory state,
   * and the job-state file. monitorTmuxSession consumes it on the happy path;
   * whenever it's still here, the agent never finished accounting for the job —
   * exactly the case the controller has to reconcile.
   *
   * @returns {number|null} the exit code, or null if not recorded/unreadable
   */
  readRecordedExitCode(jobId) {
    try {
      const p = path.join(this.config.logDir, `${jobId}.exitcode`);
      if (!fs.existsSync(p)) return null;
      const raw = fs.readFileSync(p, 'utf8').trim();
      if (!/^-?\d+$/.test(raw)) return null;
      return parseInt(raw, 10);
    } catch (e) {
      return null;
    }
  }

  /** Verdict derived purely from the recorded exit code, or null if none. */
  _verdictFromExitCode(jobId, kind = 'backup', extra = {}) {
    const exitCode = this.readRecordedExitCode(jobId);
    if (exitCode === null) return null;
    return {
      jobId,
      kind,
      phase: exitCode === 0 ? 'completed' : 'failed',
      status: exitCode === 0 ? 'completed' : 'failed',
      exitCode,
      progress: exitCode === 0 ? 100 : null,
      progressText: null,
      evidence: {
        source: 'exitcode-file',
        exitCodeFileFound: true,
        ...extra,
      },
      reason: `Shell recorded exit code ${exitCode}`,
    };
  }

  /**
   * Top-level lookup: caller doesn't need to know if jobId is a backup or
   * restore — we try both.
   */
  async getJobLiveStatus(jobId) {
    if (!jobId) {
      return this._unknown(jobId, 'no jobId provided');
    }

    // Try backup first (most common case)
    const backupState = this.backupExecutor?.loadJobState?.(jobId);
    if (backupState) {
      return await this._inspectBackup(jobId, backupState);
    }

    // Then try restore
    if (this.restoreExecutor && typeof this.restoreExecutor.getJob === 'function') {
      try {
        const restoreJob = await this.restoreExecutor.getJob(jobId);
        if (restoreJob) {
          return await this._inspectRestore(jobId, restoreJob);
        }
      } catch (e) {
        // not a restore either
      }
    }

    // No job state for either kind. Before giving up, check the exit-code file:
    // the agent losing its record does NOT mean the run's outcome is unknowable,
    // and this is precisely the case that used to be reported as `unknown` and
    // then optimistically filed as "completed" by the controller — turning a
    // failed backup into a green one in the history.
    const verdict = this._verdictFromExitCode(jobId, 'backup', { jobStateFound: false });
    if (verdict) return verdict;

    // Still nothing decisive. The agent may have lost its job-state file (a
    // restart, a cleanup race) while the backup is very much still running on
    // the host — a live tmux session and/or a progress file that was updated
    // seconds ago. Without this scan getJobLiveStatus returns `unknown`, and
    // the controller files a running backup as FAILED with no logs — the exact
    // symptom users hit on long offsite rsyncs. Inspect the host directly.
    const discovered = await this._discoverActiveByJobId(jobId);
    if (discovered) return discovered;

    return this._unknown(jobId, 'job not found in agent state and no exit code recorded');
  }

  // -------------------------------------------------------------------
  // Backup inspection
  // -------------------------------------------------------------------
  async _inspectBackup(jobId, jobState) {
    const out = {
      jobId,
      kind: 'backup',
      vmName: jobState.vmName || null,
      hypervisorIp: jobState.hypervisorIp || null,
      scheduleType: jobState.scheduleType || null,
      // Authoritative fields
      phase: 'unknown',         // 'queued' | 'starting' | 'backup' | 'rsync' | 'completed' | 'failed' | 'orphaned' | 'unknown'
      status: 'unknown',        // 'running' | 'completed' | 'failed' | 'unknown'
      // The shell's own record of how the script exited — hard evidence, and
      // the only thing here that proves rather than infers an outcome.
      exitCode: this.readRecordedExitCode(jobId),
      progress: typeof jobState.progress === 'number' ? jobState.progress : null,
      progressText: jobState.progressText || null,
      // Evidence
      evidence: {
        jobStateFound: true,
        exitCodeFileFound: this.readRecordedExitCode(jobId) !== null,
        tmuxSessionName: jobState.tmuxSession || null,
        tmuxAlive: false,
        lockFileExists: false,
        lockFilePath: null,
        progressFileExists: false,
        progressFilePath: null,
        progressFileSnapshot: null,
        backupProcessAlive: false,
        rsyncProcessAlive: false,
        backupManagerProcessAlive: false,
      },
      lastUpdate: jobState.lastUpdate || null,
      checkedAt: new Date().toISOString(),
    };

    // Tmux check. Match by jobId CONTAINMENT first — this is format-agnostic
    // and so catches sessions named by any backup code path (ours,
    // `<vm>_<sched>_<shortId>`, or the `<jobId>_<vm>_<sched>_<hash>` form other
    // hosts use). Only then fall back to the exact recorded name and the
    // VM+schedule prefix. Without this, a live foreign-named session reads as
    // dead and the job is wrongly finalized as failed.
    {
      const sessions = await this._listTmuxSessions();
      let match = sessions.find(s =>
        this._sessionMatchesJob(s, jobId, jobState.vmName, jobState.scheduleType)) || null;
      if (!match && jobState.tmuxSession && sessions.includes(jobState.tmuxSession)) {
        match = jobState.tmuxSession;
      }
      if (match) {
        out.evidence.tmuxSessionName = match;
        out.evidence.tmuxAlive = true;
      }
    }

    // Lock file
    if (jobState.storagePoolPath && jobState.vmName && jobState.scheduleType) {
      const lockPath = path.join(
        jobState.storagePoolPath,
        'in_progress_backups',
        `${jobState.vmName}_${jobState.scheduleType}_backup`
      );
      out.evidence.lockFilePath = lockPath;
      out.evidence.lockFileExists = await this._fileExists(lockPath);
    }

    // Progress file
    if (jobState.storagePoolPath && jobState.vmName && jobState.scheduleType) {
      const progressPath = path.join(
        jobState.storagePoolPath,
        '.progress',
        `${jobState.vmName}_${jobState.scheduleType}.progress`
      );
      out.evidence.progressFilePath = progressPath;
      const exists = await this._fileExists(progressPath);
      out.evidence.progressFileExists = exists;
      if (exists) {
        out.evidence.progressFileSnapshot = await this._readJsonSafe(progressPath);
        out.evidence.progressFileFresh = await this._progressArtifactFresh(
          progressPath, out.evidence.progressFileSnapshot
        );
      }
    }

    // Process checks
    out.evidence.backupProcessAlive = await this._processAlive(
      `virtnbdbackup.*${this._escape(jobState.vmName || '')}`
    );
    out.evidence.rsyncProcessAlive = await this._processAlive(
      `rsync.*${this._escape(jobState.vmName || '')}`
    );
    out.evidence.backupManagerProcessAlive = await this._processAlive(
      `Backup_Manager.sh.*--domain ${this._escape(jobState.vmName || '')}`
    );

    // Decide phase + status
    this._decideBackupPhase(out);
    return out;
  }

  _decideBackupPhase(out) {
    const e = out.evidence;
    const anyAlive = e.tmuxAlive || e.backupProcessAlive || e.rsyncProcessAlive || e.backupManagerProcessAlive;

    // Fresh progress file = what the script says it is DOING right now.
    const progressIsFresh = e.progressFileFresh || this._progressFresh(e.progressFileSnapshot);
    const liveSnap = (e.progressFileExists && progressIsFresh)
      ? (e.progressFileSnapshot || null)
      : null;

    if (anyAlive) {
      out.status = 'running';

      if (liveSnap) {
        // Prefer the progress file over process names for the phase. Process
        // names cannot see the offsite stage: that command line is
        // `rsync ... /pool/... 10.0.0.20:/...` and does NOT contain the VM
        // name, so `rsync.*<vm>` misses it and the run falls through to the
        // generic "manager alive" case below. That is how a backup deep into
        // its offsite sync kept reporting phase=backup — the panel showed
        // "Backing up" while its own progress text read "Offsite sync (...)".
        out.phase = liveSnap.type === 'rsync' ? 'rsync' : 'backup';
        if (typeof liveSnap.percentage === 'number') out.progress = liveSnap.percentage;
        else if (typeof liveSnap.percent === 'number') out.progress = liveSnap.percent;
        if (liveSnap.text) out.progressText = liveSnap.text;
      } else if (e.rsyncProcessAlive) {
        out.phase = 'rsync';
      } else {
        // virtnbdbackup running, or the manager process/tmux alive with
        // neither worker visible (setup/finalize). Still backing up.
        out.phase = 'backup';
      }
      return;
    }

    // No alive process. The shell's recorded exit code outranks every artifact
    // below it — those only let us *infer* an outcome, this one states it.
    if (typeof out.exitCode === 'number') {
      out.phase = out.exitCode === 0 ? 'completed' : 'failed';
      out.status = out.exitCode === 0 ? 'completed' : 'failed';
      if (out.exitCode === 0) out.progress = 100;
      return;
    }

    // A progress file the backup wrote just seconds ago is strong evidence it
    // is still alive, even though every process-name matcher above missed it.
    // This is common on offsite rsync: the running command line is
    // `rsync ... /pool/... 10.0.0.20:/...` and does NOT contain the VM name,
    // so `rsync.*<vm>` never matches — yet the shell keeps refreshing the
    // progress file. Trust a fresh progress file over the absent process, so a
    // syncing backup is never mislabelled failed/orphaned. Ranked below the
    // recorded exit code (which proves the script ended) but above the
    // artifact-only inferences.
    if (liveSnap) {
      out.phase = liveSnap.type === 'rsync' ? 'rsync' : 'backup';
      out.status = 'running';
      if (typeof liveSnap.percentage === 'number') out.progress = liveSnap.percentage;
      else if (typeof liveSnap.percent === 'number') out.progress = liveSnap.percent;
      if (liveSnap.text) out.progressText = liveSnap.text;
      return;
    }

    // Look at the artifacts.
    if (e.lockFileExists && !anyAlive) {
      // Lock left behind without any worker — orphaned/stale.
      out.phase = 'orphaned';
      out.status = 'failed';
      return;
    }
    if (e.progressFileExists && e.progressFileSnapshot &&
        (e.progressFileSnapshot.percentage === 100 || e.progressFileSnapshot.percent === 100)) {
      out.phase = 'completed';
      out.status = 'completed';
      out.progress = 100;
      return;
    }
    if (!e.progressFileExists && !e.lockFileExists) {
      // Job state still on disk but no artifacts and no processes — done or
      // never started. Caller should reconcile against the job log.
      out.phase = 'unknown';
      out.status = 'unknown';
      return;
    }

    out.phase = 'unknown';
    out.status = 'unknown';
  }

  // -------------------------------------------------------------------
  // Restore inspection
  // -------------------------------------------------------------------
  async _inspectRestore(jobId, restoreJob) {
    const out = {
      jobId,
      kind: 'restore',
      vmName: restoreJob.vmName || null,
      method: restoreJob.method || null,
      // Authoritative fields
      phase: 'unknown',
      status: 'unknown',
      progress: typeof restoreJob.progress === 'number' ? restoreJob.progress : null,
      progressText: restoreJob.progressText || null,
      evidence: {
        jobStateFound: true,
        tmuxSessionName: restoreJob.tmuxSession || null,
        tmuxAlive: false,
        progressFileExists: false,
        progressFilePath: restoreJob.progressFile || null,
        progressFileSnapshot: null,
        restoreProcessAlive: false,
        restoreManagerProcessAlive: false,
      },
      lastUpdate: restoreJob.lastUpdate || restoreJob.updatedAt || null,
      checkedAt: new Date().toISOString(),
    };

    if (restoreJob.tmuxSession) {
      out.evidence.tmuxAlive = await this._tmuxHasSession(restoreJob.tmuxSession);
    }

    if (restoreJob.progressFile) {
      const exists = await this._fileExists(restoreJob.progressFile);
      out.evidence.progressFileExists = exists;
      if (exists) {
        // Restore progress file is plain text, not JSON; capture last 1KB
        out.evidence.progressFileSnapshot = await this._readTailSafe(restoreJob.progressFile, 1024);
      }
    }

    out.evidence.restoreProcessAlive = await this._processAlive(
      `virtnbdrestore.*${this._escape(restoreJob.vmName || '')}`
    );
    out.evidence.restoreManagerProcessAlive = await this._processAlive(
      `Restore_Manager.sh.*--domain ${this._escape(restoreJob.vmName || '')}`
    );

    const e = out.evidence;
    if (e.restoreProcessAlive || e.restoreManagerProcessAlive || e.tmuxAlive) {
      out.phase = 'restore';
      out.status = 'running';
    } else if (e.progressFileExists) {
      out.phase = 'unknown';
      out.status = 'unknown';
    } else {
      // No progress file, no process — finished. Caller decides
      // success/failure from log + restoreExecutor history.
      out.phase = 'unknown';
      out.status = 'unknown';
    }
    return out;
  }

  // -------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------
  _unknown(jobId, reason) {
    return {
      jobId,
      kind: 'unknown',
      phase: 'unknown',
      status: 'unknown',
      reason,
      evidence: { jobStateFound: false },
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * Is this progress file being actively written?
   *
   * Same question as _progressFresh, but answerable even when the script wrote
   * no timestamp: "no timestamp" must not read as "stale", because that sends a
   * live offsite sync back to guessing its phase from process names. The file's
   * mtime says the same thing the timestamp would.
   */
  async _progressArtifactFresh(filePath, snapshot, maxAgeMs = 5 * 60 * 1000) {
    if (this._progressFresh(snapshot, maxAgeMs)) return true;
    if (!filePath) return false;
    try {
      const st = await fs.promises.stat(filePath);
      return (Date.now() - st.mtimeMs) <= maxAgeMs;
    } catch {
      return false;
    }
  }

  /**
   * Is this progress-file snapshot recent enough to prove the job is alive?
   *
   * The backup script rewrites the progress file every few seconds while it
   * runs (backup and rsync phases both), so a timestamp within the freshness
   * window means a worker is actively updating it right now. A stale file is
   * just a leftover from a finished/dead run and proves nothing.
   */
  _progressFresh(snapshot, maxAgeMs = 5 * 60 * 1000) {
    if (!snapshot || !snapshot.timestamp) return false;
    const t = Date.parse(snapshot.timestamp);
    if (Number.isNaN(t)) return false;
    return (Date.now() - t) <= maxAgeMs;
  }

  /**
   * List every live tmux session name on this host (single `tmux ls`).
   */
  async _listTmuxSessions() {
    try {
      const { stdout } = await execAsync(
        `tmux list-sessions -F "#{session_name}" 2>/dev/null || true`
      );
      return (stdout || '').trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Does a session name belong to this job? We deliberately match by
   * CONTAINMENT rather than prefix/suffix ordering, because different backup
   * code paths name the session differently — some as
   * `<sanitizedVm>_<schedule>_<shortJobId>`, others as
   * `<jobId>_<sanitizedVm>_<schedule>_<hash>`. The one thing every scheme shares
   * is that the full jobId (or, failing that, the sanitized VM + schedule) is
   * somewhere in the name. jobId is unique, so it's the safest key; VM+schedule
   * is only a fallback and can collide with a newer run of the same VM.
   */
  _sessionMatchesJob(session, jobId, vmName, scheduleType, strict = false) {
    if (!session) return false;
    if (jobId && session.includes(String(jobId))) return true;
    const shortJobId = jobId ? String(jobId).substring(0, 8) : '';
    if (shortJobId && session.endsWith(`_${shortJobId}`)) return true;
    // VM+schedule fallback. This is intentionally NOT used in strict mode: it
    // matches ANY run of the same VM+schedule, so a live session belonging to a
    // newer run would otherwise "match" an older, superseded job of the same VM
    // — resurrecting a zombie duplicate. Strict callers (e.g. the failed-job
    // resurrector) must key on the unique jobId only.
    if (!strict && vmName && scheduleType) {
      const sanitized = String(vmName).replace(/[^a-zA-Z0-9-]/g, '_');
      if (session.includes(`${sanitized}_${scheduleType}_`)) return true;
    }
    return false;
  }

  /**
   * Best-effort read of the progress file for a VM/schedule across all pools.
   * Matches on the sanitized VM name so we don't have to reverse the sanitize
   * that turned dots into underscores.
   *
   * Also reports the POOL the file was found in. That is where the run is
   * really writing, so it is the pool whose durable script log holds this
   * backup's output — the controller needs it to fetch logs for a run it only
   * knows through its tmux session.
   */
  async _findProgressForVm(vmName, scheduleType) {
    if (!scheduleType) return { path: null, snapshot: null, poolPath: null };
    try {
      const { fetchStoragePools } = require('../utils/storagePoolHelper');
      const pools = await fetchStoragePools();
      const sanitizedVm = vmName ? String(vmName).replace(/[^a-zA-Z0-9-]/g, '_') : null;
      for (const pool of pools) {
        const dir = path.join(pool.path, '.progress');
        let files = [];
        try { files = await fs.promises.readdir(dir); } catch { continue; }
        const match = files.find(f => {
          if (!f.endsWith(`_${scheduleType}.progress`)) return false;
          if (!sanitizedVm) return true;
          return f.replace(/[^a-zA-Z0-9-]/g, '_').startsWith(sanitizedVm);
        });
        if (match) {
          const p = path.join(dir, match);
          const snapshot = await this._readJsonSafe(p);
          if (snapshot) return { path: p, snapshot, poolPath: pool.path };
        }
      }
    } catch {
      // best effort
    }
    return { path: null, snapshot: null, poolPath: null };
  }

  /**
   * Last-resort host scan when the agent has no job-state file and no recorded
   * exit code for this jobId. We must not conclude "unknown" (→ controller marks
   * it failed) while the backup is still running on the host — a live tmux
   * session is proof it is still executing.
   *
   * @returns {object|null} a running verdict, or null if nothing found
   */
  async _discoverActiveByJobId(jobId, vmName = null, scheduleType = null) {
    try {
      const sessions = await this._listTmuxSessions();
      const session = sessions.find(s => this._sessionMatchesJob(s, jobId, vmName, scheduleType)) || null;
      if (!session) return null;

      // Enrich with a fresh progress file when we can figure out the VM/schedule.
      let vm = vmName;
      let sched = scheduleType;
      if (!sched) {
        // Try to recover the schedule from the session name (…_<schedule>_<tail>).
        const parts = session.split('_');
        const known = ['daily', 'weekly', 'monthly', 'once', 'custom', 'hourly'];
        const idx = parts.findIndex(p => known.includes(p));
        if (idx >= 0) sched = parts[idx];
      }
      const { path: progressPath, snapshot: progressSnapshot } =
        await this._findProgressForVm(vm, sched);

      const snap = progressSnapshot || {};
      return {
        jobId,
        kind: 'backup',
        phase: snap.type === 'rsync' ? 'rsync' : 'backup',
        status: 'running',
        exitCode: null,
        progress: typeof snap.percentage === 'number' ? snap.percentage
          : (typeof snap.percent === 'number' ? snap.percent : null),
        progressText: snap.text || null,
        evidence: {
          source: 'host-discovery',
          jobStateFound: false,
          tmuxSessionName: session,
          tmuxAlive: true,
          progressFilePath: progressPath,
          progressFileSnapshot: progressSnapshot,
        },
        reason: `Live tmux session ${session} found for job ${jobId} despite missing job-state`,
      };
    } catch {
      return null;
    }
  }

  /**
   * Batch liveness check for the history/active reconciler: given a list of
   * `{ jobId, vmName, scheduleType }`, return the subset that still have a live
   * tmux session on this host, with progress where available. One `tmux ls` for
   * the whole batch, so grepping a page of failed jobs is cheap.
   */
  async checkActiveSessions(jobs = []) {
    const sessions = await this._listTmuxSessions();
    const result = {};
    for (const j of jobs) {
      if (!j || !j.jobId) continue;
      // Strict match: only this job's unique id/short-id may resurrect it. The
      // VM+schedule fallback is unsafe here — a newer run's session would
      // otherwise flip a superseded duplicate of the same VM+schedule back to
      // running.
      const session = sessions.find(s =>
        this._sessionMatchesJob(s, j.jobId, j.vmName, j.scheduleType, true)) || null;
      if (!session) continue;
      const { path: progressPath, snapshot } =
        await this._findProgressForVm(j.vmName, j.scheduleType);
      const snap = snapshot || {};
      // The progress file outlives the run that wrote it, so only report a
      // phase when the file is still being written — otherwise the caller
      // would stamp a finished run's phase onto the job it resurrects.
      const fresh = snapshot ? await this._progressArtifactFresh(progressPath, snapshot) : false;
      result[j.jobId] = {
        active: true,
        session,
        phase: fresh ? (snap.type === 'rsync' ? 'rsync' : 'backup') : null,
        progress: typeof snap.percentage === 'number' ? snap.percentage
          : (typeof snap.percent === 'number' ? snap.percent : null),
        progressText: snap.text || null,
        progressFilePath: progressPath,
        progressSeen: fresh,
      };
    }
    return result;
  }

  /**
   * Discover EVERY live backup tmux session on this host and parse it, with no
   * input job list required. This is what lets the panel mirror `tmux ls`:
   * sessions whose controller job record was lost, superseded, or wrongly
   * finalized still show up here as long as the session is alive, so the
   * controller can adopt/resurrect them.
   *
   * Backup sessions are named `<sanitizedVm>_<schedule>_<shortJobId>` by
   * executeBackup (schedule ∈ once|daily|weekly|monthly|custom, shortJobId =
   * first 8 hex of the jobId). We parse that shape and attach live progress from
   * the pool's .progress file when we can find it.
   *
   * @returns {Promise<Array<{session,shortJobId,sanitizedVm,scheduleType,
   *   createdAt,phase,progress,progressText,progressSeen}>>}
   *   `progressSeen` says whether `phase` came from a progress file that is
   *   still being written (evidence) or is just the default.
   */
  async discoverBackupSessions() {
    let rows = [];
    try {
      const { stdout } = await execAsync(
        `tmux list-sessions -F "#{session_name}|#{session_created}" 2>/dev/null || true`
      );
      rows = (stdout || '').trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }

    const re = /^(.*)_(once|daily|weekly|monthly|custom)_([0-9a-fA-F]{8})$/;
    const out = [];
    for (const row of rows) {
      const [name, createdEpoch] = row.split('|');
      if (!name) continue;
      const m = name.match(re);
      if (!m) continue; // not a backup session we can attribute
      const sanitizedVm = m[1];
      const scheduleType = m[2];
      const shortJobId = m[3].toLowerCase();

      // Best-effort live progress for this VM/schedule.
      let phase = 'backup';
      let progress = null;
      let progressText = null;
      // Whether `phase` below is EVIDENCE (we read the progress file) or just
      // the default. The controller must not overwrite a job's 'rsync' phase
      // with a defaulted 'backup'.
      let progressSeen = false;
      // The pool this run is writing into — the controller needs it to fetch
      // the durable script log for a run it only knows through its session.
      let storagePoolPath = null;
      try {
        const { path: progressPath, snapshot, poolPath } = await this._findProgressForVm(sanitizedVm, scheduleType);
        storagePoolPath = poolPath || null;
        if (snapshot) {
          // Only a file that is actually being written may drive the phase —
          // the same VM+schedule progress file survives between runs.
          progressSeen = await this._progressArtifactFresh(progressPath, snapshot);
          phase = snapshot.type === 'rsync' ? 'rsync' : 'backup';
          if (typeof snapshot.percentage === 'number') progress = snapshot.percentage;
          else if (typeof snapshot.percent === 'number') progress = snapshot.percent;
          if (snapshot.text) progressText = snapshot.text;
        }
      } catch { /* progress is optional */ }

      out.push({
        session: name,
        shortJobId,
        // The full jobId when we can recover it from on-disk artifacts — this is
        // what lets the controller adopt the session under its REAL id so the
        // shell-written <jobId>.exitcode finalizes it correctly when it ends.
        jobId: this._resolveFullJobId(shortJobId),
        sanitizedVm,
        scheduleType,
        createdAt: createdEpoch && /^\d+$/.test(createdEpoch)
          ? new Date(parseInt(createdEpoch, 10) * 1000).toISOString()
          : null,
        phase,
        progress,
        progressText,
        progressSeen,
        storagePoolPath,
      });
    }
    return out;
  }

  /**
   * Recover the full jobId behind a session's 8-char short id by looking for the
   * artifacts the run leaves in logDir: <jobId>.log, <jobId>.exitcode, or
   * job-state/<jobId>.json. The session name only carries the short id, but the
   * shell writes the exitcode under the FULL id, so resolving it here lets the
   * controller finalize an adopted job from real evidence instead of guessing.
   * Returns the full id, or null if nothing (or something ambiguous) is found.
   */
  _resolveFullJobId(shortJobId) {
    if (!shortJobId) return null;
    const short = String(shortJobId).toLowerCase();
    const dir = this.config && this.config.logDir;
    if (!dir) return null;
    const candidates = new Set();
    try {
      for (const f of fs.readdirSync(dir)) {
        const m = f.match(/^(.*)\.(log|exitcode)$/);
        if (m && m[1].toLowerCase().startsWith(short)) candidates.add(m[1]);
      }
    } catch { /* ignore */ }
    try {
      const stateDir = path.join(dir, 'job-state');
      for (const f of fs.readdirSync(stateDir)) {
        const m = f.match(/^(.*)\.json$/);
        if (m && m[1].toLowerCase().startsWith(short)) candidates.add(m[1]);
      }
    } catch { /* ignore */ }
    // Only trust an unambiguous single match — the short id is 8 hex (32 bits),
    // collisions are unlikely but we must never attribute the wrong full id.
    return candidates.size === 1 ? [...candidates][0] : null;
  }

  async _tmuxHasSession(name) {
    try {
      await execAsync(`tmux has-session -t ${this._shellEscape(name)} 2>/dev/null`);
      return true;
    } catch {
      return false;
    }
  }

  async _findTmuxByVm(vmName, scheduleType) {
    try {
      const { stdout } = await execAsync(
        `tmux list-sessions -F "#{session_name}" 2>/dev/null || true`
      );
      if (!stdout.trim()) return null;
      const sanitized = vmName.replace(/[^a-zA-Z0-9-]/g, '_');
      const prefix = `${sanitized}_${scheduleType}_`;
      const sessions = stdout.trim().split('\n');
      return sessions.find(s => s.startsWith(prefix)) || null;
    } catch {
      return null;
    }
  }

  async _processAlive(pattern) {
    if (!pattern) return false;
    try {
      // pgrep -f returns 0 if found, 1 if not. We use stdout to confirm.
      const { stdout } = await execAsync(
        `pgrep -af ${this._shellEscape(pattern)} 2>/dev/null || true`
      );
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  async _fileExists(p) {
    if (!p) return false;
    try {
      await fs.promises.access(p, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async _readJsonSafe(p) {
    try {
      const data = await fs.promises.readFile(p, 'utf8');
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  async _readTailSafe(p, bytes) {
    try {
      const stat = await fs.promises.stat(p);
      const start = Math.max(0, stat.size - bytes);
      const fd = await fs.promises.open(p, 'r');
      try {
        const buf = Buffer.alloc(stat.size - start);
        await fd.read(buf, 0, buf.length, start);
        return buf.toString('utf8');
      } finally {
        await fd.close();
      }
    } catch {
      return null;
    }
  }

  _escape(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  _shellEscape(s) {
    return `"${String(s).replace(/(["$`\\])/g, '\\$1')}"`;
  }
}

const liveStatusService = new LiveStatusService();
module.exports = liveStatusService;
