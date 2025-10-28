import { Router } from "express";
import * as authController from "../controllers/auth.controller";
import { authenticate } from "../middleware/auth";
import {
  connectGoogleAccount,
  exchangeGoogleToken,
  disconnectGoogleAccount,
} from "../controllers/googleAuth.controller";

const router = Router();

router.post("/register", authController.register);
router.post("/login", authController.login);
router.get("/profile", authenticate, authController.getProfile);
router.put("/profile", authenticate, authController.updateProfile);

// Make token exchange public - it uses the code for authentication
router.post("/google/exchange-token", exchangeGoogleToken);

// This endpoint still requires authentication to associate tokens with user
router.post("/google/connect", authenticate, connectGoogleAccount);
router.post("/google/disconnect", authenticate, disconnectGoogleAccount);

export default router;
