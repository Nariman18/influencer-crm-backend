import express, { Application, Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import routes from "./routes";
import { errorHandler } from "./middleware/errorHandler";

dotenv.config();

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

// Handle process termination
process.on("SIGTERM", async () => {
  console.log("SIGTERM received, shutting down queues...");

  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("SIGINT received, shutting down queues...");

  process.exit(0);
});

export default app;
