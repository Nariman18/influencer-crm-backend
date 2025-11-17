"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.stopAutomation = exports.checkDuplicates = exports.importInfluencers = exports.bulkUpdateStatus = exports.bulkDeleteInfluencers = exports.deleteInfluencer = exports.updateInfluencer = exports.createInfluencer = exports.getInfluencer = exports.getInfluencers = void 0;
const prisma_1 = __importDefault(require("../config/prisma"));
const errorHandler_1 = require("../middleware/errorHandler");
const client_1 = require("@prisma/client");
const redis_queue_1 = __importDefault(require("../lib/redis-queue"));
// Helper function to check for duplicates
const checkForDuplicates = async (email, instagramHandle, excludeId) => {
    try {
        console.log("🔍 [BACKEND] checkForDuplicates called with:", {
            email,
            instagramHandle,
            excludeId,
        });
        // If no search criteria provided, return null
        if (!email && !instagramHandle) {
            console.log("🔍 [BACKEND] No search criteria provided");
            return null;
        }
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
        // If no valid conditions after trimming, return null
        if (orConditions.length === 0) {
            console.log("🔍 [BACKEND] No valid search conditions after trimming");
            return null;
        }
        console.log("🔍 [BACKEND] Searching with conditions:", JSON.stringify(orConditions));
        const whereClause = {
            AND: [...(orConditions.length > 0 ? [{ OR: orConditions }] : [])],
        };
        // Only add excludeId if it's provided and valid
        if (excludeId && excludeId.trim() !== "") {
            whereClause.AND.push({ id: { not: excludeId } });
        }
        console.log("🔍 [BACKEND] Final WHERE clause:", JSON.stringify(whereClause));
        const existing = await prisma_1.default.influencer.findFirst({
            where: whereClause,
            select: {
                id: true,
                name: true,
                email: true,
                instagramHandle: true,
                status: true,
            },
        });
        console.log("🔍 [BACKEND] Database query result:", existing);
        return existing;
    }
    catch (error) {
        console.error("❌ [BACKEND] Error in checkForDuplicates:", error);
        // If it's a database connection error or empty database, return null
        // This allows the application to continue working even if database is empty
        if (error instanceof Error) {
            if (error.message.includes("database") ||
                error.message.includes("connection")) {
                console.log("🔍 [BACKEND] Database issue, returning null");
                return null;
            }
        }
        throw error;
    }
};
const formatDuplicateResponse = (duplicate) => {
    return {
        id: duplicate.id,
        name: duplicate.name,
        email: duplicate.email ?? undefined,
        instagramHandle: duplicate.instagramHandle ?? undefined,
        status: duplicate.status,
    };
};
const getInfluencers = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const status = req.query.status;
        const search = req.query.search;
        const emailFilter = req.query.emailFilter;
        const skip = (page - 1) * limit;
        let where = {};
        // Status filter
        if (status) {
            where.status = status;
        }
        // Search filter
        if (search) {
            where.OR = [
                { name: { contains: search, mode: "insensitive" } },
                { email: { contains: search, mode: "insensitive" } },
                { instagramHandle: { contains: search, mode: "insensitive" } },
                // Removed nickname from search since it's no longer in Influencer model
            ];
        }
        // Email filter
        if (emailFilter) {
            const normalizedEmailFilter = emailFilter?.toLowerCase().trim();
            if (normalizedEmailFilter === "has-email") {
                where.email = { not: null };
            }
            else if (normalizedEmailFilter === "no-email") {
                where.email = null;
            }
        }
        // Get the data
        const [influencers, total] = await Promise.all([
            prisma_1.default.influencer.findMany({
                where,
                skip,
                take: limit,
                orderBy: { createdAt: "desc" },
                include: {
                    contracts: {
                        select: { id: true, status: true, amount: true },
                    },
                    manager: {
                        select: { id: true, name: true, email: true },
                    },
                    _count: { select: { emails: true } },
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
        console.error("❌ Error fetching influencers:", error);
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
                manager: {
                    select: { id: true, name: true, email: true },
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
        console.log("🎯 [ROUTE DEBUG] === CREATE INFLUENCER ROUTE REACHED ===");
        // CRITICAL: Check if middleware actually ran
        console.log("🎯 [ROUTE DEBUG] req.user:", req.user);
        if (!req.user) {
            console.error("🚨 [ROUTE DEBUG] CRITICAL: req.user is NULL in route handler!");
            res.status(401).json({
                error: "Authentication failed - req.user is null",
                debug: "Check if authentication middleware is executing",
            });
            return;
        }
        const { name, email, instagramHandle, followers, country, notes, link } = req.body;
        // Enhanced duplicate validation
        const duplicate = await checkForDuplicates(email, instagramHandle);
        if (duplicate) {
            throw new errorHandler_1.AppError("Influencer already exists", 400, {
                duplicate: formatDuplicateResponse(duplicate),
            });
        }
        // Validate that user is authenticated and has an ID
        if (!req.user?.id) {
            console.error("❌ [BACKEND] No user ID found in request");
            throw new errorHandler_1.AppError("User not authenticated", 401);
        }
        // FIXED: Only include fields that exist in the Influencer model
        const influencer = await prisma_1.default.influencer.create({
            data: {
                name,
                email: email || null,
                instagramHandle: instagramHandle || null,
                link: link || null,
                followers: followers ? parseInt(followers) : null,
                country: country || null,
                notes: notes || null,
                status: "NOT_SENT",
                manager: {
                    connect: { id: req.user.id },
                },
            },
            include: {
                manager: {
                    select: { id: true, name: true, email: true },
                },
            },
        });
        res.status(201).json(influencer);
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
        // FIXED: Only include fields that exist in the Influencer model
        const updateData = {
            name,
            email: email || null,
            instagramHandle: instagramHandle || null,
            link: link || null,
            followers: followers ? parseInt(followers) : null,
            country: country || null,
            status,
            notes: notes || null,
            lastContactDate,
        };
        const influencer = await prisma_1.default.influencer.update({
            where: { id },
            data: updateData,
            include: {
                manager: {
                    select: { id: true, name: true, email: true },
                },
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
    const { id } = req.params;
    const force = req.query.force === "true";
    try {
        if (!req.user) {
            throw new errorHandler_1.AppError("Not authenticated", 401);
        }
        const influencer = await prisma_1.default.influencer.findUnique({ where: { id } });
        if (!influencer) {
            throw new errorHandler_1.AppError("Influencer not found", 404);
        }
        // fetch related emails (small projection)
        const emails = await prisma_1.default.email.findMany({
            where: { influencerId: id },
            select: { id: true, status: true, scheduledJobId: true },
        });
        // statuses considered "active" (do not delete if any exist unless force=true)
        const activeStatuses = new Set([
            String(client_1.EmailStatus.PENDING),
            String(client_1.EmailStatus.QUEUED),
            String(client_1.EmailStatus.PROCESSING),
        ]);
        const hasActive = emails.some((e) => activeStatuses.has(String(e.status)));
        if (hasActive && !force) {
            // there are active emails -> refuse deletion unless forced
            return res.status(409).json({
                success: false,
                message: "Influencer has active/queued email(s). To delete anyway pass ?force=true (admin action).",
                activeEmailCount: emails.filter((e) => activeStatuses.has(String(e.status))).length,
            });
        }
        // If no active emails -> safe-delete: remove email records and influencer
        if (!hasActive) {
            // best-effort: remove scheduled jobs for these emails (if any)
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
            // Delete emails + influencer in transaction
            await prisma_1.default.$transaction([
                prisma_1.default.email.deleteMany({ where: { influencerId: id } }),
                prisma_1.default.influencer.delete({ where: { id } }),
            ]);
            return res.json({
                success: true,
                message: `Influencer deleted. Removed ${emails.length} related email records.`,
            });
        }
        // If we reach here, there were active emails and force=true was handled further down
        if (force && emails.length > 0) {
            // Attempt to remove scheduled jobs (best-effort)
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
            await prisma_1.default.$transaction([
                prisma_1.default.email.deleteMany({ where: { influencerId: id } }),
                prisma_1.default.influencer.delete({ where: { id } }),
            ]);
            return res.json({
                success: true,
                message: `Influencer and related emails deleted (force=true). Deleted ${emails.length} emails.`,
            });
        }
        // fallback (shouldn't happen)
        return res.status(409).json({
            success: false,
            message: "Unable to delete influencer - unknown state.",
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
// Bulk multiple influencer delete
const bulkDeleteInfluencers = async (req, res) => {
    try {
        const { ids, force = false } = req.body;
        if (!Array.isArray(ids) || ids.length === 0) {
            throw new errorHandler_1.AppError("Invalid influencer IDs", 400);
        }
        // gather email metadata for all influencers
        const emails = await prisma_1.default.email.findMany({
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
        // track which influencerIds have active emails
        const influencersWithActive = new Set();
        for (const e of emails) {
            if (activeStatuses.has(String(e.status))) {
                influencersWithActive.add(e.influencerId);
            }
        }
        if (influencersWithActive.size > 0 && !force) {
            return res.status(409).json({
                success: false,
                message: "One or more influencers have active/queued email(s). To delete them anyway pass { force: true } in body (admin action).",
                activeInfluencerCount: influencersWithActive.size,
                activeInfluencerIds: Array.from(influencersWithActive),
            });
        }
        // For influencers that have NO active emails -> we will delete emails + influencer
        // For force=true we delete all requested influencers (best-effort removing scheduled jobs)
        if (!force) {
            // compute deletable influencer ids: those without active emails
            const influencerIdsWithEmails = new Set(emails.map((e) => e.influencerId));
            const deletableIds = ids.filter((i) => !influencersWithActive.has(i));
            // remove scheduled jobs for deletable influencers (best-effort)
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
            // delete emails and influencers for deletableIds
            if (deletableIds.length > 0) {
                await prisma_1.default.$transaction([
                    prisma_1.default.email.deleteMany({
                        where: { influencerId: { in: deletableIds } },
                    }),
                    prisma_1.default.influencer.deleteMany({ where: { id: { in: deletableIds } } }),
                ]);
            }
            return res.json({
                success: true,
                message: `Deleted ${deletableIds.length} influencers (those without active emails). ${ids.length - deletableIds.length} skipped.`,
                deletedCount: deletableIds.length,
                skipped: ids.length - deletableIds.length,
            });
        }
        else {
            // force=true => remove scheduled jobs for all emails then delete everything
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
                        console.warn("[bulkDeleteInfluencers|force] failed to remove job", jid, rmErr);
                    }
                }
            }
            await prisma_1.default.$transaction([
                prisma_1.default.email.deleteMany({ where: { influencerId: { in: ids } } }),
                prisma_1.default.influencer.deleteMany({ where: { id: { in: ids } } }),
            ]);
            return res.json({
                success: true,
                message: `Deleted ${ids.length} influencers and ${emails.length} related emails.`,
            });
        }
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
                // FIXED: Only include fields that exist in the Influencer model
                await prisma_1.default.influencer.create({
                    data: {
                        name: data.name,
                        email: data.email,
                        instagramHandle: data.instagramHandle,
                        link: data.link,
                        followers: data.followers,
                        country: data.country,
                        notes: data.notes,
                        status: "NOT_SENT",
                        // Set the current user as manager for imported influencers
                        managerId: req.user?.id,
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
//
// STOP AUTOMATION MANUALLY
//
const stopAutomation = async (req, res) => {
    try {
        const { id: influencerId } = req.params;
        const influencer = await prisma_1.default.influencer.findUnique({
            where: { id: influencerId },
            select: {
                id: true,
                notes: true,
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
        if (!influencer) {
            throw new errorHandler_1.AppError("Influencer not found", 404);
        }
        // collect scheduled job ids (dedupe)
        const jobIds = Array.from(new Set((influencer.emails || []).map((e) => e.scheduledJobId).filter(Boolean)));
        // best-effort: remove scheduled jobs from queues
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
                // not fatal
                console.warn("[stopAutomation] failed to remove emailSend job", jid, err);
            }
        }
        // Update email rows + influencer pipeline in a transaction
        const now = new Date();
        const notesAppend = `\nAutomation stopped manually by user ${req.user?.id || "unknown"} at ${now.toISOString()}`;
        // Only update automation emails in active sending states
        const emailUpdateWhere = {
            influencerId,
            isAutomation: true,
            status: {
                in: [client_1.EmailStatus.PENDING, client_1.EmailStatus.QUEUED, client_1.EmailStatus.PROCESSING],
            },
        };
        // Use transaction so both updates succeed or fail together
        const [emailsUpdated] = await prisma_1.default
            .$transaction([
            prisma_1.default.email.updateMany({
                where: emailUpdateWhere,
                data: {
                    status: client_1.EmailStatus.FAILED,
                    errorMessage: "Automation stopped manually",
                },
            }),
            prisma_1.default.influencer.update({
                where: { id: influencerId },
                data: {
                    status: client_1.InfluencerStatus.NOT_SENT,
                    notes: (influencer.notes || "") + notesAppend,
                    lastContactDate: now,
                },
            }),
        ])
            .catch((txErr) => {
            // If transaction fails, log and try fallback: update influencer only
            console.error("[stopAutomation] transaction failed:", txErr);
            return Promise.reject(txErr);
        });
        res.json({
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
