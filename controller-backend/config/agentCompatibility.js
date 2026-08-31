/**
 * Which agent builds can do what.
 *
 * Independent offsite replication (its own job, lock, tmux session and retry
 * budget) landed in agent 1.1.0. An agent older than that has no
 * /api/offsite/* routes at all: it will never replicate anything, while its
 * backups keep succeeding — so the panel has to say it out loud.
 *
 * Two signals decide it, and BOTH are needed:
 *
 *   capabilities.offsiteSync   Authoritative when present. It is emitted by
 *                              the process actually serving the request, so it
 *                              cannot be stale or guessed wrong.
 *
 *   version                    The fallback, and the human-readable half. An
 *                              agent that predates the capabilities block has
 *                              no flag to read, so its version is all there is.
 *
 * The version alone was never enough on its own: agent package.json sat at
 * 1.0.0 across the change, so pre- and post-split builds reported the SAME
 * version. That is why 1.1.0 exists — it is the first build whose version
 * actually distinguishes it, and it is also the first that reports
 * capabilities. Anything at or above it is compatible by either signal.
 */

const MIN_AGENT_VERSION = Object.freeze({
  offsiteSync: '1.1.0',
  replicationCheck: '1.1.0',
});

/**
 * Compare two dotted version strings numerically.
 * Returns <0, 0 or >0 like a comparator. Non-numeric suffixes ("1.1.0-rc2")
 * are ignored — a release candidate of 1.1.0 carries the 1.1.0 routes.
 */
function compareVersions(a, b) {
  const parse = (v) => String(v || '0')
    .split('.')
    .map(part => parseInt(part, 10) || 0);

  const left = parse(a);
  const right = parse(b);
  const len = Math.max(left.length, right.length);

  for (let i = 0; i < len; i++) {
    const l = left[i] || 0;
    const r = right[i] || 0;
    if (l !== r) return l - r;
  }
  return 0;
}

/** True when `version` is at least `minimum`. */
function atLeast(version, minimum) {
  if (!version) return false;
  return compareVersions(version, minimum) >= 0;
}

/**
 * Decide whether an agent supports a feature, from its /api/health body.
 *
 * @param {object} healthData  the agent's health response
 * @param {'offsiteSync'|'replicationCheck'} feature
 * @returns {{ supported: boolean, version: string|null, reason: string }}
 */
function agentSupports(healthData, feature) {
  const data = healthData || {};
  const version = data.version || null;
  const caps = data.capabilities || null;
  const minimum = MIN_AGENT_VERSION[feature];

  // An explicit flag from the serving process wins over everything.
  if (caps && typeof caps[feature] === 'boolean') {
    return {
      supported: caps[feature],
      version,
      reason: caps[feature]
        ? `agent advertises ${feature}${version ? ` (v${version})` : ''}`
        : `agent v${version || 'unknown'} reports it cannot ${feature}`,
    };
  }

  // No flag: fall back to the version. A build new enough to be compatible but
  // too old to advertise capabilities still passes here.
  if (atLeast(version, minimum)) {
    return { supported: true, version, reason: `agent v${version} ≥ ${minimum}` };
  }

  return {
    supported: false,
    version,
    reason: version
      ? `agent v${version} is older than ${minimum}`
      : `agent reports no version and no capabilities, so it predates ${minimum}`,
  };
}

module.exports = { MIN_AGENT_VERSION, compareVersions, atLeast, agentSupports };
