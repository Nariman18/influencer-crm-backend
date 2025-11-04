"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyToken = exports.generateToken = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";
console.log("🔑 [JWT PRODUCTION] JWT Configuration:", {
    hasCustomSecret: !!process.env.JWT_SECRET,
    secretLength: JWT_SECRET.length,
    environment: process.env.NODE_ENV || "development",
});
const generateToken = (user) => {
    console.log("🔑 [JWT PRODUCTION] Generating token for user:", {
        id: user.id,
        name: user.name,
        environment: process.env.NODE_ENV,
    });
    const token = jsonwebtoken_1.default.sign({
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
    }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    console.log("🔑 [JWT PRODUCTION] Token generated:", {
        tokenLength: token.length,
        environment: process.env.NODE_ENV,
    });
    return token;
};
exports.generateToken = generateToken;
const verifyToken = (token) => {
    try {
        console.log("🔑 [JWT PRODUCTION] Verifying token:", {
            tokenLength: token.length,
            environment: process.env.NODE_ENV,
        });
        const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        console.log("✅ [JWT PRODUCTION] Token verified successfully:", {
            id: decoded.id,
            name: decoded.name,
            environment: process.env.NODE_ENV,
        });
        return decoded;
    }
    catch (error) {
        console.error("❌ [JWT PRODUCTION] Token verification failed:", {
            error: error instanceof Error ? error.message : "Unknown error",
            environment: process.env.NODE_ENV,
        });
        throw new Error("Invalid or expired token");
    }
};
exports.verifyToken = verifyToken;
