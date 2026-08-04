import type { Employee as PrismaEmployee } from "@prisma/client";

export type EmployeeActionRecord = Omit<PrismaEmployee, "isEnded"> & {
  isEnded: boolean;
  dailyRate: number | null;
  hourlyRate: number | null;
  monthlyRate: number | null;
  currencyCode: string | null;
  department?: string | null;
  position?: string | null;
};

export type EmployeeDirectoryRecord = {
  employeeId: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  img?: string | null;
  department?: string | null;
  position?: string | null;
  email?: string | null;
  startDate: string | null;
  endDate: string | null;
  currentStatus: string | null;
  description?: string | null;
  isArchived: boolean;
};

export type EmployeeCompensationHistoryItem = {
  id: string;
  positionId: string;
  positionName: string;
  dailyRate: number | null;
  hourlyRate: number | null;
  monthlyRate: number | null;
  currencyCode: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  createdByUserId: string | null;
  createdAt: string;
};

export type EmployeePositionHistoryItem = {
  id: string;
  employeeId: string;
  departmentId: string | null;
  departmentName: string | null;
  positionId: string | null;
  positionName: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  createdByUserId: string | null;
  createdAt: string;
};
