const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const { Server } = require('socket.io');
const cors = require('cors');
const morgan = require('morgan');
require('dotenv').config();

const config = require('./config/config');
const errorHandler = require('./middleware/errorHandler');

// Import routes
const authRoutes = require('./routes/auth');
const backupHostsRoutes = require('./routes/backupHosts');
const hypervisorsRoutes = require('./routes/hypervisors');
const vmsRoutes = require('./routes/vms');
const schedulesRoutes = require('./routes/schedules');
const backupsRoutes = require('./routes/backups');
const offsiteHostsRoutes = require('./routes/offsiteHosts');
const backupCycleRoutes = require('./routes/backupCycle');
const initRoutes = require('./routes/init');
const reportsRoutes = require('./routes/reports');
const reportDownloadRoutes = require('./routes/reportDownload');
const metricsRoutes = require('./routes/metrics');
const fixBackupRoutes = require('./routes/fixBackup');
const backupRemovalRoutes = require('./routes/backupRemoval');
const storagePoolsRoutes = require('./routes/storagePools');
const restoreStoragePoolsRoutes = require('./routes/restoreStoragePools');
const restoreRoutes = require('./routes/restore');
const healthCheckRoutes = require('./routes/healthCheck');
const usersRoutes = require('./routes/users');
const auditRoutes = require('./routes/audit');

// Import services
const schedulerService = require('./services/schedulerService');
const monitoringService = require('./services/monitoringService');
const remoteMetricsService = require('./services/remoteMetricsService');
const healthCheckService = require('./services/healthCheckService');
const storagePoolRefreshService = require('./services/storagePoolRefreshService');
const restoreStoragePoolRefreshService = require('./services/restoreStoragePoolRefreshService');
const startupRecoveryService = require('./services/startupRecoveryService');
const heartbeatService = require('./services/heartbeatService');
const missedRunService = require('./services/missedRunService');
const agentSyncService = require('./services/agentSyncService');
const reportEnrichmentService = require('./services/reportEnrichmentService');
const auditService = require('./services/auditService');
const { initializeDataFiles } = require('./services/fileStorage');
const authService = require('./services/authService');

const app = express();

// Create server (HTTP or HTTPS based on SSL configuration)
let server;
let protocol = 'http';

if (config.ssl && config.ssl.enabled && config.ssl.cert && config.ssl.key) {
  try {
    const sslOptions = {
      cert: fs.readFileSync(config.ssl.cert),
      key: fs.readFileSync(config.ssl.key)
    };
    server = https.createServer(sslOptions, app);
    protocol = 'https';
    console.log('✓ SSL/TLS enabled - Server will use HTTPS and WSS');
  } catch (error) {
    console.error('✗ Failed to load SSL certificates:', error.message);
    console.log('  Falling back to HTTP');
    server = http.createServer(app);
  }
} else {
  server = http.createServer(app);
  console.log('✓ SSL/TLS disabled - Server will use HTTP and WS');
}

const io = new Server(server, {
  cors: {
    origin: config.frontendUrl,
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  }
});

// Middleware
app.use(cors({
  origin: config.frontendUrl,
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(morgan('dev'));

app.set('io', io);

// Initialize data files
initializeDataFiles();

// Initialize auth service (create default user if needed)
authService.ensureUsersFile().then(() => {
  console.log('✓ Auth service initialized');
}).catch(err => {
  console.error('Failed to initialize auth service:', err);
});

// Routes
app.use('/api/auth', authRoutes); // Authentication routes (no auth required)

// Apply authentication middleware to protected routes
const { authenticateUser } = require('./middleware/auth');
app.use('/api/backup-hosts', authenticateUser, backupHostsRoutes);
app.use('/api/hypervisors', authenticateUser, hypervisorsRoutes);
app.use('/api/vms', authenticateUser, vmsRoutes);
app.use('/api/schedules', authenticateUser, schedulesRoutes);
app.use('/api/backups', authenticateUser, backupsRoutes);
app.use('/api/offsite-hosts', authenticateUser, offsiteHostsRoutes);
app.use('/api/backup-cycle', authenticateUser, backupCycleRoutes);
app.use('/api/init', authenticateUser, initRoutes);
app.use('/api/reports', authenticateUser, reportsRoutes);
app.use('/api/reports', authenticateUser, reportDownloadRoutes);
app.use('/api/metrics', authenticateUser, metricsRoutes);
app.use('/api/fix-backup', authenticateUser, fixBackupRoutes);
app.use('/api/backup-removal', authenticateUser, backupRemovalRoutes);
app.use('/api/storage-pools', authenticateUser, storagePoolsRoutes);
app.use('/api/restore-storage-pools', authenticateUser, restoreStoragePoolsRoutes);
app.use('/api/restore', authenticateUser, restoreRoutes);
app.use('/api/health-check', authenticateUser, healthCheckRoutes);
app.use('/api/users', authenticateUser, usersRoutes);
app.use('/api/audit', authenticateUser, auditRoutes);
app.use('/api/cleanup', authenticateUser, require('./routes/cleanup'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'controller', timestamp: new Date().toISOString() });
});

// Error handler
app.use(errorHandler);

// Socket.io
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });

  socket.on('subscribe-job', (jobId) => {
    socket.join(`job-${jobId}`);
  });

  socket.on('unsubscribe-job', (jobId) => {
    socket.leave(`job-${jobId}`);
  });

  socket.on('subscribe-init', (initId) => {
    socket.join(`init-${initId}`);
  });

  socket.on('unsubscribe-init', (initId) => {
    socket.leave(`init-${initId}`);
  });
});

