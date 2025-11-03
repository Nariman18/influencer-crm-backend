import { Response, NextFunction } from "express";
import { AuthRequest } from "../types";
import { verifyToken } from "../utils/jwt";
import { UserRole } from "@prisma/client";

export const authenticate = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void => {
  try {
    const authHeader = req.headers.authorization;

    console.log("🔐 [AUTH PRODUCTION] Auth header present:", !!authHeader);

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      console.log("❌ [AUTH PRODUCTION] No valid token provided");
      res.status(401).json({ error: "No token provided" });
      return;
    }

    const token = authHeader.substring(7);

    console.log("🔐 [AUTH PRODUCTION] Token details:", {
      tokenLength: token.length,
      first10: token.substring(0, 10) + "...",
      environment: process.env.NODE_ENV,
    });

    const user = verifyToken(token);

    console.log("✅ [AUTH PRODUCTION] User authenticated successfully:", {
      id: user.id,
      name: user.name,
      email: user.email,
      environment: process.env.NODE_ENV,
    });

    req.user = user;
    next();
  } catch (error) {
    console.error("❌ [AUTH PRODUCTION] Authentication failed:", {
      error: error instanceof Error ? error.message : "Unknown error",
      environment: process.env.NODE_ENV,
    });
    res.status(401).json({ error: "Invalid or expired token" });
  }
};

export const authorize = (...roles: UserRole[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      console.log("❌ [AUTHORIZE PRODUCTION] No user in request");
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    console.log("👤 [AUTHORIZE PRODUCTION] User authorized:", {
      id: req.user.id,
      name: req.user.name,
      role: req.user.role,
    });

    if (!roles.includes(req.user.role)) {
      console.log("❌ [AUTHORIZE PRODUCTION] Insufficient permissions");
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    next();
  };
};
