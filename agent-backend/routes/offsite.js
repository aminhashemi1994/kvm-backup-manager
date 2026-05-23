const express = require('express');
const router = express.Router();

/**
 * NOTE: Offsite backup is handled entirely by backup_manager.sh script.
 * SSH keys and paths are configured manually on the backup host server.
 * This route file is kept minimal for future extensions if needed.
 */

// POST /api/offsite/test - Test offsite connection (basic ping test)
router.post('/test', async (req, res, next) => {
  try {
    const { ip } = req.body;

    if (!ip) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: ip',
      });
    }

    // Simple ping test to check if host is reachable
    const { spawn } = require('child_process');
    const ping = spawn('ping', ['-c', '1', '-W', '2', ip]);

    let success = false;

    ping.on('close', (code) => {
      success = code === 0;
    });

    // Wait for ping to complete
    await new Promise((resolve) => {
      ping.on('close', resolve);
    });

    res.json({
      success: true,
      data: {
        success,
        message: success ? 'Host is reachable' : 'Host is not reachable',
      },
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
