import { Response } from "express";
import { AuthRequest, PaginatedResponse } from "../types";
import { AppError } from "../middleware/errorHandler";
import { getPrisma } from "../config/prisma";

const prisma = getPrisma();

export const getCampaigns = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 30;
    const isActive =
      req.query.isActive === "true"
        ? true
        : req.query.isActive === "false"
        ? false
        : undefined;

    const skip = (page - 1) * limit;

    const where = {
      ...(isActive !== undefined && { isActive }),
    };

    const [campaigns, total] = await Promise.all([
      prisma.campaign.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          createdBy: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          _count: {
            select: {
              contracts: true,
              influencers: true,
            },
          },
        },
      }),
      prisma.campaign.count({ where }),
    ]);

    const response: PaginatedResponse<(typeof campaigns)[0]> = {
      data: campaigns,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };

    res.json(response);
  } catch (error) {
    throw new AppError("Failed to fetch campaigns", 500);
  }
};

export const getCampaign = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { id } = req.params;

    const campaign = await prisma.campaign.findUnique({
      where: { id },
      include: {
        createdBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        contracts: {
          include: {
            influencer: true,
          },
        },
        influencers: {
          include: {
            influencer: true,
          },
        },
      },
    });

    if (!campaign) {
      throw new AppError("Campaign not found", 404);
    }

    res.json(campaign);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("Failed to fetch campaign", 500);
  }
};

export const createCampaign = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    if (!req.user) {
      throw new AppError("Not authenticated", 401);
    }

    const { name, description, budget, startDate, endDate } = req.body;

    const campaign = await prisma.campaign.create({
      data: {
        name,
        description,
        budget,
        startDate: startDate ? new Date(startDate) : undefined,
        endDate: endDate ? new Date(endDate) : undefined,
        createdById: req.user.id,
      },
      include: {
        createdBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    res.status(201).json(campaign);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("Failed to create campaign", 500);
  }
};

export const updateCampaign = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { id } = req.params;
    const { name, description, budget, startDate, endDate, isActive } =
      req.body;

    const updateData: {
      name?: string;
      description?: string;
      budget?: number;
      startDate?: Date;
      endDate?: Date;
      isActive?: boolean;
    } = {
      name,
      description,
      budget,
      isActive,
    };

    if (startDate) updateData.startDate = new Date(startDate);
    if (endDate) updateData.endDate = new Date(endDate);

    const campaign = await prisma.campaign.update({
      where: { id },
      data: updateData,
      include: {
        createdBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    res.json(campaign);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("Failed to update campaign", 500);
  }
};

export const deleteCampaign = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { id } = req.params;

    await prisma.campaign.delete({
      where: { id },
    });

    res.json({ message: "Campaign deleted successfully" });
  } catch (error) {
    throw new AppError("Failed to delete campaign", 500);
  }
};

export const addInfluencerToCampaign = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { id } = req.params;
    const { influencerId } = req.body;

    // Add validation to ensure IDs are present
    if (!id) {
      throw new AppError("Campaign ID is required", 400);
    }

    if (!influencerId) {
      throw new AppError("Influencer ID is required", 400);
    }

    const existing = await prisma.campaignInfluencer.findFirst({
      where: {
        campaignId: id,
        influencerId,
      },
    });

    if (existing) {
      throw new AppError("Influencer already added to this campaign", 400);
    }

    // Create the data object with explicit typing
    const campaignInfluencerData = {
      campaignId: id,
      influencerId: influencerId,
    };

    const campaignInfluencer = await prisma.campaignInfluencer.create({
      data: campaignInfluencerData,
      include: {
        influencer: true,
      },
    });

    res.status(201).json(campaignInfluencer);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("Failed to add influencer to campaign", 500);
  }
};

export const removeInfluencerFromCampaign = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { id, influencerId } = req.params;

    // Add validation
    if (!id || !influencerId) {
      throw new AppError("Campaign ID and Influencer ID are required", 400);
    }

    await prisma.campaignInfluencer.deleteMany({
      where: {
        campaignId: id,
        influencerId,
      },
    });

    res.json({ message: "Influencer removed from campaign" });
  } catch (error) {
    throw new AppError("Failed to remove influencer from campaign", 500);
  }
};
