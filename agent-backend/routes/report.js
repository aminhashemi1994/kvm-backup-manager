const express = require('express');
const router = express.Router();
const reportService = require('../services/reportService');

/**
 * GET /api/report
 * Get the current backup report
 */
router.get('/', async (req, res, next) => {
  try {
    const result = await reportService.getReport();
    
    if (result.success) {
      res.json({
        success: true,
        data: result.data,
        meta: {
          lastGenerated: result.lastGenerated,
          isGenerating: result.isGenerating
        }
      });
    } else {
      // Report doesn't exist
      res.status(404).json({
        success: false,
        error: result.error,
        isGenerating: result.isGenerating
      });
    }
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/report/status
 * Get report generation status
 */
router.get('/status', (req, res, next) => {
  try {
    const status = reportService.getStatus();
    res.json({
      success: true,
      data: status
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/report/generate
 * Trigger manual report generation
 * This endpoint waits for the generation to complete before responding
 */
router.post('/generate', async (req, res, next) => {
  try {
    console.log('[Report Route] Manual generation requested');
    
    // Check status first
    const statusBefore = reportService.getStatus();
    
    // Check if already generating - return 409 Conflict
    if (statusBefore.isGenerating) {
      console.log('[Report Route] Returning 409 - Already generating');
      return res.status(409).json({
        success: false,
        error: 'Report generation already in progress',
        message: 'Another report generation is currently running. Please wait for it to complete.',
        isGenerating: true
      });
    }
    
    // Check rate limit
    if (statusBefore.rateLimit && !statusBefore.rateLimit.canRequestNow) {
      console.log('[Report Route] Returning 429 - Rate Limited');
      return res.status(429).json({
        success: false,
        error: `Please wait ${statusBefore.rateLimit.remainingSeconds} seconds before requesting another report`,
        rateLimited: true,
        remainingSeconds: statusBefore.rateLimit.remainingSeconds,
        nextAllowedAt: statusBefore.rateLimit.nextAllowedAt
      });
    }
    
    // Start generation and WAIT for it to complete
    console.log('[Report Route] Starting generation and waiting for completion...');
    const result = await reportService.generateReport(true);
    
    if (result.success) {
      console.log('[Report Route] Generation completed successfully');
      return res.status(200).json({
        success: true,
        message: 'Report generated successfully',
        data: {
          generatedAt: result.generatedAt,
          fileSizeBytes: result.fileSizeBytes,
          durationSeconds: result.durationSeconds
        }
      });
    } else if (result.rateLimited) {
      console.log('[Report Route] Rate limited');
      return res.status(429).json(result);
    } else {
      console.error('[Report Route] Generation failed:', result.error);
      return res.status(500).json({
        success: false,
        error: result.error || 'Report generation failed',
        message: 'Failed to generate backup report'
      });
    }
  } catch (error) {
    console.error('[Report Route] Error:', error);
    next(error);
  }
});

/**
 * POST /api/report/generate-now
 *
 * Internal: same as /generate but bypasses the manual-rate-limit. Used by
 * the controller's "download report" flow so the user can refresh data
 * on demand without being blocked by the 2-minute cooldown. The
 * "already generating" check is preserved so concurrent requests don't
 * spawn duplicate generations — the second caller gets a 202 and can
 * poll status if needed.
 */
router.post('/generate-now', async (req, res, next) => {
  try {
    console.log('[Report Route] /generate-now invoked (rate-limit bypass)');

    const statusBefore = reportService.getStatus();
    if (statusBefore.isGenerating) {
      console.log('[Report Route] /generate-now: another generation already running');
      return res.status(202).json({
        success: true,
        message: 'Report generation already in progress',
        isGenerating: true,
      });
    }

    // isManual=false skips the 2-minute cooldown
    const result = await reportService.generateReport(false);
    if (!result.success) {
      return res.status(500).json({
        success: false,
        error: result.error || 'Report generation failed',
      });
    }
    return res.status(200).json({
      success: true,
      message: 'Report regenerated',
      data: {
        generatedAt: result.generatedAt,
        fileSizeBytes: result.fileSizeBytes,
        durationSeconds: result.durationSeconds,
      },
    });
  } catch (error) {
    console.error('[Report Route] /generate-now error:', error);
    next(error);
  }
});

module.exports = router;
