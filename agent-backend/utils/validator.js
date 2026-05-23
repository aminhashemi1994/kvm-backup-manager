/**
 * Validation utilities for agent
 */

const validateBackupRequest = (data) => {
  const errors = [];

  if (!data.jobId || typeof data.jobId !== 'string') {
    errors.push('jobId is required');
  }

  if (!data.vmName || typeof data.vmName !== 'string') {
    errors.push('vmName is required');
  }

  if (!data.hypervisorIp || typeof data.hypervisorIp !== 'string') {
    errors.push('hypervisorIp is required');
  }

  if (!data.method || !['full', 'inc', 'copy'].includes(data.method)) {
    errors.push('method must be one of: full, inc, copy');
  }

  if (data.compression !== undefined) {
    if (typeof data.compression !== 'number' || data.compression < 2 || data.compression > 16) {
      errors.push('compression must be a number between 2 and 16');
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
};

const validateHypervisorRequest = (data) => {
  const errors = [];

  if (!data.id || typeof data.id !== 'string') {
    errors.push('id is required');
  }

  if (!data.name || typeof data.name !== 'string') {
    errors.push('name is required');
  }

  if (!data.ip || typeof data.ip !== 'string') {
    errors.push('ip is required');
  }

  if (!data.privateKey || typeof data.privateKey !== 'string') {
    errors.push('privateKey is required');
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
};

module.exports = {
  validateBackupRequest,
  validateHypervisorRequest,
};
