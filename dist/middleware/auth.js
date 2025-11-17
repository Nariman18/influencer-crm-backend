"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authorize = exports.authenticate = void 0;
const jwt_1 = require("../utils/jwt");
const authenticate = (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        console.log("🔐 [AUTH PRODUCTION] Auth header present:", !!authHeader);
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            console.log("❌ [AUTH PRODUCTION] No valid token provided");
            res.status(401).json({ error: "No token provided" });
            return;
        }
        const token = authHeader.substring(7);
        const user = (0, jwt_1.verifyToken)(token);
        req.user = user;
        next();
    }
    catch (error) {
        console.error("❌ [AUTH PRODUCTION] Authentication failed:", {
            error: error instanceof Error ? error.message : "Unknown error",
            environment: process.env.NODE_ENV,
        });
        res.status(401).json({ error: "Invalid or expired token" });
    }
};
exports.authenticate = authenticate;
const authorize = (...roles) => {
    return (req, res, next) => {
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
exports.authorize = authorize;
