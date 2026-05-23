const { Client } = require('ssh2');
const config = require('../config/config');

class SSHService {
  /**
   * Validate and normalize private key
   */
  normalizePrivateKey(privateKey) {
    if (!privateKey) {
      throw new Error('Private key is required');
    }

    let key = privateKey.trim();

    if (!key.includes('-----BEGIN') || !key.includes('PRIVATE KEY')) {
      throw new Error('Invalid private key format. Must include BEGIN/END markers.');
    }

    key = key.replace(/\r\n/g, '\n');
    
    const lines = key.split('\n');
    if (lines.length < 3) {
      key = key
        .replace(/(-----BEGIN [A-Z ]+ PRIVATE KEY-----)/, '$1\n')
        .replace(/(-----END [A-Z ]+ PRIVATE KEY-----)/, '\n$1');
    }

    if (!key.endsWith('\n')) {
      key += '\n';
    }

    return key;
  }

  /**
   * Create SSH connection
   */
  async createConnection(host, port, username, privateKey) {
    const normalizedKey = this.normalizePrivateKey(privateKey);

    return new Promise((resolve, reject) => {
      const conn = new Client();

      const timeout = setTimeout(() => {
        conn.end();
        reject(new Error('SSH connection timeout'));
      }, config.sshTimeout);

      conn.on('ready', () => {
        clearTimeout(timeout);
        resolve(conn);
      });

      conn.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      try {
        conn.connect({
          host,
          port: port || 22,
          username: username || 'root',
          privateKey: normalizedKey,
          readyTimeout: config.sshReadyTimeout,
        });
      } catch (err) {
        clearTimeout(timeout);
        reject(err);
      }
    });
  }

  /**
   * Execute command via SSH
   */
  async executeCommand(conn, command) {
    return new Promise((resolve, reject) => {
      conn.exec(command, (err, stream) => {
        if (err) {
          return reject(err);
        }

        let stdout = '';
        let stderr = '';

        stream.on('close', (code, signal) => {
          resolve({ stdout, stderr, exitCode: code });
        });

        stream.on('data', (data) => {
          stdout += data.toString();
        });

        stream.stderr.on('data', (data) => {
          stderr += data.toString();
        });
      });
    });
  }

  /**
   * Execute command with real-time output streaming
   */
  async executeCommandStream(conn, command, onStdout, onStderr, onClose) {
    return new Promise((resolve, reject) => {
      conn.exec(command, { pty: true }, (err, stream) => {
        if (err) {
          return reject(err);
        }

        stream.on('close', (code, signal) => {
          if (onClose) onClose(code, signal);
          resolve({ exitCode: code });
        });

        stream.on('data', (data) => {
          const output = data.toString();
          if (onStdout) onStdout(output);
        });

        stream.stderr.on('data', (data) => {
          const output = data.toString();
          if (onStderr) onStderr(output);
        });
      });
    });
  }

  /**
   * Test SSH connection (health check)
   */
  async testConnection(host, port, username, privateKey) {
    let conn;
    try {
      conn = await this.createConnection(host, port, username, privateKey);
      const result = await this.executeCommand(conn, 'echo "OK"');
      return {
        success: true,
        message: 'SSH connection successful',
      };
    } catch (error) {
      console.error(`SSH test connection failed for ${host}:${port}:`, error.message);
      return {
        success: false,
        message: error.message || 'SSH connection failed',
      };
    } finally {
      if (conn) {
        try {
          conn.end();
        } catch (endError) {
          console.error('Error closing SSH connection:', endError.message);
        }
      }
    }
  }

  /**
   * List VMs using virsh list --all
   * 
   * Example output:
   *  Id   Name                                                State
   * -------------------------------------------------------------------
   *  1    vm-web-01                                           running
   *  2    vm-db-01                                            running
   *  -    vm-test-01                                          shut off
   *  -    vm-dev-01                                           paused
   */
  async listVMs(host, port, username, privateKey) {
    let conn;
    try {
      conn = await this.createConnection(host, port, username, privateKey);
      const result = await this.executeCommand(conn, 'virsh list --all');
      
      if (result.exitCode !== 0) {
        throw new Error(`virsh command failed: ${result.stderr}`);
      }

      // Parse virsh output
      const lines = result.stdout.split('\n');
      const vms = [];

      // Skip header lines (find the separator line with dashes)
      let dataStartIndex = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.match(/^-+$/)) {
          // Found separator line like "-------------------"
          dataStartIndex = i + 1;
          break;
        }
      }

      // Parse each VM line
      for (let i = dataStartIndex; i < lines.length; i++) {
        const line = lines[i];
        if (!line || !line.trim()) continue;

        // Parse the line more carefully
        // The format is: ID (right-aligned), Name, State
        // ID can be a number or "-" for shut off VMs
        // Name can contain dots, dashes, underscores
        // State can be: running, shut off, paused, crashed, idle, etc.
        
        // Split by multiple spaces (2 or more)
        const parts = line.trim().split(/\s{2,}/);
        
        if (parts.length >= 3) {
          const id = parts[0].trim();
          const name = parts[1].trim();
          const state = parts.slice(2).join(' ').trim();
          
          if (name && state) {
            vms.push({
              id: id === '-' ? null : parseInt(id, 10),
              name: name,
              state: state,
            });
          }
        } else if (parts.length === 2) {
          // Sometimes state might be joined with name if there's only one space
          // Try alternative parsing
          const match = line.match(/^\s*(-|\d+)\s+(\S+.*?)\s+(running|shut off|paused|crashed|idle|in shutdown|pmsuspended)\s*$/i);
          if (match) {
            vms.push({
              id: match[1] === '-' ? null : parseInt(match[1], 10),
              name: match[2].trim(),
              state: match[3].trim(),
            });
          }
        }
      }

      console.log(`Parsed ${vms.length} VMs from virsh output`);
      
      // Debug: log first few and last few VMs
      if (vms.length > 0) {
        console.log('First VM:', vms[0]);
        console.log('Last VM:', vms[vms.length - 1]);
        const shutOffCount = vms.filter(vm => vm.state.toLowerCase().includes('shut')).length;
        const runningCount = vms.filter(vm => vm.state.toLowerCase() === 'running').length;
        console.log(`Running: ${runningCount}, Shut off: ${shutOffCount}`);
      }
      
      return vms;
    } catch (error) {
      console.error(`Error listing VMs from ${host}:${port}:`, error.message);
      throw error;
    } finally {
      if (conn) {
        try {
          conn.end();
        } catch (endError) {
          console.error('Error closing SSH connection:', endError.message);
        }
      }
    }
  }

  /**
   * Check if directory exists on remote host
   */
  async directoryExists(host, port, username, privateKey, dirPath) {
    let conn;
    try {
      conn = await this.createConnection(host, port, username, privateKey);
      const result = await this.executeCommand(conn, `test -d "${dirPath}" && echo "exists" || echo "not_exists"`);
      return result.stdout.trim() === 'exists';
    } finally {
      if (conn) {
        conn.end();
      }
    }
  }

  /**
   * Create directory on remote host
   */
  async createDirectory(host, port, username, privateKey, dirPath) {
    let conn;
    try {
      conn = await this.createConnection(host, port, username, privateKey);
      const result = await this.executeCommand(conn, `mkdir -p "${dirPath}"`);
      return result.exitCode === 0;
    } finally {
      if (conn) {
        conn.end();
      }
    }
  }
}

const sshService = new SSHService();
module.exports = sshService;
