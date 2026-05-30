const express = require('express');
const router = express.Router();
const reportEnrichmentService = require('../services/reportEnrichmentService');
const agentService = require('../services/agentService');
const { getBackupHosts, getVirtualMachines } = require('../services/fileStorage');

/**
 * GET /api/reports/enriched/:backupHostId
 * Get enriched report for a specific backup host (with rollups).
 */
router.get('/enriched/:backupHostId', async (req, res, next) => {
  try {
    const result = await reportEnrichmentService.getEnrichedReport(req.params.backupHostId);
    if (!result.success) {
      return res.status(404).json(result);
    }
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/reports/global
 * Get global rollup across all hosts.
 */
router.get('/global', async (req, res, next) => {
  try {
    const rollup = await reportEnrichmentService.getGlobalRollup();
    res.json({ success: true, data: rollup });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/reports/trending?days=30
 * Get daily snapshots for trending charts.
 */
router.get('/trending', async (req, res, next) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const snapshots = await reportEnrichmentService.getTrending(days);
    res.json({ success: true, data: snapshots });
  } catch (error) {
    next(error);
  }
});

/**
 * Resolve which backup hosts need their report regenerated for a given
 * download scope.
 *
 *   - global → every backup host
 *   - host   → just the requested host
 *   - vm     → the host that owns the VM
 *   - hypervisor → the host that owns the hypervisor
 */
async function hostsForScope(scope, scopeId) {
  const hosts = await getBackupHosts();
  if (scope === 'global') return hosts;
  if (scope === 'host') return hosts.filter(h => h.id === scopeId);
  if (scope === 'vm') {
    const vms = await getVirtualMachines();
    const vm = vms.find(v => v.id === scopeId);
    if (!vm) return [];
    return hosts.filter(h => h.id === vm.backupHostId);
  }
  if (scope === 'hypervisor') {
    const { getHypervisors } = require('../services/fileStorage');
    const hypervisors = await getHypervisors();
    const hv = hypervisors.find(h => h.id === scopeId);
    if (!hv) return [];
    return hosts.filter(h => h.id === hv.backupHostId);
  }
  return [];
}

/**
 * POST /api/reports/regenerate
 *
 * Triggers a fresh report generation on every relevant agent for the
 * given scope. Bypasses the per-agent manual rate-limit (uses the
 * /api/report/generate-now endpoint). Waits for all agents to either
 * finish or fail before responding so the caller knows the data is fresh.
 *
 * Body: { scope: 'global'|'host'|'vm'|'hypervisor', scopeId?: string }
 *
 * Response:
 *   {
 *     success: true,
 *     results: [{ hostId, hostName, status: 'ok'|'error'|'in-progress', error? }, …]
 *   }
 */
router.post('/regenerate', async (req, res, next) => {
  try {
    const { scope, scopeId } = req.body || {};
    if (!scope || !['global', 'host', 'vm', 'hypervisor'].includes(scope)) {
      return res.status(400).json({ success: false, error: 'scope must be global, host, vm, or hypervisor' });
    }
    if (scope !== 'global' && !scopeId) {
      return res.status(400).json({ success: false, error: 'scopeId is required for non-global scope' });
    }

    const targetHosts = await hostsForScope(scope, scopeId);
    if (targetHosts.length === 0) {
      return res.status(404).json({ success: false, error: 'No backup hosts resolved for the given scope' });
    }

    // Hit each agent in parallel. We tolerate individual failures so a
    // single offline agent doesn't block the whole download flow.
    const settled = await Promise.allSettled(
      targetHosts.map(async (host) => {
        try {
          const data = await agentService.generateBackupReportNow(host.url);
          return {
            hostId: host.id,
            hostName: host.name,
            status: data?.isGenerating ? 'in-progress' : 'ok',
            generatedAt: data?.data?.generatedAt || null,
          };
        } catch (err) {
          return {
            hostId: host.id,
            hostName: host.name,
            status: 'error',
            error: err.response?.data?.error || err.message,
          };
        }
      })
    );

    const results = settled.map(s => (s.status === 'fulfilled' ? s.value : { status: 'error', error: String(s.reason) }));
    const okCount = results.filter(r => r.status === 'ok' || r.status === 'in-progress').length;

    res.json({
      success: okCount > 0,
      results,
      regenerated: okCount,
      total: results.length,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/reports/download/:format
 * Download report in specified format.
 *
 * URL params:
 *   - format: 'json' | 'csv' | 'pdf' | 'txt' | 'md' | 'xlsx'
 *
 * Query params:
 *   - scope: 'global' | 'host' | 'vm' | 'hypervisor'
 *   - scopeId: ID of the host/vm/hypervisor (required for non-global)
 *
 * For xlsx/pdf the server returns a structured JSON envelope and the
 * frontend assembles the binary file using SheetJS / jsPDF.
 */
router.get('/download/:format', async (req, res, next) => {
  try {
    const { format } = req.params;
    const { scope, scopeId } = req.query;

    const allowedFormats = ['json', 'csv', 'pdf', 'txt', 'md', 'xlsx'];
    if (!allowedFormats.includes(format)) {
      return res.status(400).json({ success: false, error: `Format must be one of: ${allowedFormats.join(', ')}` });
    }
    if (!scope || !['global', 'host', 'vm', 'hypervisor'].includes(scope)) {
      return res.status(400).json({ success: false, error: 'Scope must be global, host, vm, or hypervisor' });
    }
    if (scope !== 'global' && !scopeId) {
      return res.status(400).json({ success: false, error: 'scopeId is required for non-global scope' });
    }

    const data = await reportEnrichmentService.getDownloadData(scope, scopeId);
    if (!data) {
      return res.status(404).json({ success: false, error: 'Report data not found' });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `backup-report_${scope}${scopeId ? '_' + String(scopeId).substring(0, 8) : ''}_${timestamp}`;

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.json"`);
      return res.send(JSON.stringify(data, null, 2));
    }

    if (format === 'csv') {
      const csv = convertToCSV(data, scope);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
      return res.send(csv);
    }

    if (format === 'txt') {
      let text;
      try {
        text = convertToText(data, scope);
      } catch (formatErr) {
        console.error('[reportDownload] txt formatter threw:', formatErr);
        return res.status(500).json({ success: false, error: `txt formatter failed: ${formatErr.message}` });
      }
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.txt"`);
      return res.send(text);
    }

    if (format === 'md') {
      let md;
      try {
        md = convertToMarkdown(data, scope);
      } catch (formatErr) {
        console.error('[reportDownload] md formatter threw:', formatErr);
        return res.status(500).json({ success: false, error: `md formatter failed: ${formatErr.message}` });
      }
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.md"`);
      return res.send(md);
    }

    if (format === 'xlsx') {
      // Return tabular data — frontend builds the .xlsx using SheetJS.
      // Server-side xlsx generation would need a new backend dep which
      // we deliberately avoid.
      const sheets = buildSheets(data, scope);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}_xlsx.json"`);
      return res.json({
        success: true,
        format: 'xlsx-data',
        sheets,
        metadata: { scope, scopeId, generatedAt: new Date().toISOString(), filename: `${filename}.xlsx` },
      });
    }

    if (format === 'pdf') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}_data.json"`);
      return res.json({
        success: true,
        format: 'pdf-data',
        message: 'Use this data with the frontend PDF generator',
        data,
        metadata: { scope, scopeId, generatedAt: new Date().toISOString(), filename: `${filename}.pdf` },
      });
    }
  } catch (error) {
    next(error);
  }
});

/* ────────────────────────────────────────────────────────────────────── */
/* Format helpers                                                        */
/* ────────────────────────────────────────────────────────────────────── */

function csvEscape(v) {
  return `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
}

function convertToCSV(data, scope) {
  if (scope === 'global') {
    const rows = [
      ['Metric', 'Value'],
      ['Total Backup Hosts', data.totalBackupHosts],
      ['Online Hosts', data.onlineHosts],
      ['Total Protected VMs', data.totalProtectedVMs],
      ['Total Schedules', data.totalSchedules],
      ['Total Storage Pools', data.totalStoragePools],
      ['Last 7 Days - Total Jobs', data.last7Days?.total],
      ['Last 7 Days - Completed', data.last7Days?.completed],
      ['Last 7 Days - Failed', data.last7Days?.failed],
      ['Last 7 Days - Success Rate', `${data.last7Days?.successRate}%`],
      ['Last 30 Days - Total Jobs', data.last30Days?.total],
      ['Last 30 Days - Completed', data.last30Days?.completed],
      ['Last 30 Days - Failed', data.last30Days?.failed],
      ['Last 30 Days - Success Rate', `${data.last30Days?.successRate}%`],
      ['Generated At', data.generatedAt],
    ];
    return rows.map(r => r.map(csvEscape).join(',')).join('\n');
  }

  if (scope === 'host' && data.vms) {
    const headers = [
      'VM Name', 'Health', 'Total Size (GB)', 'Schedule Count',
      'Last Success', 'Last Failure', 'Success Rate (30d)',
      'Avg Duration', 'Available Schedules', 'Corrupted Schedules',
    ];
    const rows = [headers];
    for (const vm of data.vms) {
      rows.push([
        vm.vm_name, vm.health, vm.total_disk_usage_gb,
        vm.controllerRollup?.scheduleCount || 0,
        vm.controllerRollup?.lastSuccess || 'N/A',
        vm.controllerRollup?.lastFailure || 'N/A',
        vm.controllerRollup?.successRate30 != null ? `${vm.controllerRollup.successRate30}%` : 'N/A',
        vm.controllerRollup?.avgDurationHuman || 'N/A',
        vm.available_schedule_count || 0,
        vm.corrupted_schedule_count || 0,
      ]);
    }
    return rows.map(r => r.map(csvEscape).join(',')).join('\n');
  }

  if (scope === 'vm') {
    const headers = [
      'Schedule', 'Available', 'Disk Usage (GB)', 'Method(s)',
      'Run Count', 'Corrupted', 'First Backup', 'Last Backup',
      'Chain Depth', 'Has Incremental',
    ];
    const rows = [headers];
    for (const sched of (data.schedules || [])) {
      rows.push([
        sched.schedule,
        sched.available ? 'Yes' : 'No',
        sched.disk_usage_gb || 'N/A',
        (sched.inferred_methods || []).join(', '),
        sched.recorded_run_count || 0,
        sched.corrupted ? 'Yes' : 'No',
        sched.dump_analysis?.first_backup_date || 'N/A',
        sched.dump_analysis?.last_backup_date || 'N/A',
        sched.dump_analysis?.chain_depth || 0,
        sched.dump_analysis?.has_incremental ? 'Yes' : 'No',
      ]);
    }
    return rows.map(r => r.map(csvEscape).join(',')).join('\n');
  }

  return `"data"\n"${JSON.stringify(data).replace(/"/g, '""')}"`;
}

function convertToText(data, scope) {
  const lines = [];
  const sep = '='.repeat(78);
  const subsep = '-'.repeat(78);
  const minisep = '·'.repeat(78);

  // Render a single host's enriched report (used by both host and global
  // scope — global iterates and concatenates). Each per-host render is
  // wrapped in its own try/catch so one bad host doesn't kill the entire
  // download — its block reports the error and the rest of the report
  // continues.
  const renderHostBlock = (hostMeta, hostData) => {
    try {
      lines.push(sep);
      lines.push(`HOST: ${hostMeta?.hostName || hostData?.hostname || 'Unknown host'}`);
      if (hostMeta?.hostUrl) lines.push(`URL:  ${hostMeta.hostUrl}`);
      if (hostData) {
        lines.push(`Hostname:           ${hostData.hostname || 'N/A'}`);
        lines.push(`Backup Path:        ${hostData.backup_path || 'N/A'}`);
        lines.push(`Generated:          ${hostData.generated_at || 'N/A'}`);
        lines.push(`VM Count:           ${hostData.vm_count || (hostData.vms || []).length}`);
        lines.push(`Total Backup Size:  ${hostData.total_backup_size_gb || 'N/A'}`);
        if (hostData.summary) {
          lines.push(`Healthy:            ${hostData.summary.healthy || 0}`);
          lines.push(`Corrupted:          ${hostData.summary.corrupted || 0}`);
          lines.push(`Without Backups:    ${hostData.summary.no_backups || 0}`);
        }
      } else {
        lines.push(`Status:             ${hostMeta?.error || 'No report data'}`);
      }
      lines.push('');

      const vms = Array.isArray(hostData?.vms) ? hostData.vms : [];
      if (vms.length > 0) {
        lines.push('VIRTUAL MACHINES');
        lines.push(subsep);
        for (const vm of vms) {
          if (!vm) continue;
          lines.push('');
          lines.push(`VM: ${vm.vm_name || 'unnamed'}`);
          lines.push(`  Health:           ${vm.health || 'N/A'}`);
          lines.push(`  Path:             ${vm.vm_path || 'N/A'}`);
          lines.push(`  Total Size:       ${vm.total_disk_usage_gb || 'N/A'} GB`);
          lines.push(`  Schedules:        ${vm.available_schedule_count || 0} available, ${vm.corrupted_schedule_count || 0} corrupted, ${vm.archived_backup_count || 0} archived`);
          if (vm.controllerRollup) {
            const r = vm.controllerRollup;
            if (r.lastSuccess)         lines.push(`  Last Success:     ${r.lastSuccess}`);
            if (r.lastFailure)         lines.push(`  Last Failure:     ${r.lastFailure}`);
            if (r.successRate30 != null) lines.push(`  Success Rate 30d: ${r.successRate30}%`);
            if (r.avgDurationHuman)    lines.push(`  Avg Duration:     ${r.avgDurationHuman}`);
          }
          const schedules = Array.isArray(vm.schedules) ? vm.schedules : [];
          for (const sched of schedules) {
            if (!sched) continue;
            lines.push('');
            lines.push(`  Schedule: ${sched.schedule || 'unnamed'}`);
            lines.push(`    Available:      ${sched.available ? 'Yes' : 'No'}`);
            lines.push(`    Disk Usage:     ${sched.disk_usage_gb || 'N/A'} GB`);
            lines.push(`    Methods:        ${(Array.isArray(sched.inferred_methods) ? sched.inferred_methods : []).join(', ') || 'N/A'}`);
            lines.push(`    Recorded Runs:  ${sched.recorded_run_count || 0}`);
            lines.push(`    Corrupted:      ${sched.corrupted ? 'Yes' : 'No'}`);
            if (sched.path) lines.push(`    Path:           ${sched.path}`);
            if (sched.dump_analysis && typeof sched.dump_analysis === 'object') {
              const da = sched.dump_analysis;
              if (da.first_backup_date)   lines.push(`    First Backup:   ${da.first_backup_date}`);
              if (da.last_backup_date)    lines.push(`    Last Backup:    ${da.last_backup_date}`);
              if (da.chain_depth != null) lines.push(`    Chain Depth:    ${da.chain_depth}`);
              lines.push(`    Has Incremental:${da.has_incremental ? ' Yes' : ' No'}`);
              if (da.total_virtual_size_gb != null) lines.push(`    Total Virtual:  ${da.total_virtual_size_gb} GB`);
              if (da.total_data_size_gb != null)    lines.push(`    Total Data:     ${da.total_data_size_gb} GB`);
              const disks = Array.isArray(da.disks) ? da.disks : [];
              for (const disk of disks) {
                if (!disk) continue;
                lines.push(`      Disk ${disk.name || ''}: ${disk.format || ''}, virtual ${disk.virtual_size_gb || disk.size_gb || 'N/A'} GB, data ${disk.data_size_gb || 'N/A'} GB, full ${disk.full_count || 0}, inc ${disk.incremental_count || 0}`);
              }
            }
          }
        }
      }
      lines.push('');
      lines.push(minisep);
      lines.push('');
    } catch (blockErr) {
      // Don't let a single bad sub-record blow up the whole download.
      lines.push('');
      lines.push(`! Error rendering host block: ${blockErr.message}`);
      lines.push('');
    }
  };

  if (scope === 'global') {
    lines.push(sep);
    lines.push('BACKUP MANAGER — GLOBAL REPORT');
    lines.push(`Generated: ${data.generatedAt || new Date().toISOString()}`);
    lines.push(sep);
    lines.push('');
    lines.push('OVERVIEW');
    lines.push(subsep);
    lines.push(`Backup Hosts:       ${data.onlineHosts || 0}/${data.totalBackupHosts || 0} online`);
    lines.push(`Protected VMs:      ${data.totalProtectedVMs || 0}`);
    lines.push(`Schedules:          ${data.totalSchedules || 0}`);
    lines.push(`Storage Pools:      ${data.totalStoragePools || 0}`);
    lines.push('');
    lines.push('LAST 7 DAYS');
    lines.push(subsep);
    if (data.last7Days) {
      lines.push(`Total Jobs:         ${data.last7Days.total}`);
      lines.push(`Completed:          ${data.last7Days.completed}`);
      lines.push(`Failed:             ${data.last7Days.failed}`);
      lines.push(`Success Rate:       ${data.last7Days.successRate}%`);
    }
    lines.push('');
    lines.push('LAST 30 DAYS');
    lines.push(subsep);
    if (data.last30Days) {
      lines.push(`Total Jobs:         ${data.last30Days.total}`);
      lines.push(`Completed:          ${data.last30Days.completed}`);
      lines.push(`Failed:             ${data.last30Days.failed}`);
      lines.push(`Success Rate:       ${data.last30Days.successRate}%`);
    }
    lines.push('');

    // Per-host breakdown — same detail as the host scope, repeated for
    // every backup host.
    if (Array.isArray(data.hosts)) {
      lines.push('PER-HOST DETAIL');
      lines.push(sep);
      for (const h of data.hosts) {
        renderHostBlock(h, h.data);
      }
    }
    return lines.join('\n');
  }

  if (scope === 'host') {
    lines.push(sep);
    lines.push(`BACKUP REPORT — ${data.hostname || 'Unknown host'}`);
    lines.push(`Generated: ${data.generated_at || new Date().toISOString()}`);
    lines.push(sep);
    lines.push('');
    renderHostBlock({ hostName: data.hostname }, data);
    return lines.join('\n');
  }

  if (scope === 'vm') {
    lines.push(sep);
    lines.push(`VM REPORT — ${data.vm_name || 'Unknown VM'}`);
    lines.push(sep);
    lines.push('');
    lines.push('OVERVIEW');
    lines.push(subsep);
    lines.push(`Health:             ${data.health || 'N/A'}`);
    lines.push(`Path:               ${data.vm_path || 'N/A'}`);
    lines.push(`Total Size:         ${data.total_disk_usage_gb || 'N/A'} GB`);
    lines.push(`Schedules:          ${data.available_schedule_count || 0} available, ${data.corrupted_schedule_count || 0} corrupted, ${data.archived_backup_count || 0} archived`);
    if (data.controllerRollup) {
      const r = data.controllerRollup;
      if (r.lastSuccess)           lines.push(`Last Success:       ${r.lastSuccess}`);
      if (r.lastFailure)           lines.push(`Last Failure:       ${r.lastFailure}`);
      if (r.successRate30 != null) lines.push(`Success Rate 30d:   ${r.successRate30}%`);
      if (r.avgDurationHuman)      lines.push(`Avg Duration:       ${r.avgDurationHuman}`);
    }
    lines.push('');
    lines.push('PER-SCHEDULE BREAKDOWN');
    lines.push(subsep);
    for (const sched of (data.schedules || [])) {
      lines.push('');
      lines.push(`Schedule: ${sched.schedule}`);
      lines.push(`  Available:        ${sched.available ? 'Yes' : 'No'}`);
      lines.push(`  Disk Usage:       ${sched.disk_usage_gb || 'N/A'} GB`);
      lines.push(`  Methods:          ${(sched.inferred_methods || []).join(', ') || 'N/A'}`);
      lines.push(`  Recorded Runs:    ${sched.recorded_run_count || 0}`);
      lines.push(`  Corrupted:        ${sched.corrupted ? 'Yes' : 'No'}`);
      if (sched.path) lines.push(`  Path:             ${sched.path}`);
      if (sched.dump_analysis) {
        const da = sched.dump_analysis;
        if (da.first_backup_date)   lines.push(`  First Backup:     ${da.first_backup_date}`);
        if (da.last_backup_date)    lines.push(`  Last Backup:      ${da.last_backup_date}`);
        if (da.chain_depth != null) lines.push(`  Chain Depth:      ${da.chain_depth}`);
        lines.push(`  Has Incremental:  ${da.has_incremental ? 'Yes' : 'No'}`);
        if (da.total_virtual_size_gb != null) lines.push(`  Total Virtual:    ${da.total_virtual_size_gb} GB`);
        if (da.total_data_size_gb != null)    lines.push(`  Total Data:       ${da.total_data_size_gb} GB`);
        for (const disk of (da.disks || [])) {
          lines.push(`    Disk ${disk.name || ''}: ${disk.format || ''}, virtual ${disk.virtual_size_gb || disk.size_gb || 'N/A'} GB, data ${disk.data_size_gb || 'N/A'} GB, full ${disk.full_count || 0}, inc ${disk.incremental_count || 0}`);
        }
      }
    }
    return lines.join('\n');
  }

  return JSON.stringify(data, null, 2);
}

function convertToMarkdown(data, scope) {
  const lines = [];

  // Render a host's full enriched report — used by host scope and per-host
  // sections inside the global report.
  const renderHostBlock = (hostMeta, hostData) => {
    const title = hostMeta?.hostName || hostData?.hostname || 'Unknown host';
    lines.push(`### ${title}`);
    lines.push('');
    if (hostMeta?.hostUrl) lines.push(`*URL:* \`${hostMeta.hostUrl}\``);
    if (hostData) {
      lines.push('');
      lines.push('| Metric | Value |');
      lines.push('| --- | --- |');
      lines.push(`| Hostname | ${hostData.hostname || 'N/A'} |`);
      lines.push(`| Backup Path | \`${hostData.backup_path || 'N/A'}\` |`);
      lines.push(`| Generated | ${hostData.generated_at || 'N/A'} |`);
      lines.push(`| VM Count | ${hostData.vm_count || (hostData.vms || []).length} |`);
      lines.push(`| Total Backup Size | ${hostData.total_backup_size_gb || 'N/A'} |`);
      if (hostData.summary) {
        lines.push(`| Healthy | ${hostData.summary.healthy || 0} |`);
        lines.push(`| Corrupted | ${hostData.summary.corrupted || 0} |`);
        lines.push(`| Without Backups | ${hostData.summary.no_backups || 0} |`);
      }
      lines.push('');
      if ((hostData.vms || []).length > 0) {
        lines.push('#### Virtual Machines');
        lines.push('');
        lines.push('| VM | Health | Size (GB) | Available | Corrupted | Last Success | Success Rate (30d) | Avg Duration |');
        lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
        for (const vm of hostData.vms) {
          const r = vm.controllerRollup || {};
          lines.push(
            `| ${vm.vm_name} | ${vm.health} | ${vm.total_disk_usage_gb || 'N/A'} | ${vm.available_schedule_count || 0} | ${vm.corrupted_schedule_count || 0} | ${r.lastSuccess || 'N/A'} | ${r.successRate30 != null ? r.successRate30 + '%' : 'N/A'} | ${r.avgDurationHuman || 'N/A'} |`
          );
        }
        lines.push('');

        // Schedule breakdown per VM (collapsed under a single big table for
        // scannability).
        lines.push('#### VM Schedule Detail');
        lines.push('');
        lines.push('| VM | Schedule | Available | Size (GB) | Methods | Runs | Corrupted | First Backup | Last Backup | Chain | Has Inc |');
        lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
        for (const vm of hostData.vms) {
          for (const s of (vm.schedules || [])) {
            const da = s.dump_analysis || {};
            lines.push(
              `| ${vm.vm_name} | ${s.schedule} | ${s.available ? 'Yes' : 'No'} | ${s.disk_usage_gb || 'N/A'} | ${(s.inferred_methods || []).join(', ') || 'N/A'} | ${s.recorded_run_count || 0} | ${s.corrupted ? 'Yes' : 'No'} | ${da.first_backup_date || 'N/A'} | ${da.last_backup_date || 'N/A'} | ${da.chain_depth || 0} | ${da.has_incremental ? 'Yes' : 'No'} |`
            );
          }
        }
        lines.push('');
      }
    } else {
      lines.push('');
      lines.push(`> *No report data:* ${hostMeta?.error || 'Report not available'}`);
      lines.push('');
    }
  };

  if (scope === 'global') {
    lines.push('# Backup Manager — Global Report');
    lines.push('');
    lines.push(`*Generated:* ${data.generatedAt || new Date().toISOString()}`);
    lines.push('');
    lines.push('## Overview');
    lines.push('');
    lines.push('| Metric | Value |');
    lines.push('| --- | --- |');
    lines.push(`| Backup Hosts | ${data.onlineHosts || 0}/${data.totalBackupHosts || 0} online |`);
    lines.push(`| Protected VMs | ${data.totalProtectedVMs || 0} |`);
    lines.push(`| Schedules | ${data.totalSchedules || 0} |`);
    lines.push(`| Storage Pools | ${data.totalStoragePools || 0} |`);
    lines.push('');
    lines.push('## Last 7 Days');
    lines.push('');
    if (data.last7Days) {
      lines.push('| Metric | Value |');
      lines.push('| --- | --- |');
      lines.push(`| Total Jobs | ${data.last7Days.total} |`);
      lines.push(`| Completed | ${data.last7Days.completed} |`);
      lines.push(`| Failed | ${data.last7Days.failed} |`);
      lines.push(`| Success Rate | ${data.last7Days.successRate}% |`);
    }
    lines.push('');
    lines.push('## Last 30 Days');
    lines.push('');
    if (data.last30Days) {
      lines.push('| Metric | Value |');
      lines.push('| --- | --- |');
      lines.push(`| Total Jobs | ${data.last30Days.total} |`);
      lines.push(`| Completed | ${data.last30Days.completed} |`);
      lines.push(`| Failed | ${data.last30Days.failed} |`);
      lines.push(`| Success Rate | ${data.last30Days.successRate}% |`);
    }
    lines.push('');

    if (Array.isArray(data.hosts)) {
      lines.push('## Per-Host Detail');
      lines.push('');
      for (const h of data.hosts) {
        renderHostBlock(h, h.data);
      }
    }
    return lines.join('\n');
  }

  if (scope === 'host') {
    lines.push(`# Backup Report — ${data.hostname || 'Unknown host'}`);
    lines.push('');
    lines.push(`*Generated:* ${data.generated_at || new Date().toISOString()}`);
    lines.push('');
    renderHostBlock({ hostName: data.hostname }, data);
    return lines.join('\n');
  }

  if (scope === 'vm') {
    lines.push(`# VM Report — ${data.vm_name || 'Unknown VM'}`);
    lines.push('');
    lines.push('## Overview');
    lines.push('');
    lines.push('| Metric | Value |');
    lines.push('| --- | --- |');
    lines.push(`| Health | ${data.health || 'N/A'} |`);
    lines.push(`| Path | \`${data.vm_path || 'N/A'}\` |`);
    lines.push(`| Total Size (GB) | ${data.total_disk_usage_gb || 'N/A'} |`);
    lines.push(`| Schedules Available | ${data.available_schedule_count || 0} |`);
    lines.push(`| Schedules Corrupted | ${data.corrupted_schedule_count || 0} |`);
    lines.push(`| Archived Backups | ${data.archived_backup_count || 0} |`);
    if (data.controllerRollup) {
      const r = data.controllerRollup;
      if (r.lastSuccess)           lines.push(`| Last Success | ${r.lastSuccess} |`);
      if (r.lastFailure)           lines.push(`| Last Failure | ${r.lastFailure} |`);
      if (r.successRate30 != null) lines.push(`| Success Rate 30d | ${r.successRate30}% |`);
      if (r.avgDurationHuman)      lines.push(`| Avg Duration | ${r.avgDurationHuman} |`);
    }
    lines.push('');
    lines.push('## Schedules');
    lines.push('');
    lines.push('| Schedule | Available | Size (GB) | Methods | Runs | Corrupted | First Backup | Last Backup | Chain | Has Inc |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const s of (data.schedules || [])) {
      const da = s.dump_analysis || {};
      lines.push(
        `| ${s.schedule} | ${s.available ? 'Yes' : 'No'} | ${s.disk_usage_gb || 'N/A'} | ${(s.inferred_methods || []).join(', ') || 'N/A'} | ${s.recorded_run_count || 0} | ${s.corrupted ? 'Yes' : 'No'} | ${da.first_backup_date || 'N/A'} | ${da.last_backup_date || 'N/A'} | ${da.chain_depth || 0} | ${da.has_incremental ? 'Yes' : 'No'} |`
      );
    }
    lines.push('');

    // Per-disk detail under each schedule
    for (const s of (data.schedules || [])) {
      const da = s.dump_analysis || {};
      if ((da.disks || []).length > 0) {
        lines.push(`### ${s.schedule} — Disks`);
        lines.push('');
        lines.push('| Disk | Format | Virtual (GB) | Data (GB) | Full | Inc |');
        lines.push('| --- | --- | --- | --- | --- | --- |');
        for (const disk of da.disks) {
          lines.push(
            `| ${disk.name || ''} | ${disk.format || ''} | ${disk.virtual_size_gb || disk.size_gb || 'N/A'} | ${disk.data_size_gb || 'N/A'} | ${disk.full_count || 0} | ${disk.incremental_count || 0} |`
          );
        }
        lines.push('');
      }
    }
    return lines.join('\n');
  }

  return '```json\n' + JSON.stringify(data, null, 2) + '\n```';
}

/**
 * Build sheet data for xlsx generation. Each sheet is { name, rows }
 * where rows is a 2D array (header in row 0). The frontend turns this
 * into a workbook via SheetJS.
 */
function buildSheets(data, scope) {
  // Excel sheet names have a 31-char limit and can't contain certain
  // chars. Truncate and sanitize while keeping uniqueness.
  const usedNames = new Set();
  const safeSheetName = (name, fallback) => {
    let n = String(name || fallback || 'Sheet').replace(/[\\/?*[\]:]/g, '_').substring(0, 31);
    if (!n) n = fallback || 'Sheet';
    let candidate = n;
    let i = 2;
    while (usedNames.has(candidate)) {
      const suffix = ` (${i++})`;
      candidate = (n.substring(0, 31 - suffix.length) + suffix);
    }
    usedNames.add(candidate);
    return candidate;
  };

  const hostVMRows = (hostData) => {
    const rows = [[
      'VM Name', 'Health', 'Path', 'Total Size (GB)',
      'Available Schedules', 'Corrupted Schedules', 'Archived Backups',
      'Last Success', 'Last Failure',
      'Success Rate 30d (%)', 'Avg Duration',
    ]];
    for (const vm of (hostData?.vms || [])) {
      const r = vm.controllerRollup || {};
      rows.push([
        vm.vm_name, vm.health, vm.vm_path || '',
        vm.total_disk_usage_gb || '',
        vm.available_schedule_count || 0,
        vm.corrupted_schedule_count || 0,
        vm.archived_backup_count || 0,
        r.lastSuccess || '', r.lastFailure || '',
        r.successRate30 != null ? r.successRate30 : '',
        r.avgDurationHuman || '',
      ]);
    }
    return rows;
  };

  const hostScheduleRows = (hostData) => {
    const rows = [[
      'VM Name', 'Schedule', 'Available', 'Disk Usage (GB)', 'Methods',
      'Run Count', 'Corrupted', 'First Backup', 'Last Backup',
      'Chain Depth', 'Has Incremental', 'Total Virtual (GB)', 'Total Data (GB)',
    ]];
    for (const vm of (hostData?.vms || [])) {
      for (const s of (vm.schedules || [])) {
        const da = s.dump_analysis || {};
        rows.push([
          vm.vm_name, s.schedule, s.available ? 'Yes' : 'No',
          s.disk_usage_gb || '',
          (s.inferred_methods || []).join(', '),
          s.recorded_run_count || 0,
          s.corrupted ? 'Yes' : 'No',
          da.first_backup_date || '',
          da.last_backup_date || '',
          da.chain_depth || 0,
          da.has_incremental ? 'Yes' : 'No',
          da.total_virtual_size_gb != null ? da.total_virtual_size_gb : '',
          da.total_data_size_gb != null ? da.total_data_size_gb : '',
        ]);
      }
    }
    return rows;
  };

  if (scope === 'global') {
    const sheets = [
      {
        name: safeSheetName('Overview'),
        rows: [
          ['Metric', 'Value'],
          ['Total Backup Hosts', data.totalBackupHosts || 0],
          ['Online Hosts', data.onlineHosts || 0],
          ['Total Protected VMs', data.totalProtectedVMs || 0],
          ['Total Schedules', data.totalSchedules || 0],
          ['Total Storage Pools', data.totalStoragePools || 0],
          ['Generated At', data.generatedAt || ''],
        ],
      },
      {
        name: safeSheetName('Last 7 Days'),
        rows: [
          ['Metric', 'Value'],
          ['Total Jobs', data.last7Days?.total || 0],
          ['Completed', data.last7Days?.completed || 0],
          ['Failed', data.last7Days?.failed || 0],
          ['Skipped', data.last7Days?.skipped || 0],
          ['Success Rate (%)', data.last7Days?.successRate || 0],
        ],
      },
      {
        name: safeSheetName('Last 30 Days'),
        rows: [
          ['Metric', 'Value'],
          ['Total Jobs', data.last30Days?.total || 0],
          ['Completed', data.last30Days?.completed || 0],
          ['Failed', data.last30Days?.failed || 0],
          ['Skipped', data.last30Days?.skipped || 0],
          ['Success Rate (%)', data.last30Days?.successRate || 0],
        ],
      },
    ];

    // Per-host sheets — VM list and schedule detail per host.
    if (Array.isArray(data.hosts)) {
      const allVMs = [['Host', 'VM Name', 'Health', 'Path', 'Total Size (GB)', 'Available', 'Corrupted', 'Archived', 'Last Success', 'Success Rate 30d (%)']];
      const allScheds = [['Host', 'VM Name', 'Schedule', 'Available', 'Disk Usage (GB)', 'Methods', 'Runs', 'Corrupted', 'First Backup', 'Last Backup', 'Chain Depth', 'Has Incremental']];

      for (const h of data.hosts) {
        if (!h.ok || !h.data) continue;
        for (const vm of (h.data.vms || [])) {
          const r = vm.controllerRollup || {};
          allVMs.push([
            h.hostName, vm.vm_name, vm.health, vm.vm_path || '',
            vm.total_disk_usage_gb || '',
            vm.available_schedule_count || 0,
            vm.corrupted_schedule_count || 0,
            vm.archived_backup_count || 0,
            r.lastSuccess || '',
            r.successRate30 != null ? r.successRate30 : '',
          ]);
          for (const s of (vm.schedules || [])) {
            const da = s.dump_analysis || {};
            allScheds.push([
              h.hostName, vm.vm_name, s.schedule,
              s.available ? 'Yes' : 'No',
              s.disk_usage_gb || '',
              (s.inferred_methods || []).join(', '),
              s.recorded_run_count || 0,
              s.corrupted ? 'Yes' : 'No',
              da.first_backup_date || '',
              da.last_backup_date || '',
              da.chain_depth || 0,
              da.has_incremental ? 'Yes' : 'No',
            ]);
          }
        }
      }

      sheets.push({ name: safeSheetName('All VMs'), rows: allVMs });
      sheets.push({ name: safeSheetName('All Schedules'), rows: allScheds });

      // Also add a per-host sheet for fine-grained inspection.
      for (const h of data.hosts) {
        if (!h.ok || !h.data) {
          sheets.push({
            name: safeSheetName(`${h.hostName} (offline)`, h.hostId),
            rows: [
              ['Host', h.hostName],
              ['Status', h.error || 'No data'],
            ],
          });
          continue;
        }
        sheets.push({
          name: safeSheetName(`${h.hostName} VMs`, h.hostId + ' VMs'),
          rows: hostVMRows(h.data),
        });
      }
    }
    return sheets;
  }

  if (scope === 'host') {
    const overview = [
      ['Metric', 'Value'],
      ['Hostname', data.hostname || ''],
      ['Backup Path', data.backup_path || ''],
      ['VM Count', data.vm_count || (data.vms || []).length],
      ['Total Backup Size', data.total_backup_size_gb || ''],
      ['Healthy', data.summary?.healthy || 0],
      ['Corrupted', data.summary?.corrupted || 0],
      ['Without Backups', data.summary?.no_backups || 0],
      ['Generated At', data.generated_at || ''],
    ];
    return [
      { name: safeSheetName('Overview'), rows: overview },
      { name: safeSheetName('Virtual Machines'), rows: hostVMRows(data) },
      { name: safeSheetName('Schedules'), rows: hostScheduleRows(data) },
    ];
  }

  if (scope === 'vm') {
    const overview = [
      ['Metric', 'Value'],
      ['VM Name', data.vm_name || ''],
      ['Health', data.health || ''],
      ['Path', data.vm_path || ''],
      ['Total Size (GB)', data.total_disk_usage_gb || ''],
      ['Schedules Available', data.available_schedule_count || 0],
      ['Schedules Corrupted', data.corrupted_schedule_count || 0],
      ['Archived Backups', data.archived_backup_count || 0],
    ];
    if (data.controllerRollup) {
      const r = data.controllerRollup;
      if (r.lastSuccess)           overview.push(['Last Success', r.lastSuccess]);
      if (r.lastFailure)           overview.push(['Last Failure', r.lastFailure]);
      if (r.successRate30 != null) overview.push(['Success Rate 30d (%)', r.successRate30]);
      if (r.avgDurationHuman)      overview.push(['Avg Duration', r.avgDurationHuman]);
    }
    const schedRows = [[
      'Schedule', 'Available', 'Disk Usage (GB)', 'Methods',
      'Run Count', 'Corrupted', 'First Backup', 'Last Backup',
      'Chain Depth', 'Has Incremental',
    ]];
    const diskRows = [['Schedule', 'Disk', 'Format', 'Virtual (GB)', 'Data (GB)', 'Full', 'Inc']];
    for (const s of (data.schedules || [])) {
      const da = s.dump_analysis || {};
      schedRows.push([
        s.schedule, s.available ? 'Yes' : 'No',
        s.disk_usage_gb || '',
        (s.inferred_methods || []).join(', '),
        s.recorded_run_count || 0,
        s.corrupted ? 'Yes' : 'No',
        da.first_backup_date || '',
        da.last_backup_date || '',
        da.chain_depth || 0,
        da.has_incremental ? 'Yes' : 'No',
      ]);
      for (const disk of (da.disks || [])) {
        diskRows.push([
          s.schedule,
          disk.name || '',
          disk.format || '',
          disk.virtual_size_gb || disk.size_gb || '',
          disk.data_size_gb || '',
          disk.full_count || 0,
          disk.incremental_count || 0,
        ]);
      }
    }
    return [
      { name: safeSheetName('Overview'), rows: overview },
      { name: safeSheetName('Schedules'), rows: schedRows },
      { name: safeSheetName('Disks'), rows: diskRows },
    ];
  }

  return [
    { name: safeSheetName('Data'), rows: [['Field', 'Value'], ...Object.entries(data || {}).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)])] },
  ];
}

module.exports = router;
