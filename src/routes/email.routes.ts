// src/routes/email.routes.ts - CORRECTED VERSION
import { Router } from "express";
import * as emailController from "../controllers/email.controller";
import { authenticate } from "../middleware/auth";
import { auditLog } from "../middleware/auditLog";

const router = Router();

router.use(authenticate);

router.get("/", emailController.getEmails);
router.post("/send", auditLog("SEND", "EMAIL"), emailController.sendEmail);
router.post(
  "/bulk-send",
  auditLog("BULK_SEND", "EMAIL"),
  emailController.bulkSendEmails
);
router.get("/config/validate", emailController.validateEmailConfig);

export default router;
