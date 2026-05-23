const path = require('path');
const fs = require('fs').promises;
const config = require('../config/config');
const {
  getBackupHosts,
  getBackupJobs,
  getBackupSchedules,
  getVirtualMachines,
  getHypervisors,
  getStoragePools,
} = require('./fileStorage');
const agentService = require('./agentService');

const SNAPSHOTS_DIR = path.join(config.dataDir, 'report-snapshots');
const ENRICHED_CACHE_FILE = path.join(config.dataDir, 'enriched-report-cache.json');

/**
 * ReportEnrichmentService (Item 7)
 *
 * Takes the raw agent report (per-host) and enriches it with:
 *   - Per-VM rollups: total size, schedule count, last success/failure,
 *     success rate (30/90 days), avg duration, retention status, offsite sync
 *   - Per-host rollups: storage usage, total VMs, healthy/corrupted, throughput
 *   - Global rollups: total protected VMs, total storage, success rate,
 *     missed/failed in last 7/30 days
 *   - Creation dates per backup/method, chain depth dates
 *
 * Also manages daily snapshots for trending.
 */
class ReportEnrichmentService {
  constructor() {
    this.snapshotTimer = null;
  }

  async initialize() {
    // Ensure snapshots directory exists
    try {
      await fs.mkdir(SNAPSHOTS_DIR, { recursive: true });
    } catch (e) {}

    // Schedule daily snapshot (check every hour, generate if >24h old)
    this.snapshotTimer = setInterval(() => {
      this._maybeGenerateSnapshot().catch(e => {
        console.error('[ReportEnrich] Snapshot generation error:', e.message);
      });
    }, 60 * 60 * 1000); // every hour
    this.snapshotTimer.unref?.();

    // Generate initial snapshot if none exists for today
    this._maybeGenerateSnapshot().catch(() => {});
    console.log('✓ Report enrichment service initialized');
  }

  /**
   * Get enriched report for a specific backup host.
   * Fetches raw report from agent, then enriches with controller-side data.
   */
  async getEnrichedReport(backupHostId) {
    const hosts = await getBackupHosts();
    const host = hosts.find(h => h.id === backupHostId);
    if (!host) throw new Error('Backup host not found');

    // Fetch raw report from agent
    const rawResult = await agentService.getBackupReport(host.url);
    if (!rawResult.success || !rawResult.data) {
      return { success: false, error: rawResult.error || 'Report not available' };
    }

    const raw = rawResult.data;
    const jobs = await getBackupJobs();
    const schedules = await getBackupSchedules();
    const vms = await getVirtualMachines();

    // Enrich each VM
    const enrichedVMs = (raw.vms || []).map(vmReport => {
      return this._enrichVM(vmReport, jobs, schedules, vms, host);
    });

    // Per-host rollup
    const hostRollup = this._computeHostRollup(enrichedVMs, raw, host, jobs);

    return {
      success: true,
      data: {
        ...raw,
        vms: enrichedVMs,
        hostRollup,
        backupHostId: host.id,
        backupHostName: host.name,
        enrichedAt: new Date().toISOString(),
      },
    };
  }

