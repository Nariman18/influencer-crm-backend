"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const routes_1 = __importDefault(require("./routes"));
const errorHandler_1 = require("./middleware/errorHandler");
const redis_queue_1 = require("./lib/redis-queue");
redis_queue_1.redisQueue.setupEventListeners();
dotenv_1.default.config();
const app = (0, express_1.default)();
const PORT = process.env.PORT || 5001;
// CORS configuration
const corsOptions = {
    origin: [
        "http://localhost:3000",
        "https://localhost:3000",
        "https://influencer-crm-frontend.vercel.app",
        process.env.FRONTEND_URL,
    ].filter(Boolean),
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: [
        "Content-Type",
        "Authorization",
        "X-Requested-With",
        "Accept",
        "Origin",
        "X-CSRF-Token",
    ],
    exposedHeaders: ["Content-Length", "Authorization"],
    optionsSuccessStatus: 200,
    maxAge: 86400, // 24 hours
};
// Apply CORS middleware
app.use((0, cors_1.default)(corsOptions));
// Middleware
app.use(express_1.default.json());
app.use(express_1.default.urlencoded({ extended: true }));
// Routes
app.use("/api", routes_1.default);
// Health check
app.get("/health", (_req, res) => {
    res.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        cors: "enabled",
        allowedOrigins: corsOptions.origin,
        environment: process.env.NODE_ENV || "development",
    });
});
// Test endpoint to verify CORS
app.get("/api/test-cors", (_req, res) => {
    res.json({
        message: "CORS is working!",
        timestamp: new Date().toISOString(),
        frontend: "https://influencer-crm-frontend.vercel.app",
        environment: process.env.NODE_ENV || "development",
    });
});
// Error handling
app.use(errorHandler_1.errorHandler);
// Start server with error handling
const server = app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📊 Environment: ${process.env.NODE_ENV || "development"}`);
    console.log(`🌐 CORS enabled for origins: ${corsOptions.origin.join(", ")}`);
    console.log(`🔗 Frontend URL: https://influencer-crm-frontend.vercel.app`);
});
// Handle server errors
server.on("error", (error) => {
    console.error("❌ Server error:", error);
});
// Handle process termination
process.on("SIGTERM", async () => {
    console.log("SIGTERM received, shutting down queue...");
    await redis_queue_1.redisQueue.cleanup();
    process.exit(0);
});
process.on("SIGINT", async () => {
    console.log("SIGINT received, shutting down queue...");
    await redis_queue_1.redisQueue.cleanup();
    process.exit(0);
});
exports.default = app;
