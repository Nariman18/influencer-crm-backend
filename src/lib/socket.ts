// src/lib/socket.ts
import { Server as IOServer, Socket } from "socket.io";
import http from "http";
import IORedis from "ioredis";

let io: IOServer | null = null;
let subscriber: IORedis | null = null;

/**
 * Initialize socket.io and a dedicated Redis subscriber that listens for
 * import/export progress messages AND reply detection notifications.
 *
 * Workers SHOULD publish to channels:
 *   import:progress:<jobId>
 *   export:progress:<jobId>
 *   reply:detected:<managerId>  ✅ NEW
 *
 * And include at least: { managerId, jobId, ...progressFields } as payload.
 */
export const initSocket = (server: http.Server) => {
  if (io) return io;

  io = new IOServer(server, {
    cors: {
      origin: process.env.FRONTEND_URL || "http://localhost:3000",
      methods: ["GET", "POST"],
      credentials: true,
    },
    pingInterval: 25000,
    pingTimeout: 60000,
  });

  io.on("connection", (socket: Socket) => {
    socket.on("join", (managerId: string) => {
      if (managerId) socket.join(`manager:${managerId}`);
    });

    socket.on("leave", (managerId: string) => {
      if (managerId) socket.leave(`manager:${managerId}`);
    });
  });

  // create a separate Redis subscriber connection (do not reuse command connection)
  try {
    subscriber = new IORedis(
      process.env.REDIS_URL || "redis://localhost:6379",
      {
        maxRetriesPerRequest: null,
      }
    );

    // ✅ NEW: Subscribe to reply detection notifications
    subscriber.psubscribe(
      "import:progress:*",
      "export:progress:*",
      "reply:detected:*", // ✅ NEW
      (err, count) => {
        if (err) {
          console.warn("[socket] redis psubscribe error:", err);
          return;
        }
        console.log(
          "[socket] subscribed to import/export/reply channels, count:",
          count
        );
      }
    );

    subscriber.on("pmessage", (_pattern, channel, message) => {
      try {
        const payload = JSON.parse(String(message) || "{}");
        const { managerId, jobId, ...rest } = payload || {};

        const isImport = String(channel).startsWith("import:progress:");
        const isExport = String(channel).startsWith("export:progress:");
        const isReply = String(channel).startsWith("reply:detected:"); // ✅ NEW

        // ✅ NEW: Handle reply detection notifications
        if (isReply) {
          if (managerId && io) {
            io.to(`manager:${managerId}`).emit("reply:detected", {
              emailId: payload.emailId,
              influencerId: payload.influencerId,
              influencerEmail: payload.influencerEmail,
              timestamp: payload.timestamp,
            });
            console.log(
              `[socket] 📨 Sent reply notification to manager ${managerId}`
            );
          }
          return;
        }

        const event = isImport
          ? "import:progress"
          : isExport
          ? "export:progress"
          : "progress";

        if (managerId && io) {
          // forward to manager room
          io.to(`manager:${managerId}`).emit(event, { jobId, ...rest });
          return;
        }

        // Fallback: try to parse jobId from the channel
        const match = String(channel).match(/^(import|export):progress:(.+)$/);
        const jobIdFromChannel = match ? match[2] : null;

        if (jobIdFromChannel && io) {
          io.emit(event, { jobId: jobIdFromChannel, ...(payload || {}) });
          return;
        }

        // Last resort
        if (io) {
          io.emit("progress", payload);
        }
      } catch (e) {
        console.warn("[socket] failed to parse pubsub message:", e);
      }
    });

    // handle Redis error events
    subscriber.on("error", (err) => {
      console.warn("[socket] redis subscriber error:", err);
    });

    // graceful cleanup on process termination
    const cleanup = async () => {
      try {
        if (subscriber) {
          await subscriber.quit();
          subscriber = null;
        }
      } catch (e) {
        // ignore
      }
      try {
        if (io) {
          io.close();
          io = null;
        }
      } catch (e) {
        // ignore
      }
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  } catch (e) {
    console.warn(
      "[socket] failed to create redis subscriber for progress channels:",
      e
    );
  }

  return io;
};

export const getIO = (): IOServer => {
  if (!io) throw new Error("Socket IO not initialized");
  return io;
};
