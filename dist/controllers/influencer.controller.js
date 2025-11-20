"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.stopAutomation = exports.checkDuplicates = exports.importInfluencers = exports.bulkUpdateStatus = exports.bulkDeleteInfluencers = exports.deleteInfluencer = exports.updateInfluencer = exports.createInfluencer = exports.getInfluencer = exports.getInfluencers = void 0;
const prisma_1 = require("../config/prisma");
const errorHandler_1 = require("../middleware/errorHandler");
const client_1 = require("@prisma/client");
const redis_queue_1 = __importDefault(require("../lib/redis-queue"));
const prisma = (0, prisma_1.getPrisma)();
/**
 * Helper function to check for duplicates.
 * If managerId is provided, scope the search to that manager only.
 */
const checkForDuplicates = async (email, instagramHandle, excludeId, managerId) => {
    try {
        if (!email && !instagramHandle)
            return null;
        const orConditions = [];
        if (email && email.trim() !== "") {
            orConditions.push({
                email: {
                    equals: email.trim(),
                    mode: "insensitive",
                },
            });
        }
        if (instagramHandle && instagramHandle.trim() !== "") {
            orConditions.push({
                instagramHandle: {
                    equals: instagramHandle.trim(),
                    mode: "insensitive",
                },
            });
        }
        if (orConditions.length === 0)
            return null;
        const andClause = [{ OR: orConditions }];
        if (excludeId && excludeId.trim() !== "") {
            andClause.push({ id: { not: excludeId } });
        }
        if (managerId) {
            andClause.push({ managerId });
        }
        const whereClause = { AND: andClause };
        const existing = await prisma.influencer.findFirst({
            where: whereClause,
            select: {
                id: true,
                name: true,
                email: true,
                instagramHandle: true,
                status: true,
                managerId: true,
            },
        });
        return existing;
    }
    catch (error) {
        console.error("❌ [BACKEND] Error in checkForDuplicates:", error);
        if (error instanceof Error) {
            const msg = error.message.toLowerCase();
            if (msg.includes("database") || msg.includes("connection")) {
                // tolerate DB / connection problems by returning null (non-fatal duplicate check)
                return null;
            }
        }
        throw error;
    }
};
const formatDuplicateResponse = (duplicate) => ({
    id: duplicate.id,
    name: duplicate.name,
    email: duplicate.email ?? undefined,
    instagramHandle: duplicate.instagramHandle ?? undefined,
    status: duplicate.status,
});
/* --------------------------- CRUD / bulk / helpers -------------------------- */
const getInfluencers = async (req, res) => {
    try {
        const page = parseInt(req.query.page || "1", 10) || 1;
        const limit = parseInt(req.query.limit || "50", 10) || 50;
        const status = req.query.status;
        const search = req.query.search || undefined;
        const emailFilter = req.query.emailFilter || undefined;
        const skip = (page - 1) * limit;
        if (!req.user || !req.user.id)
            throw new errorHandler_1.AppError("Not authenticated", 401);
        // Only show influencers where managerId == current user
        const where = { managerId: req.user.id };
        if (status)
            where.status = status;
        if (search) {
            where.AND = [
                ...(where.AND || []),
                {
                    OR: [
                        { name: { contains: search, mode: "insensitive" } },
                        { email: { contains: search, mode: "insensitive" } },
                        { instagramHandle: { contains: search, mode: "insensitive" } },
                    ],
                },
            ];
        }
        if (emailFilter) {
            const normalized = emailFilter.toLowerCase().trim();
            if (normalized === "has-email" || normalized === "has_email") {
                where.AND = [...(where.AND || []), { email: { not: null } }];
            }
            else if (normalized === "no-email" || normalized === "no_email") {
                where.AND = [...(where.AND || []), { email: null }];
            }
        }
        const [influencers, total] = await Promise.all([
            prisma.influencer.findMany({
                where,
                skip,
                take: limit,
                orderBy: { createdAt: "desc" },
                include: {
                    contracts: { select: { id: true, status: true, amount: true } },
                    manager: { select: { id: true, name: true, email: true } },
                    _count: { select: { emails: true } },
                },
            }),
            prisma.influencer.count({ where }),
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
        return res.json(response);
    }
    catch (error) {
        console.error("❌ Error fetching influencers:", error);
        if (error instanceof errorHandler_1.AppError)
            throw error;
        throw new errorHandler_1.AppError("Failed to fetch influencers", 500);
    }
};
exports.getInfluencers = getInfluencers;
const getInfluencer = async (req, res) => {
    try {
        const { id } = req.params;
        if (!req.user || !req.user.id)
            throw new errorHandler_1.AppError("Not authenticated", 401);
        const influencer = await prisma.influencer.findUnique({
            where: { id },
            include: {
                contracts: {
                    include: { campaign: { select: { id: true, name: true } } },
                },
                emails: { orderBy: { createdAt: "desc" }, take: 10 },
                campaigns: { include: { campaign: true } },
                manager: { select: { id: true, name: true, email: true } },
            },
        });
        if (!influencer)
            throw new errorHandler_1.AppError("Influencer not found", 404);
        if (influencer.managerId !== req.user.id)
            throw new errorHandler_1.AppError("Not authorized to view this influencer", 403);
        return res.json(influencer);
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
        if (!req.user || !req.user.id) {
            return res.status(401).json({
                error: "Authentication failed - req.user is null",
                debug: "Check if authentication middleware is executing",
            });
        }
        const { name, email, instagramHandle, followers, country, notes, link } = req.body;
        // Duplicate check scoped to current user's influencers
        const duplicate = await checkForDuplicates(email, instagramHandle, undefined, req.user.id);
        if (duplicate) {
            throw new errorHandler_1.AppError("Influencer already exists", 400, {
                duplicate: formatDuplicateResponse(duplicate),
            });
        }
        const influencer = await prisma.influencer.create({
            data: {
                name,
                email: email || null,
                instagramHandle: instagramHandle || null,
                link: link || null,
                followers: followers ? parseInt(followers, 10) : null,
                country: country || null,
                notes: notes || null,
                status: "NOT_SENT",
                manager: { connect: { id: req.user.id } },
            },
            include: {
                manager: { select: { id: true, name: true, email: true } },
            },
        });
        return res.status(201).json(influencer);
    }
    catch (error) {
        console.error("[BACKEND] Error creating influencer:", error);
        if (error instanceof errorHandler_1.AppError)
            throw error;
        throw new errorHandler_1.AppError("Failed to create influencer", 500);
    }
};
exports.createInfluencer = createInfluencer;
const updateInfluencer = async (req, res) => {
    try {
        const { id } = req.params;
        const { name, email, instagramHandle, link, followers, country, status, notes, lastContactDate, } = req.body;
        if (!req.user || !req.user.id)
            throw new errorHandler_1.AppError("Not authenticated", 401);
        const existing = await prisma.influencer.findUnique({
            where: { id },
            select: { managerId: true },
        });
        if (!existing)
            throw new errorHandler_1.AppError("Influencer not found", 404);
        if (existing.managerId !== req.user.id)
            throw new errorHandler_1.AppError("Not authorized", 403);
        // Duplicate check (exclude current influencer) scoped to user
        const duplicate = await checkForDuplicates(email, instagramHandle, id, req.user.id);
        if (duplicate) {
            // duplicate belongs to this user's dataset (because of scoped check)
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
        const updateData = {
            name,
            email: email || null,
            instagramHandle: instagramHandle || null,
            link: link || null,
            followers: followers ? parseInt(followers, 10) : null,
            country: country || null,
            status,
            notes: notes || null,
            lastContactDate,
        };
        const influencer = await prisma.influencer.update({
            where: { id },
            data: updateData,
            include: {
                manager: { select: { id: true, name: true, email: true } },
            },
        });
        return res.json(influencer);
    }
    catch (error) {
        if (error instanceof errorHandler_1.AppError)
            throw error;
        throw new errorHandler_1.AppError("Failed to update influencer", 500);
    }
};
exports.updateInfluencer = updateInfluencer;
const deleteInfluencer = async (req, res) => {
    const { id } = req.params;
    const force = req.query.force === "true";
    try {
        if (!req.user || !req.user.id)
            throw new errorHandler_1.AppError("Not authenticated", 401);
        const influencer = await prisma.influencer.findUnique({ where: { id } });
        if (!influencer)
            throw new errorHandler_1.AppError("Influencer not found", 404);
        if (influencer.managerId !== req.user.id)
            throw new errorHandler_1.AppError("Not authorized to delete this influencer", 403);
        const emails = await prisma.email.findMany({
            where: { influencerId: id },
            select: { id: true, status: true, scheduledJobId: true },
        });
        const activeStatuses = new Set([
            String(client_1.EmailStatus.PENDING),
            String(client_1.EmailStatus.QUEUED),
            String(client_1.EmailStatus.PROCESSING),
        ]);
        const hasActive = emails.some((e) => activeStatuses.has(String(e.status)));
        if (hasActive && !force) {
            return res.status(409).json({
                success: false,
                message: "Influencer has active/queued email(s). To delete anyway pass ?force=true (admin action).",
                activeEmailCount: emails.filter((e) => activeStatuses.has(String(e.status))).length,
            });
        }
        // best-effort: remove scheduled jobs
        for (const e of emails) {
            const jid = e.scheduledJobId;
            if (jid) {
                try {
                    if (redis_queue_1.default?.followUpQueue &&
                        typeof redis_queue_1.default.followUpQueue.remove === "function") {
                        await redis_queue_1.default.followUpQueue.remove(jid);
                    }
                    if (redis_queue_1.default?.emailSendQueue &&
                        typeof redis_queue_1.default.emailSendQueue.remove === "function") {
                        await redis_queue_1.default.emailSendQueue.remove(jid);
                    }
                }
                catch (rmErr) {
                    console.warn("[deleteInfluencer] failed to remove job", jid, rmErr);
                }
            }
        }
        if (!hasActive) {
            await prisma.$transaction([
                prisma.email.deleteMany({ where: { influencerId: id } }),
                prisma.influencer.delete({ where: { id } }),
            ]);
            return res.json({
                success: true,
                message: `Influencer deleted. Removed ${emails.length} related email records.`,
            });
        }
        // force deletion path
        for (const e of emails) {
            const jid = e.scheduledJobId;
            if (jid) {
                try {
                    if (redis_queue_1.default?.followUpQueue &&
                        typeof redis_queue_1.default.followUpQueue.remove === "function") {
                        await redis_queue_1.default.followUpQueue.remove(jid);
                    }
                    if (redis_queue_1.default?.emailSendQueue &&
                        typeof redis_queue_1.default.emailSendQueue.remove === "function") {
                        await redis_queue_1.default.emailSendQueue.remove(jid);
                    }
                }
                catch (rmErr) {
                    console.warn("[deleteInfluencer|force] failed to remove job", jid, rmErr);
                }
            }
        }
        await prisma.$transaction([
            prisma.email.deleteMany({ where: { influencerId: id } }),
            prisma.influencer.delete({ where: { id } }),
        ]);
        return res.json({
            success: true,
            message: `Influencer and related emails deleted (force=true). Deleted ${emails.length} emails.`,
        });
    }
    catch (error) {
        console.error("Delete influencer error:", error);
        if (error instanceof errorHandler_1.AppError)
            throw error;
        throw new errorHandler_1.AppError("Failed to delete influencer", 500);
    }
};
exports.deleteInfluencer = deleteInfluencer;
const bulkDeleteInfluencers = async (req, res) => {
    try {
        const { ids, force = false } = req.body;
        if (!Array.isArray(ids) || ids.length === 0)
            throw new errorHandler_1.AppError("Invalid influencer IDs", 400);
        if (!req.user || !req.user.id)
            throw new errorHandler_1.AppError("Not authenticated", 401);
        // gather email metadata
        const emails = await prisma.email.findMany({
            where: { influencerId: { in: ids } },
            select: {
                id: true,
                influencerId: true,
                status: true,
                scheduledJobId: true,
            },
        });
        const activeStatuses = new Set([
            String(client_1.EmailStatus.PENDING),
            String(client_1.EmailStatus.QUEUED),
            String(client_1.EmailStatus.PROCESSING),
        ]);
        const influencersWithActive = new Set();
        for (const e of emails) {
            if (activeStatuses.has(String(e.status)))
                influencersWithActive.add(e.influencerId);
        }
        if (influencersWithActive.size > 0 && !force) {
            return res.status(409).json({
                success: false,
                message: "One or more influencers have active/queued email(s). To delete them anyway pass { force: true } in body (admin action).",
                activeInfluencerCount: influencersWithActive.size,
                activeInfluencerIds: Array.from(influencersWithActive),
            });
        }
        // deletable ids = those without active emails
        const deletableIds = ids.filter((i) => !influencersWithActive.has(i));
        // Remove scheduled jobs for deletable influencers (best-effort)
        for (const e of emails.filter((x) => deletableIds.includes(x.influencerId))) {
            const jid = e.scheduledJobId;
            if (jid) {
                try {
                    if (redis_queue_1.default?.followUpQueue &&
                        typeof redis_queue_1.default.followUpQueue.remove === "function") {
                        await redis_queue_1.default.followUpQueue.remove(jid);
                    }
                    if (redis_queue_1.default?.emailSendQueue &&
                        typeof redis_queue_1.default.emailSendQueue.remove === "function") {
                        await redis_queue_1.default.emailSendQueue.remove(jid);
                    }
                }
                catch (rmErr) {
                    console.warn("[bulkDeleteInfluencers] failed to remove job", jid, rmErr);
                }
            }
        }
        if (deletableIds.length > 0) {
            await prisma.$transaction([
                prisma.email.deleteMany({
                    where: { influencerId: { in: deletableIds } },
                }),
                prisma.influencer.deleteMany({ where: { id: { in: deletableIds } } }),
            ]);
        }
        return res.json({
            success: true,
            message: `Deleted ${deletableIds.length} influencers (those without active emails). ${ids.length - deletableIds.length} skipped.`,
            deletedCount: deletableIds.length,
            skipped: ids.length - deletableIds.length,
        });
    }
    catch (error) {
        if (error instanceof errorHandler_1.AppError)
            throw error;
        throw new errorHandler_1.AppError("Failed to bulk delete influencers", 500);
    }
};
exports.bulkDeleteInfluencers = bulkDeleteInfluencers;
const bulkUpdateStatus = async (req, res) => {
    try {
        const { ids, status } = req.body;
        if (!Array.isArray(ids) || ids.length === 0)
            throw new errorHandler_1.AppError("Invalid influencer IDs", 400);
        if (!req.user || !req.user.id)
            throw new errorHandler_1.AppError("Not authenticated", 401);
        const result = await prisma.influencer.updateMany({
            where: { id: { in: ids }, managerId: req.user.id },
            data: { status, lastContactDate: new Date() },
        });
        return res.json({
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
        if (!Array.isArray(influencers) || influencers.length === 0)
            throw new errorHandler_1.AppError("Invalid influencer data", 400);
        if (!req.user || !req.user.id)
            throw new errorHandler_1.AppError("Not authenticated", 401);
        const results = {
            success: 0,
            failed: 0,
            errors: [],
            duplicates: [],
        };
        // duplicate checks scoped to current user
        const duplicateChecks = await Promise.all(influencers.map(async (data, index) => {
            const dup = await prisma.influencer.findFirst({
                where: {
                    managerId: req.user.id,
                    OR: [
                        data.email
                            ? { email: { equals: data.email, mode: "insensitive" } }
                            : undefined,
                        data.instagramHandle
                            ? {
                                instagramHandle: {
                                    equals: data.instagramHandle,
                                    mode: "insensitive",
                                },
                            }
                            : undefined,
                    ].filter(Boolean),
                },
                select: {
                    id: true,
                    name: true,
                    email: true,
                    instagramHandle: true,
                    status: true,
                },
            });
            return { index, data, duplicate: dup };
        }));
        for (const { index, data, duplicate } of duplicateChecks) {
            try {
                if (duplicate) {
                    results.failed++;
                    results.duplicates.push({
                        index,
                        data,
                        duplicate: formatDuplicateResponse(duplicate),
                    });
                    results.errors.push({
                        index,
                        error: "Duplicate influencer",
                        duplicate: formatDuplicateResponse(duplicate),
                    });
                    continue;
                }
                await prisma.influencer.create({
                    data: {
                        name: data.name,
                        email: data.email,
                        instagramHandle: data.instagramHandle,
                        link: data.link,
                        followers: data.followers,
                        country: data.country,
                        notes: data.notes,
                        status: "NOT_SENT",
                        managerId: req.user.id,
                    },
                });
                results.success++;
            }
            catch (err) {
                results.failed++;
                results.errors.push({
                    index,
                    error: err instanceof Error ? err.message : "Unknown error",
                });
            }
        }
        return res.json(results);
    }
    catch (error) {
        if (error instanceof errorHandler_1.AppError)
            throw error;
        throw new errorHandler_1.AppError("Failed to import influencers", 500);
    }
};
exports.importInfluencers = importInfluencers;
const checkDuplicates = async (req, res) => {
    try {
        const { email, instagramHandle, excludeId } = req.body;
        if (!req.user || !req.user.id)
            throw new errorHandler_1.AppError("Not authenticated", 401);
        const or = [];
        if (email)
            or.push({ email: { equals: email, mode: "insensitive" } });
        if (instagramHandle)
            or.push({
                instagramHandle: { equals: instagramHandle, mode: "insensitive" },
            });
        if (or.length === 0)
            return res.json({ isDuplicate: false, duplicate: null });
        const whereClause = { managerId: req.user.id, AND: [{ OR: or }] };
        if (excludeId)
            whereClause.AND.push({ id: { not: excludeId } });
        const duplicate = await prisma.influencer.findFirst({
            where: whereClause,
            select: {
                id: true,
                name: true,
                email: true,
                instagramHandle: true,
                status: true,
            },
        });
        if (duplicate)
            return res.json({
                isDuplicate: true,
                duplicate: formatDuplicateResponse(duplicate),
            });
        return res.json({ isDuplicate: false, duplicate: null });
    }
    catch (error) {
        throw new errorHandler_1.AppError("Failed to check duplicates", 500);
    }
};
exports.checkDuplicates = checkDuplicates;
const stopAutomation = async (req, res) => {
    try {
        const { id: influencerId } = req.params;
        if (!req.user || !req.user.id)
            throw new errorHandler_1.AppError("Not authenticated", 401);
        const influencer = await prisma.influencer.findUnique({
            where: { id: influencerId },
            select: {
                id: true,
                notes: true,
                managerId: true,
                emails: {
                    select: {
                        id: true,
                        scheduledJobId: true,
                        status: true,
                        isAutomation: true,
                    },
                },
            },
        });
        if (!influencer)
            throw new errorHandler_1.AppError("Influencer not found", 404);
        if (influencer.managerId !== req.user.id)
            throw new errorHandler_1.AppError("Not authorized to manage this influencer", 403);
        const jobIds = Array.from(new Set((influencer.emails || []).map((e) => e.scheduledJobId).filter(Boolean)));
        for (const jid of jobIds) {
            try {
                if (redis_queue_1.default?.followUpQueue &&
                    typeof redis_queue_1.default.followUpQueue.remove === "function") {
                    await redis_queue_1.default.followUpQueue.remove(jid);
                }
            }
            catch (err) {
                console.warn("[stopAutomation] failed to remove followUp job", jid, err);
            }
            try {
                if (redis_queue_1.default?.emailSendQueue &&
                    typeof redis_queue_1.default.emailSendQueue.remove === "function") {
                    await redis_queue_1.default.emailSendQueue.remove(jid);
                }
            }
            catch (err) {
                console.warn("[stopAutomation] failed to remove emailSend job", jid, err);
            }
        }
        const now = new Date();
        const notesAppend = `\nAutomation stopped manually by user ${req.user.id || "unknown"} at ${now.toISOString()}`;
        const emailUpdateWhere = {
            influencerId,
            isAutomation: true,
            status: {
                in: [client_1.EmailStatus.PENDING, client_1.EmailStatus.QUEUED, client_1.EmailStatus.PROCESSING],
            },
        };
        const [emailsUpdated] = await prisma.$transaction([
            prisma.email.updateMany({
                where: emailUpdateWhere,
                data: {
                    status: client_1.EmailStatus.FAILED,
                    errorMessage: "Automation stopped manually",
                },
            }),
            prisma.influencer.update({
                where: { id: influencerId },
                data: {
                    status: client_1.InfluencerStatus.NOT_SENT,
                    notes: (influencer.notes || "") + notesAppend,
                    lastContactDate: now,
                },
            }),
        ]);
        return res.json({
            success: true,
            message: "Automation stopped",
            jobsRemoved: jobIds.length,
            emailsUpdated: (emailsUpdated && (emailsUpdated.count ?? emailsUpdated)) || 0,
        });
    }
    catch (error) {
        console.error("stopAutomation error:", error);
        if (error instanceof errorHandler_1.AppError)
            throw error;
        throw new errorHandler_1.AppError("Failed to stop automation", 500);
    }
};
exports.stopAutomation = stopAutomation;
const influencerController = {
    getInfluencers: exports.getInfluencers,
    getInfluencer: exports.getInfluencer,
    createInfluencer: exports.createInfluencer,
    updateInfluencer: exports.updateInfluencer,
    deleteInfluencer: exports.deleteInfluencer,
    bulkDeleteInfluencers: exports.bulkDeleteInfluencers,
    bulkUpdateStatus: exports.bulkUpdateStatus,
    importInfluencers: exports.importInfluencers,
    checkDuplicates: exports.checkDuplicates,
    stopAutomation: exports.stopAutomation,
};
exports.default = influencerController;