  /**
   * Get global rollup across all hosts.
   */
  async getGlobalRollup() {
    const hosts = await getBackupHosts();
    const jobs = await getBackupJobs();
    const schedules = await getBackupSchedules();
    const vms = await getVirtualMachines();
    const pools = await getStoragePools();

    const now = Date.now();
    const day7 = now - 7 * 86400000;
    const day30 = now - 30 * 86400000;

    const recentJobs7 = jobs.filter(j => new Date(j.startTime).getTime() > day7);
    const recentJobs30 = jobs.filter(j => new Date(j.startTime).getTime() > day30);

    const completed7 = recentJobs7.filter(j => j.status === 'completed').length;
    const failed7 = recentJobs7.filter(j => j.status === 'failed').length;
    const skipped7 = recentJobs7.filter(j => j.status === 'skipped').length;
    const completed30 = recentJobs30.filter(j => j.status === 'completed').length;
    const failed30 = recentJobs30.filter(j => j.status === 'failed').length;
    const skipped30 = recentJobs30.filter(j => j.status === 'skipped').length;

    const successRate7 = recentJobs7.length > 0
      ? Math.round((completed7 / recentJobs7.length) * 100)
      : 100;
    const successRate30 = recentJobs30.length > 0
      ? Math.round((completed30 / recentJobs30.length) * 100)
      : 100;

    return {
      totalBackupHosts: hosts.length,
      onlineHosts: hosts.filter(h => h.status === 'online').length,
      totalProtectedVMs: vms.length,
      totalSchedules: schedules.filter(s => s.enabled !== false).length,
      totalStoragePools: pools.length,
      last7Days: {
        total: recentJobs7.length,
        completed: completed7,
        failed: failed7,
        skipped: skipped7,
        successRate: successRate7,
      },
      last30Days: {
        total: recentJobs30.length,
        completed: completed30,
        failed: failed30,
        skipped: skipped30,
        successRate: successRate30,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Get report data formatted for download (JSON/CSV scope).
   */
  async getDownloadData(scope, scopeId = null) {
    if (scope === 'global') {
      return await this.getGlobalRollup();
    }
    if (scope === 'host' && scopeId) {
      const result = await this.getEnrichedReport(scopeId);
      return result.success ? result.data : null;
    }
    if (scope === 'vm' && scopeId) {
      // Find which host has this VM
      const vms = await getVirtualMachines();
      const vm = vms.find(v => v.id === scopeId);
      if (!vm) return null;
      const hosts = await getBackupHosts();
      const host = hosts.find(h => h.id === vm.backupHostId);
      if (!host) return null;
      const result = await this.getEnrichedReport(host.id);
      if (!result.success) return null;
      const vmReport = result.data.vms.find(v => v.vm_name === vm.name);
      return vmReport || null;
    }
    return null;
  }

  /**
   * Get trending data (daily snapshots).
   */
  async getTrending(days = 30) {
    try {
      const files = await fs.readdir(SNAPSHOTS_DIR);
      const jsonFiles = files.filter(f => f.endsWith('.json')).sort().slice(-days);
      const snapshots = [];
      for (const file of jsonFiles) {
        try {
          const data = await fs.readFile(path.join(SNAPSHOTS_DIR, file), 'utf8');
          snapshots.push(JSON.parse(data));
        } catch (e) {}
      }
      return snapshots;
    } catch (e) {
      return [];
    }
  }

  // -------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------

  _enrichVM(vmReport, jobs, schedules, vms, host) {
    const vmName = vmReport.vm_name;
    // Find matching VM in controller data
    const controllerVm = vms.find(v => v.name === vmName && v.backupHostId === host.id);
    const vmId = controllerVm ? controllerVm.id : null;

    // Get jobs for this VM
    const vmJobs = vmId
      ? jobs.filter(j => j.vmId === vmId)
      : jobs.filter(j => j.vmName === vmName && j.backupHostId === host.id);

    const now = Date.now();
    const day30 = now - 30 * 86400000;
    const day90 = now - 90 * 86400000;

    const jobs30 = vmJobs.filter(j => new Date(j.startTime).getTime() > day30);
    const jobs90 = vmJobs.filter(j => new Date(j.startTime).getTime() > day90);

    const completed30 = jobs30.filter(j => j.status === 'completed').length;
    const completed90 = jobs90.filter(j => j.status === 'completed').length;

    const successRate30 = jobs30.length > 0 ? Math.round((completed30 / jobs30.length) * 100) : null;
    const successRate90 = jobs90.length > 0 ? Math.round((completed90 / jobs90.length) * 100) : null;

    // Last success / failure
    const completedJobs = vmJobs.filter(j => j.status === 'completed').sort((a, b) =>
      new Date(b.endTime || b.startTime) - new Date(a.endTime || a.startTime)
    );
    const failedJobs = vmJobs.filter(j => j.status === 'failed').sort((a, b) =>
      new Date(b.endTime || b.startTime) - new Date(a.endTime || a.startTime)
    );

    const lastSuccess = completedJobs[0] ? (completedJobs[0].endTime || completedJobs[0].startTime) : null;
    const lastFailure = failedJobs[0] ? (failedJobs[0].endTime || failedJobs[0].startTime) : null;
    const lastFailureError = failedJobs[0] ? failedJobs[0].error : null;

    // Average duration (completed jobs in last 30 days)
    const durationsMs = jobs30
      .filter(j => j.status === 'completed' && j.startTime && j.endTime)
      .map(j => new Date(j.endTime) - new Date(j.startTime));
    const avgDurationMs = durationsMs.length > 0
      ? Math.round(durationsMs.reduce((a, b) => a + b, 0) / durationsMs.length)
      : null;

    // Schedule count
    const vmSchedules = vmId
      ? schedules.filter(s => s.vmId === vmId)
      : [];

    // Backup creation dates from the raw report
    const creationDates = [];
    for (const sched of (vmReport.schedules || [])) {
      if (sched.dump_analysis && sched.dump_analysis.first_backup_date) {
        creationDates.push({
          schedule: sched.schedule,
          firstBackup: sched.dump_analysis.first_backup_date,
          lastBackup: sched.dump_analysis.last_backup_date,
          chainDepth: sched.dump_analysis.chain_depth,
          hasIncremental: sched.dump_analysis.has_incremental,
        });
      }
    }

    return {
      ...vmReport,
      // Enriched fields
      vmId,
      controllerRollup: {
        scheduleCount: vmSchedules.length,
        activeSchedules: vmSchedules.filter(s => s.enabled !== false).length,
        lastSuccess,
        lastFailure,
        lastFailureError,
        successRate30,
        successRate90,
        avgDurationMs,
        avgDurationHuman: avgDurationMs ? this._formatDuration(avgDurationMs) : null,
        totalJobsLast30Days: jobs30.length,
        totalJobsLast90Days: jobs90.length,
        creationDates,
      },
    };
  }

  _computeHostRollup(enrichedVMs, raw, host, jobs) {
    const hostJobs = jobs.filter(j => j.backupHostId === host.id);
    const now = Date.now();
    const day30 = now - 30 * 86400000;
    const jobs30 = hostJobs.filter(j => new Date(j.startTime).getTime() > day30);
    const completed30 = jobs30.filter(j => j.status === 'completed').length;

    return {
      totalVMs: raw.vm_count || enrichedVMs.length,
      healthySummary: raw.summary || {},
      totalBackupSizeGB: raw.total_backup_size_gb || null,
      totalBackupSizeBytes: raw.total_backup_size_bytes || null,
      successRate30: jobs30.length > 0 ? Math.round((completed30 / jobs30.length) * 100) : 100,
      totalJobs30: jobs30.length,
      completedJobs30: completed30,
      failedJobs30: jobs30.filter(j => j.status === 'failed').length,
      generatedAt: raw.generated_at || null,
      hostname: raw.hostname || null,
    };
  }

  _formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }

  async _maybeGenerateSnapshot() {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const snapshotFile = path.join(SNAPSHOTS_DIR, `${today}.json`);

    try {
      await fs.access(snapshotFile);
      // Already exists for today — skip
      return;
    } catch (e) {
      // Doesn't exist — generate
    }

    try {
      const globalRollup = await this.getGlobalRollup();
      await fs.writeFile(snapshotFile, JSON.stringify({
        date: today,
        ...globalRollup,
      }, null, 2), 'utf8');
      console.log(`[ReportEnrich] Daily snapshot saved: ${snapshotFile}`);

      // Prune old snapshots (keep 90 days)
      await this._pruneSnapshots(90);
    } catch (e) {
      console.error('[ReportEnrich] Failed to generate daily snapshot:', e.message);
    }
  }

  async _pruneSnapshots(keepDays) {
    try {
      const files = await fs.readdir(SNAPSHOTS_DIR);
      const cutoff = new Date(Date.now() - keepDays * 86400000).toISOString().split('T')[0];
      for (const file of files) {
        if (file < `${cutoff}.json`) {
          await fs.unlink(path.join(SNAPSHOTS_DIR, file));
        }
      }
    } catch (e) {}
  }

  shutdown() {
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
  }
}

const reportEnrichmentService = new ReportEnrichmentService();
module.exports = reportEnrichmentService;
