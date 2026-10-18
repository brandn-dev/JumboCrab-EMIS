import type {
  DraftAssignmentKind,
  DraftAssignmentSource,
  DraftScope,
  DraftSourceMode,
} from "@/lib/schedule-draft-policy";
import type { SchedulePolicyIssueReport } from "@/types/schedule-policy-types";

export type ScheduleDraftStatus = "DRAFT" | "VALIDATED" | "APPROVED" | "PUBLISHED" | "DISCARDED";

export type ScheduleDraftSummary = {
  id: string;
  lineageId: string;
  version: number;
  weekStart: string;
  scope: DraftScope;
  sourceMode: DraftSourceMode;
  sourceWeekStart: string | null;
  status: ScheduleDraftStatus;
  sourceFingerprint: string;
  draftFingerprint: string;
  assignmentCount: number;
  createdAt: string;
  updatedAt: string;
};

export type ScheduleDraftAssignment = {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  workDate: string;
  shiftId: number | null;
  baselineShiftId: number | null;
  baselineOverrideShiftId: number | null;
  hasBaselineOverride: boolean;
  assignmentKind: DraftAssignmentKind;
  isProtected: boolean;
  source: DraftAssignmentSource;
  reason: string | null;
};

export type ScheduleDraftDetails = ScheduleDraftSummary & {
  createdByUsername: string;
  isLatestVersion: boolean;
  isSourceStale: boolean;
  validationReport: (SchedulePolicyIssueReport & { validatedAt: string }) | null;
  warningsAcknowledgedAt: string | null;
  approvedAt: string | null;
  publishedAt: string | null;
  notificationStatus: "PENDING" | "PROCESSING" | "DELIVERED" | "FAILED" | "SKIPPED" | null;
  notificationError: string | null;
  assignments: ScheduleDraftAssignment[];
  versions: ScheduleDraftSummary[];
};

export type ScheduleDraftGroup = {
  latest: ScheduleDraftSummary;
  versions: ScheduleDraftSummary[];
};
