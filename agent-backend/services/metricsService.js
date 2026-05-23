const { exec } = require('child_process');
const { promisify } = require('util');
const os = require('os');
const path = require('path');
const fs = require('fs');

const execAsync = promisify(exec);

class MetricsService {
  constructor() {
    this.cachedMetrics = null;
    this.lastUpdate = null;
    this.CACHE_DURATION = 2000; // 2 seconds cache (reduced from 5 seconds for more real-time updates)
    this.config = null;
    this.backupPath = null;
  }

  async initialize(config) {
    this.config = config;
    
    // Use config backup path as fallback
    // Storage pools are now managed dynamically via API
    this.backupPath = config.backupPath;
    
    console.log('✓ Metrics service initialized');
    console.log(`  Backup path (fallback): ${this.backupPath}`);
  }

  /**
   * Get all system metrics
   */
  async getMetrics() {
    // Return cached metrics if still fresh
    if (this.cachedMetrics && this.lastUpdate && (Date.now() - this.lastUpdate < this.CACHE_DURATION)) {
      return this.cachedMetrics;
    }

    const [cpu, memory, disks, backupDisk] = await Promise.all([
      this.getCPUUsage(),
      this.getMemoryUsage(),
      this.getDiskUsage(),
      this.getBackupPathUsage()
    ]);

    this.cachedMetrics = {
      timestamp: new Date().toISOString(),
      hostname: os.hostname(),
      cpu,
      memory,
      disks,
      backupDisk
    };
    this.lastUpdate = Date.now();

    return this.cachedMetrics;
  }

  /**
   * Get CPU usage percentage
   */
  async getCPUUsage() {
    try {
      // Get CPU usage using top command
      const { stdout } = await execAsync("top -bn1 | grep 'Cpu(s)' | sed 's/.*, *\\([0-9.]*\\)%* id.*/\\1/' | awk '{print 100 - $1}'");
      const usage = parseFloat(stdout.trim()) || 0;

      return {
        usage: Math.min(100, Math.max(0, usage)),
        cores: os.cpus().length,
        model: os.cpus()[0]?.model || 'Unknown'
      };
    } catch (error) {
      console.error('Error getting CPU usage:', error);
      return {
        usage: 0,
        cores: os.cpus().length,
        model: os.cpus()[0]?.model || 'Unknown',
        error: error.message
      };
    }
  }

  /**
   * Get memory usage
   */
  async getMemoryUsage() {
    try {
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const usage = (usedMem / totalMem) * 100;

      return {
        total: totalMem,
        used: usedMem,
        free: freeMem,
        usage: Math.min(100, Math.max(0, usage)),
        totalGB: (totalMem / (1024 ** 3)).toFixed(2),
        usedGB: (usedMem / (1024 ** 3)).toFixed(2),
        freeGB: (freeMem / (1024 ** 3)).toFixed(2)
      };
    } catch (error) {
      console.error('Error getting memory usage:', error);
      return {
        total: 0,
        used: 0,
        free: 0,
        usage: 0,
        error: error.message
      };
    }
  }

  /**
   * Get disk usage for all mount points
   */
  async getDiskUsage() {
    try {
      // Use df command to get disk usage
      const { stdout } = await execAsync("df -BG | grep -E '^/dev/' | awk '{print $1,$2,$3,$4,$5,$6}'");
      
      const lines = stdout.trim().split('\n');
      const disks = [];

      for (const line of lines) {
        const parts = line.split(/\s+/);
        if (parts.length >= 6) {
          const device = parts[0];
          const total = parseInt(parts[1].replace('G', '')) || 0;
          const used = parseInt(parts[2].replace('G', '')) || 0;
          const available = parseInt(parts[3].replace('G', '')) || 0;
          const usagePercent = parseInt(parts[4].replace('%', '')) || 0;
          const mountPoint = parts[5];

          disks.push({
            device,
            mountPoint,
            total,
            used,
            available,
            usage: Math.min(100, Math.max(0, usagePercent)),
            totalGB: total,
            usedGB: used,
            availableGB: available
          });
        }
      }

      return disks;
    } catch (error) {
      console.error('Error getting disk usage:', error);
      return [{
        device: 'unknown',
        mountPoint: '/',
        total: 0,
        used: 0,
        available: 0,
        usage: 0,
        error: error.message
      }];
    }
  }

  /**
   * Get backup path disk usage
   */
  async getBackupPathUsage() {
    if (!this.backupPath) {
      return null;
    }

    try {
      const { stdout } = await execAsync(`df -BG "${this.backupPath}" | tail -1 | awk '{print $1,$2,$3,$4,$5,$6}'`);
      const parts = stdout.trim().split(/\s+/);
      
      if (parts.length >= 6) {
        const device = parts[0];
        const total = parseInt(parts[1].replace('G', '')) || 0;
        const used = parseInt(parts[2].replace('G', '')) || 0;
        const available = parseInt(parts[3].replace('G', '')) || 0;
        const usagePercent = parseInt(parts[4].replace('%', '')) || 0;
        const mountPoint = parts[5];

        return {
          device,
          mountPoint,
          path: this.backupPath,
          total,
          used,
          available,
          usage: Math.min(100, Math.max(0, usagePercent)),
          totalGB: total,
          usedGB: used,
          availableGB: available
        };
      }
    } catch (error) {
      console.error('Error getting backup path usage:', error);
    }
    
    return null;
  }

  /**
   * Get metrics for specific mount point
   */
  async getMountPointMetrics(mountPoint) {
    const metrics = await this.getMetrics();
    const disk = metrics.disks.find(d => d.mountPoint === mountPoint);
    
    if (!disk) {
      // Try to get metrics for this specific path
      try {
        const { stdout } = await execAsync(`df -BG "${mountPoint}" | tail -1 | awk '{print $1,$2,$3,$4,$5,$6}'`);
        const parts = stdout.trim().split(/\s+/);
        
        if (parts.length >= 6) {
          return {
            device: parts[0],
            mountPoint: parts[5],
            total: parseInt(parts[1].replace('G', '')) || 0,
            used: parseInt(parts[2].replace('G', '')) || 0,
            available: parseInt(parts[3].replace('G', '')) || 0,
            usage: parseInt(parts[4].replace('%', '')) || 0
          };
        }
      } catch (error) {
        console.error(`Error getting metrics for ${mountPoint}:`, error);
      }
    }
    
    return disk || null;
  }
}

const metricsService = new MetricsService();
module.exports = metricsService;
