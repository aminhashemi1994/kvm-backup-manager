const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

class RetentionService {
  constructor(config) {
    this.config = config;
  }

  /**
   * Get backup directories for a VM
   * @param {string} vmName - VM name
   * @param {string} storagePoolPath - Storage pool path (optional, uses config.backupPath if not provided)
   */
  getVMBackupPaths(vmName, storagePoolPath = null) {
    const basePath = path.join(storagePoolPath || this.config.backupPath, vmName);
    return {
      current: path.join(basePath, 'current'),
      archived: path.join(basePath, 'archived'),
      monthly: path.join(basePath, 'monthly'),
    };
  }

  /**
   * Archive current backup
   * Moves current backup to archived with timestamp
   * @param {string} vmName - VM name
   * @param {number} maxArchivedBackups - Maximum archived backups to keep (optional)
   * @param {string} storagePoolPath - Storage pool path (optional)
   */
  async archiveCurrentBackup(vmName, maxArchivedBackups = null, storagePoolPath = null) {
    const paths = this.getVMBackupPaths(vmName, storagePoolPath);
    
    // Check if current backup exists
    if (!fsSync.existsSync(paths.current)) {
      return { success: false, message: 'No current backup to archive' };
    }

    // Create archived directory if it doesn't exist
    await fs.mkdir(paths.archived, { recursive: true });

    // Generate timestamp for archive name
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
    const archiveName = `backup_${timestamp}_${Date.now()}`;
    const archivePath = path.join(paths.archived, archiveName);

    try {
      // Move current to archived
      await fs.rename(paths.current, archivePath);
      console.log(`Archived backup for ${vmName}: ${archiveName}`);

      // Apply retention policy
      await this.applyRetentionPolicy(vmName, 'archived', maxArchivedBackups, storagePoolPath);

      return { 
        success: true, 
        message: 'Backup archived successfully',
        archivePath: archiveName
      };
    } catch (error) {
      console.error(`Error archiving backup for ${vmName}:`, error);
      return { success: false, message: error.message };
    }
  }

  /**
   * Apply retention policy to archived or monthly backups
   * Removes oldest backups if count exceeds limit
   * @param {string} vmName - VM name
   * @param {string} type - 'archived' or 'monthly'
   * @param {number} maxBackups - Maximum backups to keep (optional)
   * @param {string} storagePoolPath - Storage pool path (optional)
   */
  async applyRetentionPolicy(vmName, type = 'archived', maxBackups = null, storagePoolPath = null) {
    const paths = this.getVMBackupPaths(vmName, storagePoolPath);
    const targetPath = type === 'archived' ? paths.archived : paths.monthly;
    
    // Use provided maxBackups or defaults
    const limit = maxBackups !== null ? maxBackups : (type === 'archived' ? 5 : 12);

    if (!fsSync.existsSync(targetPath)) {
      return { removed: 0, kept: 0 };
    }

    try {
      // Get all backup directories
      const entries = await fs.readdir(targetPath, { withFileTypes: true });
      const backups = entries
        .filter(entry => entry.isDirectory())
        .map(entry => ({
          name: entry.name,
          path: path.join(targetPath, entry.name),
        }));

      // Sort by name (which includes timestamp) - oldest first
      backups.sort((a, b) => a.name.localeCompare(b.name));

      // Calculate how many to remove
      const toRemove = backups.length - limit;
      
      if (toRemove <= 0) {
        console.log(`Retention OK for ${vmName}/${type}: ${backups.length}/${limit} backups`);
        return { removed: 0, kept: backups.length };
      }

      // Remove oldest backups
      const removed = [];
      for (let i = 0; i < toRemove; i++) {
        const backup = backups[i];
        console.log(`Removing old ${type} backup: ${vmName}/${backup.name}`);
        await fs.rm(backup.path, { recursive: true, force: true });
        removed.push(backup.name);
      }

      console.log(`Retention applied for ${vmName}/${type}: removed ${removed.length}, kept ${backups.length - removed.length}`);
      
      return { 
        removed: removed.length, 
        kept: backups.length - removed.length,
        removedBackups: removed
      };
    } catch (error) {
      console.error(`Error applying retention policy for ${vmName}/${type}:`, error);
      throw error;
    }
  }

