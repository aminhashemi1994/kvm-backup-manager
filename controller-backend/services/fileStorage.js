const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const lockfile = require('proper-lockfile');
const config = require('../config/config');

class FileStorage {
  async initializeDataFiles() {
    try {
      await this.ensureDir(config.dataDir);
      await this.ensureDir(config.logsDir);
      await this.ensureDir(config.sshKeysDir);

      const files = [
        config.backupHostsFile,
        config.hypervisorsFile,
        config.virtualMachinesFile,
        config.backupSchedulesFile,
        config.backupJobsFile,
        path.join(config.dataDir, 'offsite-hosts.json'),
        path.join(config.dataDir, 'storage-pools.json'),
        path.join(config.dataDir, 'restore-storage-pools.json'),
      ];

      for (const file of files) {
        if (!fsSync.existsSync(file)) {
          await fs.writeFile(file, JSON.stringify([], null, 2), 'utf8');
          console.log(`Created: ${file}`);
        }
      }

      console.log('✓ Controller data files initialized');
    } catch (error) {
      console.error('Error initializing data files:', error);
      throw error;
    }
  }

  async ensureDir(dir) {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }

  async readJSON(filePath) {
    let release;
    try {
      release = await lockfile.lock(filePath, { retries: 5, stale: 10000 });
      const data = await fs.readFile(filePath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    } finally {
      if (release) await release();
    }
  }

  async writeJSON(filePath, data) {
    let release;
    try {
      release = await lockfile.lock(filePath, { retries: 5, stale: 10000 });
      await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
    } finally {
      if (release) await release();
    }
  }

  // Backup Hosts
  async getBackupHosts() { return await this.readJSON(config.backupHostsFile); }
  async saveBackupHosts(hosts) { await this.writeJSON(config.backupHostsFile, hosts); }

  // Hypervisors
  async getHypervisors() { return await this.readJSON(config.hypervisorsFile); }
  async saveHypervisors(hypervisors) { await this.writeJSON(config.hypervisorsFile, hypervisors); }

  // Virtual Machines
  async getVirtualMachines() { return await this.readJSON(config.virtualMachinesFile); }
  async saveVirtualMachines(vms) { await this.writeJSON(config.virtualMachinesFile, vms); }

  // Backup Schedules
  async getBackupSchedules() { return await this.readJSON(config.backupSchedulesFile); }
  async saveBackupSchedules(schedules) { await this.writeJSON(config.backupSchedulesFile, schedules); }

  // Backup Jobs
  async getBackupJobs() { return await this.readJSON(config.backupJobsFile); }
  async saveBackupJobs(jobs) { await this.writeJSON(config.backupJobsFile, jobs); }

  // Offsite Hosts
  async getOffsiteHosts() { 
    return await this.readJSON(path.join(config.dataDir, 'offsite-hosts.json')); 
  }
  async saveOffsiteHosts(hosts) { 
    await this.writeJSON(path.join(config.dataDir, 'offsite-hosts.json'), hosts); 
  }

  // Storage Pools
  async getStoragePools() {
    return await this.readJSON(path.join(config.dataDir, 'storage-pools.json'));
  }
  async saveStoragePools(pools) {
    await this.writeJSON(path.join(config.dataDir, 'storage-pools.json'), pools);
  }

  // Restore Storage Pools
  async getRestoreStoragePools() {
    return await this.readJSON(path.join(config.dataDir, 'restore-storage-pools.json'));
  }
  async saveRestoreStoragePools(pools) {
    await this.writeJSON(path.join(config.dataDir, 'restore-storage-pools.json'), pools);
  }

  // Logs
  async appendLog(jobId, logLine) {
    const logPath = path.join(config.logsDir, `${jobId}.log`);
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] ${logLine}\n`;
    await fs.appendFile(logPath, entry, 'utf8');
  }

  async readLog(jobId) {
    const logPath = path.join(config.logsDir, `${jobId}.log`);
    try {
      return await fs.readFile(logPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return '';
      throw error;
    }
  }
}

const fileStorage = new FileStorage();

module.exports = {
  initializeDataFiles: () => fileStorage.initializeDataFiles(),
  getBackupHosts: () => fileStorage.getBackupHosts(),
  saveBackupHosts: (hosts) => fileStorage.saveBackupHosts(hosts),
  getHypervisors: () => fileStorage.getHypervisors(),
  saveHypervisors: (hypervisors) => fileStorage.saveHypervisors(hypervisors),
  getVirtualMachines: () => fileStorage.getVirtualMachines(),
  saveVirtualMachines: (vms) => fileStorage.saveVirtualMachines(vms),
  getBackupSchedules: () => fileStorage.getBackupSchedules(),
  saveBackupSchedules: (schedules) => fileStorage.saveBackupSchedules(schedules),
  getBackupJobs: () => fileStorage.getBackupJobs(),
  saveBackupJobs: (jobs) => fileStorage.saveBackupJobs(jobs),
  getOffsiteHosts: () => fileStorage.getOffsiteHosts(),
  saveOffsiteHosts: (hosts) => fileStorage.saveOffsiteHosts(hosts),
  getStoragePools: () => fileStorage.getStoragePools(),
  saveStoragePools: (pools) => fileStorage.saveStoragePools(pools),
  addStoragePool: async (pool) => {
    const pools = await fileStorage.getStoragePools();
    pools.push(pool);
    await fileStorage.saveStoragePools(pools);
  },
  updateStoragePool: async (id, updates) => {
    const pools = await fileStorage.getStoragePools();
    const index = pools.findIndex(p => p.id === id);
    if (index !== -1) {
      pools[index] = { ...pools[index], ...updates };
      await fileStorage.saveStoragePools(pools);
    }
  },
  deleteStoragePool: async (id) => {
    const pools = await fileStorage.getStoragePools();
    const filtered = pools.filter(p => p.id !== id);
    await fileStorage.saveStoragePools(filtered);
  },
  getRestoreStoragePools: () => fileStorage.getRestoreStoragePools(),
  saveRestoreStoragePools: (pools) => fileStorage.saveRestoreStoragePools(pools),
  addRestoreStoragePool: async (pool) => {
    const pools = await fileStorage.getRestoreStoragePools();
    pools.push(pool);
    await fileStorage.saveRestoreStoragePools(pools);
  },
  updateRestoreStoragePool: async (id, updates) => {
    const pools = await fileStorage.getRestoreStoragePools();
    const index = pools.findIndex(p => p.id === id);
    if (index !== -1) {
      pools[index] = { ...pools[index], ...updates };
      await fileStorage.saveRestoreStoragePools(pools);
    }
  },
  deleteRestoreStoragePool: async (id) => {
    const pools = await fileStorage.getRestoreStoragePools();
    const filtered = pools.filter(p => p.id !== id);
    await fileStorage.saveRestoreStoragePools(filtered);
  },
  updateBackupHost: async (id, updates) => {
    const hosts = await fileStorage.getBackupHosts();
    const index = hosts.findIndex(h => h.id === id);
    if (index !== -1) {
      hosts[index] = { ...hosts[index], ...updates };
      await fileStorage.saveBackupHosts(hosts);
    }
  },
  updateHypervisor: async (id, updates) => {
    const hypervisors = await fileStorage.getHypervisors();
    const index = hypervisors.findIndex(h => h.id === id);
    if (index !== -1) {
      hypervisors[index] = { ...hypervisors[index], ...updates };
      await fileStorage.saveHypervisors(hypervisors);
    }
  },
  updateOffsiteHost: async (id, updates) => {
    const hosts = await fileStorage.getOffsiteHosts();
    const index = hosts.findIndex(h => h.id === id);
    if (index !== -1) {
      hosts[index] = { ...hosts[index], ...updates };
      await fileStorage.saveOffsiteHosts(hosts);
    }
  },
  appendLog: (jobId, logLine) => fileStorage.appendLog(jobId, logLine),
  readLog: (jobId) => fileStorage.readLog(jobId),
  // Restore Jobs (stored in data/restore-jobs.json with { jobs: [] } wrapper)
  getRestoreJobs: async () => {
    const filePath = path.join(config.dataDir, 'restore-jobs.json');
    try {
      const data = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(data);
      return parsed.jobs || [];
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      return [];
    }
  },
  saveRestoreJobs: async (jobs) => {
    const filePath = path.join(config.dataDir, 'restore-jobs.json');
    await fs.writeFile(filePath, JSON.stringify({ jobs }, null, 2), 'utf8');
  },
};
