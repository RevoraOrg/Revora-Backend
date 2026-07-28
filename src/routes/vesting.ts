import { Router } from 'express';
import { VestingService, PartialClaimRequest } from '../services/vestingService';
import { requireAuth } from '../middleware/auth';

const router = Router();
const vestingService = new VestingService();

/**
 * POST /api/v1/vesting/claim
 * Process a partial claim for a vesting schedule
 */
router.post('/claim', requireAuth, async (req, res) => {
  try {
    const { scheduleId, claimAmount } = req.body;
    const userId = req.user?.id;

    if (!scheduleId || typeof claimAmount !== 'number' || claimAmount < 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request: scheduleId and non-negative claimAmount required'
      });
    }

    const request: PartialClaimRequest = {
      scheduleId,
      claimAmount,
      userId: userId || ''
    };

    const result = await vestingService.processPartialClaim(request);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
        remainingAmount: result.remainingAmount
      });
    }

    res.json({
      success: true,
      claimedAmount: result.claimedAmount,
      remainingAmount: result.remainingAmount
    });
  } catch (error) {
    console.error('Vesting claim error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

export default router;