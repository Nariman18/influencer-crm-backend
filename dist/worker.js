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
Object.defineProperty(exports, "__esModule", { value: true });
// src/worker.ts
require("dotenv/config");
// Importing this file instantiates queues, workers & schedulers
const redis_queue_1 = __importStar(require("./lib/redis-queue"));
(async () => {
    try {
        console.log("[worker] starting worker process...");
        // optional: attach event listeners for logs/monitoring
        (0, redis_queue_1.setupEventListeners)();
        console.log("[worker] workers & schedulers initialized");
        console.log("[worker] listening for jobs on:");
        console.log("   -", redis_queue_1.default.emailSendQueue.name);
        console.log("   -", redis_queue_1.default.followUpQueue.name);
        // Keep process alive – Workers do this by default, so nothing else required.
        process.on("SIGINT", () => {
            console.log("[worker] SIGINT received, shutting down...");
            process.exit(0);
        });
        process.on("SIGTERM", () => {
            console.log("[worker] SIGTERM received, shutting down...");
            process.exit(0);
        });
    }
    catch (err) {
        console.error("[worker] failed to start:", err);
        process.exit(1);
    }
})();
