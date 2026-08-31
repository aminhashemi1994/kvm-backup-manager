const express = require('express');
const router = express.Router();
const offsiteJobService = require('../services/offsiteJobService');
const replicationCheckService = require('../services/replicationCheckService');
const { getOffsiteJobs, readLog, getBackupHosts } = require('../services/fileStorage');
const agentService = require('../services/agentService');

/**
 * Offsite replication jobs.
 *
 * Separate from /api/backups on purpose: a replication job has its own
 * lifecycle, its own store and its own meaning of failure, and none of the
 * backup reporting should have to tell the two apart.
 */

// GET /api/offsite-jobs — history and active syncs.
//   ?vmId=      only this VM
//   ?status=    comma-separated statuses
//   ?active=1   just what is queued or running
//   ?limit=     newest N (default 200)
router.get('/', async (req, res, next) => {
  try {
    let jobs = await getOffsiteJobs();

    if (req.query.vmId) {
      jobs = jobs.filter(j => j.vmId === req.query.vmId);
    }
    if (req.query.active === '1' || req.query.active === 'true') {
      jobs = jobs.filter(j => j.status === 'queued' || j.status === 'running');
    } else if (req.query.status) {
      const wanted = String(req.query.status).split(',').map(s => s.trim()).filter(Boolean);
      jobs = jobs.filter(j => wanted.includes(j.status));
    }

    jobs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
    res.json({ success: true, data: jobs.slice(0, limit) });
  } catch (error) {
    next(error);
  }
});

// GET /api/offsite-jobs/:id
router.get('/:id', async (req, res, next) => {
  try {
    const job = (await getOffsiteJobs()).find(j => j.id === req.params.id);
    if (!job) return res.status(404).json({ success: false, error: 'Offsite job not found' });
    res.json({ success: true, data: job });
  } catch (error) {
    next(error);
  }
});

// GET /api/offsite-jobs/:id/log
//
// Served from the AGENT, the same way a backup's log is. The controller's own
// log store only ever holds the handful of lines the controller itself wrote
// ("queued", "started on <host>") — the transfer's real output, including
// Rsync_Manager's live per-target progress bars, exists only in the tmux log on
// the agent. Reading the controller store alone is why the live viewer showed a
// replication job as having essentially no output.
//
// ?tail=N (default 2000) bounds the payload; ?full=1 serves the whole file.
router.get('/:id/log', async (req, res, next) => {
  try {
    const jobId = req.params.id;
    const job = (await getOffsiteJobs()).find(j => j.id === jobId);

    // Whatever the controller recorded, always available as the fallback.
    const controllerLog = await readLog(jobId);

    if (!job) {
      return res.json({ success: true, data: { jobId, log: controllerLog } });
    }

    const hosts = await getBackupHosts();
    const host = hosts.find(h => h.id === job.backupHostId);
    if (!host) {
      return res.json({ success: true, data: { jobId, log: controllerLog } });
    }

    const tail = req.query.full === '1'
      ? undefined
      : (Number(req.query.tail) > 0 ? Number(req.query.tail) : 2000);

    try {
      const client = agentService.createAgentClient(host.url, host.id, host.name);
      const response = await client.get(`/api/offsite/logs/${jobId}`, {
        timeout: 10000,
        params: tail ? { tail } : {},
      });
      const agentLog = (response.data && response.data.data && response.data.data.logs) || '';
      // An empty reply is a normal answer (the job never started, or the log
      // was reaped), not an error — fall back rather than showing nothing.
      if (agentLog.trim()) {
        return res.json({ success: true, data: { jobId, log: agentLog } });
      }
    } catch (err) {
      // An agent too old to have this route 404s. That is not worth failing
      // the request over: the controller's own record still explains what it
      // knows, and the panel shows that instead of an error.
      console.error(`[OffsiteJobs] Could not fetch the agent log for ${jobId}: ${err.message}`);
    }

    res.json({ success: true, data: { jobId, log: controllerLog } });
  } catch (error) {
    next(error);
  }
});

// POST /api/offsite-jobs — start a sync for one VM.
router.post('/', async (req, res, next) => {
  try {
    const { vmId, scheduleId } = req.body;
    if (!vmId) {
      return res.status(400).json({ success: false, error: 'vmId is required' });
    }

    const result = await offsiteJobService.requestSync({
      vmId,
      scheduleId: scheduleId || null,
      trigger: 'manual',
    });

    if (!result.created) {
      // An existing sync already covers this request — that is a normal answer,
      // not a failure, so it comes back as 200 with the job that covers it.
      if (result.job) {
        return res.json({ success: true, data: result.job, note: result.reason });
      }
      return res.status(409).json({ success: false, error: result.reason });
    }
    res.status(202).json({ success: true, data: result.job });
  } catch (error) {
    next(error);
  }
});

// POST /api/offsite-jobs/:id/retry — same button as the backup history's.
//
// { resetSourceGuard: true } re-records the source-filesystem baseline instead
// of refusing. It disarms the check that stops an unmounted pool from deleting
// the offsite copies, so it is only ever correct for a pool that has genuinely
// been moved to new storage — never as a way to get past a refusal.
router.post('/:id/retry', async (req, res, next) => {
  try {
    const result = await offsiteJobService.retry(req.params.id, {
      resetSourceGuard: (req.body || {}).resetSourceGuard === true,
    });
    if (!result.ok) return res.status(409).json({ success: false, error: result.reason });
    res.json({ success: true, data: result.job });
  } catch (error) {
    next(error);
  }
});

// POST /api/offsite-jobs/:id/cancel
router.post('/:id/cancel', async (req, res, next) => {
  try {
    const result = await offsiteJobService.cancel(req.params.id);
    if (!result.ok) return res.status(409).json({ success: false, error: result.reason });
    res.json({ success: true, data: { jobId: req.params.id, status: 'cancelled' } });
  } catch (error) {
    next(error);
  }
});

// POST /api/offsite-jobs/:id/update — status from the agent.
router.post('/:id/update', async (req, res, next) => {
  try {
    const result = await offsiteJobService.handleAgentUpdate(req.params.id, req.body || {});
    if (!result.ok) return res.status(404).json({ success: false, error: result.reason });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

// GET /api/offsite-jobs/check/results — the latest replication check per VM.
router.get('/check/results', async (req, res, next) => {
  try {
    // Display variant: the recorded snapshot, minus VMs that no longer
    // replicate, plus `not_checked` rows for VMs enabled since the last run —
    // so both turning offsite on and turning it off show up here immediately.
    res.json({ success: true, data: await replicationCheckService.getResultsForDisplay() });
  } catch (error) {
    next(error);
  }
});

// POST /api/offsite-jobs/check/run — run the check now.
//   { backupHostId? }  limit it to one backup host
//   { sync: true }     queue a sync for every VM found behind
router.post('/check/run', async (req, res, next) => {
  try {
    const { backupHostId, sync } = req.body || {};
    const summary = await replicationCheckService.runNow({
      backupHostId: backupHostId || null,
      autoSync: sync === true,
    });
    res.json({ success: true, data: summary });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
