const fs = require('fs').promises;
const path = require('path');
const config = require('../config/config');

class LogService {
  /**
   * Read log file
   */
  async getLog(jobId) {
    const logPath = path.join(config.logDir, `${jobId}.log`);
    try {
      return await fs.readFile(logPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        return '';
      }
      throw error;
    }
  }

  /**
   * Get parsed log entries
   */
  async getParsedLog(jobId) {
    const logs = await this.getLog(jobId);
    if (!logs) return [];

    const lines = logs.split('\n').filter(line => line.trim());
    return lines.map(line => {
      const match = line.match(/^\[(.*?)\] (.*)$/);
      if (match) {
        return {
          timestamp: match[1],
          message: match[2],
        };
      }
      return {
        timestamp: null,
        message: line,
      };
    });
  }

  /**
   * List all log files
   */
  async listLogs() {
    try {
      const files = await fs.readdir(config.logDir);
      const logs = [];

      for (const file of files) {
        if (file.endsWith('.log')) {
          const filePath = path.join(config.logDir, file);
          const stats = await fs.stat(filePath);
          logs.push({
            jobId: file.replace('.log', ''),
            size: stats.size,
            created: stats.birthtime,
            modified: stats.mtime,
          });
        }
      }

      // Sort by modified date descending
      logs.sort((a, b) => new Date(b.modified) - new Date(a.modified));

      return logs;
    } catch (error) {
      return [];
    }
  }

  /**
   * Delete old logs
   */
  async cleanOldLogs(maxAgeDays = 30) {
    const files = await fs.readdir(config.logDir);
    const now = Date.now();
    const maxAge = maxAgeDays * 24 * 60 * 60 * 1000;
    let deletedCount = 0;

    for (const file of files) {
      if (!file.endsWith('.log')) continue;

      const filePath = path.join(config.logDir, file);
      const stats = await fs.stat(filePath);
      
      if (now - stats.mtimeMs > maxAge) {
        await fs.unlink(filePath);
        deletedCount++;
      }
    }

    return { deleted: deletedCount };
  }
}

// Export singleton instance
const logService = new LogService();

module.exports = logService;
