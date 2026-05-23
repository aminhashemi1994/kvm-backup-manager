/**
 * Helper utilities for agent
 */

/**
 * Format bytes to human-readable
 */
const formatBytes = (bytes, decimals = 2) => {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};

/**
 * Format duration
 */
const formatDuration = (startTime, endTime) => {
  const start = new Date(startTime);
  const end = endTime ? new Date(endTime) : new Date();
  const diff = Math.floor((end - start) / 1000);

  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ${diff % 60}s`;
  return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`;
};

/**
 * Sleep helper
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Generate timestamp string
 */
const timestamp = () => new Date().toISOString();

/**
 * Safe JSON parse
 */
const safeJsonParse = (str, fallback = null) => {
  try {
    return JSON.parse(str);
  } catch (e) {
    return fallback;
  }
};

module.exports = {
  formatBytes,
  formatDuration,
  sleep,
  timestamp,
  safeJsonParse,
};