  /**
   * Create monthly backup from current
   * Copies current backup to monthly directory
   * @param {string} vmName - VM name
   * @param {number} maxMonthlyBackups - Maximum monthly backups to keep (optional)
   * @param {string} storagePoolPath - Storage pool path (optional)
   */
  async createMonthlyBackup(vmName, maxMonthlyBackups = null, storagePoolPath = null) {
    const paths = this.getVMBackupPaths(vmName, storagePoolPath);
    
    // Check if current backup exists
    if (!fsSync.existsSync(paths.current)) {
      return { success: false, message: 'No current backup to copy' };
    }

    // Create monthly directory if it doesn't exist
    await fs.mkdir(paths.monthly, { recursive: true });

    // Generate monthly backup name (YYYY-MM format)
    const date = new Date();
    const monthlyName = `backup_${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    const monthlyPath = path.join(paths.monthly, monthlyName);

    // Check if monthly backup for this month already exists
    if (fsSync.existsSync(monthlyPath)) {
      return { 
        success: false, 
        message: 'Monthly backup for this month already exists' 
      };
    }

    try {
      // Copy current to monthly (use cp -r command for efficiency)
      const { spawn } = require('child_process');
      await new Promise((resolve, reject) => {
        const cp = spawn('cp', ['-r', paths.current, monthlyPath]);
        cp.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Copy failed with code ${code}`));
        });
        cp.on('error', reject);
      });

      console.log(`Created monthly backup for ${vmName}: ${monthlyName}`);

      // Apply retention policy
      await this.applyRetentionPolicy(vmName, 'monthly', maxMonthlyBackups, storagePoolPath);

      return { 
        success: true, 
        message: 'Monthly backup created successfully',
        monthlyPath: monthlyName
      };
    } catch (error) {
      console.error(`Error creating monthly backup for ${vmName}:`, error);
      return { success: false, message: error.message };
    }
  }

  /**
   * Get backup statistics for a VM
   * @param {string} vmName - VM name
   * @param {string} storagePoolPath - Storage pool path (optional)
   */
  async getBackupStats(vmName, storagePoolPath = null) {
    const paths = this.getVMBackupPaths(vmName, storagePoolPath);
    const stats = {
      current: { exists: false, size: 0 },
      archived: { count: 0, totalSize: 0, backups: [] },
      monthly: { count: 0, totalSize: 0, backups: [] },
    };

    // Check current backup
    if (fsSync.existsSync(paths.current)) {
      stats.current.exists = true;
      stats.current.size = await this.getDirectorySize(paths.current);
    }

    // Check archived backups
    if (fsSync.existsSync(paths.archived)) {
      const entries = await fs.readdir(paths.archived, { withFileTypes: true });
      const backups = entries.filter(e => e.isDirectory());
      stats.archived.count = backups.length;
      
      for (const backup of backups) {
        const backupPath = path.join(paths.archived, backup.name);
        const size = await this.getDirectorySize(backupPath);
        stats.archived.totalSize += size;
        stats.archived.backups.push({ name: backup.name, size });
      }
    }

    // Check monthly backups
    if (fsSync.existsSync(paths.monthly)) {
      const entries = await fs.readdir(paths.monthly, { withFileTypes: true });
      const backups = entries.filter(e => e.isDirectory());
      stats.monthly.count = backups.length;
      
      for (const backup of backups) {
        const backupPath = path.join(paths.monthly, backup.name);
        const size = await this.getDirectorySize(backupPath);
        stats.monthly.totalSize += size;
        stats.monthly.backups.push({ name: backup.name, size });
      }
    }

    return stats;
  }

  /**
   * Get directory size recursively
   */
  async getDirectorySize(dirPath) {
    let totalSize = 0;

    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        
        if (entry.isDirectory()) {
          totalSize += await this.getDirectorySize(fullPath);
        } else {
          const stats = await fs.stat(fullPath);
          totalSize += stats.size;
        }
      }
    } catch (error) {
      console.error(`Error getting directory size for ${dirPath}:`, error);
    }

    return totalSize;
  }

  /**
   * Delete a backup directory
   * @param {string} vmName - VM name
   * @param {string} type - 'current', 'archived', or 'monthly'
   * @param {string} backupName - Specific backup name (optional, for archived/monthly)
   * @param {string} storagePoolPath - Storage pool path (optional)
   */
  async deleteBackup(vmName, type, backupName = null, storagePoolPath = null) {
    const paths = this.getVMBackupPaths(vmName, storagePoolPath);
    let targetPath;

    switch (type) {
      case 'current':
        targetPath = paths.current;
        break;
      case 'archived':
        targetPath = backupName 
          ? path.join(paths.archived, backupName)
          : paths.archived;
        break;
      case 'monthly':
        targetPath = backupName 
          ? path.join(paths.monthly, backupName)
          : paths.monthly;
        break;
      default:
        return { success: false, message: 'Invalid backup type' };
    }

    if (!fsSync.existsSync(targetPath)) {
      return { success: false, message: 'Backup not found' };
    }

    try {
      await fs.rm(targetPath, { recursive: true, force: true });
      console.log(`Deleted backup: ${vmName}/${type}${backupName ? '/' + backupName : ''}`);
      return { success: true, message: 'Backup deleted successfully' };
    } catch (error) {
      console.error(`Error deleting backup:`, error);
      return { success: false, message: error.message };
    }
  }
}

module.exports = RetentionService;
