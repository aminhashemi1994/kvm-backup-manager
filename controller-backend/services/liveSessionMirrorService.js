const { getBackupHosts, getBackupJobs, getVirtualMachines } = require('./fileStorage');
const { adoptLiveTmuxSessions, canInsertAdoptedJob } = require('./liveSessionAdoption');
const { snapshotJobs, commitJobChanges } = require('./jobReconcileCommit');

/**
 * LiveSessionMirrorService
 *
 * Keeps the stored job list mirroring `tmux ls` on every host CONTINUOUSLY,
 * instead of only while an HTTP request is being served.
 *
 * Adoption used to run inside the /active and /history handlers, so the panel
 * paid for it: opening Active Jobs fired a request that had to reach every
 * agent before it could answer, and the rows only showed up once that round
 * trip finished. Doing the same work on a background interval means the store
 * is already correct when the page loads — the handlers just read it — and the
 * sessions show up even with no browser tab open at all.
 *
 * This is deliberately the cheap half of reconciliation: one
 * GET /api/jobs/live-sessions per host, no per-job live-status calls. The
 * periodic agentSyncService still does the deep reconcile (finalizing finished
 * jobs) on its own slower cadence.
 */
class LiveSessionMirrorService {
  constructor() {
    this.io = null;
    this.timer = null;
    this.running = false;
    this.lastRunAt = 0;
    this.intervalMs = parseInt(process.env.LIVE_SESSION_MIRROR_INTERVAL_MS, 10) || 15000;
  }

  initialize(io) {
    this.io = io;
    if (this.timer) return;
    // First pass shortly after boot, once hosts have been health-checked.
    setTimeout(() => this.runOnce().catch(() => {}), 5000);
    this.timer = setInterval(() => {
      this.runOnce().catch(err =>
        console.error('[LiveSessionMirror] pass failed:', err.message)
      );
    }, this.intervalMs);
    console.log(`✓ Live tmux session mirror started (every ${Math.round(this.intervalMs / 1000)}s)`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce() {
    if (this.running) return { changed: false, skipped: true };
    this.running = true;
    try {
      const hosts = (await getBackupHosts()).filter(h => h && h.url && (!h.status || h.status === 'online'));
      if (hosts.length === 0) {
        this.lastRunAt = Date.now();
        return { changed: false };
      }

      const jobs = await getBackupJobs();
      const before = snapshotJobs(jobs);
      const vms = await getVirtualMachines();

      const adopted = await adoptLiveTmuxSessions(jobs, hosts, vms);
      this.lastRunAt = Date.now();
      if (!adopted) return { changed: false };

      const { changed, jobs: committed } = await commitJobChanges(before, jobs, {
        insertGuard: canInsertAdoptedJob,
      });
      if (!changed) return { changed: false };

      // Tell open panels right away instead of making them wait for their next
      // poll — this is what makes a session appear (and a phase change land)
      // "instantly". Only what actually moved is announced.
      if (this.io) {
        let announced = 0;
        for (const job of committed) {
          const prev = before.get(job.id);
          if (!prev || prev.status !== job.status || prev.phase !== job.phase ||
              prev.progress !== job.progress || prev.progressText !== job.progressText) {
            this.io.emit('job-updated', job);
            announced++;
          }
        }
        if (announced > 0) {
          this.io.emit('jobs-synced', { source: 'live-session-mirror', updated: announced });
        }
      }
      return { changed: true };
    } finally {
      this.running = false;
    }
  }
}

module.exports = new LiveSessionMirrorService();
