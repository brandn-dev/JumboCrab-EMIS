import type { ScheduleValidationIssue } from "@/lib/schedule-validation";

export type ScheduleCoverageRuleRecord = {
  id: string;
  name: string;
  departmentId: string | null;
  departmentName: string | null;
  positionId: string | null;
  positionName: string | null;
  shiftId: number | null;
  shiftLabel: string | null;
  weekday: number;
  minimumStaff: number;
  maximumStaff: number | null;
  priority: "HARD" | "SOFT";
  isActive: boolean;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ScheduleCoveragePositionOption = {
  positionId: string;
  name: string;
  departmentId: string;
  departmentName: string;
};

export type SchedulePolicyIssueReport = {
  issues: ScheduleValidationIssue[];
  isValid: boolean;
  blockerCount: number;
  warningCount: number;
  infoCount: number;
  coverageConfigured: boolean;
  validatedAt?: string;
};
