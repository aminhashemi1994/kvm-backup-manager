const express = require('express');
const router = express.Router();
const authService = require('../services/authService');
const auditService = require('../services/auditService');
const { authenticateUser } = require('../middleware/auth');

// Simple per-IP attempt counters. req.ip is the real client IP because the
// app trusts the nginx proxy (see server.js).
const WINDOW_MS = 15 * 60 * 1000;

function createLimiter(maxAttempts) {
  const attempts = new Map();
  return {
    // True once the IP has used up its attempts in the current window
    isLimited(ip) {
      const entry = attempts.get(ip);
      return !!entry && Date.now() - entry.start <= WINDOW_MS && entry.count >= maxAttempts;
    },
    record(ip) {
      const now = Date.now();
      const entry = attempts.get(ip);
      if (!entry || now - entry.start > WINDOW_MS) {
        attempts.set(ip, { start: now, count: 1 });
      } else {
        entry.count += 1;
      }
      // Drop expired entries so the map can't grow without bound
      if (attempts.size > 10000) {
        for (const [key, e] of attempts) if (now - e.start > WINDOW_MS) attempts.delete(key);
      }
    },
    reset(ip) {
      attempts.delete(ip);
    },
  };
}

const loginLimiter = createLimiter(10); // failed logins per IP
const setupLimiter = createLimiter(10); // setup attempts per IP (guards the setup token)

/**
 * POST /api/auth/login
 * User login
 */
router.post('/login', async (req, res, next) => {
  try {
    if (loginLimiter.isLimited(req.ip)) {
      return res.status(429).json({
        success: false,
        error: 'Too many failed login attempts. Try again in 15 minutes.'
      });
    }

    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({
        success: false,
        error: 'Username and password are required'
      });
    }
    
    const result = await authService.login(username, password);
    
    if (!result.success) {
      loginLimiter.record(req.ip);
      // Audit failed login
      await auditService.log('auth.login_failed', {
        actor: username,
        details: { reason: result.error },
        ip: req.ip,
      });
      return res.status(401).json(result);
    }
    
    loginLimiter.reset(req.ip);

    // Audit successful login
    await auditService.log('auth.login', {
      actor: result.user.username,
      actorId: result.user.id,
      actorRole: result.user.role,
      ip: req.ip,
    });
    
    res.json(result);
  } catch (error) {
    console.error('[Auth] Login error:', error);
    next(error);
  }
});

/**
 * GET /api/auth/setup-status
 * Whether the initial admin account still has to be created
 */
router.get('/setup-status', async (req, res, next) => {
  try {
    res.json({ success: true, needsSetup: await authService.needsSetup() });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/auth/setup
 * Create the initial admin account (only allowed while no users exist)
 */
router.post('/setup', async (req, res, next) => {
  try {
    if (setupLimiter.isLimited(req.ip)) {
      return res.status(429).json({ success: false, error: 'Too many setup attempts. Try again later.' });
    }

    setupLimiter.record(req.ip);
    const { username, password, setupToken } = req.body;
    const result = await authService.setupInitialAdmin(username, password, setupToken);

    if (!result.success) {
      if (result.code === 'BAD_TOKEN') {
        await auditService.log('auth.initial_setup_failed', {
          actor: typeof username === 'string' ? username : null,
          details: { reason: result.error },
          ip: req.ip,
        });
      }
      const status = { SETUP_DONE: 409, BAD_TOKEN: 403 }[result.code] || 400;
      return res.status(status).json(result);
    }

    await auditService.log('auth.initial_setup', {
      actor: result.user.username,
      actorId: result.user.id,
      actorRole: result.user.role,
      ip: req.ip,
    });

    res.json(result);
  } catch (error) {
    console.error('[Auth] Initial setup error:', error);
    next(error);
  }
});

/**
 * POST /api/auth/change-password
 * Change user password (requires authentication)
 */
router.post('/change-password', authenticateUser, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const username = req.user.username;
    
    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        error: 'Current password and new password are required'
      });
    }
    
    const result = await authService.changePassword(username, currentPassword, newPassword);
    
    if (!result.success) {
      return res.status(400).json(result);
    }
    
    res.json(result);
  } catch (error) {
    console.error('[Auth] Change password error:', error);
    next(error);
  }
});

/**
 * GET /api/auth/verify
 * Verify token validity
 */
router.get('/verify', authenticateUser, (req, res) => {
  res.json({
    success: true,
    user: {
      id: req.user.id,
      username: req.user.username,
      role: req.user.role
    }
  });
});

/**
 * POST /api/auth/logout
 * Logout (client-side token removal, but we can log it)
 */
router.post('/logout', authenticateUser, (req, res) => {
  console.log(`[Auth] User ${req.user.username} logged out`);
  res.json({
    success: true,
    message: 'Logged out successfully'
  });
});

module.exports = router;
