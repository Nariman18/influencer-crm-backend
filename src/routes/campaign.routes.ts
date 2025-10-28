import { Router } from 'express';
import * as campaignController from '../controllers/campaign.controller';
import { authenticate } from '../middleware/auth';
import { auditLog } from '../middleware/auditLog';

const router = Router();

router.use(authenticate);

router.get('/', campaignController.getCampaigns);
router.get('/:id', campaignController.getCampaign);
router.post('/', auditLog('CREATE', 'CAMPAIGN'), campaignController.createCampaign);
router.put('/:id', auditLog('UPDATE', 'CAMPAIGN'), campaignController.updateCampaign);
router.delete('/:id', auditLog('DELETE', 'CAMPAIGN'), campaignController.deleteCampaign);
router.post('/:id/influencers', auditLog('ADD_INFLUENCER', 'CAMPAIGN'), campaignController.addInfluencerToCampaign);
router.delete('/:id/influencers/:influencerId', auditLog('REMOVE_INFLUENCER', 'CAMPAIGN'), campaignController.removeInfluencerFromCampaign);

export default router;

