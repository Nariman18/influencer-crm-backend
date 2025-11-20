// src/lib/socket.ts
import { Server as IOServer, Socket } from "socket.io";
import http from "http";
import IORedis from "ioredis";

let io: IOServer | null = null;
let subscriber: IORedis | null = null;

/**
 * Initialize socket.io and a dedicated Redis subscriber that listens for
 * import/export progress messages and forwards them to manager rooms.
 *
 * Workers SHOULD publish to channels:
 *   import:progress:<jobId>
 *   export:progress:<jobId>
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

    // subscribe to progress patterns
    // ioredis.psubscribe accepts multiple patterns (variadic)
    subscriber.psubscribe(
      "import:progress:*",
      "export:progress:*",
      (err, count) => {
        if (err) {
          console.warn("[socket] redis psubscribe error:", err);
          return;
        }
        console.log(
          "[socket] subscribed to import/export progress channels, count:",
          count
        );
      }
    );

    subscriber.on("pmessage", (_pattern, channel, message) => {
      try {
        const payload = JSON.parse(String(message) || "{}");
        // Prefer payload.managerId if present (workers should include it).
        const { managerId, jobId, ...rest } = payload || {};

        const isImport = String(channel).startsWith("import:progress:");
        const isExport = String(channel).startsWith("export:progress:");
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

        // Fallback: try to parse jobId from the channel (if worker didn't include managerId)
        const match = String(channel).match(/^(import|export):progress:(.+)$/);
        const jobIdFromChannel = match ? match[2] : null;

        if (jobIdFromChannel && io) {
          // Broadcast only the standardized envelope, not raw payload directly
          io.emit(event, { jobId: jobIdFromChannel, ...(payload || {}) });
          return;
        }

        // As a last resort, if no managerId and no jobId, broadcast raw payload under 'progress' event
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
