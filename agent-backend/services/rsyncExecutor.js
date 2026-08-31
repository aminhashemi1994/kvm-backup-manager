const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const { exec } = require('child_process');
const { promisify } = require('util');
const controllerAuthService = require('./controllerAuthService');
const { sanitizeLog } = require('../utils/logSanitizer');

const execAsync = promisify(exec);

const RSYNC_SCRIPT = path.join(__dirname, '../scripts/Rsync_Manager.sh');

/**
 * Offsite replication, run as its own job.
 *
 * Until now the rsync to the offsite hosts was the tail end of a backup run: it
 * lived in the backup's tmux session, wrote the backup's progress file, and
 * held the backup job open for as long as the transfer took — routinely hours
 * on a large chain. A failed transfer could only be retried by re-running the
 * whole thing, and the next backup could not report done until the previous
 * one's replication had finished.
 *
 * Here it is a job in its own right, driven by its own script — Rsync_Manager.sh
 * — in its own `rs_`-prefixed tmux session, against its own progress file and
 * its own lock, reporting to the controller's offsite-job endpoint. The backup
 * and the sync of the same VM can overlap safely: the transfer excludes
 * *.partial, which is exactly the data a running backup is still writing.
 *
 * Deliberately much smaller than BackupExecutor:
 *
 *   - No queue and no concurrency limit of its own. A sync is started by the
 *     controller, which does the throttling; the agent's job is to run it.
 *   - No VM lock map. The script's own VM-level lock file is the authority,
 *     and it survives an agent restart, which an in-memory map does not.
 *   - Exit code 75 is not a failure. It means another rsync for this VM holds
 *     the lock, so this one stood down without doing anything and without
 *     touching anyone's retry budget.
 */

// Must match Rsync_Manager.sh.
const EXIT_RSYNC_BUSY = 75;    // another sync for this VM holds the lock
const EXIT_OUT_OF_SYNC = 2;    // --check-only: a target differs from the source

// How often the progress file is read, and the floor on how often a progress
// update is pushed to the controller. A multi-hour transfer crosses whole
// percent points minutes apart, so pushing only on a changed percentage leaves
// the panel looking frozen; the text line (bytes, speed, ETA) moves constantly.
const PROGRESS_POLL_MS = 2000;
const PROGRESS_PUSH_INTERVAL_MS = 5000;

// How often untracked-but-live transfers are looked for. Matches
// BackupExecutor's sweep so both kinds of job are re-adopted equally quickly.
const RECOVERY_SWEEP_MS = 10000;

// How often the tmux session is checked for having exited.
const SESSION_POLL_MS = 5000;

class RsyncExecutor {
  constructor() {
    this.io = null;
    this.config = null;
    this.activeJobs = new Map();
    this.jobStateDir = null;
    this.recoveryCheckInterval = null;
  }

  init(io, config) {
    this.io = io;
    this.config = config;
    this.jobStateDir = path.join(config.logDir, 'rsync-job-state');
    if (!fs.existsSync(this.jobStateDir)) {
      fs.mkdirSync(this.jobStateDir, { recursive: true });
    }

    // Startup recovery alone is not enough, for the same reason BackupExecutor
    // runs this loop: a transfer can become untracked WHILE the agent is up —
    // a monitor torn down by an unhandled error, a state file written before a
    // crash mid-`executeRsync`. The session keeps running in tmux either way,
    // invisible to both the agent and the panel until something looks for it.
    // Cheap: it does nothing at all unless a state file has no live monitor.
    if (!this.recoveryCheckInterval) {
      this.recoveryCheckInterval = setInterval(() => {
        this.checkAndRecoverJobs().catch(err =>
          console.error(`[RsyncExecutor] Recovery sweep failed: ${err.message}`));
      }, RECOVERY_SWEEP_MS);
      // Never hold the process open for this.
      if (this.recoveryCheckInterval.unref) this.recoveryCheckInterval.unref();
    }

    console.log(`[RsyncExecutor] Ready. Job state: ${this.jobStateDir}`);
  }

