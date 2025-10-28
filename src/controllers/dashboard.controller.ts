import { Response } from "express";
import prisma from "../config/prisma";
import { AuthRequest, DashboardStats } from "../types";
import { AppError } from "../middleware/errorHandler";

export const getDashboardStats = async (
  _req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [
      totalInfluencers,
      activeContracts,
      emailsSentToday,
      ping1Count,
      ping2Count,
      ping3Count,
      contractCount,
    ] = await Promise.all([
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

    const stats: DashboardStats = {
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
  } catch (error) {
    throw new AppError("Failed to fetch dashboard stats", 500);
  }
};

export const getPipelineData = async (
  _req: AuthRequest,
  res: Response
): Promise<void> => {
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
  } catch (error) {
    throw new AppError("Failed to fetch pipeline data", 500);
  }
};

export const getRecentActivity = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const limit = parseInt(req.query.limit as string) || 10;

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
  } catch (error) {
    throw new AppError("Failed to fetch recent activity", 500);
  }
};
