const jwt = require('jsonwebtoken');

/**
 * Verify a controller-signed agent token ("Bearer <jwt>" or bare JWT).
 * Returns the decoded payload, or null when missing/invalid.
 */
function verifyAgentToken(header) {
  if (!header || typeof header !== 'string') return null;
  const token = header.startsWith('Bearer ') ? header.substring(7) : header;
  try {
    const decoded = jwt.verify(token, process.env.AGENT_JWT_SECRET);
    return decoded.type === 'agent' ? decoded : null;
  } catch (error) {
    return null;
  }
}

/**
 * JWT authentication middleware for agent (controller -> agent communication).
 * AGENT_JWT_SECRET is required at startup (utils/requireSecrets.js), so there
 * is no unauthenticated mode.
 */
const authMiddleware = (req, res, next) => {
  const authHeader = req.headers['authorization'] || req.headers['x-agent-token'];

  if (!authHeader) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required - no token provided',
    });
  }

  const decoded = verifyAgentToken(authHeader);
  if (!decoded) {
    return res.status(403).json({
      success: false,
      error: 'Invalid authentication token',
    });
  }

  req.agent = decoded;
  next();
};

module.exports = authMiddleware;
module.exports.verifyAgentToken = verifyAgentToken;
