"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ImportController = void 0;
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const prisma_1 = require("../config/prisma");
const import_export_queue_1 = require("../lib/import-export-queue");
const errorHandler_1 = require("../middleware/errorHandler");
const storage_1 = require("@google-cloud/storage");
const crypto_1 = __importDefault(require("crypto"));
const prisma = (0, prisma_1.getPrisma)();
const GCS_BUCKET = process.env.GCS_BUCKET || "influencers-import-storage";
if (!GCS_BUCKET) {
    console.warn("[import.controller] GCS_BUCKET not set — controller cannot upload to GCS");
}
// Use explicit keyFilename if provided, otherwise use ADC.
// This avoids crashes in environments where credentials come from VM metadata.
const storageClient = new storage_1.Storage(process.env.GOOGLE_APPLICATION_CREDENTIALS
    ? { keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS }
    : undefined);
/**
 * Use memoryStorage for multer so we can upload directly from buffer to GCS.
 */
const upload = (0, multer_1.default)({
    storage: multer_1.default.memoryStorage(),
    limits: {
        fileSize: Number(process.env.MAX_IMPORT_FILE_MB || 200) * 1024 * 1024,
    },
});
const makeGcsKey = (managerId, originalname) => {
    const ts = Date.now();
    const rand = crypto_1.default.randomBytes(6).toString("hex");
    const safeName = String(originalname).replace(/[^a-zA-Z0-9.\-_]/g, "_");
    return `imports/${managerId}/${ts}-${rand}-${safeName}`;
};
const hasImportJobField = async (field) => {
    // Lightweight runtime check: ask Prisma for select of that field on a non-existing id
    // and see if Prisma throws or accepts the field.
    try {
        // This will throw if field isn't in the model's select type
        await prisma.importJob.findFirst({
            select: { id: true, [field]: true },
            where: { id: null },
        });
        return true;
    }
    catch {
        return false;
    }
};
exports.ImportController = {
    importInfluencers: [
        upload.single("file"),
        async (req, res) => {
            try {
                if (!req.user?.id)
                    throw new errorHandler_1.AppError("Not authenticated", 401);
                const file = req.file;
                if (!file)
                    throw new errorHandler_1.AppError("File required", 400);
                // Create import job record with PENDING and placeholder filePath (will update)
                const jobRecord = await prisma.importJob.create({
                    data: {
                        managerId: req.user.id,
                        filename: file.originalname,
                        status: "PENDING",
                    },
                });
                let filePath = file.path || ""; // fallback (should not exist with memoryStorage)
                let fileUrl = null;
                if (GCS_BUCKET) {
                    const key = makeGcsKey(req.user.id, file.originalname);
                    const bucket = storageClient.bucket(GCS_BUCKET);
                    const gcsFile = bucket.file(key);
                    // Upload buffer (non-resumable)
                    await gcsFile.save(file.buffer, {
                        metadata: {
                            contentType: file.mimetype || "application/octet-stream",
                            metadata: {
                                originalName: file.originalname,
                                importJobId: jobRecord.id,
                            },
                        },
                        resumable: false,
                        public: false,
                    });
                    filePath = `gs://${GCS_BUCKET}/${key}`;
                    // Optionally generate a signed URL (24h) for UI preview
                    try {
                        const signedUrl = await gcsFile.getSignedUrl({
                            action: "read",
                            expires: Date.now() + 1000 * 60 * 60 * 24, // 24h
                        });
                        fileUrl = Array.isArray(signedUrl) ? signedUrl[0] : signedUrl;
                    }
                    catch (e) {
                        console.warn("[import.controller] failed to create signed URL:", e);
                        fileUrl = null;
                    }
                    // Update job record: only set fileUrl if the ImportJob model supports it.
                    try {
                        const supportsFileUrl = await hasImportJobField("fileUrl");
                        const updateData = { filePath };
                        if (supportsFileUrl && fileUrl)
                            updateData.fileUrl = fileUrl;
                        // Using `as any` here to avoid polymorphic type complaints in TS if you haven't updated schema.
                        await prisma.importJob.update({
                            where: { id: jobRecord.id },
                            data: updateData,
                        });
                    }
                    catch (uErr) {
                        console.warn("[import.controller] failed to persist file metadata to importJob:", uErr);
                    }
                }
                else {
                    // fallback: write to local tmp (keep old behaviour)
                    const uploadDir = path_1.default.join(process.cwd(), "tmp", "imports");
                    fs_1.default.mkdirSync(uploadDir, { recursive: true });
                    const localName = `${Date.now()}-${file.originalname}`;
                    const localPath = path_1.default.join(uploadDir, localName);
                    await fs_1.default.promises.writeFile(localPath, file.buffer);
                    filePath = localPath;
                    // persist local path
                    try {
                        await prisma.importJob.update({
                            where: { id: jobRecord.id },
                            data: { filePath: filePath },
                        });
                    }
                    catch (uErr) {
                        console.warn("[import.controller] failed to persist local filePath to importJob:", uErr);
                    }
                }
                await (0, import_export_queue_1.enqueueImport)({
                    managerId: req.user.id,
                    filePath,
                    filename: file.originalname,
                    importJobId: jobRecord.id,
                });
                return res.status(202).json({
                    message: "Import queued",
                    jobId: jobRecord.id,
                    filePath,
                    fileUrl,
                });
            }
            catch (err) {
                console.error("importInfluencers error:", err);
                if (err instanceof errorHandler_1.AppError)
                    throw err;
                throw new errorHandler_1.AppError("Failed to queue import", 500);
            }
        },
    ],
    importMultipleFiles: [
        upload.array("files"),
        async (req, res) => {
            try {
                if (!req.user?.id)
                    throw new errorHandler_1.AppError("Not authenticated", 401);
                const files = req.files;
                if (!files || files.length === 0)
                    throw new errorHandler_1.AppError("Files required", 400);
                const results = [];
                const supportsFileUrl = await hasImportJobField("fileUrl");
                for (const file of files) {
                    const jobRecord = await prisma.importJob.create({
                        data: {
                            managerId: req.user.id,
                            filename: file.originalname,
                            status: "PENDING",
                        },
                    });
                    let filePath = "";
                    let fileUrl = null;
                    if (GCS_BUCKET) {
                        const key = makeGcsKey(req.user.id, file.originalname);
                        const bucket = storageClient.bucket(GCS_BUCKET);
                        const gcsFile = bucket.file(key);
                        await gcsFile.save(file.buffer, {
                            metadata: {
                                contentType: file.mimetype || "application/octet-stream",
                            },
                            resumable: false,
                            public: false,
                        });
                        filePath = `gs://${GCS_BUCKET}/${key}`;
                        try {
                            const signedUrl = await gcsFile.getSignedUrl({
                                action: "read",
                                expires: Date.now() + 1000 * 60 * 60 * 24,
                            });
                            fileUrl = Array.isArray(signedUrl) ? signedUrl[0] : signedUrl;
                        }
                        catch (e) {
                            fileUrl = null;
                        }
                        try {
                            const updateData = { filePath };
                            if (supportsFileUrl && fileUrl)
                                updateData.fileUrl = fileUrl;
                            await prisma.importJob.update({
                                where: { id: jobRecord.id },
                                data: updateData,
                            });
                        }
                        catch (uErr) {
                            console.warn("[import.controller] failed to persist imported file metadata:", uErr);
                        }
                    }
                    else {
                        // fallback local temp storage
                        const uploadDir = path_1.default.join(process.cwd(), "tmp", "imports");
                        fs_1.default.mkdirSync(uploadDir, { recursive: true });
                        const localName = `${Date.now()}-${file.originalname}`;
                        const localPath = path_1.default.join(uploadDir, localName);
                        await fs_1.default.promises.writeFile(localPath, file.buffer);
                        filePath = localPath;
                        try {
                            await prisma.importJob.update({
                                where: { id: jobRecord.id },
                                data: { filePath },
                            });
                        }
                        catch (uErr) {
                            console.warn("[import.controller] failed to persist local import job metadata:", uErr);
                        }
                    }
                    await (0, import_export_queue_1.enqueueImport)({
                        managerId: req.user.id,
                        filePath,
                        filename: file.originalname,
                        importJobId: jobRecord.id,
                    });
                    results.push({
                        filename: file.originalname,
                        jobId: jobRecord.id,
                        filePath,
                        fileUrl,
                    });
                }
                return res
                    .status(202)
                    .json({ message: "Batch import queued", jobs: results });
            }
            catch (err) {
                console.error("importMultipleFiles error:", err);
                if (err instanceof errorHandler_1.AppError)
                    throw err;
                throw new errorHandler_1.AppError("Failed to queue batch imports", 500);
            }
        },
    ],
    getImportStatus: async (req, res) => {
        try {
            if (!req.user?.id)
                throw new errorHandler_1.AppError("Not authenticated", 401);
            const { jobId } = req.params;
            if (!jobId)
                throw new errorHandler_1.AppError("jobId is required", 400);
            const job = await prisma.importJob.findUnique({ where: { id: jobId } });
            if (!job)
                throw new errorHandler_1.AppError("Not found", 404);
            if (job.managerId !== req.user.id)
                throw new errorHandler_1.AppError("Not authorized", 403);
            return res.json(job);
        }
        catch (err) {
            if (err instanceof errorHandler_1.AppError)
                throw err;
            throw new errorHandler_1.AppError("Failed to get import status", 500);
        }
    },
    cancelImportJob: async (req, res) => {
        try {
            if (!req.user?.id)
                throw new errorHandler_1.AppError("Not authenticated", 401);
            const { jobId } = req.params;
            if (!jobId)
                throw new errorHandler_1.AppError("jobId is required", 400);
            const job = await prisma.importJob.findUnique({ where: { id: jobId } });
            if (!job)
                throw new errorHandler_1.AppError("Not found", 404);
            if (job.managerId !== req.user.id)
                throw new errorHandler_1.AppError("Not authorized", 403);
            if (!["PENDING", "PROCESSING"].includes(job.status)) {
                return res
                    .status(400)
                    .json({ message: "Job cannot be cancelled in current status" });
            }
            await prisma.importJob.update({
                where: { id: jobId },
                data: {
                    status: "FAILED",
                    errors: [{ error: "Cancelled by user" }],
                },
            });
            return res.json({ success: true, message: "Job cancelled" });
        }
        catch (err) {
            if (err instanceof errorHandler_1.AppError)
                throw err;
            throw new errorHandler_1.AppError("Failed to cancel import job", 500);
        }
    },
};
exports.default = exports.ImportController;
