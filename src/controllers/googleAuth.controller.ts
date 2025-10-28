import { Request, Response } from "express";
import { google } from "googleapis";
import prisma from "../config/prisma";
import { AppError } from "../middleware/errorHandler";
import { AuthRequest } from "../types";

const OAuth2 = google.auth.OAuth2;

/**
 * Enhanced token exchange with better error handling
 */
export const exchangeGoogleToken = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    console.log("🔄 Google token exchange request received");

    const { code } = req.body;

    if (!code) {
      throw new AppError("Authorization code required", 400);
    }

    console.log("📝 Exchanging code for tokens...");

    const oauth2Client = new OAuth2(
      process.env.GOOGLE_CLIENT_ID!,
      process.env.GOOGLE_CLIENT_SECRET!,
      `${process.env.FRONTEND_URL}/auth/callback`
    );

    // **FIX: Add better error handling for token exchange**
    let tokens;
    try {
      const tokenResponse = await oauth2Client.getToken(code);
      tokens = tokenResponse.tokens;
      console.log("✅ Tokens received successfully");
    } catch (tokenError: any) {
      console.error("❌ Token exchange failed:", tokenError);
      if (tokenError.message.includes("invalid_grant")) {
        throw new AppError(
          "Authorization code is invalid or has expired. Please try connecting again.",
          400
        );
      }
      throw new AppError(`Token exchange failed: ${tokenError.message}`, 400);
    }

    if (!tokens.access_token || !tokens.refresh_token) {
      console.error("❌ Incomplete tokens received:", tokens);
      throw new AppError("Incomplete tokens received from Google", 400);
    }

    console.log("🔧 Token details:", {
      hasAccessToken: !!tokens.access_token,
      hasRefreshToken: !!tokens.refresh_token,
      accessTokenLength: tokens.access_token.length,
      refreshTokenLength: tokens.refresh_token.length,
    });

    // **FIX: Verify tokens and get user info**
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({
      auth: oauth2Client,
      version: "v2",
    });

    let userInfo;
    try {
      userInfo = await oauth2.userinfo.get();
      console.log("✅ User info retrieved:", userInfo.data.email);
    } catch (userInfoError: any) {
      console.error("❌ Failed to get user info:", userInfoError);
      throw new AppError("Failed to verify Google account information", 400);
    }

    if (!userInfo.data.email) {
      throw new AppError("Failed to get email from Google account", 400);
    }

    // **FIX: Test Gmail API access**
    try {
      const gmail = google.gmail({ version: "v1", auth: oauth2Client });
      // Simple test to verify Gmail access
      await gmail.users.getProfile({ userId: "me" });
      console.log("✅ Gmail API access verified");
    } catch (gmailError: any) {
      console.error("❌ Gmail API access failed:", gmailError);
      throw new AppError(
        "Gmail API access not granted. Please make sure to grant all requested permissions.",
        400
      );
    }

    res.json({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      email: userInfo.data.email,
      expiresIn: tokens.expiry_date,
    });
  } catch (error: unknown) {
    console.error("🔥 Google token exchange error:", error);
    if (error instanceof AppError) throw error;
    throw new AppError("Failed to exchange authorization code", 500);
  }
};

/**
 * Enhanced Google account connection with token validation
 */
export const connectGoogleAccount = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    console.log("🔗 Google account connection request received");

    if (!req.user) {
      throw new AppError("Not authenticated", 401);
    }

    const { accessToken, refreshToken, email } = req.body;

    if (!accessToken || !refreshToken || !email) {
      throw new AppError("Google tokens and email are required", 400);
    }

    console.log("📝 Storing Google tokens for user:", req.user.id);
    console.log("📧 Gmail address:", email);
    console.log("🔑 Token details:", {
      accessTokenLength: accessToken.length,
      refreshTokenLength: refreshToken.length,
    });

    // **FIX: Validate tokens before storing**
    const oauth2Client = new OAuth2(
      process.env.GOOGLE_CLIENT_ID!,
      process.env.GOOGLE_CLIENT_SECRET!,
      process.env.GOOGLE_REDIRECT_URI!
    );

    oauth2Client.setCredentials({
      access_token: accessToken,
      refresh_token: refreshToken,
    });

    try {
      // Test token validity
      const tokenInfo = await oauth2Client.getTokenInfo(accessToken);
      console.log(
        "✅ Token is valid, expires at:",
        new Date(tokenInfo.expiry_date!)
      );

      // Test Gmail access
      const gmail = google.gmail({ version: "v1", auth: oauth2Client });
      await gmail.users.getProfile({ userId: "me" });
      console.log("✅ Gmail access verified");
    } catch (validationError: any) {
      console.error("❌ Token validation failed:", validationError);
      throw new AppError(
        "Google tokens are invalid. Please reconnect your Google account.",
        400
      );
    }

    // **FIX: Update user with validated tokens**
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

    console.log("✅ Google account connected successfully:", {
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
  } catch (error: unknown) {
    console.error("🔥 Google account connection error:", error);
    if (error instanceof AppError) throw error;
    throw new AppError("Failed to connect Google account", 500);
  }
};

/**
 * NEW: Disconnect Google account
 */
export const disconnectGoogleAccount = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    if (!req.user) {
      throw new AppError("Not authenticated", 401);
    }

    console.log("🔓 Disconnecting Google account for user:", req.user.id);

    await prisma.user.update({
      where: { id: req.user.id },
      data: {
        googleAccessToken: null,
        googleRefreshToken: null,
        googleEmail: null,
      },
    });

    console.log("✅ Google account disconnected successfully");

    res.json({
      message: "Google account disconnected successfully",
      hasGoogleAuth: false,
    });
  } catch (error: unknown) {
    console.error("Google account disconnection error:", error);
    if (error instanceof AppError) throw error;
    throw new AppError("Failed to disconnect Google account", 500);
  }
};
