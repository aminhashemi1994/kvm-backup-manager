const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { io: ioClient } = require('socket.io-client');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const config = require('./config/config');
const errorHandler = require('./middleware/errorHandler');

// Import routes
const healthRoutes = require('./routes/health');
const hypervisorsRoutes = require('./routes/hypervisors');
const backupRoutes = require('./routes/backup');
const directoriesRoutes = require('./routes/directories');
const offsiteRoutes = require('./routes/offsite');
const retentionRoutes = require('./routes/retention');
const initRoutes = require('./routes/init');
const reportRoutes = require('./routes/report');
const metricsRoutes = require('./routes/metrics');
const fixBackupRoutes = require('./routes/fixBackup');
const cleanupBackupRoutes = require('./routes/cleanupBackup');
const backupStatusRoutes = require('./routes/backupStatus');
const backupRemovalRoutes = require('./routes/backupRemoval');
const remoteMetricsRoutes = require('./routes/remoteMetrics');
const storagePoolsRoutes = require('./routes/storagePools');
const restoreStoragePoolsRoutes = require('./routes/restoreStoragePools');
const restoreRoutes = require('./routes/restore');
const storagePoolSyncRoutes = require('./routes/storagePoolSync');
const concurrencyConfigSyncRoutes = require('./routes/concurrencyConfigSync');
const scheduleValidationRoutes = require('./routes/scheduleValidation');
const liveStatusRoutes = require('./routes/liveStatus');

// Import services
const backupExecutor = require('./services/backupExecutor');
const restoreExecutor = require('./services/restoreExecutor');
const initHostService = require('./services/initHostService');
const reportService = require('./services/reportService');
const metricsService = require('./services/metricsService');
const storagePoolSyncService = require('./services/storagePoolSyncService');
const concurrencyConfigSyncService = require('./services/concurrencyConfigSyncService');
const liveStatusService = require('./services/liveStatusService');
const cleanupService = require('./services/cleanupService');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Ensure logs directory exists
if (!fs.existsSync(config.logDir)) {
  fs.mkdirSync(config.logDir, { recursive: true });
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(morgan('dev'));

app.set('io', io);
app.set('config', config);
app.set('hypervisors', new Map());

// Initialize backup executor
backupExecutor.initialize(io, config);

// Initialize restore executor
restoreExecutor.setSocketIO(io);
restoreExecutor.setConfig(config);

// Initialize init host service
initHostService.initialize(io, config);

// Initialize report service
reportService.initialize(config);

// Initialize metrics service (async)
metricsService.initialize(config).catch(err => {
  console.error('Failed to initialize metrics service:', err);
});

// Initialize storage pool sync service
storagePoolSyncService.initialize(config);

// Initialize concurrency config sync service. Pulls maxConcurrentBackups
// from the controller every 60s and exposes it to backupExecutor — so the
// concurrency cap is centrally managed in the panel, not via the agent's
// .env file.
concurrencyConfigSyncService.initialize(config);

// Initialize live status service (Item 2)
liveStatusService.initialize({ config, backupExecutor, restoreExecutor });
console.log('✓ Live status service initialized');

// Initialize cleanup service (Item 3 — runs on startup + periodic + lazy)
cleanupService.initialize({ config, backupExecutor });

// Routes
app.use('/api/health', healthRoutes);
app.use('/api/hypervisors', hypervisorsRoutes);
app.use('/api/backup', backupRoutes);
app.use('/api/directories', directoriesRoutes);
app.use('/api/offsite', offsiteRoutes);
app.use('/api/retention', retentionRoutes);
app.use('/api/init', initRoutes);
app.use('/api/report', reportRoutes);
app.use('/api/metrics', metricsRoutes);
app.use('/api/fix-backup', fixBackupRoutes);
app.use('/api/cleanup-backup', cleanupBackupRoutes);
app.use('/api/backup-status', backupStatusRoutes);
app.use('/api/backup-removal', backupRemovalRoutes);
app.use('/api/remote-metrics', remoteMetricsRoutes);
app.use('/api/storage-pools', storagePoolsRoutes);
app.use('/api/restore-storage-pools', restoreStoragePoolsRoutes);
app.use('/api/restore', restoreRoutes);
app.use('/api/storage-pool-sync', storagePoolSyncRoutes);
app.use('/api/concurrency-config', concurrencyConfigSyncRoutes);
app.use('/api/schedule-validation', scheduleValidationRoutes);
app.use('/api/jobs', liveStatusRoutes);
app.use('/api/cleanup', require('./routes/cleanup'));

// Error handler
app.use(errorHandler);

// Socket.io connection
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });

  socket.on('subscribe-job', (jobId) => {
    socket.join(`job-${jobId}`);
  });

  socket.on('subscribe-init', (initId) => {
    socket.join(`init-${initId}`);
  });
});

// Connect to controller (optional)
let controllerSocket = null;
if (config.controllerUrl) {
  controllerSocket = ioClient(config.controllerUrl, {
    reconnection: true,
    reconnectionDelay: 5000,
  });

  controllerSocket.on('connect', () => {
    console.log('Connected to controller');
  });

  controllerSocket.on('disconnect', () => {
    console.log('Disconnected from controller');
  });

  app.set('controllerSocket', controllerSocket);
}

// Start server
server.listen(config.port, config.host, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║        KVM Backup Manager - Agent Backend                 ║
╠════════════════════════════════════════════════════════════╣
║  Status: Running                                           ║
║  Host: ${config.host.padEnd(50)}║
║  Port: ${config.port.toString().padEnd(50)}║
║  Controller: ${(config.controllerUrl || 'Not configured').padEnd(44)}║
║  Storage Pools: Managed dynamically via controller         ║
╚════════════════════════════════════════════════════════════╝
  `);
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  if (controllerSocket) controllerSocket.disconnect();
  reportService.shutdown();
  backupExecutor.shutdown();
  cleanupService.shutdown();
  storagePoolSyncService.shutdown?.();
  concurrencyConfigSyncService.shutdown();
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully...');
  if (controllerSocket) controllerSocket.disconnect();
  reportService.shutdown();
  backupExecutor.shutdown();
  cleanupService.shutdown();
  storagePoolSyncService.shutdown?.();
  concurrencyConfigSyncService.shutdown();
  server.close(() => process.exit(0));
});

module.exports = { app, server, io };
