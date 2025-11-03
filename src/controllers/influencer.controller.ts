import { Response } from "express";
import prisma from "../config/prisma";
import { AuthRequest, PaginatedResponse } from "../types";
import { AppError } from "../middleware/errorHandler";
import { InfluencerStatus } from "@prisma/client";

// Helper function to check for duplicates
// Helper function to check for duplicates
const checkForDuplicates = async (
  email?: string,
  instagramHandle?: string,
  excludeId?: string
) => {
  try {
    console.log("🔍 [BACKEND] checkForDuplicates called with:", {
      email,
      instagramHandle,
      excludeId,
    });

    // If no search criteria provided, return null
    if (!email && !instagramHandle) {
      console.log("🔍 [BACKEND] No search criteria provided");
      return null;
    }

    const orConditions = [];

    if (email && email.trim() !== "") {
      orConditions.push({
        email: {
          equals: email.trim(),
          mode: "insensitive" as const,
        },
      });
    }

    if (instagramHandle && instagramHandle.trim() !== "") {
      orConditions.push({
        instagramHandle: {
          equals: instagramHandle.trim(),
          mode: "insensitive" as const,
        },
      });
    }

    // If no valid conditions after trimming, return null
    if (orConditions.length === 0) {
      console.log("🔍 [BACKEND] No valid search conditions after trimming");
      return null;
    }

    console.log(
      "🔍 [BACKEND] Searching with conditions:",
      JSON.stringify(orConditions)
    );

    const whereClause: any = {
      AND: [...(orConditions.length > 0 ? [{ OR: orConditions }] : [])],
    };

    // Only add excludeId if it's provided and valid
    if (excludeId && excludeId.trim() !== "") {
      whereClause.AND.push({ id: { not: excludeId } });
    }

    console.log(
      "🔍 [BACKEND] Final WHERE clause:",
      JSON.stringify(whereClause)
    );

    const existing = await prisma.influencer.findFirst({
      where: whereClause,
      select: {
        id: true,
        name: true,
        email: true,
        instagramHandle: true,
        status: true,
      },
    });

    console.log("🔍 [BACKEND] Database query result:", existing);
    return existing;
  } catch (error) {
    console.error("❌ [BACKEND] Error in checkForDuplicates:", error);

    // If it's a database connection error or empty database, return null
    // This allows the application to continue working even if database is empty
    if (error instanceof Error) {
      if (
        error.message.includes("database") ||
        error.message.includes("connection")
      ) {
        console.log("🔍 [BACKEND] Database issue, returning null");
        return null;
      }
    }

    throw error;
  }
};

const formatDuplicateResponse = (duplicate: any) => {
  return {
    id: duplicate.id,
    name: duplicate.name,
    email: duplicate.email ?? undefined,
    instagramHandle: duplicate.instagramHandle ?? undefined,
    status: duplicate.status,
  };
};

export const getInfluencers = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const status = req.query.status as InfluencerStatus | undefined;
    const search = req.query.search as string | undefined;
    const emailFilter = req.query.emailFilter as string | undefined;

    const skip = (page - 1) * limit;

    let where: any = {};

    // Status filter
    if (status) {
      where.status = status;
    }

    // Search filter
    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
        { instagramHandle: { contains: search, mode: "insensitive" } },
        { nickname: { contains: search, mode: "insensitive" } },
      ];
    }

    // Email filter
    if (emailFilter) {
      const normalizedEmailFilter = emailFilter?.toLowerCase().trim();
      if (normalizedEmailFilter === "has-email") {
        where.email = { not: null };
      } else if (normalizedEmailFilter === "no-email") {
        where.email = null;
      }
    }

    // Get the data
    const [influencers, total] = await Promise.all([
      prisma.influencer.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          contracts: {
            select: { id: true, status: true, amount: true },
          },
          manager: {
            select: { id: true, name: true, email: true },
          },
          _count: { select: { emails: true } },
        },
      }),
      prisma.influencer.count({ where }),
    ]);

    console.log("📊 [GET INFLUENCERS] Manager relationships:");
    influencers.forEach((inf, index) => {
      console.log(`   ${index + 1}. ${inf.name}:`, {
        managerId: inf.managerId,
        manager: inf.manager,
        hasManager: !!inf.manager,
        managerName: inf.manager?.name || "NO MANAGER",
      });
    });

    const response: PaginatedResponse<(typeof influencers)[0]> = {
      data: influencers,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };

    res.json(response);
  } catch (error) {
    console.error("❌ Error fetching influencers:", error);
    throw new AppError("Failed to fetch influencers", 500);
  }
};

