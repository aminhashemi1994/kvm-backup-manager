const jwt = require('jsonwebtoken');
const axios = require('axios');

const AGENT_JWT_SECRET = process.env.AGENT_JWT_SECRET || 'agent-secret-key-change-in-production';

/**
 * Generate JWT token for agent communication
 */
function generateAgentToken(agentId, agentName) {
  return jwt.sign(
    { 
      agentId, 
      agentName,
      type: 'agent'
    },
    AGENT_JWT_SECRET,
    { expiresIn: '7d' } // Agents get 7-day tokens
  );
}

/**
 * Create axios instance with agent JWT token
 */
function createAuthenticatedAxios(agentUrl, agentId, agentName) {
  const token = generateAgentToken(agentId, agentName);
  
  return axios.create({
    baseURL: agentUrl,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });
}

/**
 * Make authenticated request to agent
 */
async function makeAgentRequest(agentUrl, agentId, agentName, method, endpoint, data = null, options = {}) {
  const token = generateAgentToken(agentId, agentName);
  
  const config = {
    method,
    url: `${agentUrl}${endpoint}`,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers
    },
    ...options
  };
  
  if (data) {
    config.data = data;
  }
  
  return axios(config);
}

module.exports = {
  generateAgentToken,
  createAuthenticatedAxios,
  makeAgentRequest
};
