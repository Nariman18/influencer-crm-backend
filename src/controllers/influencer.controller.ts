import { Response } from "express";
import prisma from "../config/prisma";
import { AuthRequest, PaginatedResponse } from "../types";
import { AppError } from "../middleware/errorHandler";
import { InfluencerStatus } from "@prisma/client";

// Helper function to check for duplicates

const checkForDuplicates = async (
  email?: string,
  instagramHandle?: string,
  excludeId?: string
) => {
  if (!email && !instagramHandle) return null;

  const orConditions = [];

  if (email) {
    orConditions.push({
      email: {
        equals: email,
        mode: "insensitive" as const,
      },
    });
  }

  if (instagramHandle) {
    orConditions.push({
      instagramHandle: {
        equals: instagramHandle,
        mode: "insensitive" as const,
      },
    });
  }

  const existing = await prisma.influencer.findFirst({
    where: {
      AND: [
        { id: { not: excludeId } }, // Exclude current influencer when updating
        ...(orConditions.length > 0 ? [{ OR: orConditions }] : []),
      ],
    },
    select: {
      id: true,
      name: true,
      email: true,
      instagramHandle: true,
      status: true,
    },
  });

  return existing;
};

const formatDuplicateResponse = (duplicate: any) => {
  return {
    id: duplicate.id,
    name: duplicate.name,
    email: duplicate.email ?? undefined, // Convert null to undefined
    instagramHandle: duplicate.instagramHandle ?? undefined, // Convert null to undefined
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
    const hasEmail = req.query.hasEmail as string | undefined;

    const skip = (page - 1) * limit;

    const where = {
      ...(status && { status }),
      ...(search && {
        OR: [
          { name: { contains: search, mode: "insensitive" as const } },
          { email: { contains: search, mode: "insensitive" as const } },
          {
            instagramHandle: { contains: search, mode: "insensitive" as const },
          },
        ],
      }),
      // Enhanced email filter - handles both null and empty strings
      ...(hasEmail === "true" && {
        AND: [
          { email: { not: null } },
          { email: { not: "" } }, // Also exclude empty strings
        ],
      }),
      ...(hasEmail === "false" && {
        OR: [
          { email: null },
          { email: "" }, // Also include empty strings
        ],
      }),
    };

    const [influencers, total] = await Promise.all([
      prisma.influencer.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        include: {
          contracts: {
            select: {
              id: true,
              status: true,
              amount: true,
            },
          },
          _count: {
            select: {
              emails: true,
            },
          },
        },
      }),
      prisma.influencer.count({ where }),
    ]);

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
    throw new AppError("Failed to fetch influencers", 500);
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
    const {
      name,
      email,
      instagramHandle,
      followers,
      engagementRate,
      niche,
      country,
      notes,
    } = req.body;

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

    const influencer = await prisma.influencer.create({
      data: {
        name,
        email,
        instagramHandle,
        followers,
        engagementRate,
        niche,
        country,
        notes,
        status: "PING_1",
      },
    });

    res.status(201).json(influencer);
  } catch (error) {
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
      engagementRate,
      niche,
      country,
      status,
      notes,
      lastContactDate,
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

    const influencer = await prisma.influencer.update({
      where: { id },
      data: {
        name,
        email,
        instagramHandle,
        followers,
        engagementRate,
        niche,
        country,
        status,
        notes,
        lastContactDate,
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
            engagementRate: data.engagementRate,
            niche: data.niche,
            country: data.country,
            notes: data.notes,
            status: "PING_1",
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
