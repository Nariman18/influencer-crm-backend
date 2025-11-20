"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deleteEmailTemplate = exports.updateEmailTemplate = exports.createEmailTemplate = exports.getEmailTemplate = exports.getEmailTemplates = void 0;
const prisma_1 = require("../config/prisma");
const errorHandler_1 = require("../middleware/errorHandler");
const prisma = (0, prisma_1.getPrisma)();
const getEmailTemplates = async (req, res) => {
    try {
        const isActive = req.query.isActive === "true"
            ? true
            : req.query.isActive === "false"
                ? false
                : undefined;
        const templates = await prisma.emailTemplate.findMany({
            where: {
                ...(isActive !== undefined && { isActive }),
            },
            orderBy: { createdAt: "desc" },
        });
        res.json(templates);
    }
    catch (error) {
        throw new errorHandler_1.AppError("Failed to fetch email templates", 500);
    }
};
exports.getEmailTemplates = getEmailTemplates;
const getEmailTemplate = async (req, res) => {
    try {
        const { id } = req.params;
        const template = await prisma.emailTemplate.findUnique({
            where: { id },
        });
        if (!template) {
            throw new errorHandler_1.AppError("Email template not found", 404);
        }
        res.json(template);
    }
    catch (error) {
        if (error instanceof errorHandler_1.AppError)
            throw error;
        throw new errorHandler_1.AppError("Failed to fetch email template", 500);
    }
};
exports.getEmailTemplate = getEmailTemplate;
const createEmailTemplate = async (req, res) => {
    try {
        const { name, subject, body, variables } = req.body;
        const template = await prisma.emailTemplate.create({
            data: {
                name,
                subject,
                body,
                variables: variables || [],
            },
        });
        res.status(201).json(template);
    }
    catch (error) {
        throw new errorHandler_1.AppError("Failed to create email template", 500);
    }
};
exports.createEmailTemplate = createEmailTemplate;
const updateEmailTemplate = async (req, res) => {
    try {
        const { id } = req.params;
        const { name, subject, body, variables, isActive } = req.body;
        const template = await prisma.emailTemplate.update({
            where: { id },
            data: {
                name,
                subject,
                body,
                variables,
                isActive,
            },
        });
        res.json(template);
    }
    catch (error) {
        if (error instanceof errorHandler_1.AppError)
            throw error;
        throw new errorHandler_1.AppError("Failed to update email template", 500);
    }
};
exports.updateEmailTemplate = updateEmailTemplate;
const deleteEmailTemplate = async (req, res) => {
    try {
        const { id } = req.params;
        await prisma.emailTemplate.delete({
            where: { id },
        });
        res.json({ message: "Email template deleted successfully" });
    }
    catch (error) {
        throw new errorHandler_1.AppError("Failed to delete email template", 500);
    }
};
exports.deleteEmailTemplate = deleteEmailTemplate;
