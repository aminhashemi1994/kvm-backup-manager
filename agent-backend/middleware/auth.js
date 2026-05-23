const config = require('../config/config');

/**
 * JWT authentication middleware for agent (controller -> agent communication)
 */
const authMiddleware = (req, res, next) => {
  // If no JWT secret is configured, skip authentication
  const jwtSecret = process.env.AGENT_JWT_SECRET;
  
  if (!jwtSecret) {
    console.warn('[Auth] AGENT_JWT_SECRET not configured - authentication disabled');
    return next();
  }

  const authHeader = req.headers['authorization'] || req.headers['x-agent-token'];
  
  if (!authHeader) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required - no token provided',
    });
  }

  const token = authHeader.startsWith('Bearer ') 
    ? authHeader.substring(7) 
    : authHeader;
  
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, jwtSecret);
    
    // Verify this is an agent token
    if (decoded.type !== 'agent') {
      return res.status(403).json({
        success: false,
        error: 'Invalid token type',
      });
    }
    
    req.agent = decoded;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: 'Token expired',
      });
    }
    
    return res.status(403).json({
      success: false,
      error: 'Invalid authentication token',
    });
  }
};

module.exports = authMiddleware;
