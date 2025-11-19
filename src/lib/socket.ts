// src/lib/socket.ts
import { Server as IOServer, Socket } from "socket.io";
import http from "http";
import IORedis from "ioredis";

let io: IOServer | null = null;
let subscriber: IORedis | null = null;

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

  // create a separate subscriber connection (so we don't interfere with command connection)
  try {
    subscriber = new IORedis(
      process.env.REDIS_URL || "redis://localhost:6379",
      { maxRetriesPerRequest: null }
    );
    // subscribe to pattern channels for import/export progress
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
        const payload = JSON.parse(String(message));
        // payload should include managerId and jobId (we included managerId when publishing)
        const { managerId, jobId, ...rest } = payload || {};
        if (managerId && io) {
          // forward to manager room
          const event = channel.startsWith("import:")
            ? "import:progress"
            : "export:progress";
          io.to(`manager:${managerId}`).emit(event, { jobId, ...rest });
        } else {
          // fallback: try to parse jobId from channel if managerId not present
          const match = String(channel).match(
            /^(import|export):progress:(.+)$/
          );
          const jobIdFromChannel = match ? match[2] : null;
          const event = channel.startsWith("import:")
            ? "import:progress"
            : "export:progress";
          if (io && jobIdFromChannel) {
            // broadcast widely (but better if workers include managerId)
            io.emit(event, { jobId: jobIdFromChannel, ...payload });
          }
        }
      } catch (e) {
        console.warn("[socket] failed to parse pubsub message:", e);
      }
    });
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