  /**
   * Re-adopt transfers that are running in tmux but have no monitor.
   *
   * Only acts on jobs this agent has a state file for and is NOT already
   * tracking. A job whose session has genuinely gone is left to
   * recoverRunningJobs()'s stricter judgement at the next restart rather than
   * being finalized here — a sweep running every few seconds must not be the
   * thing that declares a transfer dead on one bad `tmux has-session`.
   */
  async checkAndRecoverJobs() {
    if (!this.jobStateDir) return;

    let files = [];
    try {
      files = fs.readdirSync(this.jobStateDir).filter(f => f.endsWith('.json'));
    } catch (_) {
      return;
    }

    for (const file of files) {
      const jobId = file.replace(/\.json$/, '');
      if (this.activeJobs.has(jobId)) continue; // already monitored

      let state = null;
      try {
        state = JSON.parse(fs.readFileSync(path.join(this.jobStateDir, file), 'utf8'));
      } catch (_) {
        continue; // a half-written file; the next sweep will read it whole
      }

      const session = state.tmuxSession;
      if (!session || !(await this._sessionExists(session))) continue;

      console.log(`[RsyncExecutor] Re-adopting offsite job ${jobId} — ${session} is alive but untracked`);
      const revived = { ...state, progressText: state.progressText || 'Re-attached to running sync' };
      this.activeJobs.set(jobId, revived);
      this._monitor(jobId, session, revived);
      // Tell the controller it is alive again, so a job it had given up on
      // stops reading as failed while the transfer is in fact still going.
      await this.updateController(jobId, 'running', state.progress || 0, {
        progressText: 'Re-attached to running sync',
      }).catch(() => { /* the monitor's next tick will carry it */ });
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Job state, so a restarted agent can find a transfer that is still running
  // ───────────────────────────────────────────────────────────────────────

  saveJobState(jobId, data) {
    try {
      fs.writeFileSync(
        path.join(this.jobStateDir, `${jobId}.json`),
        JSON.stringify(data, null, 2)
      );
    } catch (err) {
      console.error(`[RsyncExecutor] Could not save state for ${jobId}: ${err.message}`);
    }
  }

  deleteJobState(jobId) {
    try {
      const p = path.join(this.jobStateDir, `${jobId}.json`);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (_) { /* best effort */ }
  }

  /**
   * Reattach to transfers that outlived the agent.
   *
   * An rsync job lives in tmux, so restarting the agent does not stop it. Any
   * job whose session is still there is picked back up and monitored as if
   * nothing happened; the rest are judged by whatever exit code they left
   * behind, and reported as failed only when there is no evidence they
   * finished.
   */
  async recoverRunningJobs() {
    let files = [];
    try {
      files = fs.readdirSync(this.jobStateDir).filter(f => f.endsWith('.json'));
    } catch (_) {
      return;
    }
    if (files.length === 0) return;

    console.log(`[RsyncExecutor] Checking ${files.length} offsite job(s) left by the previous run`);

    for (const file of files) {
      const jobId = file.replace(/\.json$/, '');
      let state = null;
      try {
        state = JSON.parse(fs.readFileSync(path.join(this.jobStateDir, file), 'utf8'));
      } catch (_) {
        this.deleteJobState(jobId);
        continue;
      }

      const session = state.tmuxSession;
      if (session && await this._sessionExists(session)) {
        console.log(`[RsyncExecutor] Offsite job ${jobId} is still running in ${session}; reattaching`);
        this.activeJobs.set(jobId, state);
        this._monitor(jobId, session, state);
        continue;
      }

      const exitCode = this._readExitCode(jobId);
      if (exitCode === null) {
        console.warn(`[RsyncExecutor] Offsite job ${jobId} vanished with no exit code; reporting as failed`);
        await this.updateController(jobId, 'failed', null, {
          error: 'The agent restarted and this offsite sync was no longer running. No result was recorded.',
        });
      } else {
        console.log(`[RsyncExecutor] Offsite job ${jobId} finished while the agent was down (exit ${exitCode})`);
        await this._reportOutcome(jobId, state, exitCode);
      }
      this.deleteJobState(jobId);
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Running a sync
  // ───────────────────────────────────────────────────────────────────────

  /**
   * @param {object} jobData
   * @param {string} jobData.jobId
   * @param {string} jobData.vmName
   * @param {string} jobData.storagePoolPath  Source pool on this backup host.
   * @param {string[]} jobData.offsiteHosts   Encoded "ip[:path[:threshold]]".
   */
  async executeRsync(jobData) {
    const {
      jobId,
      vmName,
      storagePoolPath,
      offsiteHosts = [],
      offsiteRetryAttempts = 3,
      offsiteRetryBackoffSeconds = 15,
      offsiteRsyncTimeoutSeconds = 1800,
      diskUsageThreshold = 80,
      verbose = false,
      // Re-record the source baseline instead of refusing when it does not
      // match. Only ever set deliberately, for a pool that really has moved to
      // new storage — it disarms the guard that protects the offsite copies.
      resetSourceGuard = false,
    } = jobData;

    if (!vmName) throw new Error('vmName is required');
    if (!storagePoolPath) throw new Error('storagePoolPath is required');
    if (!Array.isArray(offsiteHosts) || offsiteHosts.length === 0) {
      throw new Error('At least one offsite host is required');
    }

    const logFile = path.join(this.config.logDir, `${jobId}.log`);
    const log = (message) => {
      const timestamp = new Date().toISOString();
      const line = `[${timestamp}] ${sanitizeLog(message)}\n`;
      try { fs.appendFileSync(logFile, line); } catch (_) { /* best effort */ }
      if (this.io) {
        this.io.to(`job-${jobId}`).emit('offsite-log', { jobId, timestamp, message });
      }
    };

    // <vm>_rsync_<jobid8>. Named so an operator running `tmux ls` on the host
    // can tell at a glance which VM a transfer belongs to and that it is a
    // replication rather than a backup.
    //
    // The `_rsync_<8 hex>` tail is also the namespace marker: BackupExecutor
    // falls back to matching tmux sessions by VM name when it has lost track
    // of one, and skips anything carrying this tail. Without that it would
    // adopt a transfer's session as a backup's and report rsync progress
    // against the backup job. Keep the two in step if either is renamed.
    const sanitizedVmName = vmName.replace(/[^a-zA-Z0-9-]/g, '_');
    const tmuxSession = `${sanitizedVmName}_rsync_${jobId.substring(0, 8)}`;

    const state = { ...jobData, tmuxSession, startedAt: Date.now(), progress: 0 };
    this.activeJobs.set(jobId, state);
    this.saveJobState(jobId, state);

    const args = this._buildArgs({
      vmName, storagePoolPath, offsiteHosts, diskUsageThreshold,
      offsiteRetryAttempts, offsiteRetryBackoffSeconds, offsiteRsyncTimeoutSeconds,
      verbose, jobId, tmuxSession, resetSourceGuard,
    });

    const command = `bash ${RSYNC_SCRIPT} ${args.join(' ')}`;

    log('');
    log('═'.repeat(60));
    log(`OFFSITE SYNC — ${vmName}`);
    log(`Targets: ${offsiteHosts.join(', ')}`);
    log(`Started: ${new Date().toISOString()}`);
    log(`Script log dir: ${path.join(storagePoolPath, vmName, 'offsite_logs')}`);
    log('═'.repeat(60));
    log(`Creating tmux session: ${tmuxSession}`);

    await this.updateController(jobId, 'running', 0, { progressText: 'Starting offsite sync...' });

    const exitCodeFile = path.join(this.config.logDir, `${jobId}.exitcode`);
    try {
      try { if (fs.existsSync(exitCodeFile)) fs.unlinkSync(exitCodeFile); } catch (_) { /* best effort */ }

      await execAsync(`tmux kill-session -t ${tmuxSession} 2>/dev/null || true`);
      await execAsync(`tmux new-session -d -s ${tmuxSession}`);
      // Wire the capture up before the command runs: a sync that refuses
      // immediately — an offsite host declining the connection, or the VM lock
      // already held — starts and exits inside the window this would otherwise
      // miss, leaving no trace of it in the log at all.
      await execAsync(`tmux pipe-pane -t ${tmuxSession} -o "cat >> '${logFile}'"`);
      await execAsync(
        `tmux send-keys -t ${tmuxSession} "cd '${storagePoolPath}' && ${command}; echo \\$? > '${exitCodeFile}'; exit" C-m`
      );

      log(`Offsite sync running. Attach with: tmux attach -t ${tmuxSession}`);
      this._monitor(jobId, tmuxSession, state);
      return { success: true, tmuxSession };
    } catch (error) {
      log(`Failed to start the offsite sync: ${error.message}`);
      this.activeJobs.delete(jobId);
      this.deleteJobState(jobId);
      await this.updateController(jobId, 'failed', null, { error: error.message });
      return { success: false, error: error.message };
    }
  }

  /**
   * Arguments for Rsync_Manager.sh. Shared by the sync and the check so the two
   * can never end up pointed at different targets or thresholds.
   */
  _buildArgs({
    vmName, storagePoolPath, offsiteHosts, diskUsageThreshold,
    offsiteRetryAttempts, offsiteRetryBackoffSeconds, offsiteRsyncTimeoutSeconds,
    verbose, jobId, tmuxSession, checkOnly, resetSourceGuard,
  }) {
    const args = [
      '--domain', `'${vmName}'`,
      '--backup-path', `'${storagePoolPath}'`,
      '--offsite-ip', `'${offsiteHosts.join(',')}'`,
      '--disk-threshold', String(diskUsageThreshold != null ? diskUsageThreshold : 80),
    ];
    if (checkOnly) {
      args.push('--check-only');
    } else {
      args.push(
        '--offsite-retry-attempts', String(offsiteRetryAttempts != null ? offsiteRetryAttempts : 3),
        '--offsite-retry-backoff-base', String(offsiteRetryBackoffSeconds != null ? offsiteRetryBackoffSeconds : 15),
        '--offsite-rsync-timeout', String(offsiteRsyncTimeoutSeconds != null ? offsiteRsyncTimeoutSeconds : 1800),
      );
    }
    // Identity, so the lock the script takes names its owner and a later run
    // can tell "still going" from "died and left the lock behind".
    if (jobId) args.push('--rsync-job-id', jobId);
    if (tmuxSession) args.push('--rsync-tmux-session', tmuxSession);
    if (resetSourceGuard) args.push('--reset-source-guard');
    if (verbose) args.push('--verbose');
    return args;
  }

  /**
   * Is every offsite target holding exactly what this VM's backup directory
   * holds? Reads only — no transfer, no lock taken.
   *
   * This is what the replication check calls. It runs in the foreground rather
   * than in tmux: it is metadata work measured in seconds, and the caller wants
   * the answer, not a job to follow.
   *
   * A VM with a sync already running reports `checked: false` rather than an
   * answer. Its destination is mid-update by definition, so any verdict would
   * be about a moving target, and whoever holds the lock will report the real
   * outcome when they finish.
   */
  async checkReplication({ vmName, storagePoolPath, offsiteHosts = [], diskUsageThreshold, timeoutMs = 300000 }) {
    if (!vmName || !storagePoolPath) throw new Error('vmName and storagePoolPath are required');
    if (!Array.isArray(offsiteHosts) || offsiteHosts.length === 0) {
      throw new Error('At least one offsite host is required');
    }

    const args = this._buildArgs({
      vmName, storagePoolPath, offsiteHosts, diskUsageThreshold, checkOnly: true,
    });

    let stdout = '';
    let exitCode = 0;
    try {
      const res = await execAsync(`bash ${RSYNC_SCRIPT} ${args.join(' ')}`, {
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
      });
      stdout = res.stdout || '';
    } catch (err) {
      // A non-zero exit is an answer here, not an error: 2 means out of sync,
      // 75 means a sync is in progress. Only a missing result is a failure.
      stdout = (err && err.stdout) || '';
      exitCode = (err && typeof err.code === 'number') ? err.code : 1;
      if (!stdout && err && err.killed) {
        throw new Error(`Replication check for ${vmName} timed out after ${timeoutMs}ms`);
      }
    }

    // The script prints one JSON line last, after everything it logged.
    const line = stdout.trim().split('\n').filter(l => l.trim().startsWith('{')).pop();
    if (!line) {
      throw new Error(`Replication check for ${vmName} produced no result (exit ${exitCode})`);
    }

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(`Replication check for ${vmName} returned unreadable output: ${err.message}`);
    }
    return { ...parsed, exitCode, inSync: exitCode === 0 && parsed.state === 'in_sync' };
  }

  /**
   * Stop a running sync.
   *
   * Killing the tmux session takes rsync with it. Nothing needs undoing: the
   * partially transferred file is staged inside .rsync-partial and never under
   * its real name, so the destination is never left holding a truncated file
   * under a name that looks complete, and the next run resumes from there.
   */
  async cancelRsync(jobId) {
    const state = this.activeJobs.get(jobId) || this._loadJobState(jobId);
    if (!state) return { success: false, error: 'No such offsite job' };

    if (state.tmuxSession) {
      try {
        await execAsync(`tmux kill-session -t ${state.tmuxSession} 2>/dev/null || true`);
      } catch (_) { /* already gone */ }
    }
    this.activeJobs.delete(jobId);
    this.deleteJobState(jobId);
    await this.updateController(jobId, 'cancelled', null, {
      progressText: 'Cancelled. Transferred data is kept and the next sync resumes from it.',
    });
    return { success: true };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Monitoring
  // ───────────────────────────────────────────────────────────────────────

  _monitor(jobId, tmuxSession, state) {
    const { vmName, storagePoolPath } = state;
    const basePath = storagePoolPath || this.config.backupPath;
    // The sync's own progress file. Never the backup's — a backup for this VM
    // may be running right now, and the two would overwrite each other.
    const progressFile = path.join(basePath, '.progress', `${vmName}_offsite.progress`);
    // The script writes one extra file per offsite host while the sync is
    // running (`${vm_name}_offsite_<ip>.progress`). We read all of them so the
    // panel can show one bar per target — the aggregate file alone only has
    // an overall percentage.
    const progressDir = path.join(basePath, '.progress');

    let lastPct = -1;
    let lastText = '';
    let lastTargetsSig = '';
    let lastPushAt = 0;

    const progressInterval = setInterval(() => {
      try {
        if (!fs.existsSync(progressFile)) return;
        const content = fs.readFileSync(progressFile, 'utf8').trim();
        if (!content) return;

        let data;
        try { data = JSON.parse(content); } catch { return; }

        const pct = Number.isFinite(data.percentage) ? data.percentage : 0;
        const text = data.text || '';

        // Per-target snapshot. Built from the per-host progress files the
        // script writes; absent or empty files just drop out of the snapshot.
        const targets = this._collectTargetProgress(vmName, progressDir);

        const targetsSig = targets.map(t => `${t.ip}:${t.percentage}:${t.status}`).join('|');
        const now = Date.now();
        const changed = pct !== lastPct || text !== lastText || targetsSig !== lastTargetsSig;
        const stale = now - lastPushAt >= PROGRESS_PUSH_INTERVAL_MS;
        if (!changed && !stale) return;

        lastPct = pct;
        lastText = text;
        lastTargetsSig = targetsSig;
        lastPushAt = now;

        const tracked = this.activeJobs.get(jobId);
        if (tracked) {
          tracked.progress = pct;
          tracked.progressText = text;
          tracked.offsiteProgress = targets;
        }
        if (this.io) {
          this.io.to(`job-${jobId}`).emit('offsite-progress', {
            jobId,
            progress: pct,
            progressText: text,
            targets,
          });
        }
        this.updateController(jobId, 'running', pct, {
          progressText: text,
          offsiteProgress: targets,
        }).catch(() => { /* progress updates are self-correcting; stay quiet */ });
      } catch (_) { /* transient read errors are expected while it is rewritten */ }
    }, PROGRESS_POLL_MS);

    // setInterval does not wait for an async callback, and `_sessionExists`
    // shells out to tmux — under load that can take longer than the poll
    // period. Without this flag two ticks sit in the same await, both see the
    // session gone, and both report the outcome: a duplicate terminal update,
    // a duplicate RocketChat message, and a second follow-up sync. The
    // clearInterval calls below do not help, because the second tick has
    // already fired by the time they run.
    let settling = false;

    const sessionInterval = setInterval(async () => {
      if (settling) return;
      if (await this._sessionExists(tmuxSession)) return;
      if (settling) return; // a tick that started before this one won the race
      settling = true;

      clearInterval(progressInterval);
      clearInterval(sessionInterval);

      // The shell writes the exit code after the script returns, so it can lag
      // the session disappearing by a moment.
      await new Promise(r => setTimeout(r, 1500));
      const exitCode = this._readExitCode(jobId);

      await this._reportOutcome(jobId, state, exitCode);
      this.activeJobs.delete(jobId);
      this.deleteJobState(jobId);
    }, SESSION_POLL_MS);
  }

  /**
   * Turn an exit code into the job's verdict.
   *
   * Four outcomes, not two. EXIT_RSYNC_BUSY means another rsync for this VM
   * already held the lock, so this job did nothing at all — reporting that as
   * a failure would raise an incident for the lock working correctly, and would
   * spend a retry attempt on a sync that was never attempted. A null exit code
   * means no exit code was ever recorded, which says the session was killed,
   * not that the transfer failed; the events file decides that one.
   */
  async _reportOutcome(jobId, state, exitCode) {
    const { vmName, storagePoolPath, startedAt } = state;
    const results = this._collectOffsiteResults(
      vmName, storagePoolPath, startedAt || Date.now() - 3600000
    );

    this._logSummary(jobId, exitCode, results);

    if (exitCode === EXIT_RSYNC_BUSY) {
      await this.updateController(jobId, 'busy', null, {
        progressText: 'Another offsite sync for this VM was already running; nothing to do.',
        offsiteResults: results,
      });
      return;
    }

    if (exitCode === 0) {
      await this.updateController(jobId, 'completed', 100, {
        exitCode,
        progressText: 'Offsite sync complete — destination verified against source.',
        offsiteResults: results,
      });
      return;
    }

    // A guard refusal never reaches a target, so there are no per-target
    // results to explain it. Read the reason the script gave instead —
    // "exit code 1" is useless next to "the pool is not mounted".
    const refusal = this._readSourceRefusal(
      vmName, storagePoolPath, startedAt || Date.now() - 3600000
    );
    if (refusal) {
      await this.updateController(jobId, 'failed', null, {
        exitCode,
        error: refusal.message,
        sourceGuard: refusal.event,
        offsiteResults: results,
      });
      return;
    }

    // No exit code file at all. The shell writes it after the script returns,
    // so a missing one does not mean the sync failed — it means the session
    // ended without the shell getting that far: `tmux kill-session`, a reboot,
    // an OOM kill. Reporting that as a plain sync failure blames the transfer
    // for something that happened to it, and it looks identical to a genuine
    // rsync error in the history.
    //
    // The events file is the better witness. The script writes one per target
    // as it finishes, so if every target recorded success the work is done and
    // the verdict is 'completed' regardless of the missing file. Anything else
    // is still a failure, but one that says what actually happened.
    if (exitCode === null) {
      const targets = results || [];
      const allSucceeded = targets.length > 0 && targets.every(r => r.status === 'success');

      if (allSucceeded) {
        await this.updateController(jobId, 'completed', 100, {
          exitCode: null,
          progressText: 'Offsite sync complete — every target verified before the session ended.',
          offsiteResults: results,
        });
        return;
      }

      const partial = targets.filter(r => r.status === 'failed' || r.status === 'skipped');
      await this.updateController(jobId, 'failed', null, {
        exitCode: null,
        error: partial.length > 0
          ? `Offsite sync ended without completing: ${partial.map(r => `${r.ip} (${r.reason || 'unknown'})`).join(', ')}`
          : 'The offsite sync session ended without recording an outcome — it was killed, '
            + 'or the host restarted, before the transfer finished. Nothing was deleted at '
            + 'the destination; the next sync will resume the work.',
        offsiteResults: results,
      });
      return;
    }

    const failed = (results || []).filter(r => r.status === 'failed' || r.status === 'skipped');
    const error = failed.length > 0
      ? `Offsite sync failed for ${failed.map(r => `${r.ip} (${r.reason || 'unknown'})`).join(', ')}`
      : `Offsite sync failed (exit code ${exitCode === null ? 'unknown' : exitCode})`;

    await this.updateController(jobId, 'failed', null, {
      exitCode,
      error,
      offsiteResults: results,
    });
  }

  _logSummary(jobId, exitCode, results) {
    try {
      const ts = new Date().toISOString();
      const lines = ['', '─'.repeat(60)];
      if (exitCode === EXIT_RSYNC_BUSY) {
        lines.push('OFFSITE SYNC STOOD DOWN — another sync for this VM holds the lock');
      } else {
        lines.push(`OFFSITE SYNC FINISHED — exit code ${exitCode === null ? 'unknown' : exitCode}`);
      }
      if (Array.isArray(results) && results.length > 0) {
        lines.push('Result per target:');
        for (const r of results) {
          lines.push(`  ${r.ip}: ${r.status}${r.reason ? ` (${r.reason})` : ''}`);
        }
      }
      lines.push(`Finished: ${ts}`, '─'.repeat(60), '');
      fs.appendFileSync(
        path.join(this.config.logDir, `${jobId}.log`),
        lines.map(l => `[${ts}] ${l}`).join('\n') + '\n'
      );
      if (this.io) {
        this.io.to(`job-${jobId}`).emit('offsite-log', { jobId, timestamp: ts, message: lines.join('\n') });
      }
    } catch (_) { /* never let logging break completion handling */ }
  }

  /**
   * The sync's own log, as tmux captured it.
   *
   * This is the file `pipe-pane` writes, so it holds everything the pane
   * showed — including Rsync_Manager's live per-target progress bars. The
   * controller serves it to the panel exactly as it serves a backup's log,
   * which is what makes the two views behave the same way.
   *
   * @param {string} jobId
   * @param {number|string} [tail] last N lines only; the whole file otherwise
   */
  async readLog(jobId, tail) {
    const logFile = path.join(this.config.logDir, `${jobId}.log`);
    let content = '';
    try {
      content = await fsp.readFile(logFile, 'utf8');
    } catch (err) {
      // No log is a normal answer (job never started, or log already reaped),
      // not an error — the controller falls back to its own record.
      if (err.code === 'ENOENT') return '';
      throw err;
    }

    const n = parseInt(tail, 10);
    if (!Number.isFinite(n) || n <= 0) return content;

    const lines = content.split('\n');
    return lines.slice(-n).join('\n');
  }

  // ───────────────────────────────────────────────────────────────────────
  // Helpers
  // ───────────────────────────────────────────────────────────────────────

  async _sessionExists(session) {
    try {
      await execAsync(`tmux has-session -t ${session} 2>/dev/null`);
      return true;
    } catch (_) {
      return false;
    }
  }

  _readExitCode(jobId) {
    try {
      const p = path.join(this.config.logDir, `${jobId}.exitcode`);
      if (!fs.existsSync(p)) return null;
      const raw = fs.readFileSync(p, 'utf8').trim();
      const code = parseInt(raw, 10);
      return Number.isFinite(code) ? code : null;
    } catch (_) {
      return null;
    }
  }

  _loadJobState(jobId) {
    try {
      const p = path.join(this.jobStateDir, `${jobId}.json`);
      if (!fs.existsSync(p)) return null;
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (_) {
      return null;
    }
  }

  /**
   * Per-target outcomes, read from the events file the script writes.
   *
   * `offsite_host_busy` maps to 'skipped' rather than 'failed': that target was
   * not attempted because someone else was already syncing to it, which is not
   * something to warn about or count against the target's health.
   */
  /**
   * The run-level events file for this sync.
   *
   * The sync writes to the VM's own offsite_logs directory — it belongs to no
   * single schedule, and it is excluded from the transfer so it never travels
   * to the offsite host. Per-target files carry an _offsite_<ip> infix, so the
   * run-level name is matched exactly.
   */
  _findRunEventsFile(vmName, storagePoolPath, sinceMs) {
    if (!vmName || !storagePoolPath) return null;
    const logsDir = path.join(storagePoolPath, vmName, 'offsite_logs');
    if (!fs.existsSync(logsDir)) return null;

    const candidates = fs.readdirSync(logsDir)
      .filter(f => /_offsite\.events\.jsonl$/.test(f))
      .map(f => {
        const full = path.join(logsDir, f);
        try { return { full, mtime: fs.statSync(full).mtimeMs }; } catch { return null; }
      })
      .filter(Boolean)
      .filter(x => x.mtime >= sinceMs - 60000)
      .sort((a, b) => b.mtime - a.mtime);

    return candidates.length > 0 ? candidates[0].full : null;
  }

  /**
   * Snapshot every per-host progress file for a running offsite sync.
   *
   * The script writes `${vmName}_offsite_<ip>.progress` next to the aggregate
   * file while the sync is in flight. Each is a single JSON line of the form
   * `{"percentage":N,"text":"...","type":"rsync","timestamp":"..."}` — we
   * parse that into a normalised `{ ip, percentage, text }` row. Rows whose
   * file no longer exists (the script deletes per-target files at the end of
   * the run, line 2168) simply drop out, and we never throw — the next poll
   * replaces whatever we sent last.
   *
   * The terminal state (success / failed / busy) is appended by reading the
   * newest matching `_offsite_<ip>.events.jsonl` once we hit 100%, so the
   * panel's progress bars can switch from spinner → done / failed without
   * waiting for the agent's `_reportOutcome` to send a new patch.
   */
  _collectTargetProgress(vmName, progressDir) {
    if (!vmName || !progressDir) return [];
    let entries;
    try {
      entries = fs.readdirSync(progressDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const prefix = `${vmName}_offsite_`;
    const suffix = '.progress';
    const out = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
      const ip = name.slice(prefix.length, name.length - suffix.length);
      const full = path.join(progressDir, name);
      let data;
      try {
        const raw = fs.readFileSync(full, 'utf8').trim();
        if (!raw) continue;
        data = JSON.parse(raw);
      } catch {
        continue;
      }
      const percentage = Number.isFinite(data.percentage) ? Math.max(0, Math.min(100, data.percentage)) : 0;
      const text = data.text || '';
      out.push({ ip, percentage, text });
    }
    out.sort((a, b) => (a.ip > b.ip ? 1 : a.ip < b.ip ? -1 : 0));

    // Cross-reference the events log for any target already at 100%: that is
    // when the script has emitted offsite_host_complete / offsite_host_fail,
    // and reflecting it in the panel one beat earlier than _reportOutcome is
    // the difference between a row that looks like it's still syncing for a
    // few seconds and one that flips to done immediately.
    for (const row of out) {
      if (row.percentage < 100) continue;
      try {
        const eventsFile = this._findTargetEventsFile(vmName, row.ip, progressDir);
        if (!eventsFile) continue;
        const lines = fs.readFileSync(eventsFile, 'utf8').split('\n');
        // Walk backwards — the most recent event wins.
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim();
          if (!line) continue;
          let ev;
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev.event === 'offsite_host_complete') { row.status = 'success'; break; }
          if (ev.event === 'offsite_host_fail')    { row.status = 'failed';  break; }
          if (ev.event === 'offsite_host_busy')    { row.status = 'skipped'; break; }
        }
      } catch { /* best effort */ }
    }
    return out;
  }

  /** Locate the per-target events file the script writes for one offsite host. */
  _findTargetEventsFile(vmName, ip, progressDir) {
    try {
      const entries = fs.readdirSync(progressDir, { withFileTypes: true });
      // The script names them `${timestamp}_offsite_${ip}.events.jsonl` inside
      // the VM's offsite_logs directory. That path is relative to the storage
      // pool, not to `.progress`, so we look one level up.
      const logsDir = path.dirname(progressDir);
      const vmLogsDir = path.join(logsDir, vmName, 'offsite_logs');
      const files = fs.readdirSync(vmLogsDir, { withFileTypes: true })
        .filter(e => e.isFile() && e.name.endsWith(`_offsite_${ip}.events.jsonl`))
        .map(e => ({ full: path.join(vmLogsDir, e.name), mtime: fs.statSync(path.join(vmLogsDir, e.name)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      return files[0] ? files[0].full : null;
    } catch {
      return null;
    }
  }

  _collectOffsiteResults(vmName, storagePoolPath, sinceMs) {
    try {
      const file = this._findRunEventsFile(vmName, storagePoolPath, sinceMs);
      if (!file) return null;

      const results = [];
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        switch (ev.event) {
          case 'offsite_host_complete':
            results.push({ ip: ev.offsite_ip, poolPath: ev.offsite_path, status: 'success' });
            break;
          case 'offsite_host_fail':
            results.push({ ip: ev.offsite_ip, poolPath: ev.offsite_path, status: 'failed', reason: ev.reason || ev.message });
            break;
          case 'offsite_fail':
          case 'offsite_host_busy':
            results.push({ ip: ev.offsite_ip, poolPath: ev.offsite_path, status: 'skipped', reason: ev.reason || ev.message });
            break;
          default:
            break;
        }
      }
      return results.length > 0 ? results : null;
    } catch (err) {
      console.error(`[RsyncExecutor] Could not read offsite results: ${err.message}`);
      return null;
    }
  }

  /**
   * Did the script refuse to sync because of the source, rather than fail
   * partway through a transfer?
   *
   * These three refusals are what protect the offsite copies from being deleted
   * to match a source that is missing, unmounted, or not the filesystem it
   * should be. They are the most important thing this job can report, and they
   * carry no per-target detail — so they are read straight off the events file
   * and handed to the controller as the verdict.
   */
  _readSourceRefusal(vmName, storagePoolPath, sinceMs) {
    const REFUSALS = {
      offsite_source_unmounted:
        'Refused to sync: the backup pool is not mounted. Syncing from an unmounted '
        + 'pool would delete this VM\u2019s backups from every offsite host.',
      offsite_source_changed:
        'Refused to sync: the backup pool path resolves to a different filesystem than it '
        + 'did before. Syncing would delete offsite data to match storage this pool has not used.',
      offsite_source_empty:
        'Refused to sync: the backup directory holds no backup data. Syncing an empty '
        + 'source would delete this VM\u2019s backups from every offsite host.',
    };

    try {
      const file = this._findRunEventsFile(vmName, storagePoolPath, sinceMs);
      if (!file) return null;
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (REFUSALS[ev.event]) {
          const detail = ev.found ? ` (found: ${ev.found})` : '';
          return { event: ev.event, message: REFUSALS[ev.event] + detail };
        }
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  async updateController(jobId, status, progress = null, extra = {}) {
    if (!this.config || !this.config.controllerUrl) return;

    const payload = { status };
    if (progress !== null) payload.progress = progress;
    for (const [k, v] of Object.entries(extra)) {
      if (v !== null && v !== undefined) payload[k] = v;
    }

    // Terminal updates are worth retrying: losing one leaves the controller
    // showing a transfer as still running until a much later reconcile, with a
    // wildly wrong duration. Progress updates are frequent and self-correcting,
    // so they get one shot and stay quiet on failure.
    const terminal = ['completed', 'failed', 'cancelled', 'busy'].includes(status);
    const attempts = terminal ? 6 : 1;

    let lastErr = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await controllerAuthService.post(
          this.config.controllerUrl,
          `/offsite-jobs/${jobId}/update`,
          payload,
          { timeout: terminal ? 10000 : 5000 }
        );
        return;
      } catch (err) {
        lastErr = err;
        if (!terminal) return;
        if (attempt < attempts) {
          await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** (attempt - 1), 30000)));
        }
      }
    }
    console.error(`[RsyncExecutor] Could not report ${status} for ${jobId}: ${lastErr && lastErr.message}`);
  }
}

module.exports = new RsyncExecutor();
