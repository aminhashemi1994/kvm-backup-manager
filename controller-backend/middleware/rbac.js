/**
 * RBAC Middleware (Item 9)
 *
 * Roles:
 *   - admin:  full access to everything
 *   - user:   read all, write only on granted backup hosts
 *   - viewer: read-only, no write actions ever
 *
 * Visibility: all roles see all hosts (option a from user answers).
 * Action restriction: users can only act on hosts in their accessGrants.
 */

/**
 * Require a minimum role level.
 * admin > user > viewer
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    // Agent tokens bypass RBAC
    if (req.tokenType === 'agent-static' || req.tokenType === 'agent') {
      return next();
    }

    const userRole = req.user?.role;
    if (!userRole) {
      return res.status(403).json({ success: false, error: 'No role assigned' });
    }

    if (allowedRoles.includes(userRole)) {
      return next();
    }

    return res.status(403).json({
      success: false,
      error: `Insufficient permissions. Required role: ${allowedRoles.join(' or ')}. Your role: ${userRole}`,
    });
  };
}

/**
 * Require admin role.
 */
const requireAdmin = requireRole('admin');

/**
 * Require at least user role (admin or user, not viewer).
 */
const requireUser = requireRole('admin', 'user');

/**
 * Check if the user has access to a specific backup host.
 * Admin always has access. User must have the host in accessGrants.
 * Viewer never has write access.
 *
 * Usage: requireHostAccess('body.backupHostId') or requireHostAccess('params.id')
 * The argument is a dot-path to where the backupHostId lives in the request.
 */
function requireHostAccess(hostIdPath) {
  return (req, res, next) => {
    // Agent tokens bypass
    if (req.tokenType === 'agent-static' || req.tokenType === 'agent') {
      return next();
    }

    const userRole = req.user?.role;

    // Admin always passes
    if (userRole === 'admin') return next();

    // Viewer never has write access
    if (userRole === 'viewer') {
      return res.status(403).json({
        success: false,
        error: 'Viewers do not have permission to perform this action',
      });
    }

    // User role — check access grants
    const hostId = getNestedValue(req, hostIdPath);
    if (!hostId) {
      // If we can't determine the host, deny by default
      return res.status(403).json({
        success: false,
        error: 'Cannot determine target backup host for access check',
      });
    }

    const grants = req.user?.accessGrants?.backupHostIds || [];
    if (grants.includes(hostId)) {
      return next();
    }

    return res.status(403).json({
      success: false,
      error: 'You do not have access to this backup host. Contact an admin to grant access.',
    });
  };
}

/**
 * Helper: get nested value from object by dot-path.
 * e.g. getNestedValue(req, 'body.backupHostId')
 */
function getNestedValue(obj, path) {
  return path.split('.').reduce((o, key) => (o && o[key] !== undefined ? o[key] : undefined), obj);
}

module.exports = {
  requireRole,
  requireAdmin,
  requireUser,
  requireHostAccess,
};
