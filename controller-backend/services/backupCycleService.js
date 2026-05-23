const axios = require('axios');
const { getVirtualMachines, saveVirtualMachines } = require('./fileStorage');

class BackupCycleService {
  /**
   * Determine backup method based on incremental cycle
   * Returns: { method: 'full' | 'inc', shouldArchive: boolean }
   */
  async determineBackupMethod(vmId) {
    const vms = await getVirtualMachines();
    const vm = vms.find(v => v.id === vmId);
    
    if (!vm) {
      throw new Error('VM not found');
    }

    // Get cycle configuration (default: 6 incrementals before full)
    const incrementalCycleCount = vm.incrementalCycleCount || 6;
    const currentIncrementalCount = vm.currentIncrementalCount || 0;

    // First backup or cycle complete -> Full backup
    if (currentIncrementalCount === 0) {
      return {
        method: 'full',
        shouldArchive: currentIncrementalCount >= incrementalCycleCount,
        currentCount: 0,
        cycleCount: incrementalCycleCount
      };
    }

    // Within cycle -> Incremental backup
    if (currentIncrementalCount < incrementalCycleCount) {
      return {
        method: 'inc',
        shouldArchive: false,
        currentCount: currentIncrementalCount,
        cycleCount: incrementalCycleCount
      };
    }

    // Cycle complete -> Archive and start new full backup
    return {
      method: 'full',
      shouldArchive: true,
      currentCount: currentIncrementalCount,
      cycleCount: incrementalCycleCount
    };
  }

  /**
   * Increment the backup counter for a VM
   */
  async incrementBackupCounter(vmId) {
    const vms = await getVirtualMachines();
    const vm = vms.find(v => v.id === vmId);
    
    if (!vm) {
      throw new Error('VM not found');
    }

    const incrementalCycleCount = vm.incrementalCycleCount || 6;
    const currentIncrementalCount = vm.currentIncrementalCount || 0;

    // Increment counter
    vm.currentIncrementalCount = currentIncrementalCount + 1;

    // If cycle complete, reset counter
    if (vm.currentIncrementalCount > incrementalCycleCount) {
      vm.currentIncrementalCount = 0;
    }

    vm.updatedAt = new Date().toISOString();
    await saveVirtualMachines(vms);

    return {
      currentCount: vm.currentIncrementalCount,
      cycleCount: incrementalCycleCount,
      cycleComplete: vm.currentIncrementalCount === 0
    };
  }

  /**
   * Reset backup counter for a VM (e.g., after manual full backup)
   */
  async resetBackupCounter(vmId) {
    const vms = await getVirtualMachines();
    const vm = vms.find(v => v.id === vmId);
    
    if (!vm) {
      throw new Error('VM not found');
    }

    vm.currentIncrementalCount = 0;
    vm.updatedAt = new Date().toISOString();
    await saveVirtualMachines(vms);

    return { currentCount: 0 };
  }

  /**
   * Execute backup with automatic cycle management
   * This is the main method to use for scheduled backups
   */
  async executeBackupWithCycle(vmId, agentUrl) {
    const vms = await getVirtualMachines();
    const vm = vms.find(v => v.id === vmId);
    
    if (!vm) {
      throw new Error('VM not found');
    }

    // Determine backup method
    const cycleInfo = await this.determineBackupMethod(vmId);
    
    console.log(`Backup cycle for ${vm.name}: method=${cycleInfo.method}, count=${cycleInfo.currentCount}/${cycleInfo.cycleCount}, archive=${cycleInfo.shouldArchive}`);

    // If cycle complete, archive current backup first
    if (cycleInfo.shouldArchive) {
      console.log(`Archiving current backup for ${vm.name} before starting new cycle`);
      
      try {
        const maxArchivedBackups = vm.maxArchivedBackups || 2;
        const hostUrl = agentUrl.startsWith('http') ? agentUrl : `http://${agentUrl}`;
        
        await axios.post(`${hostUrl}/api/retention/${vm.name}/archive`, {
          maxArchivedBackups
        });
        
        console.log(`Archived successfully, keeping ${maxArchivedBackups} archived backups`);
      } catch (error) {
        console.error(`Failed to archive backup for ${vm.name}:`, error.message);
        // Continue with backup even if archiving fails
      }
    }

    // Return backup configuration
    return {
      method: cycleInfo.method,
      vmName: vm.name,
      vmId: vm.id,
      cycleInfo: {
        current: cycleInfo.currentCount,
        total: cycleInfo.cycleCount,
        archived: cycleInfo.shouldArchive
      }
    };
  }

  /**
   * Get backup cycle status for a VM
   */
  async getBackupCycleStatus(vmId) {
    const vms = await getVirtualMachines();
    const vm = vms.find(v => v.id === vmId);
    
    if (!vm) {
      throw new Error('VM not found');
    }

    const incrementalCycleCount = vm.incrementalCycleCount || 6;
    const currentIncrementalCount = vm.currentIncrementalCount || 0;
    
    const nextMethod = currentIncrementalCount === 0 || currentIncrementalCount >= incrementalCycleCount 
      ? 'full' 
      : 'inc';
    
    const willArchive = currentIncrementalCount >= incrementalCycleCount;

    return {
      vmId: vm.id,
      vmName: vm.name,
      currentCount: currentIncrementalCount,
      cycleCount: incrementalCycleCount,
      nextMethod,
      willArchive,
      progress: `${currentIncrementalCount}/${incrementalCycleCount}`,
      cycleComplete: currentIncrementalCount >= incrementalCycleCount
    };
  }

  /**
   * Get backup cycle status for all VMs
   */
  async getAllBackupCycleStatus() {
    const vms = await getVirtualMachines();
    const statuses = [];

    for (const vm of vms) {
      if (vm.selected) {
        const status = await this.getBackupCycleStatus(vm.id);
        statuses.push(status);
      }
    }

    return statuses;
  }
}

const backupCycleService = new BackupCycleService();
module.exports = backupCycleService;
