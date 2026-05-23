const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

class InitHostService {
  constructor() {
    this.io = null;
    this.config = null;
    this.activeInits = new Map();
    this.activeProcesses = new Map();
  }

  initialize(io, config) {
    this.io = io;
    this.config = config;
    console.log('✓ Init Host service initialized');
  }

  /**
   * Initialize a host with real-time progress via Socket.io
   * The agent runs ON the backup host, so we execute the script locally
   */
  async initHost(initId) {
    console.log(`Starting local host initialization: ${initId}`);

    this.activeInits.set(initId, {
      initId,
      status: 'running',
      startTime: new Date().toISOString(),
    });

    const scriptPath = path.join(__dirname, '../scripts/Init_Host.sh');
    
    // Create log file
    const logFile = path.join(this.config.logDir, `init_${initId}.log`);
    const logStream = fs.createWriteStream(logFile, { 
      flags: 'a',
      autoClose: true,
    });

    const log = (message, type = 'info') => {
      const timestamp = new Date().toISOString();
      const entry = `[${timestamp}] [${type}] ${message}\n`;
      
      if (logStream.writable) {
        logStream.write(entry);
      }
      
      // Emit to socket
      if (this.io) {
        this.io.to(`init-${initId}`).emit('init-log', { 
          initId, 
          timestamp, 
          message,
          type 
        });
      }
    };

    log(`Initializing local host`, 'info');
    log(`Script: ${scriptPath}`, 'info');

    return new Promise((resolve) => {
      // Check if script exists
      if (!fs.existsSync(scriptPath)) {
        const error = `Script not found: ${scriptPath}`;
        log(error, 'error');
        logStream.end();
        resolve({ success: false, error });
        return;
      }

      log(`Executing initialization script...`, 'info');
      
      // Execute script locally with unbuffered output
      const initProcess = spawn('bash', [scriptPath], {
        env: { 
          ...process.env,
          PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
        },
        cwd: path.dirname(scriptPath),
        shell: false
      });

      this.activeProcesses.set(initId, initProcess);

      let hasOutput = false;

      // Handle stdout
      initProcess.stdout.on('data', (data) => {
        hasOutput = true;
        const output = data.toString();
        console.log(`[Init ${initId}] stdout:`, output);
        const lines = output.split('\n');
        
        lines.forEach(line => {
          // Remove ANSI color codes and control characters
          const cleaned = line
            .replace(/\x1b\[[0-9;]*m/g, '') // Remove ANSI color codes
            .replace(/\x1b\[K/g, '')         // Remove clear line
            .replace(/\r/g, '')              // Remove carriage returns
            .trim();
          
          if (cleaned) {
            // Detect different types of messages
            let type = 'info';
            if (cleaned.includes('✔') || cleaned.includes('✅') || cleaned.includes('[OK]') || cleaned.includes('Installed')) {
              type = 'success';
            } else if (cleaned.includes('✖') || cleaned.includes('❌') || cleaned.includes('ERROR') || cleaned.includes('Error') || cleaned.includes('Failed')) {
              type = 'error';
            } else if (cleaned.includes('⚠') || cleaned.includes('WARNING') || cleaned.includes('Warning')) {
              type = 'warning';
            } else if (cleaned.includes('⏳') || cleaned.includes('Wait') || cleaned.includes('Installing') || cleaned.includes('Checking')) {
              type = 'progress';
            }
            
            log(cleaned, type);
          }
        });
      });

      // Handle stderr
      initProcess.stderr.on('data', (data) => {
        hasOutput = true;
        const output = data.toString();
        console.log(`[Init ${initId}] stderr:`, output);
        const lines = output.split('\n');
        lines.forEach(line => {
          // Remove ANSI color codes and control characters
          const cleaned = line
            .replace(/\x1b\[[0-9;]*m/g, '') // Remove ANSI color codes
            .replace(/\x1b\[K/g, '')         // Remove clear line
            .replace(/\r/g, '')              // Remove carriage returns
            .trim();
          
          if (cleaned) {
            log(cleaned, 'error');
          }
        });
      });

      // Handle process exit
      initProcess.on('close', (code) => {
        console.log(`[Init ${initId}] Process closed with code: ${code}`);
        
        if (!hasOutput) {
          log('No output received from script. Check script permissions and execution.', 'error');
        }
        
        this.activeProcesses.delete(initId);
        
        const success = code === 0;
        const status = success ? 'completed' : 'failed';
        
        log(`Host initialization ${success ? 'completed successfully' : 'failed'} with exit code: ${code}`, success ? 'success' : 'error');

        // Close log stream after writing final message
        setTimeout(() => {
          logStream.end();
        }, 100);

        // Update init status
        const init = this.activeInits.get(initId);
        if (init) {
          init.status = status;
          init.endTime = new Date().toISOString();
          init.exitCode = code;
        }

        // Emit completion event
        if (this.io) {
          console.log(`[Init ${initId}] Emitting init-complete event: success=${success}, exitCode=${code}`);
          this.io.to(`init-${initId}`).emit('init-complete', {
            initId,
            success,
            exitCode: code,
            status
          });
        }

        // Remove from active after a delay
        setTimeout(() => {
          this.activeInits.delete(initId);
        }, 60000); // Keep for 1 minute

        resolve({ success, exitCode: code });
      });

      // Handle errors
      initProcess.on('error', (error) => {
        console.log(`[Init ${initId}] Process error:`, error);
        log(`Process error: ${error.message}`, 'error');
        
        this.activeProcesses.delete(initId);
        logStream.end();

        const init = this.activeInits.get(initId);
        if (init) {
          init.status = 'failed';
          init.endTime = new Date().toISOString();
          init.error = error.message;
        }

        if (this.io) {
          this.io.to(`init-${initId}`).emit('init-error', {
            initId,
            error: error.message
          });
        }

        resolve({ success: false, error: error.message });
      });
    });
  }

  /**
   * Get active initializations
   */
  getActiveInits() {
    return Array.from(this.activeInits.values());
  }

  /**
   * Read init log file
   */
  async readLog(initId) {
    const logFile = path.join(this.config.logDir, `init_${initId}.log`);
    try {
      return fs.readFileSync(logFile, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        return '';
      }
      throw error;
    }
  }

  /**
   * Cancel/kill an init process
   */
  async killInit(initId) {
    const process = this.activeProcesses.get(initId);
    
    if (!process) {
      return { success: false, message: 'Init process not found or already completed' };
    }

    try {
      process.kill('SIGKILL');
      this.activeProcesses.delete(initId);
      this.activeInits.delete(initId);
      
      return { success: true, message: 'Init process killed successfully' };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }
}

// Export singleton instance
const initHostService = new InitHostService();
module.exports = initHostService;
