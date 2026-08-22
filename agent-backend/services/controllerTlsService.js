const fs = require('fs');
const path = require('path');
const tls = require('tls');
const https = require('https');
const crypto = require('crypto');

/**
 * TLS transport for every agent -> controller call.
 *
 * The problem this solves: a backup agent that stops talking to the controller
 * because a certificate aged out is a backup we think we have and don't. Node's
 * default behaviour is to refuse the connection outright on CERT_HAS_EXPIRED,
 * with no interstitial and no override — so an expired cert silently freezes
 * every sync, every status callback, and every retention lookup.
 *
 * Blanket `rejectUnauthorized: false` would restore availability by throwing
 * away authentication entirely, and the agent ships a long-lived static bearer
 * token on every request. So instead we key on the distinction that actually
 * matters:
 *
 *   - Cert verifies cleanly             -> accept, and remember its public key.
 *   - Cert EXPIRED but the public key   -> accept. Same server, same key, the
 *     matches the key pinned while it      calendar just rolled over. Nothing
 *     was still valid                      is lost by continuing.
 *   - Cert EXPIRED and no pin on record -> accept (a fresh agent deployed
 *                                          during an outage must still work)
 *                                          and shout about it loudly.
 *   - Cert EXPIRED and the key CHANGED  -> refuse by default. An untrusted cert
 *                                          bearing an unfamiliar key is the
 *                                          signature of interception, not of
 *                                          expiry. Override with
 *                                          CONTROLLER_TLS_ON_PIN_MISMATCH=warn.
 *   - Anything else (unknown issuer,    -> refuse, unless explicitly allowed
 *     hostname mismatch)                   for test environments.
 *
 * The upshot: expiry degrades to "works, with alarms", and only a genuine
 * substitution attack stops traffic.
 */

const EXPIRY_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
]);

const SELF_SIGNED_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);

// Health rollup, read by /api/health and shipped to the controller so the panel
// can show a degraded agent even while the controller's own cert looks fine.
const state = {
  mode: 'unknown',        // ok | degraded-expired | degraded-unpinned | degraded-untrusted | blocked | unknown
  reason: null,
  host: null,
  cert: null,             // { subject, issuer, validFrom, validTo, daysRemaining, fingerprint256 }
  degradedSince: null,
  lastOkAt: null,
  lastCheckedAt: null,
  pinnedKeyAt: null,
};

let pinFile = null;
let pins = {};            // host -> { spki, fingerprint256, pinnedAt, subject }
let onStateChangeHook = null;

function initialize(config) {
  pinFile = path.join(config.logDir, 'controller-tls-pins.json');
  loadPins();
  console.log('✓ Controller TLS service initialized');
  console.log(`  Pin store: ${pinFile}`);
  console.log(`  Self-signed accepted: ${allowSelfSigned()}`);
  console.log(`  On pin mismatch: ${onPinMismatch()}`);
}

function allowSelfSigned() {
  return process.env.CONTROLLER_TLS_ALLOW_SELF_SIGNED === 'true';
}

function onPinMismatch() {
  return process.env.CONTROLLER_TLS_ON_PIN_MISMATCH === 'warn' ? 'warn' : 'reject';
}

function loadPins() {
  try {
    if (pinFile && fs.existsSync(pinFile)) {
      pins = JSON.parse(fs.readFileSync(pinFile, 'utf8')) || {};
      const hosts = Object.keys(pins);
      if (hosts.length) {
        console.log(`[ControllerTLS] Loaded ${hosts.length} pinned key(s): ${hosts.join(', ')}`);
      }
    }
  } catch (error) {
    console.error('[ControllerTLS] Failed to load pin store:', error.message);
    pins = {};
  }
}

function savePins() {
  if (!pinFile) return;
  try {
    fs.writeFileSync(pinFile, JSON.stringify(pins, null, 2));
  } catch (error) {
    console.error('[ControllerTLS] Failed to save pin store:', error.message);
  }
}

/**
 * Hash the SubjectPublicKeyInfo. Pinning the key rather than the whole
 * certificate means an ordinary renewal that reuses the keypair still matches,
 * and only a genuinely different key trips the alarm.
 */
function spkiOf(cert) {
  if (cert && cert.pubkey) {
    return crypto.createHash('sha256').update(cert.pubkey).digest('hex');
  }
  // Older Node builds don't expose pubkey — fall back to the cert fingerprint.
  return cert && cert.fingerprint256 ? `fp:${cert.fingerprint256}` : null;
}

function describeCert(cert) {
  if (!cert || !cert.valid_to) return null;
  const validTo = new Date(cert.valid_to);
  const days = Math.floor((validTo.getTime() - Date.now()) / 86400000);
  return {
    subject: cert.subject && (cert.subject.CN || JSON.stringify(cert.subject)),
    issuer: cert.issuer && (cert.issuer.CN || JSON.stringify(cert.issuer)),
    validFrom: cert.valid_from,
    validTo: cert.valid_to,
    daysRemaining: days,
    fingerprint256: cert.fingerprint256 || null,
  };
}

