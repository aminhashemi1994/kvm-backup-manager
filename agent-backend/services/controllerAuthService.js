const axios = require('axios');

/**
 * Simple helper to make authenticated calls from agent to controller
 * Uses pre-configured AGENT_JWT_TOKEN from .env
 */

/**
 * Make an authenticated GET request to controller
 */
async function get(controllerUrl, endpoint, config = {}) {
  const token = process.env.AGENT_JWT_TOKEN;
  
  if (!token) {
    throw new Error('AGENT_JWT_TOKEN not configured in .env');
  }
  
  return axios.get(`${controllerUrl}${endpoint}`, {
    ...config,
    headers: {
      ...config.headers,
      'Authorization': `Bearer ${token}`
    }
  });
}

/**
 * Make an authenticated POST request to controller
 */
async function post(controllerUrl, endpoint, data, config = {}) {
  const token = process.env.AGENT_JWT_TOKEN;
  
  if (!token) {
    throw new Error('AGENT_JWT_TOKEN not configured in .env');
  }
  
  return axios.post(`${controllerUrl}${endpoint}`, data, {
    ...config,
    headers: {
      ...config.headers,
      'Authorization': `Bearer ${token}`
    }
  });
}

module.exports = {
  get,
  post
};
