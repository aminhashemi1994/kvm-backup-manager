require('dotenv').config();
const path = require('path');
const fs = require('fs');

// Storage pools are now managed dynamically via API
// backupPath and restorePath are kept as fallbacks only for backward compatibility
const config = {
  // Server
  port: parseInt(process.env.PORT) || 3001,
  host: process.env.SERVICE_IP || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',
  
  // Controller
  controllerUrl: process.env.CONTROLLER_URL || null,
  
  // Authentication
  agentSecret: process.env.AGENT_SECRET || null,
  
  // Paths - Storage pools are now managed dynamically via API
  // NO DEFAULT PATHS - must be configured via storage pools
  backupPath: process.env.BACKUP_PATH || null,
  restorePath: process.env.RESTORE_PATH || null,
  logDir: path.resolve(process.env.LOG_DIR || './logs'),
  
  // SSH Configuration
  sshTimeout: parseInt(process.env.SSH_TIMEOUT) || 30000,
  sshReadyTimeout: parseInt(process.env.SSH_READY_TIMEOUT) || 20000,
  
  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',
  
  // Backup
  // maxConcurrentBackups is no longer set via env var. The agent pulls it
  // from the controller (per backup host) on a 60-second sync loop and
  // caches it locally — see concurrencyConfigSyncService. Use that
  // service's getMaxConcurrent() at the call site instead of reading
  // config.maxConcurrentBackups.
  defaultCompressionLevel: 2,
};

module.exports = config;
