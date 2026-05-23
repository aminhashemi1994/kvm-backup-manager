const express = require('express');
const router = express.Router();
const auditService = require('../services/auditService');
const { requireAdmin } = require('../middleware/rbac');

/**
 * GET /api/audit - Query audit logs (admin only)
 * Query params: page, limit, action, actor, targetType, targetId, from, to
 */
router.get('/', requireAdmin, async (req, res, next) => {
  try {
    const { page, limit, action, actor, targetType, targetId, from, to } = req.query;
    const result = await auditService.query({
      page: parseInt(page) || 1,
      limit: parseInt(limit) || 50,
      action,
      actor,
      targetType,
      targetId,
      from,
      to,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/audit/stats - Get audit stats (admin only)
 */
router.get('/stats', requireAdmin, async (req, res, next) => {
  try {
    const stats = await auditService.getStats();
    res.json({ success: true, data: stats });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
