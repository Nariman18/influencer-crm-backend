"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRecentActivity = exports.getPipelineData = exports.getDashboardStats = void 0;
const prisma_1 = require("../config/prisma");
const errorHandler_1 = require("../middleware/errorHandler");
const prisma = (0, prisma_1.getPrisma)();
const getDashboardStats = async (_req, res) => {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const [totalInfluencers, activeContracts, emailsSentToday, ping1Count, ping2Count, ping3Count, contractCount,] = await Promise.all([
            prisma.influencer.count(),
            prisma.contract.count({
                where: {
                    status: { in: ["ACTIVE", "SIGNED"] },
                },
            }),
            prisma.email.count({
                where: {
                    sentAt: { gte: today },
                },
            }),
            prisma.influencer.count({ where: { status: "PING_1" } }),
            prisma.influencer.count({ where: { status: "PING_2" } }),
            prisma.influencer.count({ where: { status: "PING_3" } }),
            prisma.influencer.count({ where: { status: "CONTRACT" } }),
        ]);
        const stats = {
            totalInfluencers,
            activeContracts,
            emailsSentToday,
            pipelineStats: {
                ping1: ping1Count,
                ping2: ping2Count,
                ping3: ping3Count,
                contract: contractCount,
            },
        };
        res.json(stats);
    }
    catch (error) {
        throw new errorHandler_1.AppError("Failed to fetch dashboard stats", 500);
    }
};
exports.getDashboardStats = getDashboardStats;
const getPipelineData = async (_req, res) => {
    try {
        const pipeline = await prisma.influencer.groupBy({
            by: ["status"],
            _count: true,
        });
        const formattedPipeline = pipeline.map((item) => ({
            status: item.status,
            count: item._count,
        }));
        res.json(formattedPipeline);
    }
    catch (error) {
        throw new errorHandler_1.AppError("Failed to fetch pipeline data", 500);
    }
};
exports.getPipelineData = getPipelineData;
const getRecentActivity = async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;
        const activities = await prisma.auditLog.findMany({
            take: limit,
            orderBy: { createdAt: "desc" },
            include: {
                user: {
                    select: {
                        id: true,
                        name: true,
                        email: true,
                    },
                },
            },
        });
        res.json(activities);
    }
    catch (error) {
        throw new errorHandler_1.AppError("Failed to fetch recent activity", 500);
    }
};
exports.getRecentActivity = getRecentActivity;
