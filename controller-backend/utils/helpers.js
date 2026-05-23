/**
 * Helper utilities
 */

/**
 * Generate cron expression from schedule options
 */
const generateCronExpression = (options) => {
  const { type, time, daysOfWeek, intervalValue, intervalUnit, cronExpression } = options;

  switch (type) {
    case 'daily':
      const [hour, minute] = (time || '00:00').split(':');
      return `${minute} ${hour} * * *`;
    
    case 'weekly':
      const [wHour, wMinute] = (time || '00:00').split(':');
      const days = daysOfWeek || [0]; // Default to Sunday
      return `${wMinute} ${wHour} * * ${days.join(',')}`;
    
    case 'interval':
      if (intervalUnit === 'hours') {
        return `0 */${intervalValue || 1} * * *`;
      } else {
        // days
        return `0 0 */${intervalValue || 1} * *`;
      }
    
    case 'cron':
      return cronExpression || '0 0 * * *';
    
    case 'custom-days':
      // Custom days don't use a single cron expression
      // Each date has its own scheduled time
      return null;
    
    case 'once':
      // One-time backup - will be scheduled once and then disabled
      const [oHour, oMinute] = (time || '00:00').split(':');
      return `${oMinute} ${oHour} * * *`;
    
    case 'monthly':
      // Monthly on the 1st of each month
      const [mHour, mMinute] = (time || '00:00').split(':');
      return `${mMinute} ${mHour} 1 * *`;
    
    default:
      return '0 0 * * *';
  }
};

/**
 * Parse cron expression to human-readable format
 */
const parseCronToHuman = (cronExpression) => {
  if (!cronExpression) return 'Custom schedule';
  
  const parts = cronExpression.split(' ');
  if (parts.length !== 5) return cronExpression;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  // Daily
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*' && !hour.includes('/')) {
    return `Daily at ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  }

  // Monthly (1st of each month)
  if (dayOfMonth === '1' && month === '*' && dayOfWeek === '*') {
    return `Monthly on the 1st at ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  }

  // Interval - hours
  if (hour.includes('/') && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    const interval = hour.split('/')[1];
    return `Every ${interval} hour${interval > 1 ? 's' : ''}`;
  }

  // Interval - days
  if (dayOfMonth.includes('/') && month === '*' && dayOfWeek === '*') {
    const interval = dayOfMonth.split('/')[1];
    return `Every ${interval} day${interval > 1 ? 's' : ''} at ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  }

  // Weekly
  if (dayOfMonth === '*' && month === '*' && dayOfWeek !== '*') {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const selectedDays = dayOfWeek.split(',').map(d => days[parseInt(d)]).join(', ');
    return `Weekly on ${selectedDays} at ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  }

  return cronExpression;
};

/**
 * Format bytes to human-readable
 */
const formatBytes = (bytes, decimals = 2) => {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};

/**
 * Format duration
 */
const formatDuration = (startTime, endTime) => {
  const start = new Date(startTime);
  const end = endTime ? new Date(endTime) : new Date();
  const diff = Math.floor((end - start) / 1000);

  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ${diff % 60}s`;
  return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`;
};

/**
 * Sleep helper
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

module.exports = {
  generateCronExpression,
  parseCronToHuman,
  formatBytes,
  formatDuration,
  sleep,
};
