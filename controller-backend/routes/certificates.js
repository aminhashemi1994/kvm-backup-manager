const express = require('express');
const router = express.Router();
const certificateMonitorService = require('../services/certificateMonitorService');

// GET /api/certificates/status - current expiry posture for every watched cert
router.get('/status', async (req, res, next) => {
  try {
    res.json({
      success: true,
      data: certificateMonitorService.getStatus()
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/certificates/check - re-inspect everything now
router.post('/check', async (req, res, next) => {
  try {
    const data = await certificateMonitorService.triggerManualCheck();
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/certificates/agent-report
 *
 * An agent telling us its own view of the link. Note this necessarily arrives
 * over the connection being complained about, which is precisely why the agent
 * transport fails open — if it failed closed, this report could never reach us.
 */
router.post('/agent-report', async (req, res, next) => {
  try {
    const { agentPort, tls } = req.body || {};
    const key = req.body.agentId || `port:${agentPort}` || 'unknown-agent';
    certificateMonitorService.recordAgentReport(key, tls);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
