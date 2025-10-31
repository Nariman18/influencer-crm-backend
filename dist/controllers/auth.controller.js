"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateProfile = exports.getProfile = exports.login = exports.register = void 0;
const prisma_1 = __importDefault(require("../config/prisma"));
const password_1 = require("../utils/password");
const jwt_1 = require("../utils/jwt");
const errorHandler_1 = require("../middleware/errorHandler");
const register = async (req, res) => {
    try {
        const { email, password, name, role } = req.body;
        const existingUser = await prisma_1.default.user.findUnique({ where: { email } });
        if (existingUser) {
            throw new errorHandler_1.AppError("User already exists", 400);
        }
        const hashedPassword = await (0, password_1.hashPassword)(password);
        const user = await prisma_1.default.user.create({
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
        const token = (0, jwt_1.generateToken)({
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
        });
        res.status(201).json({ user, token });
    }
    catch (error) {
        if (error instanceof errorHandler_1.AppError)
            throw error;
        throw new errorHandler_1.AppError("Registration failed", 500);
    }
};
exports.register = register;
const login = async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await prisma_1.default.user.findUnique({ where: { email } });
        if (!user) {
            throw new errorHandler_1.AppError("Invalid credentials", 401);
        }
        if (!user.isActive) {
            throw new errorHandler_1.AppError("Account is inactive", 403);
        }
        const isPasswordValid = await (0, password_1.comparePassword)(password, user.password);
        if (!isPasswordValid) {
            throw new errorHandler_1.AppError("Invalid credentials", 401);
        }
        const token = (0, jwt_1.generateToken)({
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
    }
    catch (error) {
        if (error instanceof errorHandler_1.AppError)
            throw error;
        throw new errorHandler_1.AppError("Login failed", 500);
    }
};
exports.login = login;
const getProfile = async (req, res) => {
    try {
        if (!req.user) {
            throw new errorHandler_1.AppError("Not authenticated", 401);
        }
        const user = await prisma_1.default.user.findUnique({
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
            throw new errorHandler_1.AppError("User not found", 404);
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
    }
    catch (error) {
        if (error instanceof errorHandler_1.AppError)
            throw error;
        throw new errorHandler_1.AppError("Failed to get profile", 500);
    }
};
exports.getProfile = getProfile;
const updateProfile = async (req, res) => {
    try {
        if (!req.user) {
            throw new errorHandler_1.AppError("Not authenticated", 401);
        }
        const { name, email } = req.body;
        const user = await prisma_1.default.user.update({
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
    }
    catch (error) {
        if (error instanceof errorHandler_1.AppError)
            throw error;
        throw new errorHandler_1.AppError("Failed to update profile", 500);
    }
};
exports.updateProfile = updateProfile;
