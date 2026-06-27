const jwt = require('jsonwebtoken');

/**
 * Middleware to verify JWT token for user authentication (frontend -> controller)
 * Also accepts static token for agent-to-controller calls
 */
const authenticateUser = (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    
    if (!authHeader) {
      return res.status(401).json({
        success: false,
        error: 'No authorization token provided'
      });
    }

    const token = authHeader.startsWith('Bearer ') 
      ? authHeader.substring(7) 
      : authHeader;

    // Check if it's the static agent token
    const agentStaticToken = process.env.AGENT_STATIC_TOKEN;
    if (agentStaticToken && token === agentStaticToken) {
      req.user = { type: 'agent', agentId: 'static-agent' };
      req.tokenType = 'agent-static';
      return next();
    }

    // Otherwise verify as JWT token (user or agent JWT)
    const userSecret = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
    const agentSecret = process.env.AGENT_JWT_SECRET;
    
    let decoded = null;
    let tokenType = 'user';
    
    try {
      // Try user token first
      decoded = jwt.verify(token, userSecret);
      tokenType = 'user';
    } catch (userError) {
      // If user token fails and agent secret is configured, try agent token
      if (agentSecret) {
        try {
          decoded = jwt.verify(token, agentSecret);
          tokenType = 'agent';
        } catch (agentError) {
          // Both failed, throw the original user error
          throw userError;
        }
      } else {
        // No agent secret configured, throw user error
        throw userError;
      }
    }
    
    // Item 8: Check if user is disabled
    if (tokenType === 'user' && decoded && decoded.id) {
      // Lazy check — we don't read the file on every request for performance.
      // The JWT contains the role at issue time. If a user is disabled, their
      // token will fail on next login. For immediate revocation, admins should
      // change the JWT_SECRET or wait for token expiry.
      // However, we do check the 'disabled' flag if it's in the token.
      if (decoded.disabled === true) {
        return res.status(403).json({
          success: false,
          error: 'Account is disabled. Contact an administrator.'
        });
      }
    }
    
    req.user = decoded;
    req.tokenType = tokenType;

    // Sliding-window session refresh — USER tokens only, and only when the
    // request follows real user activity (X-Session-Active header set by the
    // frontend). Background polling without user interaction does NOT extend
    // the session, so an unattended tab still expires after the idle window.
    //
    // This is deliberately NOT applied to agent tokens (static or agent JWT):
    // agent↔controller and controller↔agent communication must never be
    // affected by user-session timeouts.
    const userIsActive = req.headers['x-session-active'] === '1';
    if (tokenType === 'user' && decoded && decoded.id && userIsActive) {
      try {
        const expiresIn = process.env.JWT_EXPIRES_IN || '30m';
        const freshToken = jwt.sign(
          {
            id: decoded.id,
            username: decoded.username,
            role: decoded.role,
            accessGrants: decoded.accessGrants || { backupHostIds: [] },
            ...(decoded.disabled !== undefined ? { disabled: decoded.disabled } : {}),
          },
          userSecret,
          { expiresIn }
        );
        res.setHeader('X-Refresh-Token', freshToken);
      } catch (refreshErr) {
        // If refresh minting fails for any reason, don't block the request —
        // the existing token is still valid until its own expiry.
        console.error('[Auth] Failed to mint refresh token:', refreshErr.message);
      }
    }

    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: 'Token expired'
      });
    }
    
    return res.status(403).json({
      success: false,
      error: 'Invalid token'
    });
  }
};

/**
 * Optional authentication - doesn't fail if no token provided
 */
const optionalAuth = (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    
    if (authHeader) {
      const token = authHeader.startsWith('Bearer ') 
        ? authHeader.substring(7) 
        : authHeader;

      const jwtSecret = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
      const decoded = jwt.verify(token, jwtSecret);
      req.user = decoded;
    }
    
    next();
  } catch (error) {
    // Continue without user info
    next();
  }
};

module.exports = {
  authenticateUser,
  optionalAuth
};
