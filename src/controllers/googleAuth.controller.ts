// backend/googleAuth.controller.ts (updated)
import { Request, Response } from "express";
import { google } from "googleapis";
import { getPrisma } from "../config/prisma";
import { AppError } from "../middleware/errorHandler";
import { AuthRequest } from "../types";

const OAuth2 = google.auth.OAuth2;
const prisma = getPrisma();

/**
 * exchangeGoogleToken (unchanged except minor logging)
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

    const redirectUri = `${process.env.FRONTEND_URL}/auth/callback`;

    console.log("📝 Exchanging code for tokens...");

    const oauth2Client = new OAuth2(
      process.env.GOOGLE_CLIENT_ID!,
      process.env.GOOGLE_CLIENT_SECRET!,
      redirectUri
    );

    let tokens;
    try {
      const tokenResponse = await oauth2Client.getToken(code);
      tokens = tokenResponse.tokens;
      console.log("Tokens received successfully");
    } catch (tokenError: any) {
      console.error("Token exchange failed:", tokenError);
      if (tokenError.message && tokenError.message.includes("invalid_grant")) {
        throw new AppError(
          "Authorization code is invalid or has expired. Please try connecting again.",
          400
        );
      }
      throw new AppError(`Token exchange failed: ${tokenError.message}`, 400);
    }

    if (!tokens.access_token || !tokens.refresh_token) {
      console.error("Incomplete tokens received:", tokens);
      throw new AppError("Incomplete tokens received from Google", 400);
    }

    console.log("Token details:", {
      hasAccessToken: !!tokens.access_token,
      hasRefreshToken: !!tokens.refresh_token,
      accessTokenLength: tokens.access_token.length,
      refreshTokenLength: tokens.refresh_token.length,
    });

    // Verify tokens and get user info**
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({
      auth: oauth2Client,
      version: "v2",
    });

    let userInfo;
    try {
      userInfo = await oauth2.userinfo.get();
      console.log("User info retrieved:", userInfo.data.email);
    } catch (userInfoError: any) {
      console.error("Failed to get user info:", userInfoError);
      throw new AppError("Failed to verify Google account information", 400);
    }

    if (!userInfo.data.email) {
      throw new AppError("Failed to get email from Google account", 400);
    }

    console.log("✅ Google OAuth successful - tokens received");

    res.json({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      email: userInfo.data.email,
      expiresIn: tokens.expiry_date,
    });
  } catch (error: unknown) {
    console.error("Google token exchange error:", error);
    if (error instanceof AppError) throw error;
    throw new AppError("Failed to exchange authorization code", 500);
  }
};

/**
 * connectGoogleAccount (updated: requires and validates `state`)
 */
export const connectGoogleAccount = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    console.log("🔗 Google account connection request received");

    console.log("🔗 /google/connect called - req.body:", {
      keys: Object.keys(req.body || {}),
      sampleBody: (() => {
        try {
          return {
            ...req.body,
            accessToken: req.body?.accessToken ? "<accessToken...>" : undefined,
            refreshToken: req.body?.refreshToken
              ? "<refreshToken...>"
              : undefined,
            state: req.body?.state,
          };
        } catch {
          return "unserializable";
        }
      })(),
      sessionId: req.headers["x-session-id"] || null,
      ip: req.ip || null,
    });

    if (!req.user) {
      throw new AppError("Not authenticated", 401);
    }

    const { accessToken, refreshToken, email, state } = req.body;

    if (!accessToken || !refreshToken || !email || !state) {
      throw new AppError("Google tokens, email and state are required", 400);
    }

    // Decode state (base64 JSON produced by frontend)
    let decodedState: any = null;
    try {
      const json = Buffer.from(state, "base64").toString("utf8");
      decodedState = JSON.parse(json);
    } catch (err) {
      console.error("Invalid OAuth state format", err);
      throw new AppError("Invalid OAuth state", 400);
    }

    if (!decodedState || !decodedState.uid) {
      throw new AppError("OAuth state missing required data", 400);
    }

    // Ensure the state UID matches the currently authenticated user
    if (String(decodedState.uid) !== String(req.user.id)) {
      console.error("OAuth state user mismatch", {
        stateUid: decodedState.uid,
        reqUser: req.user.id,
      });
      throw new AppError("OAuth state does not match authenticated user", 403);
    }

    console.log("📝 Storing Google tokens for user:", req.user.id);
    console.log("📧 Gmail address:", email);
    console.log("🔑 Token details:", {
      accessTokenLength: accessToken.length,
      refreshTokenLength: refreshToken.length,
    });

    // Defensive DB checks: ensure tokens not already associated with another user
    try {
      const existingAccessOwner = await prisma.user.findFirst({
        where: {
          googleAccessToken: accessToken,
          NOT: { id: req.user.id },
        },
        select: { id: true, email: true },
      });

      if (existingAccessOwner) {
        console.error(
          "Access token already associated with another user",
          existingAccessOwner
        );
        throw new AppError(
          "This Google access token is already used by another account",
          400
        );
      }

      const existingRefreshOwner = await prisma.user.findFirst({
        where: {
          googleRefreshToken: refreshToken,
          NOT: { id: req.user.id },
        },
        select: { id: true, email: true },
      });

      if (existingRefreshOwner) {
        console.error(
          "Refresh token already associated with another user",
          existingRefreshOwner
        );
        throw new AppError(
          "This Google refresh token is already used by another account",
          400
        );
      }
    } catch (dbCheckErr) {
      // If DB check throws AppError, rethrow; otherwise log and abort
      if (dbCheckErr instanceof AppError) throw dbCheckErr;
      console.error("Token ownership check failed:", dbCheckErr);
      throw new AppError("Failed to validate token ownership", 500);
    }

    // Validate tokens before storing**
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
      const tokenInfo = await oauth2Client.getTokenInfo(accessToken);
      console.log(
        "Token is valid, expires at:",
        tokenInfo.expiry_date || "unknown"
      );
      console.log("✅ Google OAuth tokens validated");
    } catch (validationError: any) {
      console.error("Token validation failed:", validationError);
      throw new AppError(
        "Google tokens are invalid. Please reconnect your Google account.",
        400
      );
    }

    // Persist tokens + audit info (connectedAt/Ip). If your Prisma schema doesn't have these fields, remove them.
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
  } catch (error: unknown) {
    console.error("Google account connection error:", error);
    if (error instanceof AppError) throw error;
    throw new AppError("Failed to connect Google account", 500);
  }
};

/**
 * Disconnect Google account (unchanged)
 */
export const disconnectGoogleAccount = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    if (!req.user) {
      throw new AppError("Not authenticated", 401);
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
  } catch (error: unknown) {
    console.error("Google account disconnection error:", error);
    if (error instanceof AppError) throw error;
    throw new AppError("Failed to disconnect Google account", 500);
  }
};
