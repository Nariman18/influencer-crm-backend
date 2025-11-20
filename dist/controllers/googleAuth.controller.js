"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.disconnectGoogleAccount = exports.connectGoogleAccount = exports.exchangeGoogleToken = void 0;
const googleapis_1 = require("googleapis");
const prisma_1 = require("../config/prisma");
const errorHandler_1 = require("../middleware/errorHandler");
const OAuth2 = googleapis_1.google.auth.OAuth2;
const prisma = (0, prisma_1.getPrisma)();
/**
 * Enhanced token exchange with better error handling
 */
const exchangeGoogleToken = async (req, res) => {
    try {
        console.log("🔄 Google token exchange request received");
        const { code } = req.body;
        if (!code) {
            throw new errorHandler_1.AppError("Authorization code required", 400);
        }
        const redirectUri = `${process.env.FRONTEND_URL}/auth/callback`;
        console.log("📝 Exchanging code for tokens...");
        const oauth2Client = new OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, redirectUri);
        // Add better error handling for token exchange**
        let tokens;
        try {
            const tokenResponse = await oauth2Client.getToken(code);
            tokens = tokenResponse.tokens;
            console.log("Tokens received successfully");
        }
        catch (tokenError) {
            console.error("Token exchange failed:", tokenError);
            if (tokenError.message.includes("invalid_grant")) {
                throw new errorHandler_1.AppError("Authorization code is invalid or has expired. Please try connecting again.", 400);
            }
            throw new errorHandler_1.AppError(`Token exchange failed: ${tokenError.message}`, 400);
        }
        if (!tokens.access_token || !tokens.refresh_token) {
            console.error("Incomplete tokens received:", tokens);
            throw new errorHandler_1.AppError("Incomplete tokens received from Google", 400);
        }
        console.log("Token details:", {
            hasAccessToken: !!tokens.access_token,
            hasRefreshToken: !!tokens.refresh_token,
            accessTokenLength: tokens.access_token.length,
            refreshTokenLength: tokens.refresh_token.length,
        });
        // Verify tokens and get user info**
        oauth2Client.setCredentials(tokens);
        const oauth2 = googleapis_1.google.oauth2({
            auth: oauth2Client,
            version: "v2",
        });
        let userInfo;
        try {
            userInfo = await oauth2.userinfo.get();
            console.log("User info retrieved:", userInfo.data.email);
        }
        catch (userInfoError) {
            console.error("Failed to get user info:", userInfoError);
            throw new errorHandler_1.AppError("Failed to verify Google account information", 400);
        }
        if (!userInfo.data.email) {
            throw new errorHandler_1.AppError("Failed to get email from Google account", 400);
        }
        console.log("✅ Google OAuth successful - tokens received");
        res.json({
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            email: userInfo.data.email,
            expiresIn: tokens.expiry_date,
        });
    }
    catch (error) {
        console.error("Google token exchange error:", error);
        if (error instanceof errorHandler_1.AppError)
            throw error;
        throw new errorHandler_1.AppError("Failed to exchange authorization code", 500);
    }
};
exports.exchangeGoogleToken = exchangeGoogleToken;
/**
 * Enhanced Google account connection with token validation
 */
const connectGoogleAccount = async (req, res) => {
    try {
        console.log("🔗 Google account connection request received");
        if (!req.user) {
            throw new errorHandler_1.AppError("Not authenticated", 401);
        }
        const { accessToken, refreshToken, email } = req.body;
        if (!accessToken || !refreshToken || !email) {
            throw new errorHandler_1.AppError("Google tokens and email are required", 400);
        }
        console.log("📝 Storing Google tokens for user:", req.user.id);
        console.log("📧 Gmail address:", email);
        console.log("🔑 Token details:", {
            accessTokenLength: accessToken.length,
            refreshTokenLength: refreshToken.length,
        });
        // Validate tokens before storing**
        const oauth2Client = new OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
        oauth2Client.setCredentials({
            access_token: accessToken,
            refresh_token: refreshToken,
        });
        try {
            // Test token validity
            const tokenInfo = await oauth2Client.getTokenInfo(accessToken);
            console.log("Token is valid, expires at:", new Date(tokenInfo.expiry_date));
            console.log("✅ Google OAuth tokens validated");
        }
        catch (validationError) {
            console.error("Token validation failed:", validationError);
            throw new errorHandler_1.AppError("Google tokens are invalid. Please reconnect your Google account.", 400);
        }
        // Update user with validated tokens**
        const updatedUser = await prisma.user.update({
            where: { id: req.user.id },
            data: {
                googleAccessToken: accessToken,
                googleRefreshToken: refreshToken,
                googleEmail: email,
            },
            select: {
                id: true,
                email: true,
                googleEmail: true,
                name: true,
            },
        });
        console.log("Google account connected successfully:", {
            userId: updatedUser.id,
            userEmail: updatedUser.email,
            gmailAddress: updatedUser.googleEmail,
        });
        res.json({
            message: "Google account connected successfully",
            hasGoogleAuth: true,
            email: email,
            gmailAddress: email,
        });
    }
    catch (error) {
        console.error("Google account connection error:", error);
        if (error instanceof errorHandler_1.AppError)
            throw error;
        throw new errorHandler_1.AppError("Failed to connect Google account", 500);
    }
};
exports.connectGoogleAccount = connectGoogleAccount;
/**
 * Disconnect Google account
 */
const disconnectGoogleAccount = async (req, res) => {
    try {
        if (!req.user) {
            throw new errorHandler_1.AppError("Not authenticated", 401);
        }
        console.log("Disconnecting Google account for user:", req.user.id);
        await prisma.user.update({
            where: { id: req.user.id },
            data: {
                googleAccessToken: null,
                googleRefreshToken: null,
                googleEmail: null,
            },
        });
        console.log("Google account disconnected successfully");
        res.json({
            message: "Google account disconnected successfully",
            hasGoogleAuth: false,
        });
    }
    catch (error) {
        console.error("Google account disconnection error:", error);
        if (error instanceof errorHandler_1.AppError)
            throw error;
        throw new errorHandler_1.AppError("Failed to disconnect Google account", 500);
    }
};
exports.disconnectGoogleAccount = disconnectGoogleAccount;
