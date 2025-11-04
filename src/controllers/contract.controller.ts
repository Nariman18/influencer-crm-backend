import { Response } from "express";
import prisma from "../config/prisma";
import { AuthRequest, PaginatedResponse } from "../types";
import { AppError } from "../middleware/errorHandler";
import { ContractStatus } from "@prisma/client";

export const getContracts = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const status = req.query.status as ContractStatus | undefined;
    const campaignId = req.query.campaignId as string | undefined;

    const skip = (page - 1) * limit;

    const where = {
      ...(status && { status }),
      ...(campaignId && { campaignId }),
    };

    const [contracts, total] = await Promise.all([
      prisma.contract.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          influencer: {
            select: {
              id: true,
              name: true,
              email: true,
              instagramHandle: true,
            },
          },
          campaign: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      }),
      prisma.contract.count({ where }),
    ]);

    const response: PaginatedResponse<(typeof contracts)[0]> = {
      data: contracts,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };

    res.json(response);
  } catch (error) {
    throw new AppError("Failed to fetch contracts", 500);
  }
};

export const getContract = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { id } = req.params;

    if (!id) {
      throw new AppError("Contract ID is required", 400);
    }

    const contract = await prisma.contract.findUnique({
      where: { id },
      include: {
        influencer: true,
        campaign: true,
      },
    });

    if (!contract) {
      throw new AppError("Contract not found", 404);
    }

    res.json(contract);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("Failed to fetch contract", 500);
  }
};

export const createContract = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const {
      influencerId,
      campaignId,
      amount,
      currency,
      startDate,
      endDate,
      deliverables,
      terms,
      // New contract fields from Ready Influencers
      nickname,
      link,
      contactMethod,
      paymentMethod,
      managerComment,
      statistics,
      storyViews,
      averageViews,
      engagementCount,
    } = req.body;

    // Validate required fields
    if (!influencerId) {
      throw new AppError("Influencer ID is required", 400);
    }

    const contractData: {
      influencerId: string;
      campaignId?: string;
      amount?: number;
      currency?: string;
      startDate?: Date;
      endDate?: Date;
      deliverables?: string;
      terms?: string;
      status: "DRAFT";
      // New contract fields
      nickname?: string;
      link?: string;
      contactMethod?: string;
      paymentMethod?: string;
      managerComment?: string;
      statistics?: string;
      storyViews?: string;
      averageViews?: string;
      engagementCount?: string;
    } = {
      influencerId,
      status: "DRAFT",
    };

    // Only add fields if they are provided
    if (campaignId) contractData.campaignId = campaignId;
    if (amount !== undefined) contractData.amount = parseFloat(amount);
    if (currency) contractData.currency = currency;
    if (startDate) contractData.startDate = new Date(startDate);
    if (endDate) contractData.endDate = new Date(endDate);
    if (deliverables) contractData.deliverables = deliverables;
    if (terms) contractData.terms = terms;

    // New contract fields
    if (nickname) contractData.nickname = nickname;
    if (link) contractData.link = link;
    if (contactMethod) contractData.contactMethod = contactMethod;
    if (paymentMethod) contractData.paymentMethod = paymentMethod;
    if (managerComment) contractData.managerComment = managerComment;
    if (statistics) contractData.statistics = statistics;
    if (storyViews) contractData.storyViews = storyViews;
    if (averageViews) contractData.averageViews = averageViews;
    if (engagementCount) contractData.engagementCount = engagementCount;

    const contract = await prisma.contract.create({
      data: contractData,
      include: {
        influencer: true,
        campaign: true,
      },
    });

    // Update influencer status to CONTRACT
    await prisma.influencer.update({
      where: { id: influencerId },
      data: { status: "CONTRACT" },
    });

    res.status(201).json(contract);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("Failed to create contract", 500);
  }
};

export const updateContract = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { id } = req.params;
    const {
      status,
      amount,
      currency,
      startDate,
      endDate,
      deliverables,
      terms,
      contractFileUrl,
      // New contract fields
      nickname,
      link,
      contactMethod,
      paymentMethod,
      managerComment,
      statistics,
      storyViews,
      averageViews,
      engagementCount,
    } = req.body;

    if (!id) {
      throw new AppError("Contract ID is required", 400);
    }

    const updateData: {
      status?: ContractStatus;
      amount?: number;
      currency?: string;
      startDate?: Date;
      endDate?: Date;
      deliverables?: string;
      terms?: string;
      contractFileUrl?: string;
      signedAt?: Date;
      // New contract fields
      nickname?: string;
      link?: string;
      contactMethod?: string;
      paymentMethod?: string;
      managerComment?: string;
      statistics?: string;
      storyViews?: string;
      averageViews?: string;
      engagementCount?: string;
    } = {};

    // Only add fields that are provided
    if (status) updateData.status = status;
    if (amount !== undefined) updateData.amount = parseFloat(amount);
    if (currency) updateData.currency = currency;
    if (deliverables) updateData.deliverables = deliverables;
    if (terms) updateData.terms = terms;
    if (contractFileUrl) updateData.contractFileUrl = contractFileUrl;
    if (startDate) updateData.startDate = new Date(startDate);
    if (endDate) updateData.endDate = new Date(endDate);
    if (status === "SIGNED") updateData.signedAt = new Date();

    // New contract fields
    if (nickname !== undefined) updateData.nickname = nickname;
    if (link !== undefined) updateData.link = link;
    if (contactMethod !== undefined) updateData.contactMethod = contactMethod;
    if (paymentMethod !== undefined) updateData.paymentMethod = paymentMethod;
    if (managerComment !== undefined)
      updateData.managerComment = managerComment;
    if (statistics !== undefined) updateData.statistics = statistics;
    if (storyViews !== undefined) updateData.storyViews = storyViews;
    if (averageViews !== undefined) updateData.averageViews = averageViews;
    if (engagementCount !== undefined)
      updateData.engagementCount = engagementCount;

    const contract = await prisma.contract.update({
      where: { id },
      data: updateData,
      include: {
        influencer: true,
        campaign: true,
      },
    });

    res.json(contract);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("Failed to update contract", 500);
  }
};

export const deleteContract = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { id } = req.params;

    if (!id) {
      throw new AppError("Contract ID is required", 400);
    }

    await prisma.contract.delete({
      where: { id },
    });

    res.json({ message: "Contract deleted successfully" });
  } catch (error) {
    throw new AppError("Failed to delete contract", 500);
  }
};

// Bulk multiple contract delete
export const bulkDeleteContracts = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      throw new AppError("Invalid contract IDs", 400);
    }

    const result = await prisma.contract.deleteMany({
      where: {
        id: { in: ids },
      },
    });

    res.json({
      message: `Deleted ${result.count} contracts`,
      count: result.count,
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("Failed to bulk delete contracts", 500);
  }
};
