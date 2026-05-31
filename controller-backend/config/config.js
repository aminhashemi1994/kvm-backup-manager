require('dotenv').config();
const path = require('path');

const config = {
  // Server
  port: parseInt(process.env.PORT) || 3000,
  host: process.env.SERVICE_IP || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',
  
  // Frontend - Always allow all origins for CORS
  frontendUrl: '*',
  
  // Paths
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  
  // Data file paths
  get agentsFile() {
    return path.join(this.dataDir, 'agents.json');
  },
  get backupHostsFile() {
    return path.join(this.dataDir, 'backup-hosts.json');
  },
  get hypervisorsFile() {
    return path.join(this.dataDir, 'hypervisors.json');
  },
  get virtualMachinesFile() {
    return path.join(this.dataDir, 'virtual-machines.json');
  },
  get backupSchedulesFile() {
    return path.join(this.dataDir, 'backup-schedules.json');
  },
  get backupJobsFile() {
    return path.join(this.dataDir, 'backup-jobs.json');
  },
  get logsDir() {
    return path.join(this.dataDir, 'logs');
  },
  get sshKeysDir() {
    return path.join(this.dataDir, 'ssh-keys');
  },
  
  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',
  
  // Agent Configuration
  agentRequestTimeout: parseInt(process.env.AGENT_REQUEST_TIMEOUT) || 300000, // 5 minutes
  agentHealthCheckInterval: parseInt(process.env.AGENT_HEALTH_CHECK_INTERVAL) || 60000, // 1 minute
  
  // Backup
  maxConcurrentBackups: parseInt(process.env.MAX_CONCURRENT_BACKUPS) || 15,
  defaultCompressionLevel: 2,
  
  // Log rotation
  maxLogAge: 30, // days
  maxLogSize: 100 * 1024 * 1024, // 100MB
  
  // Rocket.Chat Integration
  rocketChat: {
    enabled: process.env.ROCKETCHAT_ENABLED === 'true',
    webhookUrl: process.env.ROCKETCHAT_WEBHOOK_URL,
    url: process.env.ROCKETCHAT_URL,
    authToken: process.env.ROCKETCHAT_AUTH_TOKEN,
    userId: process.env.ROCKETCHAT_USER_ID,
    channel: process.env.ROCKETCHAT_CHANNEL || 'backup-notifications',
  },
  
  // SSL/TLS Configuration
  ssl: {
    enabled: process.env.SSL_ENABLED === 'true',
    cert: process.env.SSL_CERT_PATH,
    key: process.env.SSL_KEY_PATH,
  },
};

module.exports = config;