export const influencerTest = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    console.log("🔍 [PRODUCTION DEBUG] Testing manager relationships");

    // Get the latest 5 influencers with manager relations
    const influencers = await prisma.influencer.findMany({
      take: 5,
      orderBy: { createdAt: "desc" },
      include: {
        manager: {
          select: { id: true, name: true, email: true },
        },
      },
    });

    // Also test a specific query like your GET endpoint
    const testInfluencers = await prisma.influencer.findMany({
      where: {},
      take: 3,
      orderBy: { createdAt: "desc" },
      include: {
        contracts: {
          select: { id: true, status: true, amount: true },
        },
        manager: {
          select: { id: true, name: true, email: true },
        },
        _count: { select: { emails: true } },
      },
    });

    res.json({
      success: true,
      environment: process.env.NODE_ENV,
      timestamp: new Date().toISOString(),
      latestInfluencers: influencers.map((inf) => ({
        id: inf.id,
        name: inf.name,
        managerId: inf.managerId,
        manager: inf.manager,
        hasManager: !!inf.manager,
      })),
      testQueryResults: testInfluencers.map((inf) => ({
        id: inf.id,
        name: inf.name,
        managerId: inf.managerId,
        manager: inf.manager,
        hasManager: !!inf.manager,
      })),
    });
  } catch (error) {
    console.error("❌ [PRODUCTION DEBUG] Error:", error);
    res.status(500).json({ error: "Debug failed" });
  }
};

export const getInfluencer = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { id } = req.params;

    const influencer = await prisma.influencer.findUnique({
      where: { id },
      include: {
        contracts: {
          include: {
            campaign: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
        emails: {
          orderBy: { createdAt: "desc" },
          take: 10,
        },
        campaigns: {
          include: {
            campaign: true,
          },
        },
        manager: {
          select: { id: true, name: true, email: true },
        },
      },
    });

    if (!influencer) {
      throw new AppError("Influencer not found", 404);
    }

    res.json(influencer);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("Failed to fetch influencer", 500);
  }
};

export const createInfluencer = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    console.log("🎯 [ROUTE DEBUG] === CREATE INFLUENCER ROUTE REACHED ===");

    // CRITICAL: Check if middleware actually ran
    console.log("🎯 [ROUTE DEBUG] req.user:", req.user);
    console.log("🎯 [ROUTE DEBUG] req.user exists:", !!req.user);
    console.log("🎯 [ROUTE DEBUG] req.user ID:", req.user?.id);
    console.log("🎯 [ROUTE DEBUG] Environment:", process.env.NODE_ENV);

    if (!req.user) {
      console.error(
        "🚨 [ROUTE DEBUG] CRITICAL: req.user is NULL in route handler!"
      );
      console.error(
        "🚨 [ROUTE DEBUG] This means authentication middleware didn't run or failed silently"
      );
      console.error("🚨 [ROUTE DEBUG] Headers:", {
        authorization: req.headers.authorization ? "Present" : "Missing",
        "content-type": req.headers["content-type"],
      });

      res.status(401).json({
        error: "Authentication failed - req.user is null",
        debug: "Check if authentication middleware is executing",
      });
      return;
    }

    const {
      name,
      email,
      instagramHandle,
      followers,
      country,
      notes,
      nickname,
      link,
      contactMethod,
      paymentMethod,
      managerComment,
      statistics,
      storyViews,
      averageViews,
      engagementCount,
      priceEUR,
      priceUSD,
    } = req.body;

    console.log("🔍 [BACKEND] createInfluencer called with:", {
      name,
      email,
      instagramHandle,
      managerId: req.user?.id,
      user: req.user,
    });

    // Enhanced duplicate validation
    const duplicate = await checkForDuplicates(email, instagramHandle);

    if (duplicate) {
      let errorMessage = "Influencer already exists";

      if (
        duplicate.email?.toLowerCase() === email?.toLowerCase() &&
        duplicate.instagramHandle?.toLowerCase() ===
          instagramHandle?.toLowerCase()
      ) {
        errorMessage = `Influencer already exists with both email (${duplicate.email}) and Instagram handle (${duplicate.instagramHandle})`;
      } else if (duplicate.email?.toLowerCase() === email?.toLowerCase()) {
        errorMessage = `Influencer already exists with this email: ${duplicate.email}`;
      } else if (
        duplicate.instagramHandle?.toLowerCase() ===
        instagramHandle?.toLowerCase()
      ) {
        errorMessage = `Influencer already exists with this Instagram handle: ${duplicate.instagramHandle}`;
      }

      throw new AppError(errorMessage, 400, {
        duplicate: formatDuplicateResponse(duplicate),
      });
    }

    // Validate that user is authenticated and has an ID
    if (!req.user?.id) {
      console.error("❌ [BACKEND] No user ID found in request");
      throw new AppError("User not authenticated", 401);
    }

    console.log("👤 [BACKEND] Setting managerId:", req.user.id);

    // FIX: Create a complete data object with ALL fields
    const influencerData = {
      name,
      email: email || null, // Explicitly set to null if empty
      instagramHandle: instagramHandle || null,
      followers: followers ? parseInt(followers) : null,
      country: country || null,
      notes: notes || null,
      nickname: nickname || null,
      link: link || null,
      contactMethod: contactMethod || null,
      paymentMethod: paymentMethod || null,
      managerComment: managerComment || null,
      statistics: statistics || null,
      storyViews: storyViews || null,
      averageViews: averageViews || null,
      engagementCount: engagementCount || null,
      priceEUR: priceEUR ? parseFloat(priceEUR) : null,
      priceUSD: priceUSD ? parseFloat(priceUSD) : null,
      status: "PING_1" as InfluencerStatus,
      // CRITICAL FIX: Explicitly set managerId
      managerId: req.user.id,
    };

    console.log(
      "📝 [PRODUCTION CREATE] Final data being sent to Prisma:",
      influencerData
    );

    const influencer = await prisma.influencer.create({
      data: influencerData,
      // Include manager relation in response
      include: {
        manager: {
          select: { id: true, name: true, email: true },
        },
      },
    });

    console.log("✅ [PRODUCTION CREATE] SUCCESS - Influencer created!");
    console.log("✅ [PRODUCTION CREATE] Final result:", {
      id: influencer.id,
      name: influencer.name,
      managerId: influencer.managerId,
      manager: influencer.manager,
      hasManager: !!influencer.manager,
      managerName: influencer.manager?.name || "NO MANAGER",
    });

    res.status(201).json(influencer);
  } catch (error) {
    console.error("❌ [BACKEND] Error creating influencer:", error);
    if (error instanceof AppError) throw error;
    throw new AppError("Failed to create influencer", 500);
  }
};

