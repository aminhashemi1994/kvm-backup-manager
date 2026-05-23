const axios = require('axios');
const fs = require('fs');
const path = require('path');
const controllerAuthService = require('../services/controllerAuthService');

/**
 * Fetch storage pools from controller
 * Falls back to config.backupPath if controller is unavailable or no pools exist
 */
async function fetchStoragePools() {
  const config = require('../config/config');
  const storagePoolSyncService = require('../services/storagePoolSyncService');
  
  try {
    // Try to get from sync service first (cached)
    let pools = storagePoolSyncService.getStoragePools();
    
    if (pools.length > 0) {
      console.log(`[StoragePoolHelper] Using ${pools.length} cached storage pools`);
      return pools;
    }
    
    // If no cached pools, try to fetch from controller
    const controllerUrl = config.controllerUrl;
    const backupHostId = storagePoolSyncService.getBackupHostId();
    
    if (!controllerUrl) {
      console.log('[StoragePoolHelper] No controller URL configured, using fallback');
      return [{ path: config.backupPath, name: 'Default (Fallback)' }];
    }
    
    if (!backupHostId) {
      console.log('[StoragePoolHelper] No backup host ID discovered yet, using fallback');
      return [{ path: config.backupPath, name: 'Default (Fallback)' }];
    }
    
    const controllerAuthService = require('../services/controllerAuthService');
    const endpoint = `/storage-pools/backup-host/${backupHostId}`;
    const response = await controllerAuthService.get(controllerUrl, endpoint, { timeout: 5000 });
    pools = response.data.data || [];
    
    if (pools.length === 0) {
      console.log('[StoragePoolHelper] No storage pools found, using fallback');
      return [{ path: config.backupPath, name: 'Default (Fallback)' }];
    }
    
    console.log(`[StoragePoolHelper] Found ${pools.length} storage pools`);
    return pools;
  } catch (error) {
    console.error('[StoragePoolHelper] Failed to fetch storage pools:', error.message);
    // Fallback to config
    return [{ path: config.backupPath, name: 'Default (Fallback)' }];
  }
}

/**
 * Find a VM in any storage pool
 * Returns { pool, vmPath } if found, null otherwise
 */
async function findVMInStoragePools(vmName) {
  const pools = await fetchStoragePools();
  
  for (const pool of pools) {
    const vmPath = path.join(pool.path, vmName);
    if (fs.existsSync(vmPath)) {
      console.log(`[StoragePoolHelper] Found VM "${vmName}" in pool: ${pool.path}`);
      return { pool, vmPath };
    }
  }
  
  console.log(`[StoragePoolHelper] VM "${vmName}" not found in any storage pool`);
  return null;
}

/**
 * Find a specific schedule for a VM in any storage pool
 * Returns { pool, schedulePath } if found, null otherwise
 */
async function findScheduleInStoragePools(vmName, scheduleType) {
  const pools = await fetchStoragePools();
  
  for (const pool of pools) {
    const schedulePath = path.join(pool.path, vmName, scheduleType);
    if (fs.existsSync(schedulePath)) {
      console.log(`[StoragePoolHelper] Found ${scheduleType} schedule for VM "${vmName}" in pool: ${pool.path}`);
      return { pool, schedulePath };
    }
  }
  
  console.log(`[StoragePoolHelper] ${scheduleType} schedule for VM "${vmName}" not found in any storage pool`);
  return null;
}

/**
 * Find all instances of a VM across all storage pools
 * Returns array of { pool, vmPath }
 */
async function findAllVMInstances(vmName) {
  const pools = await fetchStoragePools();
  const instances = [];
  
  for (const pool of pools) {
    const vmPath = path.join(pool.path, vmName);
    if (fs.existsSync(vmPath)) {
      instances.push({ pool, vmPath });
    }
  }
  
  console.log(`[StoragePoolHelper] Found ${instances.length} instances of VM "${vmName}"`);
  return instances;
}

module.exports = {
  fetchStoragePools,
  findVMInStoragePools,
  findScheduleInStoragePools,
  findAllVMInstances
};
