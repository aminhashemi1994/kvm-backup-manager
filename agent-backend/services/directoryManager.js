const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const config = require('../config/config');

class DirectoryManager {
  /**
   * Get backup directories for a VM
   */
  async getBackupDirectories(vmName) {
    const vmBackupPath = path.join(config.backupPath, vmName);
    
    const directories = {
      vmName,
      basePath: vmBackupPath,
      exists: false,
      current: {
        exists: false,
        path: path.join(vmBackupPath, 'current'),
        size: null,
        lastModified: null,
      },
      archived: {
        exists: false,
        path: path.join(vmBackupPath, 'archived'),
        items: [],
      },
      monthly: {
        exists: false,
        path: path.join(vmBackupPath, 'monthly'),
        size: null,
        lastModified: null,
      },
    };

    try {
      // Check if VM backup directory exists
      await fs.access(vmBackupPath);
      directories.exists = true;

      // Check current directory
      try {
        const currentStats = await fs.stat(directories.current.path);
        directories.current.exists = currentStats.isDirectory();
        directories.current.lastModified = currentStats.mtime;
        directories.current.size = await this.getDirectorySize(directories.current.path);
      } catch (e) {
        // Directory doesn't exist
      }

      // Check archived directory
      try {
        const archivedPath = directories.archived.path;
        await fs.access(archivedPath);
        directories.archived.exists = true;

        const items = await fs.readdir(archivedPath);
        for (const item of items) {
          const itemPath = path.join(archivedPath, item);
          const stats = await fs.stat(itemPath);
          if (stats.isDirectory()) {
            directories.archived.items.push({
              name: item,
              path: itemPath,
              size: await this.getDirectorySize(itemPath),
              lastModified: stats.mtime,
            });
          }
        }

        // Sort by date descending
        directories.archived.items.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
      } catch (e) {
        // Directory doesn't exist
      }

      // Check monthly directory
      try {
        const monthlyStats = await fs.stat(directories.monthly.path);
        directories.monthly.exists = monthlyStats.isDirectory();
        directories.monthly.lastModified = monthlyStats.mtime;
        directories.monthly.size = await this.getDirectorySize(directories.monthly.path);
      } catch (e) {
        // Directory doesn't exist
      }

    } catch (e) {
      // VM backup directory doesn't exist
    }

    return directories;
  }

  /**
   * Get directory size recursively
   */
  async getDirectorySize(dirPath) {
    let totalSize = 0;

    try {
      const files = await fs.readdir(dirPath);
      
      for (const file of files) {
        const filePath = path.join(dirPath, file);
        const stats = await fs.stat(filePath);
        
        if (stats.isDirectory()) {
          totalSize += await this.getDirectorySize(filePath);
        } else {
          totalSize += stats.size;
        }
      }
    } catch (e) {
      // Directory might not exist or no permission
    }

    return totalSize;
  }

  /**
   * Archive current backup
   */
  async archiveCurrentBackup(vmName) {
    const vmBackupPath = path.join(config.backupPath, vmName);
    const currentPath = path.join(vmBackupPath, 'current');
    const archivedPath = path.join(vmBackupPath, 'archived');

    // Check if current exists
    try {
      await fs.access(currentPath);
    } catch (e) {
      throw new Error('No current backup to archive');
    }

    // Ensure archived directory exists
    await fs.mkdir(archivedPath, { recursive: true });

    // Generate archive name with date
    const now = new Date();
    const datePart = now.toISOString().split('T')[0];
    const timePart = now.toTimeString().split(' ')[0].replace(/:/g, '-');
    const archiveName = `${datePart}_${timePart}_${vmName}`;
    const archiveDestPath = path.join(archivedPath, archiveName);

    // Move current to archived
    await fs.rename(currentPath, archiveDestPath);

    // Recreate current directory
    await fs.mkdir(currentPath, { recursive: true });

    return {
      success: true,
      archiveName,
      archivePath: archiveDestPath,
    };
  }

  /**
   * Delete backup directory
   */
  async deleteBackupDirectory(vmName, type) {
    const vmBackupPath = path.join(config.backupPath, vmName);
    let targetPath;

    switch (type) {
      case 'current':
        targetPath = path.join(vmBackupPath, 'current');
        break;
      case 'monthly':
        targetPath = path.join(vmBackupPath, 'monthly');
        break;
      case 'archived':
        targetPath = path.join(vmBackupPath, 'archived');
        break;
      default:
        throw new Error('Invalid directory type');
    }

    // Remove directory recursively
    await fs.rm(targetPath, { recursive: true, force: true });

    // Recreate empty directory
    await fs.mkdir(targetPath, { recursive: true });

    return {
      success: true,
      deleted: targetPath,
    };
  }

  /**
   * Delete specific archived backup
   */
  async deleteArchivedBackup(vmName, archiveName) {
    const archivePath = path.join(config.backupPath, vmName, 'archived', archiveName);

    // Check if exists
    try {
      await fs.access(archivePath);
    } catch (e) {
      throw new Error('Archive not found');
    }

    // Remove directory
    await fs.rm(archivePath, { recursive: true, force: true });

    return {
      success: true,
      deleted: archiveName,
    };
  }

  /**
   * Create monthly backup (replace existing)
   */
  async createMonthlyBackup(vmName) {
    const vmBackupPath = path.join(config.backupPath, vmName);
    const monthlyPath = path.join(vmBackupPath, 'monthly');

    // Remove existing monthly
    try {
      await fs.rm(monthlyPath, { recursive: true, force: true });
    } catch (e) {
      // Might not exist
    }

    // Recreate monthly directory
    await fs.mkdir(monthlyPath, { recursive: true });

    return {
      success: true,
      path: monthlyPath,
    };
  }

  /**
   * Get all VMs with backups
   */
  async getAllVMsWithBackups() {
    const vms = [];

    try {
      const entries = await fs.readdir(config.backupPath);
      
      for (const entry of entries) {
        const entryPath = path.join(config.backupPath, entry);
        const stats = await fs.stat(entryPath);
        
        if (stats.isDirectory()) {
          const dirInfo = await this.getBackupDirectories(entry);
          if (dirInfo.exists) {
            vms.push({
              vmName: entry,
              hasCurrent: dirInfo.current.exists,
              hasMonthly: dirInfo.monthly.exists,
              archivedCount: dirInfo.archived.items.length,
            });
          }
        }
      }
    } catch (e) {
      // Backup path might not exist
    }

    return vms;
  }
}

// Export singleton instance
const directoryManager = new DirectoryManager();

module.exports = directoryManager;
