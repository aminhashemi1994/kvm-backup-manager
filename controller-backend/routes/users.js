const express = require('express');
const router = express.Router();
const authService = require('../services/authService');
const auditService = require('../services/auditService');
const { requireAdmin } = require('../middleware/rbac');

/**
 * All user management routes require admin role.
 */
router.use(requireAdmin);

/**
 * GET /api/users - List all users
 */
router.get('/', async (req, res, next) => {
  try {
    const users = await authService.listUsers();
    res.json({ success: true, data: users });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/users/:id - Get single user
 */
router.get('/:id', async (req, res, next) => {
  try {
    const user = await authService.getUserById(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    res.json({ success: true, data: user });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/users - Create user
 */
router.post('/', async (req, res, next) => {
  try {
    const { username, password, role, email, fullName, accessGrants } = req.body;
    const result = await authService.createUser({ username, password, role, email, fullName, accessGrants });

    if (!result.success) {
      return res.status(400).json(result);
    }

    // Audit
    await auditService.log('user.create', {
      actor: req.user.username,
      actorId: req.user.id,
      actorRole: req.user.role,
      targetType: 'user',
      targetId: result.data.id,
      targetName: username,
      details: { role, accessGrants },
      ip: req.ip,
    });

    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/users/:id - Update user
 */
router.put('/:id', async (req, res, next) => {
  try {
    const result = await authService.updateUser(req.params.id, req.body);

    if (!result.success) {
      return res.status(400).json(result);
    }

    // Audit
    const changes = Object.keys(req.body).filter(k => k !== 'password');
    await auditService.log('user.update', {
      actor: req.user.username,
      actorId: req.user.id,
      actorRole: req.user.role,
      targetType: 'user',
      targetId: req.params.id,
      targetName: result.data.username,
      details: { changedFields: changes },
      ip: req.ip,
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/users/:id - Delete user
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const user = await authService.getUserById(req.params.id);
    const result = await authService.deleteUser(req.params.id, req.user.id);

    if (!result.success) {
      return res.status(400).json(result);
    }

    // Audit
    await auditService.log('user.delete', {
      actor: req.user.username,
      actorId: req.user.id,
      actorRole: req.user.role,
      targetType: 'user',
      targetId: req.params.id,
      targetName: user ? user.username : 'unknown',
      ip: req.ip,
    });

    res.json({ success: true, message: 'User deleted' });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/users/:id/grant-access - Grant backup host access
 */
router.post('/:id/grant-access', async (req, res, next) => {
  try {
    const { backupHostIds } = req.body;
    if (!Array.isArray(backupHostIds) || backupHostIds.length === 0) {
      return res.status(400).json({ success: false, error: 'backupHostIds array is required' });
    }

    const result = await authService.grantAccess(req.params.id, backupHostIds);
    if (!result.success) {
      return res.status(400).json(result);
    }

    // Audit
    const user = await authService.getUserById(req.params.id);
    await auditService.log('user.grant_access', {
      actor: req.user.username,
      actorId: req.user.id,
      actorRole: req.user.role,
      targetType: 'user',
      targetId: req.params.id,
      targetName: user ? user.username : 'unknown',
      details: { grantedHostIds: backupHostIds },
      ip: req.ip,
    });

    res.json({ success: true, data: result.data });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/users/:id/revoke-access - Revoke backup host access
 */
router.post('/:id/revoke-access', async (req, res, next) => {
  try {
    const { backupHostIds } = req.body;
    if (!Array.isArray(backupHostIds) || backupHostIds.length === 0) {
      return res.status(400).json({ success: false, error: 'backupHostIds array is required' });
    }

    const result = await authService.revokeAccess(req.params.id, backupHostIds);
    if (!result.success) {
      return res.status(400).json(result);
    }

    // Audit
    const user = await authService.getUserById(req.params.id);
    await auditService.log('user.revoke_access', {
      actor: req.user.username,
      actorId: req.user.id,
      actorRole: req.user.role,
      targetType: 'user',
      targetId: req.params.id,
      targetName: user ? user.username : 'unknown',
      details: { revokedHostIds: backupHostIds },
      ip: req.ip,
    });

    res.json({ success: true, data: result.data });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
