"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.bulkDeleteContracts = exports.deleteContract = exports.updateContract = exports.createContract = exports.getContract = exports.getContracts = void 0;
const prisma_1 = __importDefault(require("../config/prisma"));
const errorHandler_1 = require("../middleware/errorHandler");
const getContracts = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const status = req.query.status;
        const campaignId = req.query.campaignId;
        const skip = (page - 1) * limit;
        const where = {
            ...(status && { status }),
            ...(campaignId && { campaignId }),
        };
        const [contracts, total] = await Promise.all([
            prisma_1.default.contract.findMany({
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
            prisma_1.default.contract.count({ where }),
        ]);
        const response = {
            data: contracts,
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
        throw new errorHandler_1.AppError("Failed to fetch contracts", 500);
    }
};
exports.getContracts = getContracts;
const getContract = async (req, res) => {
    try {
        const { id } = req.params;
        if (!id) {
            throw new errorHandler_1.AppError("Contract ID is required", 400);
        }
        const contract = await prisma_1.default.contract.findUnique({
            where: { id },
            include: {
                influencer: true,
                campaign: true,
            },
        });
        if (!contract) {
            throw new errorHandler_1.AppError("Contract not found", 404);
        }
        res.json(contract);
    }
    catch (error) {
        if (error instanceof errorHandler_1.AppError)
            throw error;
        throw new errorHandler_1.AppError("Failed to fetch contract", 500);
    }
};
exports.getContract = getContract;
const createContract = async (req, res) => {
    try {
        const { influencerId, campaignId, amount, currency, startDate, endDate, deliverables, terms, 
        // New contract fields from Ready Influencers
        nickname, link, contactMethod, paymentMethod, managerComment, statistics, storyViews, averageViews, engagementCount, } = req.body;
        // Validate required fields
        if (!influencerId) {
            throw new errorHandler_1.AppError("Influencer ID is required", 400);
        }
        const contractData = {
            influencerId,
            status: "DRAFT",
        };
        // Only add fields if they are provided
        if (campaignId)
            contractData.campaignId = campaignId;
        if (amount !== undefined)
            contractData.amount = parseFloat(amount);
        if (currency)
            contractData.currency = currency;
        if (startDate)
            contractData.startDate = new Date(startDate);
        if (endDate)
            contractData.endDate = new Date(endDate);
        if (deliverables)
            contractData.deliverables = deliverables;
        if (terms)
            contractData.terms = terms;
        // New contract fields
        if (nickname)
            contractData.nickname = nickname;
        if (link)
            contractData.link = link;
        if (contactMethod)
            contractData.contactMethod = contactMethod;
        if (paymentMethod)
            contractData.paymentMethod = paymentMethod;
        if (managerComment)
            contractData.managerComment = managerComment;
        if (statistics)
            contractData.statistics = statistics;
        if (storyViews)
            contractData.storyViews = storyViews;
        if (averageViews)
            contractData.averageViews = averageViews;
        if (engagementCount)
            contractData.engagementCount = engagementCount;
        const contract = await prisma_1.default.contract.create({
            data: contractData,
            include: {
                influencer: true,
                campaign: true,
            },
        });
        // Update influencer status to CONTRACT
        await prisma_1.default.influencer.update({
            where: { id: influencerId },
            data: { status: "CONTRACT" },
        });
        res.status(201).json(contract);
    }
    catch (error) {
        if (error instanceof errorHandler_1.AppError)
            throw error;
        throw new errorHandler_1.AppError("Failed to create contract", 500);
    }
};
exports.createContract = createContract;
const updateContract = async (req, res) => {
    try {
        const { id } = req.params;
        const { status, amount, currency, startDate, endDate, deliverables, terms, contractFileUrl, 
        // New contract fields
        nickname, link, contactMethod, paymentMethod, managerComment, statistics, storyViews, averageViews, engagementCount, } = req.body;
        if (!id) {
            throw new errorHandler_1.AppError("Contract ID is required", 400);
        }
        const updateData = {};
        // Only add fields that are provided
        if (status)
            updateData.status = status;
        if (amount !== undefined)
            updateData.amount = parseFloat(amount);
        if (currency)
            updateData.currency = currency;
        if (deliverables)
            updateData.deliverables = deliverables;
        if (terms)
            updateData.terms = terms;
        if (contractFileUrl)
            updateData.contractFileUrl = contractFileUrl;
        if (startDate)
            updateData.startDate = new Date(startDate);
        if (endDate)
            updateData.endDate = new Date(endDate);
        if (status === "SIGNED")
            updateData.signedAt = new Date();
        // New contract fields
        if (nickname !== undefined)
            updateData.nickname = nickname;
        if (link !== undefined)
            updateData.link = link;
        if (contactMethod !== undefined)
            updateData.contactMethod = contactMethod;
        if (paymentMethod !== undefined)
            updateData.paymentMethod = paymentMethod;
        if (managerComment !== undefined)
            updateData.managerComment = managerComment;
        if (statistics !== undefined)
            updateData.statistics = statistics;
        if (storyViews !== undefined)
            updateData.storyViews = storyViews;
        if (averageViews !== undefined)
            updateData.averageViews = averageViews;
        if (engagementCount !== undefined)
            updateData.engagementCount = engagementCount;
        const contract = await prisma_1.default.contract.update({
            where: { id },
            data: updateData,
            include: {
                influencer: true,
                campaign: true,
            },
        });
        res.json(contract);
    }
    catch (error) {
        if (error instanceof errorHandler_1.AppError)
            throw error;
        throw new errorHandler_1.AppError("Failed to update contract", 500);
    }
};
exports.updateContract = updateContract;
const deleteContract = async (req, res) => {
    try {
        const { id } = req.params;
        if (!id) {
            throw new errorHandler_1.AppError("Contract ID is required", 400);
        }
        await prisma_1.default.contract.delete({
            where: { id },
        });
        res.json({ message: "Contract deleted successfully" });
    }
    catch (error) {
        throw new errorHandler_1.AppError("Failed to delete contract", 500);
    }
};
exports.deleteContract = deleteContract;
// Bulk multiple contract delete
const bulkDeleteContracts = async (req, res) => {
    try {
        const { ids } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) {
            throw new errorHandler_1.AppError("Invalid contract IDs", 400);
        }
        const result = await prisma_1.default.contract.deleteMany({
            where: {
                id: { in: ids },
            },
        });
        res.json({
            message: `Deleted ${result.count} contracts`,
            count: result.count,
        });
    }
    catch (error) {
        if (error instanceof errorHandler_1.AppError)
            throw error;
        throw new errorHandler_1.AppError("Failed to bulk delete contracts", 500);
    }
};
exports.bulkDeleteContracts = bulkDeleteContracts;
