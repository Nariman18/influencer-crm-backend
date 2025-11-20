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
const prisma = (0, prisma_1.getPrisma)();
const uploadDir = path_1.default.join(process.cwd(), "tmp", "imports");
fs_1.default.mkdirSync(uploadDir, { recursive: true });
const upload = (0, multer_1.default)({
    storage: multer_1.default.diskStorage({
        destination: (_req, _file, cb) => cb(null, uploadDir),
        filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
    }),
    limits: {
        fileSize: Number(process.env.MAX_IMPORT_FILE_MB || 200) * 1024 * 1024,
    },
});
exports.ImportController = {
    importInfluencers: [
        upload.single("file"),
        async (req, res) => {
            try {
                console.log("[IMPORT] headers:", {
                    authorization: req.headers.authorization,
                    cookies: req.headers.cookie,
                });
                console.log("[IMPORT] req.user present:", !!req.user);
                if (!req.user?.id)
                    throw new errorHandler_1.AppError("Not authenticated", 401);
                const file = req.file;
                if (!file)
                    throw new errorHandler_1.AppError("File required", 400);
                const jobRecord = await prisma.importJob.create({
                    data: {
                        managerId: req.user.id,
                        filename: file.originalname,
                        filePath: file.path,
                        status: "PENDING",
                    },
                });
                await (0, import_export_queue_1.enqueueImport)({
                    managerId: req.user.id,
                    filePath: file.path,
                    filename: file.originalname,
                    importJobId: jobRecord.id,
                });
                return res
                    .status(202)
                    .json({ message: "Import queued", jobId: jobRecord.id });
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
                for (const file of files) {
                    const jobRecord = await prisma.importJob.create({
                        data: {
                            managerId: req.user.id,
                            filename: file.originalname,
                            filePath: file.path,
                            status: "PENDING",
                        },
                    });
                    await (0, import_export_queue_1.enqueueImport)({
                        managerId: req.user.id,
                        filePath: file.path,
                        filename: file.originalname,
                        importJobId: jobRecord.id,
                    });
                    results.push({ filename: file.originalname, jobId: jobRecord.id });
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
