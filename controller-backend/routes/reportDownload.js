const express = require('express');
const router = express.Router();
const reportEnrichmentService = require('../services/reportEnrichmentService');

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
 * GET /api/reports/download/:format
 * Download report in specified format.
 * Query params:
 *   - scope: 'global' | 'host' | 'vm' | 'hypervisor'
 *   - scopeId: ID of the host/vm/hypervisor (required for non-global)
 *   - format: 'json' | 'csv' | 'pdf' (from URL param)
 */
router.get('/download/:format', async (req, res, next) => {
  try {
    const { format } = req.params;
    const { scope, scopeId } = req.query;

    if (!['json', 'csv', 'pdf'].includes(format)) {
      return res.status(400).json({ success: false, error: 'Format must be json, csv, or pdf' });
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
    const filename = `backup-report_${scope}${scopeId ? '_' + scopeId.substring(0, 8) : ''}_${timestamp}`;

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

    if (format === 'pdf') {
      // PDF generation — return a structured JSON that the frontend can render
      // into a PDF client-side (using jspdf). Server-side PDF would require
      // puppeteer or similar heavy dep which we're avoiding.
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}_data.json"`);
      return res.json({
        success: true,
        format: 'pdf-data',
        message: 'Use this data with the frontend PDF generator',
        data,
        metadata: {
          scope,
          scopeId,
          generatedAt: new Date().toISOString(),
          filename: `${filename}.pdf`,
        },
      });
    }
  } catch (error) {
    next(error);
  }
});

/**
 * Convert report data to CSV format.
 */
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
    return rows.map(r => r.map(c => `"${String(c || '').replace(/"/g, '""')}"`).join(',')).join('\n');
  }

  if (scope === 'host' && data.vms) {
    const headers = [
      'VM Name', 'Health', 'Total Size (GB)', 'Schedule Count',
      'Last Success', 'Last Failure', 'Success Rate (30d)',
      'Avg Duration', 'Available Schedules', 'Corrupted Schedules'
    ];
    const rows = [headers];
    for (const vm of data.vms) {
      rows.push([
        vm.vm_name,
        vm.health,
        vm.total_disk_usage_gb,
        vm.controllerRollup?.scheduleCount || 0,
        vm.controllerRollup?.lastSuccess || 'N/A',
        vm.controllerRollup?.lastFailure || 'N/A',
        vm.controllerRollup?.successRate30 !== null ? `${vm.controllerRollup.successRate30}%` : 'N/A',
        vm.controllerRollup?.avgDurationHuman || 'N/A',
        vm.available_schedule_count || 0,
        vm.corrupted_schedule_count || 0,
      ]);
    }
    return rows.map(r => r.map(c => `"${String(c || '').replace(/"/g, '""')}"`).join(',')).join('\n');
  }

  if (scope === 'vm') {
    // Single VM — flatten schedules into rows
    const headers = [
      'Schedule', 'Available', 'Disk Usage (GB)', 'Method(s)',
      'Run Count', 'Corrupted', 'First Backup', 'Last Backup',
      'Chain Depth', 'Has Incremental'
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
    return rows.map(r => r.map(c => `"${String(c || '').replace(/"/g, '""')}"`).join(',')).join('\n');
  }

  // Fallback: JSON-like CSV
  return `"data"\n"${JSON.stringify(data).replace(/"/g, '""')}"`;
}

module.exports = router;
