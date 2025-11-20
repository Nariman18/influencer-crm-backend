import dotenv from "dotenv";
dotenv.config({ path: ".env.server" });

import express, { Application, Request, Response } from "express";
import cors from "cors";
import http from "http";
import routes from "./routes";
import { errorHandler } from "./middleware/errorHandler";
import { initSocket } from "./lib/socket";

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

// Enhanced health check with queue status
app.get("/api/health/detailed", async (_req: Request, res: Response) => {
  try {
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || "development",
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      timestamp: new Date().toISOString(),
      error: "Failed to get queue status",
    });
  }
});

// Add these debug endpoints
app.get("/api/debug/queue-status", async (_req: Request, res: Response) => {
  try {
    res.json({
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to get queue status" });
  }
});

// Error handling
app.use(errorHandler);

// Create raw HTTP server from express app and attach Socket.IO
const server = http.createServer(app);

try {
  initSocket(server);
  console.log("🔌 Socket.IO initialized");
} catch (err) {
  console.warn("⚠️ Socket.IO initialization failed:", err);
}

// Start listening using the http server
server.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`CORS enabled for origins: ${corsOptions.origin.join(", ")}`);
  console.log(
    `Frontend URL: ${process.env.FRONTEND_URL || "http://localhost:3000"}`
  );
});

// Handle server errors
server.on("error", (error: Error) => {
  console.error("❌ Server error:", error);
});

// Handle process termination
process.on("SIGTERM", async () => {
  console.log("SIGTERM received, shutting down queues...");
  try {
    server.close();
  } catch (e) {
    // ignore
  }
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("SIGINT received, shutting down queues...");
  try {
    server.close();
  } catch (e) {
    // ignore
  }
  process.exit(0);
});

export default app;
