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
          // If a backup exists from a previous run, prefer that over creating
          // a brand-new empty file. Protects against the case where a crash
          // (OOM, power loss) left the main file truncated and someone or
          // something then deleted it, making us "lose" all schedules etc.
          const bakPath = `${file}.bak`;
          if (fsSync.existsSync(bakPath)) {
            try {
              const bakRaw = fsSync.readFileSync(bakPath, 'utf8');
              JSON.parse(bakRaw); // validate
              fsSync.copyFileSync(bakPath, file);
              console.log(`Recovered ${file} from ${bakPath} on startup`);
              continue;
            } catch (e) {
              console.error(`Backup ${bakPath} unusable: ${e.message}`);
            }
          }
          await fs.writeFile(file, JSON.stringify([], null, 2), 'utf8');
          console.log(`Created: ${file}`);
        } else {
          // File exists — sanity check it. If parsing fails, try recovery
          // before any other code reads it.
          try {
            const raw = fsSync.readFileSync(file, 'utf8');
            if (raw && raw.trim()) JSON.parse(raw);
          } catch (parseErr) {
            console.error(`[fileStorage] ${file} is corrupt: ${parseErr.message}`);
            const bakPath = `${file}.bak`;
            if (fsSync.existsSync(bakPath)) {
              try {
                const bakRaw = fsSync.readFileSync(bakPath, 'utf8');
                JSON.parse(bakRaw);
                fsSync.copyFileSync(bakPath, file);
                console.log(`Recovered ${file} from ${bakPath} on startup`);
                continue;
              } catch (e) {
                console.error(`Backup ${bakPath} also unusable: ${e.message}`);
              }
            }
            // Last resort: move the corrupt file aside so the app can boot
            // and the user can investigate, and replace it with an empty array.
            const corruptPath = `${file}.corrupt-${Date.now()}`;
            try {
              fsSync.renameSync(file, corruptPath);
              console.error(`Quarantined corrupt file to ${corruptPath}`);
            } catch (e) {
              console.error(`Could not quarantine ${file}: ${e.message}`);
            }
            await fs.writeFile(file, JSON.stringify([], null, 2), 'utf8');
            console.log(`Created fresh: ${file}`);
          }
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
      let data;
      try {
        data = await fs.readFile(filePath, 'utf8');
      } catch (readErr) {
        if (readErr.code === 'ENOENT') return [];
        throw readErr;
      }

      // Empty / whitespace-only file: treat as corrupt and try to recover
      if (!data || !data.trim()) {
        console.error(`[fileStorage] ${filePath} is empty — attempting recovery from .bak`);
        const recovered = await this._tryReadBackup(filePath);
        if (recovered !== null) return recovered;
        return [];
      }

      try {
        return JSON.parse(data);
      } catch (parseErr) {
        // Corrupt JSON — most likely a truncated write from a crash.
        // Try the backup copy before giving up so we never silently lose data.
        console.error(`[fileStorage] Failed to parse ${filePath}: ${parseErr.message}. Attempting recovery from .bak`);
        const recovered = await this._tryReadBackup(filePath);
        if (recovered !== null) {
          // Restore the main file from the backup so the next read is clean.
          try {
            const bakPath = `${filePath}.bak`;
            await fs.copyFile(bakPath, filePath);
            console.error(`[fileStorage] Restored ${filePath} from ${bakPath}`);
          } catch (restoreErr) {
            console.error(`[fileStorage] Could not restore ${filePath} from .bak: ${restoreErr.message}`);
          }
          return recovered;
        }
        // No usable backup — return empty array so callers don't crash.
        // (Throwing here would 500 every API endpoint that touches this file.)
        console.error(`[fileStorage] No usable backup for ${filePath}; returning empty array. Manual intervention may be required.`);
        return [];
      }
    } finally {
      if (release) {
        try { await release(); } catch (_) { /* lock may already be gone */ }
      }
    }
  }

  async _tryReadBackup(filePath) {
    const bakPath = `${filePath}.bak`;
    try {
      const bakData = await fs.readFile(bakPath, 'utf8');
      if (!bakData || !bakData.trim()) return null;
      const parsed = JSON.parse(bakData);
      console.error(`[fileStorage] Recovered ${filePath} from ${bakPath}`);
      return parsed;
    } catch (err) {
      return null;
    }
  }

  async writeJSON(filePath, data) {
    let release;
    try {
      release = await lockfile.lock(filePath, { retries: 5, stale: 10000, realpath: false });
      const json = JSON.stringify(data, null, 2);
      const tmpPath = `${filePath}.tmp`;
      const bakPath = `${filePath}.bak`;

      // Write to a temp file, fsync, then atomically rename into place.
      // This prevents truncation/corruption if the process is killed mid-write.
      const fh = await fs.open(tmpPath, 'w');
      try {
        await fh.writeFile(json, 'utf8');
        try { await fh.sync(); } catch (_) { /* sync may not be supported on some FS */ }
      } finally {
        await fh.close();
      }

      // Rotate previous version to .bak (so a corrupted next-write is recoverable)
      try {
        await fs.copyFile(filePath, bakPath);
      } catch (copyErr) {
        // Original may not exist on first write — that's fine.
        if (copyErr.code !== 'ENOENT') {
          console.error(`[fileStorage] Could not refresh backup ${bakPath}: ${copyErr.message}`);
        }
      }

      await fs.rename(tmpPath, filePath);
    } finally {
      if (release) {
        try { await release(); } catch (_) { /* lock may already be gone */ }
      }
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
  // Generic atomic JSON helpers — exported so other modules (heartbeat,
  // restore routes, auth, etc.) can persist their files crash-safely
  // without re-inventing the temp-file/rename dance.
  readJSON: (filePath) => fileStorage.readJSON(filePath),
  writeJSON: (filePath, data) => fileStorage.writeJSON(filePath, data),
  // Restore Jobs (stored in data/restore-jobs.json with { jobs: [] } wrapper).
  // Uses the same atomic write path as everything else; readers transparently
  // unwrap the { jobs: [...] } envelope.
  getRestoreJobs: async () => {
    const filePath = path.join(config.dataDir, 'restore-jobs.json');
    try {
      const parsed = await fileStorage.readJSON(filePath);
      // readJSON returns [] on missing/corrupt; if a fresh file got created
      // it'll also be []. Otherwise unwrap the envelope.
      if (Array.isArray(parsed)) return parsed; // legacy / fallback shape
      return parsed.jobs || [];
    } catch (err) {
      return [];
    }
  },
  saveRestoreJobs: async (jobs) => {
    const filePath = path.join(config.dataDir, 'restore-jobs.json');
    await fileStorage.writeJSON(filePath, { jobs });
  },
};
