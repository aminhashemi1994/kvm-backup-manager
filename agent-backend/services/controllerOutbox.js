const fs = require('fs');
const path = require('path');

/**
 * Durable spool for agent -> controller writes that must not be lost.
 *
 * A backup that finishes on disk but whose "completed" callback never lands
 * leaves the controller showing the job as still running forever: retention
 * never fires, the report says the VM wasn't backed up, and an operator chasing
 * a phantom failure eventually reruns a backup that already succeeded. The
 * in-line retry in backupExecutor gives up after roughly 31 seconds, which is
 * nowhere near long enough to ride out a certificate incident or a controller
 * restart.
 *
 * So terminal status updates that exhaust their inline retries land here
 * instead of being dropped. The spool survives an agent restart and drains as
 * soon as the controller answers again.
 */

const MAX_ENTRIES = 5000;
const DRAIN_INTERVAL_MS = 30 * 1000;

let outboxFile = null;
let entries = [];
let draining = false;
let drainTimer = null;
let config = null;

function initialize(agentConfig) {
  config = agentConfig;
  outboxFile = path.join(agentConfig.logDir, 'controller-outbox.json');
  load();

  console.log('✓ Controller outbox initialized');
  console.log(`  Spool file: ${outboxFile}`);
  console.log(`  Pending entries: ${entries.length}`);

  if (entries.length > 0) {
    console.warn(`[Outbox] ${entries.length} undelivered controller update(s) from a previous run — will replay`);
  }

  drainTimer = setInterval(() => {
    drain().catch(err => console.error('[Outbox] Periodic drain failed:', err.message));
  }, DRAIN_INTERVAL_MS);

  // Try immediately; the controller is usually up by now.
  drain().catch(() => { /* logged inside */ });
}

function load() {
  try {
    if (outboxFile && fs.existsSync(outboxFile)) {
      const parsed = JSON.parse(fs.readFileSync(outboxFile, 'utf8'));
      entries = Array.isArray(parsed) ? parsed : [];
    }
  } catch (error) {
    console.error('[Outbox] Failed to load spool (starting empty):', error.message);
    entries = [];
  }
}

function persist() {
  if (!outboxFile) return;
  try {
    // Write-then-rename so a crash mid-write can't leave a truncated spool —
    // this file is the only record that the update is still owed.
    const tmp = `${outboxFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
    fs.renameSync(tmp, outboxFile);
  } catch (error) {
    console.error('[Outbox] Failed to persist spool:', error.message);
  }
}

/**
 * Queue a controller write for later delivery.
 *
 * @param {object} item
 * @param {string} item.endpoint  - path relative to CONTROLLER_URL
 * @param {object} item.payload   - request body
 * @param {string} [item.dedupeKey] - later entries with the same key replace earlier ones
 * @param {string} [item.description] - human label for logs
 */
function enqueue({ endpoint, payload, dedupeKey, description }) {
  if (!endpoint) return null;

  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    endpoint,
    payload,
    dedupeKey: dedupeKey || null,
    description: description || endpoint,
    enqueuedAt: new Date().toISOString(),
    attempts: 0,
    lastError: null,
  };

  // A job's final state supersedes anything earlier queued for the same job —
  // replaying a stale "running" after "completed" would corrupt the record.
  if (entry.dedupeKey) {
    entries = entries.filter(e => e.dedupeKey !== entry.dedupeKey);
  }

  entries.push(entry);

  if (entries.length > MAX_ENTRIES) {
    const dropped = entries.length - MAX_ENTRIES;
    entries = entries.slice(dropped);
    console.error(`[Outbox] Spool exceeded ${MAX_ENTRIES} entries — dropped ${dropped} oldest update(s)`);
  }

  persist();
  console.warn(`[Outbox] Queued for later delivery: ${entry.description} (${entries.length} pending)`);
  return entry.id;
}

/**
 * Attempt to deliver everything queued. Safe to call often — it no-ops while a
 * drain is already in flight, and stops on the first failure so a down
 * controller doesn't cost one request per entry.
 */
async function drain() {
  if (draining || entries.length === 0) return { delivered: 0, pending: entries.length };
  if (!config || !config.controllerUrl) return { delivered: 0, pending: entries.length };

  draining = true;
  let delivered = 0;

  try {
    const controllerAuthService = require('./controllerAuthService');

    // Snapshot: entries may be appended to while we work.
    const queue = [...entries];

    for (const entry of queue) {
      try {
        await controllerAuthService.post(
          config.controllerUrl,
          entry.endpoint,
          entry.payload,
          { timeout: 15000, _skipOutboxDrain: true }
        );
        entries = entries.filter(e => e.id !== entry.id);
        delivered++;
        console.log(`[Outbox] ✓ Delivered queued update: ${entry.description}`);
      } catch (error) {
        entry.attempts++;
        entry.lastError = error.message;
        // Controller still unreachable — stop here and retry the whole spool
        // on the next tick rather than hammering it once per entry.
        console.warn(`[Outbox] Delivery failed for ${entry.description}: ${error.message}. ${entries.length} still pending.`);
        break;
      }
    }
  } finally {
    if (delivered > 0) persist();
    draining = false;
  }

  if (delivered > 0) {
    console.log(`[Outbox] Drained ${delivered} update(s); ${entries.length} still pending`);
  }
  return { delivered, pending: entries.length };
}

function getStatus() {
  return {
    pending: entries.length,
    oldest: entries.length ? entries[0].enqueuedAt : null,
    entries: entries.slice(0, 20).map(e => ({
      description: e.description,
      enqueuedAt: e.enqueuedAt,
      attempts: e.attempts,
      lastError: e.lastError,
    })),
  };
}

function shutdown() {
  if (drainTimer) {
    clearInterval(drainTimer);
    drainTimer = null;
  }
  persist();
}

module.exports = {
  initialize,
  enqueue,
  drain,
  getStatus,
  shutdown,
};
