import { Response, NextFunction } from "express";
import { AuthRequest } from "../types";
import { getPrisma } from "../config/prisma";

const prisma = getPrisma();

export const auditLog = (action: string, entity: string) => {
  return async (
    req: AuthRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const originalSend = res.json;

    // Use function declaration to preserve 'this' context
    res.json = function (data: unknown) {
      if (req.user && res.statusCode >= 200 && res.statusCode < 300) {
        const entityId =
          typeof data === "object" && data !== null && "id" in data
            ? String((data as { id: unknown }).id)
            : undefined;

        prisma.auditLog
          .create({
            data: {
              userId: req.user.id,
              action,
              entity,
              entityId,
              details: JSON.stringify({
                method: req.method,
                path: req.path,
                body: req.body,
              }),
              ipAddress: req.ip || req.socket.remoteAddress,
            },
          })
          .catch((error: Error) => {
            console.error("Audit log error:", error);
          });
      }

      return originalSend.call(this, data);
    };

    next();
  };
};
