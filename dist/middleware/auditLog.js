"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.auditLog = void 0;
const prisma_1 = require("../config/prisma");
const prisma = (0, prisma_1.getPrisma)();
const auditLog = (action, entity) => {
    return async (req, res, next) => {
        const originalSend = res.json;
        // Use function declaration to preserve 'this' context
        res.json = function (data) {
            if (req.user && res.statusCode >= 200 && res.statusCode < 300) {
                const entityId = typeof data === "object" && data !== null && "id" in data
                    ? String(data.id)
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
                    .catch((error) => {
                    console.error("Audit log error:", error);
                });
            }
            return originalSend.call(this, data);
        };
        next();
    };
};
exports.auditLog = auditLog;
