// src/server.ts
import express, { Application, Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import routes from "./routes";
import { errorHandler } from "./middleware/errorHandler";

dotenv.config();

// Keep a reference to a possibly-imported redisQueue for graceful cleanup
let embeddedQueue: any | null = null;

if (process.env.RUN_WORKER !== "false") {
  // dynamic import so we can guard it by env var
  import("./lib/redis-queue")
    .then((rq) => {
      try {
        // save reference for shutdown
        embeddedQueue = rq.default || rq;
        rq.setupEventListeners?.();
      } catch (e) {
        console.warn("[server] failed to attach queue event listeners:", e);
      }
      console.log(
        "[server] embedded worker/scheduler started (RUN_WORKER != 'false')"
      );
    })
    .catch((err) => {
      console.warn("[server] failed to initialize embedded worker:", err);
    });
} else {
  console.log("[server] embedded worker disabled (RUN_WORKER === 'false')");
}

const app: Application = express();
const PORT = process.env.PORT || 5001;

// CORS configuration
const corsOptions = {
  origin: [
    "http://localhost:3000",
    "https://localhost:3000",
    "https://influencer-crm-frontend.vercel.app",
    process.env.FRONTEND_URL,
  ].filter(Boolean) as string[],
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
app.use(cors(corsOptions));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use("/api", routes);

// Health check
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    cors: "enabled",
    allowedOrigins: corsOptions.origin,
    environment: process.env.NODE_ENV || "development",
  });
});

// Test endpoint to verify CORS
app.get("/api/test-cors", (_req: Request, res: Response) => {
  res.json({
    message: "CORS is working!",
    timestamp: new Date().toISOString(),
    frontend: "https://influencer-crm-frontend.vercel.app",
    environment: process.env.NODE_ENV || "development",
  });
});

// Error handling
app.use(errorHandler);

// Start server with error handling
const server = app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`CORS enabled for origins: ${corsOptions.origin.join(", ")}`);
  console.log(`Frontend URL: https://influencer-crm-frontend.vercel.app`);
});

// Handle server errors
server.on("error", (error: Error) => {
  console.error("❌ Server error:", error);
});

// Graceful shutdown helper
const shutdown = async (signal: string) => {
  console.log(`${signal} received, starting graceful shutdown...`);
  try {
    // If embedded queue present and has cleanup, call it (best-effort)
    if (embeddedQueue && typeof embeddedQueue.cleanup === "function") {
      console.log("[server] calling embeddedQueue.cleanup()");
      await embeddedQueue.cleanup();
    }
  } catch (e) {
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
    }, 10_000);
  } catch (err) {
    console.error("[server] error during shutdown:", err);
    process.exit(1);
  }
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export default app;
