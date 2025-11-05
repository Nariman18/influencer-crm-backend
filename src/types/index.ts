import { Request } from "express";
import { UserRole, EmailStatus } from "@prisma/client";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

export interface PaginationParams {
  page: number;
  limit: number;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface EmailTemplateVariables {
  [key: string]: string;
}

export interface BulkOperationResult {
  success: number;
  failed: number;
  errors: Array<{
    index: number;
    error: string;
  }>;
}

export interface DashboardStats {
  totalInfluencers: number;
  activeContracts: number;
  emailsSentToday: number;
  pipelineStats: {
    ping1: number;
    ping2: number;
    ping3: number;
    contract: number;
  };
}

export interface ImportInfluencerData {
  name: string;
  email?: string;
  instagramHandle?: string;
  followers?: number;
  engagementRate?: number;
  niche?: string;
  country?: string;
  notes?: string;
}

// Exporting the Prisma EmailStatus for use in my backend
export { EmailStatus };
