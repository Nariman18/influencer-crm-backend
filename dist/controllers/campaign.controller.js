"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.removeInfluencerFromCampaign = exports.addInfluencerToCampaign = exports.deleteCampaign = exports.updateCampaign = exports.createCampaign = exports.getCampaign = exports.getCampaigns = void 0;
const prisma_1 = __importDefault(require("../config/prisma"));
const errorHandler_1 = require("../middleware/errorHandler");
const getCampaigns = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 30;
        const isActive = req.query.isActive === "true"
            ? true
            : req.query.isActive === "false"
                ? false
                : undefined;
        const skip = (page - 1) * limit;
        const where = {
            ...(isActive !== undefined && { isActive }),
        };
        const [campaigns, total] = await Promise.all([
            prisma_1.default.campaign.findMany({
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
            prisma_1.default.campaign.count({ where }),
        ]);
        const response = {
            data: campaigns,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        };
        res.json(response);
    }
    catch (error) {
        throw new errorHandler_1.AppError("Failed to fetch campaigns", 500);
    }
};
exports.getCampaigns = getCampaigns;
const getCampaign = async (req, res) => {
    try {
        const { id } = req.params;
        const campaign = await prisma_1.default.campaign.findUnique({
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
            throw new errorHandler_1.AppError("Campaign not found", 404);
        }
        res.json(campaign);
    }
    catch (error) {
        if (error instanceof errorHandler_1.AppError)
            throw error;
        throw new errorHandler_1.AppError("Failed to fetch campaign", 500);
    }
};
exports.getCampaign = getCampaign;
const createCampaign = async (req, res) => {
    try {
        if (!req.user) {
            throw new errorHandler_1.AppError("Not authenticated", 401);
        }
        const { name, description, budget, startDate, endDate } = req.body;
        const campaign = await prisma_1.default.campaign.create({
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
    }
    catch (error) {
        if (error instanceof errorHandler_1.AppError)
            throw error;
        throw new errorHandler_1.AppError("Failed to create campaign", 500);
    }
};
exports.createCampaign = createCampaign;
const updateCampaign = async (req, res) => {
    try {
        const { id } = req.params;
        const { name, description, budget, startDate, endDate, isActive } = req.body;
        const updateData = {
            name,
            description,
            budget,
            isActive,
        };
        if (startDate)
            updateData.startDate = new Date(startDate);
        if (endDate)
            updateData.endDate = new Date(endDate);
        const campaign = await prisma_1.default.campaign.update({
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
    }
    catch (error) {
        if (error instanceof errorHandler_1.AppError)
            throw error;
        throw new errorHandler_1.AppError("Failed to update campaign", 500);
    }
};
exports.updateCampaign = updateCampaign;
const deleteCampaign = async (req, res) => {
    try {
        const { id } = req.params;
        await prisma_1.default.campaign.delete({
            where: { id },
        });
        res.json({ message: "Campaign deleted successfully" });
    }
    catch (error) {
        throw new errorHandler_1.AppError("Failed to delete campaign", 500);
    }
};
exports.deleteCampaign = deleteCampaign;
const addInfluencerToCampaign = async (req, res) => {
    try {
        const { id } = req.params;
        const { influencerId } = req.body;
        // Add validation to ensure IDs are present
        if (!id) {
            throw new errorHandler_1.AppError("Campaign ID is required", 400);
        }
        if (!influencerId) {
            throw new errorHandler_1.AppError("Influencer ID is required", 400);
        }
        const existing = await prisma_1.default.campaignInfluencer.findFirst({
            where: {
                campaignId: id,
                influencerId,
            },
        });
        if (existing) {
            throw new errorHandler_1.AppError("Influencer already added to this campaign", 400);
        }
        // Create the data object with explicit typing
        const campaignInfluencerData = {
            campaignId: id,
            influencerId: influencerId,
        };
        const campaignInfluencer = await prisma_1.default.campaignInfluencer.create({
            data: campaignInfluencerData,
            include: {
                influencer: true,
            },
        });
        res.status(201).json(campaignInfluencer);
    }
    catch (error) {
        if (error instanceof errorHandler_1.AppError)
            throw error;
        throw new errorHandler_1.AppError("Failed to add influencer to campaign", 500);
    }
};
exports.addInfluencerToCampaign = addInfluencerToCampaign;
const removeInfluencerFromCampaign = async (req, res) => {
    try {
        const { id, influencerId } = req.params;
        // Add validation
        if (!id || !influencerId) {
            throw new errorHandler_1.AppError("Campaign ID and Influencer ID are required", 400);
        }
        await prisma_1.default.campaignInfluencer.deleteMany({
            where: {
                campaignId: id,
                influencerId,
            },
        });
        res.json({ message: "Influencer removed from campaign" });
    }
    catch (error) {
        throw new errorHandler_1.AppError("Failed to remove influencer from campaign", 500);
    }
};
exports.removeInfluencerFromCampaign = removeInfluencerFromCampaign;