export const updateInfluencer = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { id } = req.params;
    const {
      name,
      email,
      instagramHandle,
      followers,
      country,
      status,
      notes,
      lastContactDate,
      nickname,
      link,
      contactMethod,
      paymentMethod,
      managerComment,
      statistics,
      storyViews,
      averageViews,
      engagementCount,
      priceEUR,
      priceUSD,
    } = req.body;

    // Check for duplicates when updating (exclude current influencer)
    const duplicate = await checkForDuplicates(email, instagramHandle, id);

    if (duplicate) {
      let errorMessage = "Another influencer already exists";

      if (
        duplicate.email?.toLowerCase() === email?.toLowerCase() &&
        duplicate.instagramHandle?.toLowerCase() ===
          instagramHandle?.toLowerCase()
      ) {
        errorMessage = `Another influencer already exists with both email (${duplicate.email}) and Instagram handle (${duplicate.instagramHandle})`;
      } else if (duplicate.email?.toLowerCase() === email?.toLowerCase()) {
        errorMessage = `Another influencer already exists with this email: ${duplicate.email}`;
      } else if (
        duplicate.instagramHandle?.toLowerCase() ===
        instagramHandle?.toLowerCase()
      ) {
        errorMessage = `Another influencer already exists with this Instagram handle: ${duplicate.instagramHandle}`;
      }

      throw new AppError(errorMessage, 400, {
        duplicate: formatDuplicateResponse(duplicate),
      });
    }

    // FIX: Create complete data object
    const updateData = {
      name,
      email: email || null,
      instagramHandle: instagramHandle || null,
      followers: followers ? parseInt(followers) : null,
      country: country || null,
      status,
      notes: notes || null,
      lastContactDate,
      nickname: nickname || null,
      link: link || null,
      contactMethod: contactMethod || null,
      paymentMethod: paymentMethod || null,
      managerComment: managerComment || null,
      statistics: statistics || null,
      storyViews: storyViews || null,
      averageViews: averageViews || null,
      engagementCount: engagementCount || null,
      priceEUR: priceEUR ? parseFloat(priceEUR) : null,
      priceUSD: priceUSD ? parseFloat(priceUSD) : null,
    };

    const influencer = await prisma.influencer.update({
      where: { id },
      data: updateData,
      include: {
        manager: {
          select: { id: true, name: true, email: true },
        },
      },
    });

    res.json(influencer);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("Failed to update influencer", 500);
  }
};

export const deleteInfluencer = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { id } = req.params;

    await prisma.influencer.delete({
      where: { id },
    });

    res.json({ message: "Influencer deleted successfully" });
  } catch (error) {
    throw new AppError("Failed to delete influencer", 500);
  }
};

