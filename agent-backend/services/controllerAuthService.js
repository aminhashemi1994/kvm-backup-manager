const axios = require('axios');
const controllerTlsService = require('./controllerTlsService');

/**
 * Simple helper to make authenticated calls from agent to controller
 * Uses pre-configured AGENT_JWT_TOKEN from .env
 *
 * Every request goes out over the resilient TLS agent in controllerTlsService,
 * so an expired controller certificate degrades to "works, with alarms"
 * instead of severing the agent from the controller. See that module for the
 * expiry-vs-substitution rules.
 */

function withTransport(config = {}) {
  const token = process.env.AGENT_JWT_TOKEN;

  if (!token) {
    throw new Error('AGENT_JWT_TOKEN not configured in .env');
  }

  const { _skipOutboxDrain, ...rest } = config;

  return {
    ...rest,
    // Only consulted for https:// targets; harmless on plain http.
    httpsAgent: controllerTlsService.getAgent(),
    headers: {
      ...config.headers,
      'Authorization': `Bearer ${token}`
    }
  };
}

/**
 * A reachable controller is the signal the outbox is waiting for. Kick a drain
 * whenever any call succeeds, so queued status updates land as soon as
 * connectivity returns rather than waiting out the 30s timer.
 */
function noteReachable(config = {}) {
  if (config._skipOutboxDrain) return;
  try {
    const outbox = require('./controllerOutbox');
    if (outbox.getStatus().pending > 0) {
      outbox.drain().catch(() => { /* logged inside */ });
    }
  } catch (_) {
    // Outbox not initialised yet — nothing queued to deliver.
  }
}

/**
 * Make an authenticated GET request to controller
 */
async function get(controllerUrl, endpoint, config = {}) {
  const response = await axios.get(`${controllerUrl}${endpoint}`, withTransport(config));
  noteReachable(config);
  return response;
}

/**
 * Make an authenticated POST request to controller
 */
async function post(controllerUrl, endpoint, data, config = {}) {
  const response = await axios.post(`${controllerUrl}${endpoint}`, data, withTransport(config));
  noteReachable(config);
  return response;
}

module.exports = {
  get,
  post
};
