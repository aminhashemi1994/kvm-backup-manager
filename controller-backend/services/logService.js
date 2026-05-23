const { appendLog, readLog } = require('./fileStorage');

class LogService {
  /**
   * Log a message for a job
   */
  async log(jobId, message) {
    try {
      await appendLog(jobId, message);
      console.log(`[Job ${jobId.substring(0, 8)}] ${message}`);
    } catch (error) {
      console.error(`Error logging for job ${jobId}:`, error);
    }
  }

  /**
   * Get logs for a job
   */
  async getLogs(jobId) {
    try {
      return await readLog(jobId);
    } catch (error) {
      console.error(`Error reading logs for job ${jobId}:`, error);
      return '';
    }
  }

  /**
   * Parse log file into array of entries
   */
  async getParsedLogs(jobId) {
    const logs = await this.getLogs(jobId);
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
   * Stream log updates
   */
  async streamLog(jobId, io) {
    // This is called when agent sends log updates
    // We forward them to the frontend
    io.to(`job-${jobId}`).emit('backup-log', {
      jobId,
      timestamp: new Date().toISOString(),
    });
  }
}

// Export singleton instance
const logService = new LogService();

module.exports = logService;
