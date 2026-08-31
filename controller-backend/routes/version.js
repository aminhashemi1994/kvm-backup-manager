const express = require('express');
const router = express.Router();

/**
 * The panel's version, from the controller's package.json.
 *
 * Single source of truth: the frontend used to carry its own hardcoded
 * strings, which drifted apart (the sidebar said one thing, Settings said
 * another, and neither matched the backend). Everything that displays a
 * version now reads it from here, so bumping package.json is the whole
 * release step.
 *
 * Read once at require time — the file cannot change under a running process,
 * and re-reading it per request would be pointless work on a value the UI
 * polls.
 */
const pkg = require('../package.json');

const PAYLOAD = Object.freeze({
  version: pkg.version,
  name: 'KVM Backup Manager',
  license: pkg.license || 'MIT',
  service: 'controller',
});

// GET /api/version
router.get('/', (req, res) => {
  res.json({ success: true, data: PAYLOAD });
});

module.exports = router;
