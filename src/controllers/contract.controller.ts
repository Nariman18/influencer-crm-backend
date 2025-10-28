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