function setState(next) {
  const changed = state.mode !== next.mode || state.reason !== next.reason;
  Object.assign(state, next, { lastCheckedAt: new Date().toISOString() });

  if (next.mode === 'ok') {
    state.lastOkAt = state.lastCheckedAt;
    state.degradedSince = null;
  } else if (changed) {
    state.degradedSince = state.lastCheckedAt;
  }

  // Only announce transitions. This runs on a 60s sync loop; logging every
  // pass would bury the event that actually matters.
  if (changed) {
    if (next.mode === 'ok') {
      console.log('[ControllerTLS] ✓ Controller certificate verified cleanly');
    } else {
      console.error(`[ControllerTLS] ⚠ TLS DEGRADED (${next.mode}): ${next.reason}`);
      if (state.cert) {
        console.error(`[ControllerTLS]   Certificate valid_to ${state.cert.validTo} (${state.cert.daysRemaining} days remaining)`);
      }
      if (next.mode !== 'blocked') {
        console.error('[ControllerTLS]   Traffic is CONTINUING so backups are not interrupted. Renew the certificate.');
      }
    }
    if (typeof onStateChangeHook === 'function') {
      try { onStateChangeHook(getState()); } catch (_) { /* never let alerting break transport */ }
    }
  }
}

/** Register a callback fired whenever the TLS posture changes. */
function onStateChange(fn) {
  onStateChangeHook = fn;
}

/**
 * Decide whether to keep a socket whose peer we've just seen. Returns null to
 * accept, or an Error to tear the connection down.
 */
function evaluatePeer(socket, host) {
  const cert = socket.getPeerCertificate(true);
  const described = describeCert(cert);
  const spki = spkiOf(cert);
  const authError = socket.authorizationError && String(socket.authorizationError);

  // Clean verification: Node checked the trust chain AND the hostname.
  if (socket.authorized) {
    if (spki) {
      const existing = pins[host];
      if (!existing || existing.spki !== spki) {
        pins[host] = {
          spki,
          fingerprint256: described && described.fingerprint256,
          subject: described && described.subject,
          pinnedAt: new Date().toISOString(),
        };
        savePins();
        console.log(`[ControllerTLS] Pinned controller key for ${host}`);
      }
      state.pinnedKeyAt = pins[host].pinnedAt;
    }
    setState({ mode: 'ok', reason: null, host, cert: described });
    return null;
  }

  const isExpiry = EXPIRY_CODES.has(authError);
  const isSelfSigned = SELF_SIGNED_CODES.has(authError);

  if (isExpiry) {
    const pin = pins[host];
    if (pin && spki && pin.spki === spki) {
      setState({
        mode: 'degraded-expired',
        reason: `Controller certificate expired on ${described ? described.validTo : 'an unknown date'}, but its public key matches the key pinned on ${pin.pinnedAt}. Same server — continuing.`,
        host,
        cert: described,
      });
      return null;
    }
    if (!pin) {
      setState({
        mode: 'degraded-unpinned',
        reason: `Controller certificate is expired (${authError}) and this agent has no previously pinned key to compare against. Accepting so backups keep running — verify the controller identity manually.`,
        host,
        cert: described,
      });
      return null;
    }
    // Expired AND the key changed. That is not what expiry looks like.
    const reason = `Controller certificate is expired AND its public key does not match the key pinned for ${host}. That is what interception looks like, not expiry.`;
    if (onPinMismatch() === 'warn') {
      setState({
        mode: 'degraded-untrusted',
        reason: `${reason} Continuing anyway because CONTROLLER_TLS_ON_PIN_MISMATCH=warn.`,
        host,
        cert: described,
      });
      return null;
    }
    setState({
      mode: 'blocked',
      reason: `${reason} Refusing the connection. Set CONTROLLER_TLS_ON_PIN_MISMATCH=warn to override.`,
      host,
      cert: described,
    });
    return Object.assign(new Error(reason), { code: 'ERR_TLS_PIN_MISMATCH' });
  }

  if (isSelfSigned && allowSelfSigned()) {
    setState({
      mode: 'degraded-untrusted',
      reason: `Controller certificate is not trusted (${authError}); accepted because CONTROLLER_TLS_ALLOW_SELF_SIGNED=true.`,
      host,
      cert: described,
    });
    return null;
  }

  setState({
    mode: 'blocked',
    reason: `Controller certificate rejected: ${authError || 'unknown verification failure'}.`,
    host,
    cert: described,
  });
  return Object.assign(new Error(`Controller TLS verification failed: ${authError}`), {
    code: authError || 'ERR_TLS_VERIFICATION_FAILED',
  });
}

/**
 * https.Agent that hands verification to evaluatePeer instead of letting Node
 * destroy the socket before we can tell expiry apart from substitution.
 */
class ResilientHttpsAgent extends https.Agent {
  createConnection(options, callback) {
    const host = options.servername || options.host;

    // rejectUnauthorized:false stops Node tearing the socket down on its own;
    // it does NOT mean "accept anything". socket.authorized and
    // socket.authorizationError are still populated either way, and
    // evaluatePeer is what decides. Hostname verification is preserved:
    // socket.authorized is only true when Node checked the chain AND the name.
    const socket = tls.connect({ ...options, rejectUnauthorized: false }, () => {
      let verdict = null;
      try {
        verdict = evaluatePeer(socket, host);
      } catch (error) {
        verdict = error;
      }
      if (verdict) {
        socket.destroy(verdict);
        return;
      }
      if (typeof callback === 'function') callback(null, socket);
    });

    socket.on('error', () => { /* surfaced to the caller via the request */ });
    return socket;
  }
}

const agent = new ResilientHttpsAgent({ keepAlive: true, maxSockets: 24 });

function getAgent() {
  return agent;
}

function getState() {
  return { ...state, cert: state.cert ? { ...state.cert } : null };
}

/** True when traffic is flowing but the certificate needs human attention. */
function isDegraded() {
  return state.mode.startsWith('degraded') || state.mode === 'blocked';
}

module.exports = {
  initialize,
  getAgent,
  getState,
  isDegraded,
  onStateChange,
  // exported for tests
  _evaluatePeer: evaluatePeer,
};
