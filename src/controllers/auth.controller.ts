import { Request, Response } from "express";
import prisma from "../config/prisma";
import { hashPassword, comparePassword } from "../utils/password";
import { generateToken } from "../utils/jwt";
import { AppError } from "../middleware/errorHandler";
import { AuthRequest } from "../types";

export const register = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password, name, role } = req.body;

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      throw new AppError("User already exists", 400);
    }

    const hashedPassword = await hashPassword(password);

    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name,
        role: role || "MEMBER",
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
      },
    });

    const token = generateToken({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    });

    res.status(201).json({ user, token });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("Registration failed", 500);
  }
};

export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body;

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      throw new AppError("Invalid credentials", 401);
    }

    if (!user.isActive) {
      throw new AppError("Account is inactive", 403);
    }

    const isPasswordValid = await comparePassword(password, user.password);
    if (!isPasswordValid) {
      throw new AppError("Invalid credentials", 401);
    }

    const token = generateToken({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    });

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      token,
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("Login failed", 500);
  }
};

export const getProfile = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    if (!req.user) {
      throw new AppError("Not authenticated", 401);
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isActive: true,
        googleAccessToken: true, // Add this
        googleRefreshToken: true, // Add this
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      throw new AppError("User not found", 404);
    }

    // Return hasGoogleAuth flag instead of actual tokens for security
    res.json({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      isActive: user.isActive,
      hasGoogleAuth: !!(user.googleAccessToken && user.googleRefreshToken),
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("Failed to get profile", 500);
  }
};

export const updateProfile = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    if (!req.user) {
      throw new AppError("Not authenticated", 401);
    }

    const { name, email } = req.body;

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { name, email },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        updatedAt: true,
      },
    });

    res.json(user);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("Failed to update profile", 500);
  }
};
