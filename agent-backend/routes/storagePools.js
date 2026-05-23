const express = require('express');
const router = express.Router();
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execAsync = promisify(exec);

/**
 * POST /api/storage-pools/validate - Validate a storage pool path
 * 
 * Checks:
 * 1. Path exists
 * 2. Path is a mount point (not just a directory)
 * 3. Gets storage information (size, usage, etc.)
 */
router.post('/validate', async (req, res, next) => {
  try {
    const { path: storagePath } = req.body;

    if (!storagePath) {
      return res.status(400).json({
        success: false,
        error: 'path is required'
      });
    }

    // Check if path exists
    if (!fs.existsSync(storagePath)) {
      return res.json({
        success: false,
        error: `Path does not exist: ${storagePath}`
      });
    }

    // Check if it's a directory
    const stats = fs.statSync(storagePath);
    if (!stats.isDirectory()) {
      return res.json({
        success: false,
        error: `Path is not a directory: ${storagePath}`
      });
    }

    // Check if it's a mount point or subdirectory of a mount point
    const mountPointInfo = await checkIfMountPointOrSubdirectory(storagePath);
    if (!mountPointInfo.isValid) {
      return res.json({
        success: false,
        error: `Path is not on a mounted filesystem: ${storagePath}. It must be a mount point or a subdirectory of a mounted filesystem.`
      });
    }

    console.log(`Storage pool path validation: ${storagePath}`);
    console.log(`  - Is mount point: ${mountPointInfo.isMountPoint}`);
    console.log(`  - Mount point: ${mountPointInfo.mountPoint}`);

    // Get storage information
    const storageInfo = await getStorageInfo(storagePath);
    
    if (!storageInfo) {
      return res.json({
        success: false,
        error: `Failed to get storage information for: ${storagePath}`
      });
    }

    res.json({
      success: true,
      data: storageInfo
    });
  } catch (error) {
    console.error('Error validating storage pool:', error);
    next(error);
  }
});

/**
 * Check if a path is a mount point or subdirectory of a mount point
 * Returns: { isValid: boolean, isMountPoint: boolean, mountPoint: string }
 */
async function checkIfMountPointOrSubdirectory(targetPath) {
  try {
    // First, check if the path itself is a mount point
    const isMountPoint = await checkIfMountPoint(targetPath);
    if (isMountPoint) {
      return {
        isValid: true,
        isMountPoint: true,
        mountPoint: targetPath
      };
    }

    // If not a mount point, check if it's a subdirectory of a mount point
    // Get all mount points from /proc/mounts
    const { stdout: mounts } = await execAsync('cat /proc/mounts');
    const mountLines = mounts.split('\n');
    const mountPoints = [];
    
    for (const line of mountLines) {
      const parts = line.split(' ');
      if (parts.length >= 2) {
        const mountPoint = parts[1];
        // Skip special filesystems
        if (!mountPoint.startsWith('/proc') && 
            !mountPoint.startsWith('/sys') && 
            !mountPoint.startsWith('/dev') &&
            !mountPoint.startsWith('/run') &&
            mountPoint !== '/') {
          mountPoints.push(mountPoint);
        }
      }
    }

    // Sort mount points by length (longest first) to find the most specific mount point
    mountPoints.sort((a, b) => b.length - a.length);

    // Check if targetPath is under any mount point
    for (const mountPoint of mountPoints) {
      if (targetPath.startsWith(mountPoint + '/') || targetPath === mountPoint) {
        console.log(`Path ${targetPath} is under mount point: ${mountPoint}`);
        return {
          isValid: true,
          isMountPoint: false,
          mountPoint: mountPoint
        };
      }
    }

    // Also check root filesystem
    return {
      isValid: true,
      isMountPoint: false,
      mountPoint: '/'
    };
  } catch (error) {
    console.error('Error checking mount point or subdirectory:', error);
    return {
      isValid: false,
      isMountPoint: false,
      mountPoint: null
    };
  }
}

/**
 * Check if a path is a mount point
 */
async function checkIfMountPoint(targetPath) {
  try {
    // Method 1: Use mountpoint command if available
    try {
      await execAsync(`mountpoint -q "${targetPath}"`);
      return true;
    } catch (e) {
      // mountpoint command not available or path is not a mount point
    }

    // Method 2: Compare device of path with parent
    const { stdout: pathDevice } = await execAsync(`stat -c '%d' "${targetPath}" 2>/dev/null`);
    const parentPath = path.dirname(targetPath);
    const { stdout: parentDevice } = await execAsync(`stat -c '%d' "${parentPath}" 2>/dev/null`);
    
    // If devices are different, it's a mount point
    if (pathDevice.trim() !== parentDevice.trim()) {
      return true;
    }

    // Method 3: Check /proc/mounts
    const { stdout: mounts } = await execAsync('cat /proc/mounts');
    const mountLines = mounts.split('\n');
    
    for (const line of mountLines) {
      const parts = line.split(' ');
      if (parts.length >= 2) {
        const mountPoint = parts[1];
        if (mountPoint === targetPath) {
          return true;
        }
      }
    }

    return false;
  } catch (error) {
    console.error('Error checking mount point:', error);
    return false;
  }
}

