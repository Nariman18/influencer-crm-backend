"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRecentActivity = exports.getPipelineData = exports.getDashboardStats = void 0;
const prisma_1 = __importDefault(require("../config/prisma"));
const errorHandler_1 = require("../middleware/errorHandler");
const getDashboardStats = async (_req, res) => {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const [totalInfluencers, activeContracts, emailsSentToday, ping1Count, ping2Count, ping3Count, contractCount,] = await Promise.all([
            prisma_1.default.influencer.count(),
            prisma_1.default.contract.count({
                where: {
                    status: { in: ["ACTIVE", "SIGNED"] },
                },
            }),
            prisma_1.default.email.count({
                where: {
                    sentAt: { gte: today },
                },
            }),
            prisma_1.default.influencer.count({ where: { status: "PING_1" } }),
            prisma_1.default.influencer.count({ where: { status: "PING_2" } }),
            prisma_1.default.influencer.count({ where: { status: "PING_3" } }),
            prisma_1.default.influencer.count({ where: { status: "CONTRACT" } }),
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
        const pipeline = await prisma_1.default.influencer.groupBy({
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
        const activities = await prisma_1.default.auditLog.findMany({
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
