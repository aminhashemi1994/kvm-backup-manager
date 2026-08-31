const express = require('express');
const router = express.Router();
const prometheusMetricsService = require('../services/prometheusMetricsService');

/**
 * GET /metrics — Prometheus scrape endpoint.
 *
 * Mounted OUTSIDE `authenticateUser`: Prometheus cannot obtain or refresh a
 * user JWT, so the panel's session auth cannot apply here. Access is controlled
 * by a dedicated scrape token instead.
 *
 * Set METRICS_TOKEN in the controller's environment and give the same value to
 * the monitoring team:
 *
 *   scrape_configs:
 *     - job_name: backup-manager
 *       scheme: https
 *       authorization:
 *         credentials: <METRICS_TOKEN>
 *       static_configs:
 *         - targets: ['backup-manager.internal']
 *
 * With METRICS_TOKEN unset the endpoint answers any request on the private
 * network. That is a deliberate default — a metrics endpoint that 401s on the
 * day it is installed gets debugged as "monitoring is broken" — but it is
 * logged loudly at boot, because the exposition does name every VM, host and
 * schedule in the fleet.
 */

/** Constant-time comparison, so a wrong token cannot be found byte by byte. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return require('crypto').timingSafeEqual(bufA, bufB);
}

function authorizeScrape(req, res, next) {
  const expected = process.env.METRICS_TOKEN;
  if (!expected) return next();

  // Both forms are accepted: Prometheus writes `authorization.credentials` as a
  // bare Bearer token, while curl and some agents send ?token= during testing.
  const header = req.get('authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const provided = bearer || req.query.token || '';

  if (provided && safeEqual(provided, expected)) return next();

  // No WWW-Authenticate header: this is a machine endpoint, and prompting a
  // browser for credentials only invites someone to paste the token into one.
  return res.status(401).type('text/plain').send('Unauthorized\n');
}

router.get('/', authorizeScrape, async (req, res) => {
  try {
    const body = await prometheusMetricsService.collect();
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    // The exposition is a point-in-time render; caching it anywhere between
    // here and Prometheus would silently flatten every graph.
    res.set('Cache-Control', 'no-store');
    res.send(body);
  } catch (err) {
    console.error('[Metrics] Failed to render Prometheus metrics:', err);
    // Plain text, not the JSON error envelope: whatever reads this is a
    // scraper, and a 500 with a readable reason is what shows up in its log.
    res.status(500).type('text/plain').send(`# scrape failed: ${err.message}\n`);
  }
});

module.exports = router;