export const bulkUpdateStatus = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { ids, status } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      throw new AppError("Invalid influencer IDs", 400);
    }

    const result = await prisma.influencer.updateMany({
      where: {
        id: { in: ids },
      },
      data: {
        status,
        lastContactDate: new Date(),
      },
    });

    res.json({
      message: `Updated ${result.count} influencers`,
      count: result.count,
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("Failed to bulk update influencers", 500);
  }
};

export const importInfluencers = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { influencers } = req.body;

    if (!Array.isArray(influencers) || influencers.length === 0) {
      throw new AppError("Invalid influencer data", 400);
    }

    const results = {
      success: 0,
      failed: 0,
      errors: [] as Array<{
        index: number;
        error: string;
        duplicate?: {
          id: string;
          name: string;
          email?: string;
          instagramHandle?: string;
          status: string;
        };
      }>,
      duplicates: [] as Array<{
        index: number;
        data: any;
        duplicate: {
          id: string;
          name: string;
          email?: string;
          instagramHandle?: string;
          status: string;
        };
      }>,
    };

    // First, check all influencers for duplicates
    const duplicateChecks = await Promise.all(
      influencers.map(async (data, index) => {
        const duplicate = await checkForDuplicates(
          data.email,
          data.instagramHandle
        );
        return { index, data, duplicate };
      })
    );

    // Process influencers sequentially
    for (const { index, data, duplicate } of duplicateChecks) {
      try {
        if (duplicate) {
          results.failed++;
          const formattedDuplicate = formatDuplicateResponse(duplicate);
          results.duplicates.push({
            index,
            data,
            duplicate: formattedDuplicate,
          });

          let errorMessage = "Duplicate influencer";
          if (
            duplicate.email?.toLowerCase() === data.email?.toLowerCase() &&
            duplicate.instagramHandle?.toLowerCase() ===
              data.instagramHandle?.toLowerCase()
          ) {
            errorMessage = `Duplicate: email (${duplicate.email}) and Instagram (${duplicate.instagramHandle})`;
          } else if (
            duplicate.email?.toLowerCase() === data.email?.toLowerCase()
          ) {
            errorMessage = `Duplicate email: ${duplicate.email}`;
          } else if (
            duplicate.instagramHandle?.toLowerCase() ===
            data.instagramHandle?.toLowerCase()
          ) {
            errorMessage = `Duplicate Instagram: ${duplicate.instagramHandle}`;
          }

          results.errors.push({
            index,
            error: errorMessage,
            duplicate: formattedDuplicate,
          });
          continue;
        }

        await prisma.influencer.create({
          data: {
            name: data.name,
            email: data.email,
            instagramHandle: data.instagramHandle,
            followers: data.followers,
            country: data.country,
            notes: data.notes,
            nickname: data.nickname,
            link: data.link,
            contactMethod: data.contactMethod,
            paymentMethod: data.paymentMethod,
            managerComment: data.managerComment,
            statistics: data.statistics,
            storyViews: data.storyViews,
            averageViews: data.averageViews,
            engagementCount: data.engagementCount,
            priceEUR: data.priceEUR,
            priceUSD: data.priceUSD,
            status: "PING_1",
            // Set the current user as manager for imported influencers
            managerId: req.user?.id,
          },
        });

        results.success++;
      } catch (error) {
        results.failed++;
        results.errors.push({
          index,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    res.json(results);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("Failed to import influencers", 500);
  }
};

// Check duplicates endpoint
export const checkDuplicates = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const { email, instagramHandle, excludeId } = req.body;

    const duplicate = await checkForDuplicates(
      email,
      instagramHandle,
      excludeId
    );

    if (duplicate) {
      res.json({
        isDuplicate: true,
        duplicate: formatDuplicateResponse(duplicate),
      });
    } else {
      res.json({
        isDuplicate: false,
        duplicate: null,
      });
    }
  } catch (error) {
    throw new AppError("Failed to check duplicates", 500);
  }
};

// Add this to your influencer controller or auth controller
export const testProductionAuth = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    console.log("🔍 [PRODUCTION TEST] Testing production authentication:", {
      hasUser: !!req.user,
      user: req.user,
      environment: process.env.NODE_ENV,
      timestamp: new Date().toISOString(),
    });

    if (!req.user) {
      res.status(401).json({
        success: false,
        error: "Not authenticated in production",
        environment: process.env.NODE_ENV,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Test database connection and user lookup
    const dbUser = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, name: true, email: true, role: true },
    });

    res.json({
      success: true,
      message: "Production authentication working correctly",
      authUser: req.user,
      dbUser: dbUser,
      environment: process.env.NODE_ENV,
      timestamp: new Date().toISOString(),
      userMatch: dbUser?.id === req.user.id,
    });
  } catch (error) {
    console.error("❌ [PRODUCTION TEST] Error:", error);
    res.status(500).json({
      success: false,
      error: "Production test failed",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
