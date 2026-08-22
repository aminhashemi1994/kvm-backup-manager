const fs = require('fs');
const tls = require('tls');
const crypto = require('crypto');
const config = require('../config/config');
const rocketChatService = require('./rocketChatService');
const notificationPolicy = require('./notificationPolicyService');
const { getBackupHosts } = require('./fileStorage');
const agentService = require('./agentService');

/**
 * Watches every certificate the platform depends on and raises the alarm well
 * before one of them expires.
 *
 * The agents are built to keep running through an expired certificate rather
 * than stopping (see agent-backend/services/controllerTlsService.js), which
 * removes the outage but also removes the symptom — nobody notices a cert died
 * until something else breaks. This service is the counterweight: it is the
 * thing that makes a silent, survivable degradation loud.
 *
 * Three sources are checked:
 *   1. Certificate files on disk (the controller's own cert, the nginx cert).
 *   2. Live TLS endpoints, which catches the case where nginx is still serving
 *      an old cert because nobody reloaded it after renewal — a renewed file on
 *      disk and an expired cert on the wire look identical from the filesystem.
 *   3. Each agent's self-reported TLS posture, so a degraded agent-to-controller
 *      link shows up in the panel.
 */

// Days remaining at which we speak up. Crossing any of these sends one alert.
const WARN_THRESHOLDS = [30, 14, 7, 3, 1];

/**
 * 'unknown' means the agent has not completed a TLS handshake with the
 * controller — normally because CONTROLLER_URL is plain http, so the TLS
 * transport is never exercised. That is a perfectly healthy configuration and
 * must not be reported as degradation; treating it as such produced alerts
 * reading "Degraded (still working) — Details: unknown", which is pure noise.
 */
function isDegradedMode(mode) {
  return !!mode && mode !== 'ok' && mode !== 'unknown';
}
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;   // 4x/day is plenty for a daily-granularity signal
const EXPIRED_RENOTIFY_MS = 24 * 60 * 60 * 1000; // keep nagging daily once actually expired

class CertificateMonitorService {
  constructor() {
    this.io = null;
    this.timer = null;
    this.targets = [];
    this.results = [];
    this.lastCheckedAt = null;
    // target key -> { lastThreshold, lastExpiredAlertAt }
    this.alertState = new Map();
    this.agentTlsReports = new Map(); // backupHostId/port -> tls state from the agent
  }

  setSocketIO(io) {
    this.io = io;
  }

  initialize(io) {
    if (io) this.io = io;
    this.targets = this.resolveTargets();

    console.log('✓ Certificate monitor initialized');
    if (this.targets.length === 0) {
      console.log('  No certificates configured to monitor.');
      console.log('  Set SSL_CERT_PATH, or CERT_MONITOR_FILES / CERT_MONITOR_ENDPOINTS, to enable expiry alerts.');
    } else {
      this.targets.forEach(t => console.log(`  Watching ${t.kind}: ${t.label}`));
    }

    // Don't race the rest of startup; nothing here is time-critical.
    setTimeout(() => this.runCheck().catch(err => {
      console.error('[CertMonitor] Initial check failed:', err.message);
    }), 20000);

    this.timer = setInterval(() => {
      this.runCheck().catch(err => console.error('[CertMonitor] Periodic check failed:', err.message));
    }, CHECK_INTERVAL_MS);
  }