/**
 * Get storage information for a path
 */
async function getStorageInfo(targetPath) {
  try {
    // Use df to get storage info
    const { stdout } = await execAsync(`df -BG "${targetPath}" | tail -1`);
    const parts = stdout.trim().split(/\s+/);
    
    if (parts.length < 6) {
      return null;
    }

    const device = parts[0];
    const totalStr = parts[1];
    const usedStr = parts[2];
    const availableStr = parts[3];
    const usagePercentStr = parts[4];
    const mountPoint = parts[5];

    // Parse values (remove 'G' suffix)
    const totalGB = parseInt(totalStr.replace('G', '')) || 0;
    const usedGB = parseInt(usedStr.replace('G', '')) || 0;
    const availableGB = parseInt(availableStr.replace('G', '')) || 0;
    const usagePercent = parseInt(usagePercentStr.replace('%', '')) || 0;

    return {
      device,
      mountPoint,
      totalGB,
      usedGB,
      availableGB,
      usagePercent
    };
  } catch (error) {
    console.error('Error getting storage info:', error);
    return null;
  }
}

module.exports = router;


/**
 * POST /api/storage-pools/validate-offsite - Validate storage pool exists on offsite host
 * 
 * Checks if a storage pool path exists on a remote offsite host via SSH
 * Same validation as backup host: path exists, is directory, is on mounted filesystem
 */
router.post('/validate-offsite', async (req, res, next) => {
  try {
    const { path: storagePath, offsiteIp, username = 'root' } = req.body;

    if (!storagePath || !offsiteIp) {
      return res.status(400).json({
        success: false,
        error: 'path and offsiteIp are required'
      });
    }

    console.log(`Validating storage pool on offsite host: ${offsiteIp}:${storagePath}`);

    // Test SSH connectivity
    try {
      await execAsync(`ssh -o BatchMode=yes -o ConnectTimeout=10 ${username}@${offsiteIp} exit`);
    } catch (error) {
      return res.json({
        success: false,
        error: `SSH connection failed to ${offsiteIp}: ${error.message}`
      });
    }

    // Check if path exists on remote host
    try {
      await execAsync(`ssh ${username}@${offsiteIp} "test -d '${storagePath}'"`);
    } catch (error) {
      return res.json({
        success: false,
        error: `Storage pool path does not exist on offsite host ${offsiteIp}: ${storagePath}`
      });
    }

    // Check if path is writable
    try {
      await execAsync(`ssh ${username}@${offsiteIp} "test -w '${storagePath}'"`);
    } catch (error) {
      return res.json({
        success: false,
        error: `Storage pool path is not writable on offsite host ${offsiteIp}: ${storagePath}`
      });
    }

    // Get storage information and mount point from remote host
    try {
      const { stdout } = await execAsync(`ssh ${username}@${offsiteIp} "df -BG '${storagePath}' | tail -1"`);
      const parts = stdout.trim().split(/\s+/);
      
      if (parts.length >= 6) {
        const device = parts[0];
        const totalStr = parts[1];
        const usedStr = parts[2];
        const availableStr = parts[3];
        const usagePercentStr = parts[4];
        const mountPoint = parts[5];

        const totalGB = parseInt(totalStr.replace('G', '')) || 0;
        const usedGB = parseInt(usedStr.replace('G', '')) || 0;
        const availableGB = parseInt(availableStr.replace('G', '')) || 0;
        const usagePercent = parseInt(usagePercentStr.replace('%', '')) || 0;

        console.log(`Offsite storage pool validation successful:`);
        console.log(`  - Device: ${device}`);
        console.log(`  - Mount point: ${mountPoint}`);
        console.log(`  - Total: ${totalGB}GB, Used: ${usedGB}GB, Available: ${availableGB}GB`);

        res.json({
          success: true,
          data: {
            offsiteIp,
            path: storagePath,
            device,
            mountPoint,
            totalGB,
            usedGB,
            availableGB,
            usagePercent,
            writable: true
          }
        });
      } else {
        return res.json({
          success: false,
          error: `Failed to get storage information from offsite host ${offsiteIp}: ${storagePath}`
        });
      }
    } catch (error) {
      return res.json({
        success: false,
        error: `Failed to get storage information from offsite host ${offsiteIp}: ${error.message}`
      });
    }
  } catch (error) {
    console.error('Error validating offsite storage pool:', error);
    next(error);
  }
});
