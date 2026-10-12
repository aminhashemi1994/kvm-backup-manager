const crypto = require('crypto');

/**
 * Static API-token auth for machine-to-machine integrations (CMDB, inventory
 * sync, asset reporting).
 *
 * Mounted OUTSIDE `authenticateUser`: an integration cannot obtain or refresh
 * a user JWT, and issuing a real panel user for a script would hand it the
 * whole write surface. These tokens are read-only by construction — the routes
 * behind this middleware only ever GET.
 *
 * Tokens live in INVENTORY_API_TOKENS as a comma-separated list, each entry
 * `label:secret`. The label is not a secret; it exists so an access log and an
 * audit trail can name WHICH consumer called, and so one consumer can be
 * revoked without rotating everyone else's token:
 *
 *   INVENTORY_API_TOKENS=netops-hamid:9f3c...,cmdb-sync:41ab...
 *
 * A bare `secret` with no label is accepted too and reported as "unnamed".
 *
 * Unlike METRICS_TOKEN, an unset/empty value here DENIES every request rather
 * than opening the endpoint. This surface enumerates hostnames, IPs and backup
 * topology for the whole fleet, so "not configured yet" must fail closed.
 */

/** Constant-time compare, so a wrong token cannot be discovered byte by byte. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  // Length is compared first and leaks only the length, never the contents.
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Parse INVENTORY_API_TOKENS into [{ label, secret }]. */
function parseTokens(raw) {
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf(':');
      if (idx === -1) return { label: 'unnamed', secret: entry };
      return {
        label: entry.slice(0, idx).trim() || 'unnamed',
        secret: entry.slice(idx + 1).trim(),
      };
    })
    .filter((t) => t.secret);
}

function authenticateApiToken(req, res, next) {
  const tokens = parseTokens(process.env.INVENTORY_API_TOKENS);

  if (tokens.length === 0) {
    return res.status(503).json({
      success: false,
      error: 'Inventory API is not configured (INVENTORY_API_TOKENS is unset).',
    });
  }

  // Both forms are accepted: `Authorization: Bearer <token>` for real clients,
  // and ?token= so the endpoint can be smoke-tested from a browser or curl.
  const header = req.get('authorization') || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : header.trim();
  const provided = bearer || req.query.token || '';

  if (provided) {
    // Every candidate is compared even after a match, so response time does
    // not reveal the token's position in the list.
    let matched = null;
    for (const t of tokens) {
      if (safeEqual(provided, t.secret)) matched = t;
    }
    if (matched) {
      req.apiClient = { label: matched.label, type: 'inventory-api' };
      return next();
    }
  }

  // No WWW-Authenticate header: this is a machine endpoint, and prompting a
  // browser for credentials only invites someone to paste the token into one.
  return res.status(401).json({ success: false, error: 'Invalid or missing API token' });
}

module.exports = { authenticateApiToken, parseTokens };
