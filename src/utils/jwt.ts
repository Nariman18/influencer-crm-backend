import jwt from "jsonwebtoken";
import { AuthUser } from "../types";

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

console.log("🔑 [JWT PRODUCTION] JWT Configuration:", {
  hasCustomSecret: !!process.env.JWT_SECRET,
  secretLength: JWT_SECRET.length,
  environment: process.env.NODE_ENV || "development",
});

export const generateToken = (user: AuthUser): string => {
  console.log("🔑 [JWT PRODUCTION] Generating token for user:", {
    id: user.id,
    name: user.name,
    environment: process.env.NODE_ENV,
  });

  const token = jwt.sign(
    {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"] }
  );

  console.log("🔑 [JWT PRODUCTION] Token generated:", {
    tokenLength: token.length,
    environment: process.env.NODE_ENV,
  });

  return token;
};

export const verifyToken = (token: string): AuthUser => {
  try {
    console.log("🔑 [JWT PRODUCTION] Verifying token:", {
      tokenLength: token.length,
      environment: process.env.NODE_ENV,
    });

    const decoded = jwt.verify(token, JWT_SECRET) as AuthUser;

    console.log("✅ [JWT PRODUCTION] Token verified successfully:", {
      id: decoded.id,
      name: decoded.name,
      environment: process.env.NODE_ENV,
    });

    return decoded;
  } catch (error) {
    console.error("❌ [JWT PRODUCTION] Token verification failed:", {
      error: error instanceof Error ? error.message : "Unknown error",
      environment: process.env.NODE_ENV,
    });
    throw new Error("Invalid or expired token");
  }
};
