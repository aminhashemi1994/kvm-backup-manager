const cron = require('node-cron');

const validateBackupHost = (data) => {
  const errors = [];

  if (!data.name || typeof data.name !== 'string' || data.name.trim() === '') {
    errors.push('Name is required');
  }

  if (!data.url || typeof data.url !== 'string') {
    errors.push('URL is required');
  } else {
    try {
      new URL(data.url);
    } catch {
      errors.push('URL must be valid (e.g., http://192.168.1.100:3001)');
    }
  }

  return { isValid: errors.length === 0, errors };
};

const validateHypervisor = (data) => {
  const errors = [];

  if (!data.name || typeof data.name !== 'string' || data.name.trim() === '') {
    errors.push('Name is required');
  }

  if (!data.ip || typeof data.ip !== 'string') {
    errors.push('IP address is required');
  }

  if (!data.backupHostId || typeof data.backupHostId !== 'string') {
    errors.push('Backup host ID is required');
  }

  // NOTE: privateKey is no longer required - SSH keys are configured on the backup host server

  if (data.port && (typeof data.port !== 'number' || data.port < 1 || data.port > 65535)) {
    errors.push('Port must be between 1 and 65535');
  }

  return { isValid: errors.length === 0, errors };
};

const validateSchedule = (data) => {
  const errors = [];

  if (!data.vmId || typeof data.vmId !== 'string') {
    errors.push('VM ID is required');
  }

  if (!data.scheduleType || !['daily', 'weekly', 'custom-days', 'interval', 'cron', 'once', 'monthly'].includes(data.scheduleType)) {
    errors.push('Schedule type must be: daily, weekly, custom-days, interval, cron, once, or monthly');
  }

  // Type-specific validation
  switch (data.scheduleType) {
    case 'daily':
      if (!data.time || !/^\d{2}:\d{2}$/.test(data.time)) {
        errors.push('Time is required in HH:MM format for daily schedules');
      }
      if (!data.incrementalCount || typeof data.incrementalCount !== 'number' || data.incrementalCount < 1) {
        errors.push('Incremental count must be a positive number for daily schedules');
      }
      break;

    case 'weekly':
      if (!data.time || !/^\d{2}:\d{2}$/.test(data.time)) {
        errors.push('Time is required in HH:MM format for weekly schedules');
      }
      if (!data.daysOfWeek || !Array.isArray(data.daysOfWeek) || data.daysOfWeek.length === 0) {
        errors.push('Days of week are required for weekly schedules');
      } else if (!data.daysOfWeek.every(d => d >= 0 && d <= 6)) {
        errors.push('Days of week must be between 0 (Sunday) and 6 (Saturday)');
      }
      if (!data.fullBackupDay || typeof data.fullBackupDay !== 'number' || data.fullBackupDay < 0 || data.fullBackupDay > 6) {
        errors.push('Full backup day must be specified (0-6) for weekly schedules');
      }
      break;

    case 'custom-days':
      if (!data.customDates || !Array.isArray(data.customDates) || data.customDates.length === 0) {
        errors.push('Custom dates are required for custom-days schedules');
      } else {
        // Ensure first date is full
        if (data.customDates[0].method !== 'full') {
          errors.push('First custom date must be a full backup');
        }
        
        data.customDates.forEach((cd, idx) => {
          if (!cd.date || !cd.time || !cd.method) {
            errors.push(`Custom date ${idx + 1} must have date, time, and method`);
          }
          if (cd.method && !['full', 'inc'].includes(cd.method)) {
            errors.push(`Custom date ${idx + 1} method must be full or inc`);
          }
        });
      }
      if (!data.retentionCount || typeof data.retentionCount !== 'number' || data.retentionCount < 1) {
        errors.push('Retention count is required for custom-days schedules');
      }
      break;

    case 'interval':
      if (!data.intervalValue || typeof data.intervalValue !== 'number' || data.intervalValue < 1) {
        errors.push('Interval value must be a positive number');
      }
      if (!data.intervalUnit || !['hours', 'days'].includes(data.intervalUnit)) {
        errors.push('Interval unit must be hours or days');
      }
      if (!data.incrementalCount || typeof data.incrementalCount !== 'number' || data.incrementalCount < 1) {
        errors.push('Incremental count must be a positive number for interval schedules');
      }
      break;

    case 'cron':
      if (!data.cronExpression || typeof data.cronExpression !== 'string') {
        errors.push('Cron expression is required for cron schedules');
      } else if (!cron.validate(data.cronExpression)) {
        errors.push('Invalid cron expression');
      }
      if (!data.incrementalCount || typeof data.incrementalCount !== 'number' || data.incrementalCount < 1) {
        errors.push('Incremental count must be a positive number for cron schedules');
      }
      break;

    case 'once':
      if (!data.time || !/^\d{2}:\d{2}$/.test(data.time)) {
        errors.push('Time is required in HH:MM format for once schedules');
      }
      break;

    case 'monthly':
      if (!data.time || !/^\d{2}:\d{2}$/.test(data.time)) {
        errors.push('Time is required in HH:MM format for monthly schedules');
      }
      break;
  }

  // Validate optional missed-run policy fields
  if (data.missedRunPolicy !== undefined) {
    if (!['immediate', 'most-recent', 'skip'].includes(data.missedRunPolicy)) {
      errors.push('missedRunPolicy must be: immediate, most-recent, or skip');
    }
  }
  if (data.missedRunGracePeriodMinutes !== undefined) {
    if (typeof data.missedRunGracePeriodMinutes !== 'number' || data.missedRunGracePeriodMinutes < 0) {
      errors.push('missedRunGracePeriodMinutes must be a non-negative number');
    }
  }

  return { isValid: errors.length === 0, errors };
};

const validateBackupTrigger = (data) => {
  const errors = [];

  if (!data.vmId || typeof data.vmId !== 'string') {
    errors.push('VM ID is required');
  }

  if (!data.method || !['full', 'inc', 'copy'].includes(data.method)) {
    errors.push('Method must be: full, inc, or copy');
  }

  return { isValid: errors.length === 0, errors };
};

module.exports = {
  validateBackupHost,
  validateHypervisor,
  validateSchedule,
  validateBackupTrigger,
};
