"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/server.ts
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const routes_1 = __importDefault(require("./routes"));
const errorHandler_1 = require("./middleware/errorHandler");
dotenv_1.default.config();
// Keep a reference to a possibly-imported redisQueue for graceful cleanup
let embeddedQueue = null;
if (process.env.RUN_WORKER !== "false") {
    // dynamic import so we can guard it by env var
    Promise.resolve().then(() => __importStar(require("./lib/redis-queue"))).then((rq) => {
        try {
            // save reference for shutdown
            embeddedQueue = rq.default || rq;
            rq.setupEventListeners?.();
        }
        catch (e) {
            console.warn("[server] failed to attach queue event listeners:", e);
        }
        console.log("[server] embedded worker/scheduler started (RUN_WORKER != 'false')");
    })
        .catch((err) => {
        console.warn("[server] failed to initialize embedded worker:", err);
    });
}
else {
    console.log("[server] embedded worker disabled (RUN_WORKER === 'false')");
}
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
const server = app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
    console.log(`CORS enabled for origins: ${corsOptions.origin.join(", ")}`);
    console.log(`Frontend URL: https://influencer-crm-frontend.vercel.app`);
});
// Handle server errors
server.on("error", (error) => {
    console.error("❌ Server error:", error);
});
// Graceful shutdown helper
const shutdown = async (signal) => {
    console.log(`${signal} received, starting graceful shutdown...`);
    try {
        // If embedded queue present and has cleanup, call it (best-effort)
        if (embeddedQueue && typeof embeddedQueue.cleanup === "function") {
            console.log("[server] calling embeddedQueue.cleanup()");
            await embeddedQueue.cleanup();
        }
    }
    catch (e) {
        console.warn("[server] embeddedQueue.cleanup() failed:", e);
    }
    try {
        server.close(() => {
            console.log("[server] HTTP server closed");
            process.exit(0);
        });
        // after 10s, force-exit
        setTimeout(() => {
            console.warn("[server] graceful shutdown timeout, forcing exit");
            process.exit(1);
        }, 10000);
    }
    catch (err) {
        console.error("[server] error during shutdown:", err);
        process.exit(1);
    }
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
exports.default = app;
