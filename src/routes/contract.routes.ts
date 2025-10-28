import { Router } from 'express';
import * as contractController from '../controllers/contract.controller';
import { authenticate } from '../middleware/auth';
import { auditLog } from '../middleware/auditLog';

const router = Router();

router.use(authenticate);

router.get('/', contractController.getContracts);
router.get('/:id', contractController.getContract);
router.post('/', auditLog('CREATE', 'CONTRACT'), contractController.createContract);
router.put('/:id', auditLog('UPDATE', 'CONTRACT'), contractController.updateContract);
router.delete('/:id', auditLog('DELETE', 'CONTRACT'), contractController.deleteContract);

export default router;