// Start scheduler
schedulerService.initialize(io);

// Start heartbeat service (reads previous heartbeat for missed-run recovery)
let bootSnapshot = null;
(async () => {
  try {
    bootSnapshot = await heartbeatService.readBootSnapshot();
    heartbeatService.start();
    console.log('✓ Heartbeat service started');
  } catch (err) {
    console.error('[Heartbeat] Failed to start:', err.message);
  }
})();

// Initialize missed-run service
missedRunService.initialize(io, schedulerService);

// Initialize agent sync service (Item 2)
agentSyncService.initialize(io);

// Initialize report enrichment service (Item 7)
reportEnrichmentService.initialize().catch(err => {
  console.error('[ReportEnrich] Failed to initialize:', err.message);
});

// Initialize audit service (Item 9)
auditService.initialize().catch(err => {
  console.error('[Audit] Failed to initialize:', err.message);
});

// Start monitoring service
monitoringService.initialize();

// Start remote metrics collection
remoteMetricsService.initialize();

// Start health check service
healthCheckService.initialize();

// Start storage pool refresh service
storagePoolRefreshService.initialize();

// Start restore storage pool refresh service
restoreStoragePoolRefreshService.initialize();

// Recover job states on startup (after health check has run)
setTimeout(async () => {
  try {
    await startupRecoveryService.recoverJobStates();
  } catch (err) {
    console.error('[Startup] Job recovery failed:', err);
  }

  // After recovery, replay missed schedules from downtime window
  try {
    const result = await missedRunService.runRecovery(bootSnapshot);
    if (result && (result.replayed || result.skippedByPolicy || result.skippedTooOld)) {
      console.log(`[Startup] Missed-run recovery: ${JSON.stringify(result)}`);
    }
  } catch (err) {
    console.error('[Startup] Missed-run recovery failed:', err);
  }

  // Item 2: Reconcile running jobs with agents' live-status
  try {
    const syncResult = await agentSyncService.syncAll();
    if (syncResult.synced > 0 || syncResult.finalized > 0) {
      console.log(`[Startup] Agent sync: synced=${syncResult.synced}, finalized=${syncResult.finalized}, errors=${syncResult.errors}`);
    }
  } catch (err) {
    console.error('[Startup] Agent sync failed:', err);
  }
}, 10000); // Wait 10 seconds for health checks to complete

// Start server
server.listen(config.port, config.host, () => {
  const wsProtocol = protocol === 'https' ? 'wss' : 'ws';
  console.log(`
╔════════════════════════════════════════════════════════════╗
║      KVM Backup Manager - Controller Backend              ║
╠════════════════════════════════════════════════════════════╣
║  Status: Running                                           ║
║  Protocol: ${protocol.toUpperCase().padEnd(48)}║
║  Host: ${config.host.padEnd(50)}║
║  Port: ${config.port.toString().padEnd(50)}║
║  URL: ${protocol}://${config.host}:${config.port}${' '.repeat(Math.max(0, 32 - config.host.length - config.port.toString().length))}║
║  WebSocket: ${wsProtocol}://${config.host}:${config.port}${' '.repeat(Math.max(0, 27 - config.host.length - config.port.toString().length))}║
╚════════════════════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  server.close(() => {
    heartbeatService.stop();
    schedulerService.shutdown();
    monitoringService.shutdown();
    remoteMetricsService.shutdown();
    healthCheckService.shutdown();
    storagePoolRefreshService.shutdown();
    restoreStoragePoolRefreshService.shutdown();
    reportEnrichmentService.shutdown();
    auditService.shutdown();
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  server.close(() => {
    heartbeatService.stop();
    schedulerService.shutdown();
    monitoringService.shutdown();
    remoteMetricsService.shutdown();
    healthCheckService.shutdown();
    storagePoolRefreshService.shutdown();
    restoreStoragePoolRefreshService.shutdown();
    reportEnrichmentService.shutdown();
    auditService.shutdown();
    process.exit(0);
  });
});

module.exports = { app, server, io };
