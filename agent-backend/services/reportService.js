const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

class ReportService {
  constructor() {
    this.config = null;
    this.reportFile = null;
    this.isGenerating = false;
    this.lastGenerated = null;
    this.lastManualRequest = null; // Track last manual request time
    this.generationInterval = null;
    this.INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
    this.RATE_LIMIT_MS = 2 * 60 * 1000; // 2 minutes rate limit for manual requests
  }

  initialize(config) {
    this.config = config;
    this.reportFile = path.join(config.logDir, 'backup_report.json');
    
    console.log('✓ Report service initialized');
    console.log(`  Report file: ${this.reportFile}`);
    console.log(`  Update interval: ${this.INTERVAL_MS / 60000} minutes`);

    // Generate initial report
    this.generateReport().catch(err => {
      console.error('[Report] Initial generation failed:', err);
    });

    // Schedule periodic generation
    this.generationInterval = setInterval(() => {
      console.log('[Report] Auto-generation triggered (scheduled)');
      this.generateReport().catch(err => {
        console.error('[Report] Scheduled generation failed:', err);
      });
    }, this.INTERVAL_MS);
    
    console.log(`  Next auto-generation in ${this.INTERVAL_MS / 60000} minutes`);
  }

  /**
   * Generate backup report by running Backup_Reporter.sh
   * @param {boolean} isManual - Whether this is a manual request
   */
  async generateReport(isManual = false) {
    // Check rate limit for manual requests BEFORE setting isGenerating
    if (isManual) {
      const now = Date.now();
      if (this.lastManualRequest) {
        const timeSinceLastRequest = now - this.lastManualRequest;
        if (timeSinceLastRequest < this.RATE_LIMIT_MS) {
          const remainingSeconds = Math.ceil((this.RATE_LIMIT_MS - timeSinceLastRequest) / 1000);
          console.log(`[Report] Rate limit: ${remainingSeconds}s remaining`);
          return { 
            success: false, 
            rateLimited: true,
            message: `Please wait ${remainingSeconds} seconds before requesting another report`,
            remainingSeconds,
            nextAllowedAt: new Date(this.lastManualRequest + this.RATE_LIMIT_MS).toISOString()
          };
        }
      }
      this.lastManualRequest = now;
    }

    if (this.isGenerating) {
      console.log('[Report] Already generating, skipping...');
      return { success: false, message: 'Report generation already in progress', isGenerating: true };
    }

    this.isGenerating = true;
    const startTime = Date.now();
    console.log('[Report] Starting report generation...');

    const scriptPath = path.join(__dirname, '../scripts/Backup_Reporter.sh');

    return new Promise(async (resolve) => {
      // Check if script exists
      if (!fs.existsSync(scriptPath)) {
        console.error(`[Report] Script not found: ${scriptPath}`);
        this.isGenerating = false;
        resolve({ success: false, error: 'Script not found' });
        return;
      }

      // Get storage pools from controller
      let storagePools = [];
      try {
        const axios = require('axios');
        const controllerAuthService = require('../services/controllerAuthService');
        const storagePoolSyncService = require('../services/storagePoolSyncService');
        
        // Try to get from sync service first (cached)
        storagePools = storagePoolSyncService.getStoragePools();
        console.log(`[Report] Got ${storagePools.length} storage pools from sync service`);
        
        if (storagePools.length > 0) {
          console.log('[Report] Storage pool paths:', storagePools.map(p => p.path).join(', '));
        }
        
        if (storagePools.length === 0) {
          console.log('[Report] No cached storage pools, fetching from controller...');
          const controllerUrl = this.config.controllerUrl;
          const backupHostId = storagePoolSyncService.getBackupHostId();
          
          console.log(`[Report] Backup Host ID: ${backupHostId}`);
          
          if (controllerUrl && backupHostId) {
            const endpoint = `/storage-pools/backup-host/${backupHostId}`;
            console.log(`[Report] Fetching from: ${controllerUrl}${endpoint}`);
            const response = await controllerAuthService.get(controllerUrl, endpoint, { timeout: 5000 });
            if (response.data.success) {
              storagePools = response.data.data;
              console.log(`[Report] Fetched ${storagePools.length} storage pools from controller`);
              console.log('[Report] Storage pool paths:', storagePools.map(p => p.path).join(', '));
            }
          }
        }
      } catch (error) {
        console.error('[Report] Failed to fetch storage pools from controller:', error.message);
        // Fall back to config backup path if available
        if (this.config.backupPath) {
          storagePools = [{ path: this.config.backupPath, name: 'Default' }];
        }
      }

      // If no storage pools found, use config backup path as fallback
      if (storagePools.length === 0) {
        if (this.config.backupPath) {
          storagePools = [{ path: this.config.backupPath, name: 'Default' }];
          console.log('[Report] No storage pools found, using config backup path');
        } else {
          console.error('[Report] No storage pools configured');
          this.isGenerating = false;
          resolve({ success: false, error: 'No storage pools configured' });
          return;
        }
      }

      // Build comma-separated paths
      const backupPaths = storagePools.map(p => p.path).join(',');
      console.log(`[Report] Scanning storage pools: ${backupPaths}`);

      const tempFile = `${this.reportFile}.tmp`;
      const writeStream = fs.createWriteStream(tempFile, { flags: 'w' });

      const reportProcess = spawn('bash', [scriptPath, '--backup-paths', backupPaths], {
        env: { ...process.env },
        cwd: path.dirname(scriptPath),
      });

      let hasError = false;
      let errorOutput = '';

      // Capture stdout to file
      reportProcess.stdout.on('data', (data) => {
        writeStream.write(data);
      });

      // Capture stderr for errors
      reportProcess.stderr.on('data', (data) => {
        hasError = true;
        errorOutput += data.toString();
        console.error('[Report] stderr:', data.toString());
      });

      // Handle process completion
      reportProcess.on('close', (code) => {
        writeStream.end();

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`[Report] Process completed in ${duration}s with code: ${code}`);

        if (code === 0 && !hasError) {
          // Move temp file to final location
          try {
            fs.renameSync(tempFile, this.reportFile);
            this.lastGenerated = new Date().toISOString();
            console.log(`[Report] ✓ Report generated successfully`);
            
            // Get file size
            const stats = fs.statSync(this.reportFile);
            const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
            console.log(`[Report]   File size: ${sizeMB} MB`);
            
            this.isGenerating = false;
            resolve({ 
              success: true, 
              generatedAt: this.lastGenerated,
              fileSizeBytes: stats.size,
              durationSeconds: parseFloat(duration)
            });
          } catch (error) {
            console.error('[Report] Failed to save report:', error.message);
            this.isGenerating = false;
            resolve({ success: false, error: error.message });
          }
        } else {
          console.error(`[Report] ✗ Report generation failed`);
          if (errorOutput) {
            console.error(`[Report] Error: ${errorOutput}`);
          }
          // Clean up temp file
          try {
            fs.unlinkSync(tempFile);
          } catch (e) {
            // Ignore
          }
          this.isGenerating = false;
          resolve({ 
            success: false, 
            error: errorOutput || `Process exited with code ${code}` 
          });
        }
      });

      // Handle process errors
      reportProcess.on('error', (error) => {
        console.error('[Report] Process error:', error.message);
        writeStream.end();
        try {
          fs.unlinkSync(tempFile);
        } catch (e) {
          // Ignore
        }
        this.isGenerating = false;
        resolve({ success: false, error: error.message });
      });
    });
  }

  /**
   * Get the current report
   */
  async getReport() {
    if (!fs.existsSync(this.reportFile)) {
      return {
        success: false,
        error: 'Report not yet generated',
        isGenerating: this.isGenerating
      };
    }

    try {
      const data = fs.readFileSync(this.reportFile, 'utf8');
      const report = JSON.parse(data);
      
      return {
        success: true,
        data: report,
        lastGenerated: this.lastGenerated,
        isGenerating: this.isGenerating
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to read report: ${error.message}`,
        isGenerating: this.isGenerating
      };
    }
  }

  /**
   * Get report status
   */
  getStatus() {
    const exists = fs.existsSync(this.reportFile);
    let fileSize = 0;
    
    if (exists) {
      try {
        const stats = fs.statSync(this.reportFile);
        fileSize = stats.size;
      } catch (e) {
        // Ignore
      }
    }

    // Calculate rate limit info
    let canRequestNow = true;
    let rateLimitRemainingSeconds = 0;
    let nextAllowedAt = null;

    if (this.lastManualRequest) {
      const timeSinceLastRequest = Date.now() - this.lastManualRequest;
      if (timeSinceLastRequest < this.RATE_LIMIT_MS) {
        canRequestNow = false;
        rateLimitRemainingSeconds = Math.ceil((this.RATE_LIMIT_MS - timeSinceLastRequest) / 1000);
        nextAllowedAt = new Date(this.lastManualRequest + this.RATE_LIMIT_MS).toISOString();
      }
    }

    return {
      exists,
      isGenerating: this.isGenerating,
      lastGenerated: this.lastGenerated,
      fileSizeBytes: fileSize,
      nextGenerationIn: this.lastGenerated 
        ? Math.max(0, this.INTERVAL_MS - (Date.now() - new Date(this.lastGenerated).getTime()))
        : 0,
      rateLimit: {
        canRequestNow,
        remainingSeconds: rateLimitRemainingSeconds,
        nextAllowedAt,
        limitSeconds: this.RATE_LIMIT_MS / 1000
      }
    };
  }

  /**
   * Shutdown service
   */
  shutdown() {
    if (this.generationInterval) {
      clearInterval(this.generationInterval);
      this.generationInterval = null;
    }
    console.log('✓ Report service shutdown');
  }
}

// Export singleton instance
const reportService = new ReportService();
module.exports = reportService;