  /**
   * Build the watch list. The controller's own configured cert is included
   * automatically; everything else is opt-in via env so this stays silent on
   * installations that terminate TLS somewhere we can't see.
   */
  resolveTargets() {
    const targets = [];

    if (config.ssl && config.ssl.cert) {
      targets.push({ kind: 'file', label: 'Controller certificate', path: config.ssl.cert });
    }

    const extraFiles = (process.env.CERT_MONITOR_FILES || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    for (const file of extraFiles) {
      targets.push({ kind: 'file', label: file, path: file });
    }

    // "host:port" pairs, e.g. "backup.example.com:443". This is the one that
    // catches an nginx that was never reloaded after certbot renewed.
    const endpoints = (process.env.CERT_MONITOR_ENDPOINTS || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    for (const endpoint of endpoints) {
      const [host, port] = endpoint.split(':');
      if (!host) continue;
      targets.push({
        kind: 'endpoint',
        label: `${host}:${port || 443}`,
        host,
        port: parseInt(port, 10) || 443,
      });
    }

    return targets;
  }

  /** Read a PEM/DER certificate off disk and describe it. */
  inspectFile(target) {
    try {
      const pem = fs.readFileSync(target.path);
      const x509 = new crypto.X509Certificate(pem);
      return this.describe(target, {
        subject: x509.subject,
        issuer: x509.issuer,
        validFrom: x509.validFrom,
        validTo: x509.validTo,
        fingerprint256: x509.fingerprint256,
      });
    } catch (error) {
      return {
        key: `file:${target.path}`,
        kind: 'file',
        label: target.label,
        source: target.path,
        status: 'error',
        error: `Could not read certificate: ${error.message}`,
      };
    }
  }

  /** Open a TLS connection purely to see what the server is actually serving. */
  inspectEndpoint(target) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      const socket = tls.connect({
        host: target.host,
        port: target.port,
        servername: target.host,
        // We are inspecting the certificate, not trusting it. Verification
        // failures are exactly what we want to observe and report.
        rejectUnauthorized: false,
        timeout: 10000,
      }, () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        if (!cert || !cert.valid_to) {
          finish({
            key: `endpoint:${target.label}`,
            kind: 'endpoint',
            label: target.label,
            source: target.label,
            status: 'error',
            error: 'Server presented no certificate',
          });
          return;
        }
        finish(this.describe(target, {
          subject: cert.subject && (cert.subject.CN || JSON.stringify(cert.subject)),
          issuer: cert.issuer && (cert.issuer.CN || JSON.stringify(cert.issuer)),
          validFrom: cert.valid_from,
          validTo: cert.valid_to,
          fingerprint256: cert.fingerprint256,
          authorized: socket.authorized,
          authorizationError: socket.authorizationError && String(socket.authorizationError),
        }));
      });

      socket.on('timeout', () => {
        socket.destroy();
        finish({
          key: `endpoint:${target.label}`,
          kind: 'endpoint',
          label: target.label,
          source: target.label,
          status: 'error',
          error: 'Connection timed out',
        });
      });

      socket.on('error', (error) => {
        finish({
          key: `endpoint:${target.label}`,
          kind: 'endpoint',
          label: target.label,
          source: target.label,
          status: 'error',
          error: error.message,
        });
      });
    });
  }

  describe(target, cert) {
    const validTo = new Date(cert.validTo);
    const msRemaining = validTo.getTime() - Date.now();
    const daysRemaining = Math.floor(msRemaining / 86400000);

    let status = 'ok';
    if (msRemaining <= 0) status = 'expired';
    else if (daysRemaining <= 7) status = 'critical';
    else if (daysRemaining <= 30) status = 'warning';

    return {
      key: target.kind === 'file' ? `file:${target.path}` : `endpoint:${target.label}`,
      kind: target.kind,
      label: target.label,
      source: target.path || target.label,
      status,
      daysRemaining,
      subject: cert.subject,
      issuer: cert.issuer,
      validFrom: cert.validFrom,
      validTo: cert.validTo,
      fingerprint256: cert.fingerprint256,
      authorized: cert.authorized,
      authorizationError: cert.authorizationError,
    };
  }

  /**
   * Agents post their TLS posture here when it changes (and we also read it
   * from /api/health). A degraded agent link means the agent is running on
   * the fail-open path — working, but on borrowed trust.
   */
  recordAgentReport(agentKey, tlsState) {
    if (!agentKey || !tlsState) return;
    this.agentTlsReports.set(String(agentKey), {
      ...tlsState,
      reportedAt: new Date().toISOString(),
    });
    if (isDegradedMode(tlsState.mode)) {
      // A self-report identifies itself by port, not by host id, so there is
      // no backup host to scope schedule overrides to — global default applies.
      this.announceAgentDegradation(null, String(agentKey), tlsState);
    }
  }

  /** Poll every known agent's health endpoint for its TLS posture. */
  async collectAgentTlsStates() {
    let hosts = [];
    try {
      hosts = await getBackupHosts();
    } catch (_) {
      return [];
    }

    const states = [];
    await Promise.all((hosts || []).map(async (host) => {
      if (!host || !host.url) return;
      try {
        const result = await agentService.healthCheck(host.url);
        const tlsState = result && result.success && result.data && result.data.tls;
        const outbox = result && result.success && result.data && result.data.outbox;
        if (tlsState) {
          this.agentTlsReports.set(host.id, { ...tlsState, reportedAt: new Date().toISOString() });
          states.push({ hostId: host.id, hostName: host.name, tls: tlsState, outbox });
          if (isDegradedMode(tlsState.mode)) {
            this.announceAgentDegradation(host.id, host.name || host.id, tlsState);
          }
        }
      } catch (_) {
        // Health-check failures are already the health service's business.
      }
    }));
    return states;
  }

  async runCheck() {
    const results = [];

    for (const target of this.targets) {
      if (target.kind === 'file') {
        results.push(this.inspectFile(target));
      } else {
        results.push(await this.inspectEndpoint(target));
      }
    }

    const agentStates = await this.collectAgentTlsStates();

    this.results = results;
    this.lastCheckedAt = new Date().toISOString();
    void agentStates; // recorded into agentTlsReports; getStatus() reads from there

    for (const result of results) {
      this.maybeAlert(result);
    }

    const summary = this.getStatus();
    if (this.io) this.io.emit('certificate-status', summary);

    const worst = summary.worstStatus;
    if (worst !== 'ok') {
      console.warn(`[CertMonitor] Certificate status: ${worst}`);
      results.filter(r => r.status !== 'ok').forEach(r => {
        console.warn(`[CertMonitor]   ${r.label}: ${r.status}${r.daysRemaining !== undefined ? ` (${r.daysRemaining} days)` : ''}${r.error ? ` — ${r.error}` : ''}`);
      });
    }

    return summary;
  }

  /**
   * One alert per threshold crossed, so a 30-day warning doesn't repeat four
   * times a day for a month. Expired certs re-nag daily because at that point
   * the noise is the point.
   */
  async maybeAlert(result) {
    if (result.status === 'ok') {
      this.alertState.delete(result.key);
      return;
    }

    const allowed = await notificationPolicy.shouldNotify(null, 'certificateExpiry');
    if (!allowed) return;

    const previous = this.alertState.get(result.key) || {};

    if (result.status === 'error') {
      // Throttle like an expiry rather than firing on every check. A
      // misconfigured path (SSL_CERT_PATH pointing at a file that isn't there)
      // is a standing condition, not an event, and the same message every few
      // minutes buries the alerts that actually changed.
      const lastAt = previous.lastErrorAlertAt ? new Date(previous.lastErrorAlertAt).getTime() : 0;
      if (previous.lastError === result.error && Date.now() - lastAt < EXPIRED_RENOTIFY_MS) return;
      this.alertState.set(result.key, {
        ...previous,
        lastError: result.error,
        lastErrorAlertAt: new Date().toISOString(),
      });
      rocketChatService.notifyCriticalError(
        'TLS Certificate',
        `Cannot inspect certificate for ${result.label}`,
        result.error || ''
      );
      return;
    }

    if (result.status === 'expired') {
      const last = previous.lastExpiredAlertAt ? new Date(previous.lastExpiredAlertAt).getTime() : 0;
      if (Date.now() - last < EXPIRED_RENOTIFY_MS) return;
      this.alertState.set(result.key, { ...previous, lastExpiredAlertAt: new Date().toISOString() });
      notificationPolicy.getCertificateMentions('certificateExpired')
        .then(m => rocketChatService.notifyCertificateExpired(result, m))
        .catch(() => rocketChatService.notifyCertificateExpired(result, []));
      return;
    }

    // Warning / critical: fire once per threshold band.
    const band = WARN_THRESHOLDS.find(t => result.daysRemaining <= t);
    if (band === undefined) return;
    if (previous.lastThreshold !== undefined && previous.lastThreshold <= band) return;

    this.alertState.set(result.key, { ...previous, lastThreshold: band });
    notificationPolicy.getCertificateMentions('certificateExpiring')
      .then(m => rocketChatService.notifyCertificateExpiring(result, m))
      .catch(() => rocketChatService.notifyCertificateExpiring(result, []));
  }

  /**
   * A degraded agent link belongs to a backup host, so the schedules running on
   * that host get a say — see notificationPolicyService.shouldNotifyForBackupHost.
   * The panel banner is deliberately NOT gated on that: muting chat messages for
   * a host should not hide the platform's TLS state from whoever opens the UI.
   */
  announceAgentDegradation(backupHostId, agentLabel, tlsState) {
    const key = `agent:${agentLabel}`;
    const previous = this.alertState.get(key) || {};
    if (previous.lastMode === tlsState.mode) return;
    this.alertState.set(key, { ...previous, lastMode: tlsState.mode });

    notificationPolicy.shouldNotifyForBackupHost(backupHostId, 'certificateExpiry').then((allowed) => {
      if (!allowed) return;
      notificationPolicy.getCertificateMentions('agentTlsDegraded')
        .then(m => rocketChatService.notifyAgentTlsDegraded(agentLabel, tlsState, m))
        .catch(() => rocketChatService.notifyAgentTlsDegraded(agentLabel, tlsState, []));
    }).catch(() => { /* alerting must never throw into the check loop */ });

    if (this.io) {
      this.io.emit('agent-tls-status', { agent: agentLabel, backupHostId, ...tlsState });
    }
  }

  getStatus() {
    const order = { ok: 0, warning: 1, critical: 2, expired: 3, error: 3 };
    let worstStatus = 'ok';
    for (const r of this.results) {
      if (order[r.status] > order[worstStatus]) worstStatus = r.status;
    }

    const degradedAgents = [];
    for (const [key, value] of this.agentTlsReports.entries()) {
      if (isDegradedMode(value.mode)) {
        degradedAgents.push({ agent: key, ...value });
      }
    }
    if (degradedAgents.length > 0 && worstStatus === 'ok') worstStatus = 'warning';

    return {
      worstStatus,
      lastCheckedAt: this.lastCheckedAt,
      monitored: this.results.length,
      certificates: this.results,
      degradedAgents,
      // Explicit so the panel can say the reassuring half out loud: a degraded
      // certificate does not stop backups on this platform.
      backupsContinue: true,
    };
  }

  async triggerManualCheck() {
    return this.runCheck();
  }

  shutdown() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

module.exports = new CertificateMonitorService();
