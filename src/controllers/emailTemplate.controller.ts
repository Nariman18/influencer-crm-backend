import { Response } from "express";
import { getPrisma } from "../config/prisma";
import { AuthRequest } from "../types";
import { AppError } from "../middleware/errorHandler";

const prisma = getPrisma();

export const getEmailTemplates = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const isActive =
      req.query.isActive === "true"
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
  } catch (error) {
    throw new AppError("Failed to fetch email templates", 500);
  }
};

export const getEmailTemplate = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { id } = req.params;

    const template = await prisma.emailTemplate.findUnique({
      where: { id },
    });

    if (!template) {
      throw new AppError("Email template not found", 404);
    }

    res.json(template);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("Failed to fetch email template", 500);
  }
};

export const createEmailTemplate = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
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
  } catch (error) {
    throw new AppError("Failed to create email template", 500);
  }
};

export const updateEmailTemplate = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
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
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("Failed to update email template", 500);
  }
};

export const deleteEmailTemplate = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { id } = req.params;

    await prisma.emailTemplate.delete({
      where: { id },
    });

    res.json({ message: "Email template deleted successfully" });
  } catch (error) {
    throw new AppError("Failed to delete email template", 500);
  }
};
