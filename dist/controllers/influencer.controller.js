"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkDuplicates = exports.importInfluencers = exports.bulkUpdateStatus = exports.deleteInfluencer = exports.updateInfluencer = exports.createInfluencer = exports.getInfluencer = exports.getInfluencers = void 0;
const prisma_1 = __importDefault(require("../config/prisma"));
const errorHandler_1 = require("../middleware/errorHandler");
// Helper function to check for duplicates
const checkForDuplicates = async (email, instagramHandle, excludeId) => {
    if (!email && !instagramHandle)
        return null;
    const orConditions = [];
    if (email) {
        orConditions.push({
            email: {
                equals: email,
                mode: "insensitive",
            },
        });
    }
    if (instagramHandle) {
        orConditions.push({
            instagramHandle: {
                equals: instagramHandle,
                mode: "insensitive",
            },
        });
    }
    const existing = await prisma_1.default.influencer.findFirst({
        where: {
            AND: [
                { id: { not: excludeId } }, // Exclude current influencer when updating
                ...(orConditions.length > 0 ? [{ OR: orConditions }] : []),
            ],
        },
        select: {
            id: true,
            name: true,
            email: true,
            instagramHandle: true,
            status: true,
        },
    });
    return existing;
};
const formatDuplicateResponse = (duplicate) => {
    return {
        id: duplicate.id,
        name: duplicate.name,
        email: duplicate.email ?? undefined, // Convert null to undefined
        instagramHandle: duplicate.instagramHandle ?? undefined, // Convert null to undefined
        status: duplicate.status,
    };
};
const getInfluencers = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const status = req.query.status;
        const search = req.query.search;
        const skip = (page - 1) * limit;
        const where = {
            ...(status && { status }),
            ...(search && {
                OR: [
                    { name: { contains: search, mode: "insensitive" } },
                    { email: { contains: search, mode: "insensitive" } },
                    {
                        instagramHandle: { contains: search, mode: "insensitive" },
                    },
                ],
            }),
        };
        const [influencers, total] = await Promise.all([
            prisma_1.default.influencer.findMany({
                where,
                skip,
                take: limit,
                orderBy: { createdAt: "desc" },
                include: {
                    contracts: {
                        select: {
                            id: true,
                            status: true,
                            amount: true,
                        },
                    },
                    _count: {
                        select: {
                            emails: true,
                        },
                    },
                },
            }),
            prisma_1.default.influencer.count({ where }),
        ]);
        const response = {
            data: influencers,
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
        throw new errorHandler_1.AppError("Failed to fetch influencers", 500);
    }
};
exports.getInfluencers = getInfluencers;
const getInfluencer = async (req, res) => {
    try {
        const { id } = req.params;
        const influencer = await prisma_1.default.influencer.findUnique({
            where: { id },
            include: {
                contracts: {
                    include: {
                        campaign: {
                            select: {
                                id: true,
                                name: true,
                            },
                        },
                    },
                },
                emails: {
                    orderBy: { createdAt: "desc" },
                    take: 10,
                },
                campaigns: {
                    include: {
                        campaign: true,
                    },
                },
            },
        });
        if (!influencer) {
            throw new errorHandler_1.AppError("Influencer not found", 404);
        }
        res.json(influencer);
    }
    catch (error) {
        if (error instanceof errorHandler_1.AppError)
            throw error;
        throw new errorHandler_1.AppError("Failed to fetch influencer", 500);
    }
};
exports.getInfluencer = getInfluencer;
const createInfluencer = async (req, res) => {
    try {
        const { name, email, instagramHandle, followers, engagementRate, niche, country, notes, } = req.body;
        // Enhanced duplicate validation
        const duplicate = await checkForDuplicates(email, instagramHandle);
        if (duplicate) {
            let errorMessage = "Influencer already exists";
            if (duplicate.email?.toLowerCase() === email?.toLowerCase() &&
                duplicate.instagramHandle?.toLowerCase() ===
                    instagramHandle?.toLowerCase()) {
                errorMessage = `Influencer already exists with both email (${duplicate.email}) and Instagram handle (${duplicate.instagramHandle})`;
            }
            else if (duplicate.email?.toLowerCase() === email?.toLowerCase()) {
                errorMessage = `Influencer already exists with this email: ${duplicate.email}`;
            }
            else if (duplicate.instagramHandle?.toLowerCase() ===
                instagramHandle?.toLowerCase()) {
                errorMessage = `Influencer already exists with this Instagram handle: ${duplicate.instagramHandle}`;
            }
            throw new errorHandler_1.AppError(errorMessage, 400, {
                duplicate: formatDuplicateResponse(duplicate),
            });
        }
        const influencer = await prisma_1.default.influencer.create({
            data: {
                name,
                email,
                instagramHandle,
                followers,
                engagementRate,
                niche,
                country,
                notes,
                status: "PING_1",
            },
        });
        res.status(201).json(influencer);
    }
    catch (error) {
        if (error instanceof errorHandler_1.AppError)
            throw error;
        throw new errorHandler_1.AppError("Failed to create influencer", 500);
    }
};
exports.createInfluencer = createInfluencer;
const updateInfluencer = async (req, res) => {
    try {
        const { id } = req.params;
        const { name, email, instagramHandle, followers, engagementRate, niche, country, status, notes, lastContactDate, } = req.body;
        // Check for duplicates when updating (exclude current influencer)
        const duplicate = await checkForDuplicates(email, instagramHandle, id);
        if (duplicate) {
            let errorMessage = "Another influencer already exists";
            if (duplicate.email?.toLowerCase() === email?.toLowerCase() &&
                duplicate.instagramHandle?.toLowerCase() ===
                    instagramHandle?.toLowerCase()) {
                errorMessage = `Another influencer already exists with both email (${duplicate.email}) and Instagram handle (${duplicate.instagramHandle})`;
            }
            else if (duplicate.email?.toLowerCase() === email?.toLowerCase()) {
                errorMessage = `Another influencer already exists with this email: ${duplicate.email}`;
            }
            else if (duplicate.instagramHandle?.toLowerCase() ===
                instagramHandle?.toLowerCase()) {
                errorMessage = `Another influencer already exists with this Instagram handle: ${duplicate.instagramHandle}`;
            }
            throw new errorHandler_1.AppError(errorMessage, 400, {
                duplicate: formatDuplicateResponse(duplicate),
            });
        }
        const influencer = await prisma_1.default.influencer.update({
            where: { id },
            data: {
                name,
                email,
                instagramHandle,
                followers,
                engagementRate,
                niche,
                country,
                status,
                notes,
                lastContactDate,
            },
        });
        res.json(influencer);
    }
    catch (error) {
        if (error instanceof errorHandler_1.AppError)
            throw error;
        throw new errorHandler_1.AppError("Failed to update influencer", 500);
    }
};
exports.updateInfluencer = updateInfluencer;
const deleteInfluencer = async (req, res) => {
    try {
        const { id } = req.params;
        await prisma_1.default.influencer.delete({
            where: { id },
        });
        res.json({ message: "Influencer deleted successfully" });
    }
    catch (error) {
        throw new errorHandler_1.AppError("Failed to delete influencer", 500);
    }
};
exports.deleteInfluencer = deleteInfluencer;
const bulkUpdateStatus = async (req, res) => {
    try {
        const { ids, status } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) {
            throw new errorHandler_1.AppError("Invalid influencer IDs", 400);
        }
        const result = await prisma_1.default.influencer.updateMany({
            where: {
                id: { in: ids },
            },
            data: {
                status,
                lastContactDate: new Date(),
            },
        });
        res.json({
            message: `Updated ${result.count} influencers`,
            count: result.count,
        });
    }
    catch (error) {
        if (error instanceof errorHandler_1.AppError)
            throw error;
        throw new errorHandler_1.AppError("Failed to bulk update influencers", 500);
    }
};
exports.bulkUpdateStatus = bulkUpdateStatus;
const importInfluencers = async (req, res) => {
    try {
        const { influencers } = req.body;
        if (!Array.isArray(influencers) || influencers.length === 0) {
            throw new errorHandler_1.AppError("Invalid influencer data", 400);
        }
        const results = {
            success: 0,
            failed: 0,
            errors: [],
            duplicates: [],
        };
        // First, check all influencers for duplicates
        const duplicateChecks = await Promise.all(influencers.map(async (data, index) => {
            const duplicate = await checkForDuplicates(data.email, data.instagramHandle);
            return { index, data, duplicate };
        }));
        // Process influencers sequentially
        for (const { index, data, duplicate } of duplicateChecks) {
            try {
                if (duplicate) {
                    results.failed++;
                    const formattedDuplicate = formatDuplicateResponse(duplicate);
                    results.duplicates.push({
                        index,
                        data,
                        duplicate: formattedDuplicate,
                    });
                    let errorMessage = "Duplicate influencer";
                    if (duplicate.email?.toLowerCase() === data.email?.toLowerCase() &&
                        duplicate.instagramHandle?.toLowerCase() ===
                            data.instagramHandle?.toLowerCase()) {
                        errorMessage = `Duplicate: email (${duplicate.email}) and Instagram (${duplicate.instagramHandle})`;
                    }
                    else if (duplicate.email?.toLowerCase() === data.email?.toLowerCase()) {
                        errorMessage = `Duplicate email: ${duplicate.email}`;
                    }
                    else if (duplicate.instagramHandle?.toLowerCase() ===
                        data.instagramHandle?.toLowerCase()) {
                        errorMessage = `Duplicate Instagram: ${duplicate.instagramHandle}`;
                    }
                    results.errors.push({
                        index,
                        error: errorMessage,
                        duplicate: formattedDuplicate,
                    });
                    continue;
                }
                await prisma_1.default.influencer.create({
                    data: {
                        name: data.name,
                        email: data.email,
                        instagramHandle: data.instagramHandle,
                        followers: data.followers,
                        engagementRate: data.engagementRate,
                        niche: data.niche,
                        country: data.country,
                        notes: data.notes,
                        status: "PING_1",
                    },
                });
                results.success++;
            }
            catch (error) {
                results.failed++;
                results.errors.push({
                    index,
                    error: error instanceof Error ? error.message : "Unknown error",
                });
            }
        }
        res.json(results);
    }
    catch (error) {
        if (error instanceof errorHandler_1.AppError)
            throw error;
        throw new errorHandler_1.AppError("Failed to import influencers", 500);
    }
};
exports.importInfluencers = importInfluencers;
// Check duplicates endpoint
const checkDuplicates = async (req, res) => {
    try {
        const { email, instagramHandle, excludeId } = req.body;
        const duplicate = await checkForDuplicates(email, instagramHandle, excludeId);
        if (duplicate) {
            res.json({
                isDuplicate: true,
                duplicate: formatDuplicateResponse(duplicate),
            });
        }
        else {
            res.json({
                isDuplicate: false,
                duplicate: null,
            });
        }
    }
    catch (error) {
        throw new errorHandler_1.AppError("Failed to check duplicates", 500);
    }
};
exports.checkDuplicates = checkDuplicates;
