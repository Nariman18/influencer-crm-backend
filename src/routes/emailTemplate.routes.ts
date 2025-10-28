import { Router } from 'express';
import * as emailTemplateController from '../controllers/emailTemplate.controller';
import { authenticate } from '../middleware/auth';
import { auditLog } from '../middleware/auditLog';

const router = Router();

router.use(authenticate);

router.get('/', emailTemplateController.getEmailTemplates);
router.get('/:id', emailTemplateController.getEmailTemplate);
router.post('/', auditLog('CREATE', 'EMAIL_TEMPLATE'), emailTemplateController.createEmailTemplate);
router.put('/:id', auditLog('UPDATE', 'EMAIL_TEMPLATE'), emailTemplateController.updateEmailTemplate);
router.delete('/:id', auditLog('DELETE', 'EMAIL_TEMPLATE'), emailTemplateController.deleteEmailTemplate);

export default router;

