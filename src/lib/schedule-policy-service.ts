import "server-only";

import { createHash } from "node:crypto";
import {
  AiScheduleAssignmentKind,
  AiScheduleDraftSource,
  AiScheduleDraftStatus,
  CURRENT_STATUS,
  LeaveRequestStatus,
  NotificationEventType,
  NotificationModule,
  NotificationSeverity,
  Prisma,
  ScheduleCoverageRulePriority,
  SchedulePublicationNotificationStatus,
  type PrismaClient,
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { createAndDispatchNotification } from "@/lib/notifications";
import { getScheduleSourceFingerprint } from "@/lib/schedule-source-fingerprint";
import { generateScheduleFromReference } from "@/lib/schedule-generator";
import { areDraftAssignmentsComplete } from "@/lib/schedule-draft-policy";
import {
  validateSchedule,
  type ScheduleCoverageRuleInput,
  type SchedulePolicyAssignment,
  type SchedulePolicyContext,
} from "@/lib/schedule-validation";
import {
  getScheduleDraftVersion,
  ScheduleDraftServiceError,
  saveScheduleDraftVersion,
} from "@/lib/schedule-draft-service";
import { persistWeekPlannerAssignmentsInTransaction } from "@/lib/week-planner-persistence";
import {
  getWeekDates,
  toPlannerDateKey,
  type WeekPlannerDayKey,
} from "@/lib/week-planner";
import { startOfZonedDay } from "@/lib/timezone";

export class SchedulePolicyServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchedulePolicyServiceError";
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
type SchedulePolicyClient = PrismaClient | Prisma.TransactionClient;

const parseDateOnly = (value: unknown, label: string) => {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new SchedulePolicyServiceError(`${label} must use YYYY-MM-DD.`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day, 12));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new SchedulePolicyServiceError(`${label} is not a valid date.`);
  }
  return startOfZonedDay(parsed);
};

const serializeRule = (rule: {
  id: string;
  name: string;
  departmentId: string | null;
  positionId: string | null;
  shiftId: number | null;
  weekday: number;
  minimumStaff: number;
  maximumStaff: number | null;
  priority: ScheduleCoverageRulePriority;
  isActive: boolean;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  createdAt: Date;
  updatedAt: Date;
  department: { name: string } | null;
  position: { name: string } | null;
  shift: { code: string; name: string } | null;
}) => ({
  id: rule.id,
  name: rule.name,
  departmentId: rule.departmentId,
  departmentName: rule.department?.name ?? null,
  positionId: rule.positionId,
  positionName: rule.position?.name ?? null,
  shiftId: rule.shiftId,
  shiftLabel: rule.shift ? `${rule.shift.code} · ${rule.shift.name}` : null,
  weekday: rule.weekday,
  minimumStaff: rule.minimumStaff,
  maximumStaff: rule.maximumStaff,
  priority: rule.priority,
  isActive: rule.isActive,
  effectiveFrom: rule.effectiveFrom ? toPlannerDateKey(rule.effectiveFrom) : null,
  effectiveTo: rule.effectiveTo ? toPlannerDateKey(rule.effectiveTo) : null,
  createdAt: rule.createdAt.toISOString(),
  updatedAt: rule.updatedAt.toISOString(),
});

const coverageRuleRelations = {
  department: { select: { name: true } },
  position: { select: { name: true } },
  shift: { select: { code: true, name: true } },
} as const;

export async function listScheduleCoverageRules() {
  const [rules, positions] = await Promise.all([
    db.scheduleCoverageRule.findMany({
      orderBy: [{ isActive: "desc" }, { weekday: "asc" }, { name: "asc" }, { id: "asc" }],
      include: coverageRuleRelations,
    }),
    db.position.findMany({
      where: { isActive: true, department: { isActive: true } },
      orderBy: [{ department: { name: "asc" } }, { name: "asc" }],
      select: { positionId: true, name: true, departmentId: true, department: { select: { name: true } } },
    }),
  ]);
  return {
    rules: rules.map(serializeRule),
    positions: positions.map((position) => ({
      positionId: position.positionId,
      name: position.name,
      departmentId: position.departmentId,
      departmentName: position.department.name,
    })),
  };
}

export async function saveScheduleCoverageRule(input: {
  id?: string;
  name: string;
  departmentId?: string | null;
  positionId?: string | null;
  shiftId?: number | null;
  weekday: number;
  minimumStaff: number;
  maximumStaff?: number | null;
  priority: "HARD" | "SOFT";
  isActive: boolean;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  actorUserId: string;
}) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 120) throw new SchedulePolicyServiceError("Enter a rule name up to 120 characters.");
  if (!Number.isInteger(input.weekday) || input.weekday < 1 || input.weekday > 7) {
    throw new SchedulePolicyServiceError("Choose a weekday from Monday to Sunday.");
  }
  if (!Number.isSafeInteger(input.minimumStaff) || input.minimumStaff < 0) {
    throw new SchedulePolicyServiceError("Minimum staff must be a whole number of zero or more.");
  }
  const maximumStaff = input.maximumStaff ?? null;
  if (maximumStaff != null && (!Number.isSafeInteger(maximumStaff) || maximumStaff < input.minimumStaff)) {
    throw new SchedulePolicyServiceError("Maximum staff must be a whole number at least as high as the minimum.");
  }
  if (input.priority !== "HARD" && input.priority !== "SOFT") {
    throw new SchedulePolicyServiceError("Choose a hard or soft rule.");
  }
  const departmentId = input.departmentId?.trim() || null;
  const positionId = input.positionId?.trim() || null;
  const shiftId = input.shiftId == null ? null : input.shiftId;
  if (shiftId != null && (!Number.isSafeInteger(shiftId) || shiftId <= 0)) {
    throw new SchedulePolicyServiceError("Choose a valid shift.");
  }
  const effectiveFrom = parseDateOnly(input.effectiveFrom, "Effective from");
  const effectiveTo = parseDateOnly(input.effectiveTo, "Effective to");
  if (effectiveFrom && effectiveTo && effectiveFrom > effectiveTo) {
    throw new SchedulePolicyServiceError("Effective from must be on or before effective to.");
  }

  const [department, position, shift] = await Promise.all([
    departmentId ? db.department.findUnique({ where: { departmentId }, select: { departmentId: true, isActive: true } }) : null,
    positionId ? db.position.findUnique({ where: { positionId }, select: { positionId: true, departmentId: true, isActive: true } }) : null,
    shiftId != null ? db.shift.findUnique({ where: { id: shiftId }, select: { id: true, isActive: true, isDayOff: true } }) : null,
  ]);
  if (departmentId && !department) throw new SchedulePolicyServiceError("Selected department was not found.");
  if (positionId && !position) throw new SchedulePolicyServiceError("Selected position was not found.");
  if (position && !position.isActive) throw new SchedulePolicyServiceError("Selected position is inactive.");
  if (department && !department.isActive) throw new SchedulePolicyServiceError("Selected department is inactive.");
  if (departmentId && position && position.departmentId !== departmentId) {
    throw new SchedulePolicyServiceError("Selected position does not belong to the selected department.");
  }
  if (shiftId != null && !shift) throw new SchedulePolicyServiceError("Selected shift was not found.");
  if (shift && (!shift.isActive || shift.isDayOff)) {
    throw new SchedulePolicyServiceError("Coverage rules require an active working shift.");
  }

  const data = {
    name,
    departmentId,
    positionId,
    shiftId,
    weekday: input.weekday,
    minimumStaff: input.minimumStaff,
    maximumStaff,
    priority: input.priority as ScheduleCoverageRulePriority,
    isActive: input.isActive,
    effectiveFrom,
    effectiveTo,
  };
  const saved = input.id
    ? await db.scheduleCoverageRule.update({
        where: { id: input.id },
        data,
        include: coverageRuleRelations,
      })
    : await db.scheduleCoverageRule.create({
        data: { ...data, createdByUserId: input.actorUserId },
        include: coverageRuleRelations,
      });
  return serializeRule(saved);
}

const toPolicyRule = (rule: {
  id: string;
  name: string;
  departmentId: string | null;
  positionId: string | null;
  shiftId: number | null;
  weekday: number;
  minimumStaff: number;
  maximumStaff: number | null;
  priority: ScheduleCoverageRulePriority;
  isActive: boolean;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
}): ScheduleCoverageRuleInput => ({
  ...rule,
  priority: rule.priority,
  effectiveFrom: rule.effectiveFrom ? toPlannerDateKey(rule.effectiveFrom) : null,
  effectiveTo: rule.effectiveTo ? toPlannerDateKey(rule.effectiveTo) : null,
});

const toPolicyAssignment = (assignment: {
  employeeId: string;
  workDate: Date;
  shiftId: number | null;
  assignmentKind: AiScheduleAssignmentKind;
  isProtected: boolean;
  hasBaselineOverride: boolean;
  baselineOverrideShiftId: number | null;
}): SchedulePolicyAssignment => ({
  employeeId: assignment.employeeId,
  workDate: toPlannerDateKey(assignment.workDate),
  shiftId: assignment.shiftId,
  assignmentKind: assignment.assignmentKind,
  isProtected: assignment.isProtected,
  hasBaselineOverride: assignment.hasBaselineOverride,
  baselineOverrideShiftId: assignment.baselineOverrideShiftId,
});

const getWeekBounds = (weekStart: Date) => {
  const dates = getWeekDates(weekStart).map(({ date }) => date);
  return { weekStart: dates[0], weekEnd: new Date(dates[6].getTime() + DAY_MS) };
};

const loadBoundaryAssignments = async (
  employeeIds: string[],
  weekStart: Date,
  client: SchedulePolicyClient = db,
) => {
  if (employeeIds.length === 0) return [] as SchedulePolicyAssignment[];
  const priorWeekStart = new Date(weekStart.getTime() - 7 * DAY_MS);
  const nextWeekStart = new Date(weekStart.getTime() + 7 * DAY_MS);
  const previousSunday = new Date(weekStart.getTime() - DAY_MS);
  const nextMonday = nextWeekStart;
  const [previousSchedules, nextSchedules, overrides, leaveRequests] = await Promise.all([
    client.weeklySchedule.findMany({
      where: { employeeId: { in: employeeIds }, weekStart: priorWeekStart },
      select: { employeeId: true, sunShiftId: true },
    }),
    client.weeklySchedule.findMany({
      where: { employeeId: { in: employeeIds }, weekStart: nextWeekStart },
      select: { employeeId: true, monShiftId: true },
    }),
    client.employeeShiftOverride.findMany({
      where: { employeeId: { in: employeeIds }, workDate: { in: [previousSunday, nextMonday] } },
      select: { employeeId: true, workDate: true, shiftId: true },
    }),
    client.leaveRequest.findMany({
      where: {
        employeeId: { in: employeeIds },
        status: LeaveRequestStatus.APPROVED,
        startDate: { lt: new Date(nextMonday.getTime() + DAY_MS) },
        endDate: { gte: previousSunday },
      },
      select: { employeeId: true, startDate: true, endDate: true },
    }),
  ]);
  const scheduleByKey = new Map<string, number | null>();
  for (const row of previousSchedules) scheduleByKey.set(`${row.employeeId}:${toPlannerDateKey(previousSunday)}`, row.sunShiftId);
  for (const row of nextSchedules) scheduleByKey.set(`${row.employeeId}:${toPlannerDateKey(nextMonday)}`, row.monShiftId);
  const overrideByKey = new Map(overrides.map((row) => [
    `${row.employeeId}:${toPlannerDateKey(row.workDate)}`,
    row.shiftId,
  ]));
  const leaveKeys = new Set(leaveRequests.flatMap((request) => [previousSunday, nextMonday]
    .filter((date) => date >= startOfZonedDay(request.startDate) && date <= startOfZonedDay(request.endDate))
    .map((date) => `${request.employeeId}:${toPlannerDateKey(date)}`)));
  const shiftIds = Array.from(new Set([...scheduleByKey.values(), ...overrideByKey.values()]
    .filter((id): id is number => id != null)));
  const shiftRows = shiftIds.length
    ? await client.shift.findMany({ where: { id: { in: shiftIds } }, select: { id: true, isDayOff: true } })
    : [];
  const dayOffIds = new Set(shiftRows.filter((shift) => shift.isDayOff).map((shift) => shift.id));
  return employeeIds.flatMap((employeeId) => [previousSunday, nextMonday].map((date) => {
    const workDate = toPlannerDateKey(date);
    const key = `${employeeId}:${workDate}`;
    const hasOverride = overrideByKey.has(key);
    const shiftId = hasOverride ? overrideByKey.get(key) ?? null : scheduleByKey.get(key) ?? null;
    const isProtected = leaveKeys.has(key);
    return {
      employeeId,
      workDate,
      shiftId,
      assignmentKind: isProtected
        ? "PROTECTED_LEAVE" as const
        : shiftId == null
          ? "UNASSIGNED" as const
          : dayOffIds.has(shiftId)
            ? "DAY_OFF" as const
            : "WORK" as const,
      isProtected,
      hasBaselineOverride: hasOverride,
      baselineOverrideShiftId: hasOverride ? overrideByKey.get(key) ?? null : null,
    };
  }));
};

const loadDraftPolicyContext = async (
  input: { draftId: string; ownerUserId: string },
  client: SchedulePolicyClient = db,
) => {
  const draft = await client.aiScheduleDraft.findFirst({
    where: { id: input.draftId, createdByUserId: input.ownerUserId },
    include: { assignments: { orderBy: [{ employeeId: "asc" }, { workDate: "asc" }] } },
  });
  if (!draft) throw new SchedulePolicyServiceError("Draft not found.");
  const employeeIds = Array.from(new Set(draft.assignments.map((assignment) => assignment.employeeId))).sort();
  const { weekEnd } = getWeekBounds(draft.weekStart);
  const scope = draft.scope && typeof draft.scope === "object" && !Array.isArray(draft.scope)
    ? draft.scope as Prisma.JsonObject
    : {};
  const selectionMode = scope.selectionMode === "ALL" || scope.selectionMode === "DEPARTMENT" || scope.selectionMode === "SELECTED"
    ? scope.selectionMode
    : "SELECTED";
  const scopedDepartmentId = typeof scope.departmentId === "string" ? scope.departmentId : null;
  const [employees, shifts, rules, leaveRequests, boundaryAssignments, currentFingerprint] = await Promise.all([
    employeeIds.length
      ? client.employee.findMany({
          where: { employeeId: { in: employeeIds } },
          select: { employeeId: true, departmentId: true, positionId: true, isArchived: true, currentStatus: true },
        })
      : Promise.resolve([]),
    client.shift.findMany({
      orderBy: [{ isActive: "desc" }, { startMinutes: "asc" }, { id: "asc" }],
      select: { id: true, isActive: true, isDayOff: true, startMinutes: true, endMinutes: true, spansMidnight: true, paidHoursPerDay: true },
    }),
    client.scheduleCoverageRule.findMany({
      where: { isActive: true },
      orderBy: [{ weekday: "asc" }, { id: "asc" }],
      include: { position: { select: { departmentId: true } } },
    }),
    employeeIds.length
      ? client.leaveRequest.findMany({
          where: {
            employeeId: { in: employeeIds },
            status: LeaveRequestStatus.APPROVED,
            startDate: { lt: weekEnd },
            endDate: { gte: draft.weekStart },
          },
          select: { employeeId: true, startDate: true, endDate: true },
        })
      : Promise.resolve([]),
    loadBoundaryAssignments(employeeIds, draft.weekStart, client),
    getScheduleSourceFingerprint({
      employeeIds,
      weekStart: draft.weekStart,
      referenceWeekStart: draft.sourceWeekStart,
      scope: { selectionMode, departmentId: scopedDepartmentId },
    }, client),
  ]);

  const leaveDays = leaveRequests.flatMap((request) => getWeekDates(draft.weekStart)
    .map(({ date }) => date)
    .filter((date) => date >= startOfZonedDay(request.startDate) && date <= startOfZonedDay(request.endDate))
    .map((date) => `${request.employeeId}:${toPlannerDateKey(date)}`));
  const rulesForScope = rules.filter((rule) => {
    if (selectionMode === "ALL") return true;
    if (selectionMode === "DEPARTMENT") {
      return rule.departmentId === scopedDepartmentId ||
        (rule.departmentId == null && rule.position?.departmentId === scopedDepartmentId) ||
        (rule.departmentId == null && rule.positionId == null);
    }
    if (!rule.departmentId && !rule.positionId) return true;
    return employees.some((employee) =>
      (!rule.departmentId || employee.departmentId === rule.departmentId) &&
      (!rule.positionId || employee.positionId === rule.positionId),
    );
  });
  const hasBroadCoverageRule = rulesForScope.some((rule) => !rule.departmentId && !rule.positionId);
  const coverageScopeComplete = selectionMode === "ALL" ||
    (selectionMode === "DEPARTMENT" && !hasBroadCoverageRule) ||
    (selectionMode === "SELECTED" && rulesForScope.length === 0);
  const context: SchedulePolicyContext = {
    weekStart: draft.weekStart,
    employees: employees.map((employee) => ({
      employeeId: employee.employeeId,
      departmentId: employee.departmentId,
      positionId: employee.positionId,
      isActive: !employee.isArchived &&
        employee.currentStatus !== CURRENT_STATUS.INACTIVE &&
        employee.currentStatus !== CURRENT_STATUS.ENDED,
    })),
    shifts: shifts.map((shift) => ({
      ...shift,
      paidHoursPerDay: Number(shift.paidHoursPerDay),
    })),
    rules: rulesForScope.map(toPolicyRule),
    assignments: draft.assignments.map(toPolicyAssignment),
    approvedLeaveKeys: leaveDays,
    isSourceStale: currentFingerprint !== draft.sourceFingerprint,
    scopeIsComplete: coverageScopeComplete,
    boundaryAssignments,
    minimumRestMinutes: null,
    maximumWeeklyPaidHours: null,
  };
  return { draft, context, currentSourceFingerprint: currentFingerprint };
};

const issueCounts = (issues: ReturnType<typeof validateSchedule>) => issues.reduce<Record<string, number>>((counts, issue) => {
  counts[issue.severity] = (counts[issue.severity] ?? 0) + 1;
  return counts;
}, {});

const createValidationFingerprint = (input: {
  draftFingerprint: string;
  sourceFingerprint: string;
  issues: ReturnType<typeof validateSchedule>;
}) => {
  const issues = input.issues
    .map((issue) => ({
      code: issue.code,
      severity: issue.severity,
      employeeId: issue.employeeId ?? null,
      workDate: issue.workDate ?? null,
      shiftId: issue.shiftId ?? null,
      ruleId: issue.ruleId ?? null,
      message: issue.message,
      suggestedFix: issue.suggestedFix ?? null,
    }))
    .sort((left, right) =>
      left.code.localeCompare(right.code) ||
      (left.employeeId ?? "").localeCompare(right.employeeId ?? "") ||
      (left.workDate ?? "").localeCompare(right.workDate ?? "") ||
      (left.shiftId ?? 0) - (right.shiftId ?? 0) ||
      (left.ruleId ?? "").localeCompare(right.ruleId ?? ""),
    );
  return createHash("sha256")
    .update(JSON.stringify({ version: 1, draftFingerprint: input.draftFingerprint, sourceFingerprint: input.sourceFingerprint, issues }))
    .digest("hex");
};

const makeValidationReport = (issues: ReturnType<typeof validateSchedule>, validatedAt: Date) => {
  const counts = issueCounts(issues);
  const blockerCount = counts.BLOCKER ?? 0;
  return {
    issues,
    isValid: blockerCount === 0,
    blockerCount,
    warningCount: counts.WARNING ?? 0,
    infoCount: counts.INFO ?? 0,
    coverageConfigured: !issues.some((issue) => issue.code === "COVERAGE_RULES_NOT_CONFIGURED"),
    validatedAt: validatedAt.toISOString(),
  };
};

export async function validateScheduleDraft(input: {
  draftId: string;
  ownerUserId: string;
  actorUserId: string;
}) {
  const report = await db.$transaction(async (tx) => {
    const { draft, context, currentSourceFingerprint } = await loadDraftPolicyContext(input, tx);
    const latest = await tx.aiScheduleDraft.findFirst({
      where: { lineageId: draft.lineageId, createdByUserId: input.ownerUserId },
      orderBy: { version: "desc" },
      select: { id: true },
    });
    if (latest?.id !== draft.id) throw new SchedulePolicyServiceError("Only the latest draft version can be validated.");
    if (draft.status !== "DRAFT" && draft.status !== "VALIDATED") {
      throw new SchedulePolicyServiceError("Only an editable draft version can be validated.");
    }

    const issues = validateSchedule(context);
    const validationReport = makeValidationReport(issues, new Date());
    const validatedFingerprint = validationReport.isValid
      ? createValidationFingerprint({
          draftFingerprint: draft.draftFingerprint,
          sourceFingerprint: currentSourceFingerprint,
          issues,
        })
      : null;
    const saved = await tx.aiScheduleDraft.updateMany({
      where: {
        id: draft.id,
        createdByUserId: input.ownerUserId,
        status: { in: ["DRAFT", "VALIDATED"] },
        draftFingerprint: draft.draftFingerprint,
      },
      data: {
        status: validationReport.isValid ? "VALIDATED" : "DRAFT",
        validatedFingerprint,
        validatedSourceFingerprint: currentSourceFingerprint,
        validationReport: validationReport as Prisma.InputJsonObject,
        warningsAcknowledgedAt: null,
        warningsAcknowledgedByUserId: null,
      },
    });
    if (saved.count !== 1) throw new SchedulePolicyServiceError("Draft changed during validation. Reload and try again.");

    await tx.aiActionAudit.create({
      data: {
        actorUserId: input.actorUserId,
        action: "DRAFT_VALIDATED",
        draftId: input.draftId,
        outcome: validationReport.isValid ? "SUCCEEDED" : "BLOCKED",
        metadata: {
          sourceStale: context.isSourceStale,
          activeRuleCount: context.rules.length,
          issueCounts: issueCounts(issues),
          validatedFingerprint,
        } as Prisma.InputJsonObject,
      },
    });
    return validationReport;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  const draft = await getScheduleDraftVersion({ draftId: input.draftId, ownerUserId: input.ownerUserId });
  return {
    ...report,
    draft,
  };
}

export async function validateScheduleDraftCandidates(input: {
  draftId: string;
  ownerUserId: string;
  candidates: SchedulePolicyAssignment[][];
}) {
  const { draft, context } = await loadDraftPolicyContext(input);
  const latest = await db.aiScheduleDraft.findFirst({
    where: { lineageId: draft.lineageId, createdByUserId: input.ownerUserId },
    orderBy: { version: "desc" },
    select: { id: true },
  });
  if (latest?.id !== draft.id) throw new SchedulePolicyServiceError("Only the latest draft version can be previewed.");
  if (draft.status !== "DRAFT" && draft.status !== "VALIDATED") {
    throw new SchedulePolicyServiceError("Only an editable draft version can be previewed.");
  }
  const baselineIssues = validateSchedule(context);
  const issueKey = (issue: ReturnType<typeof validateSchedule>[number]) => JSON.stringify([
    issue.code,
    issue.severity,
    issue.employeeId ?? null,
    issue.workDate ?? null,
    issue.shiftId ?? null,
    issue.ruleId ?? null,
  ]);
  const baselineKeys = new Set(baselineIssues.map(issueKey));
  return input.candidates.map((assignments) => {
    const proposedIssues = validateSchedule({ ...context, assignments });
    const introducedBlockers = proposedIssues.filter((issue) => issue.severity === "BLOCKER" && !baselineKeys.has(issueKey(issue)));
    return {
      draftVersion: draft.version,
      sourceStale: context.isSourceStale,
      issues: proposedIssues,
      blockerCount: proposedIssues.filter((issue) => issue.severity === "BLOCKER").length,
      warningCount: proposedIssues.filter((issue) => issue.severity === "WARNING").length,
      infoCount: proposedIssues.filter((issue) => issue.severity === "INFO").length,
      introducedBlockers,
    };
  });
}

export async function validateScheduleDraftCandidate(input: {
  draftId: string;
  ownerUserId: string;
  assignments: SchedulePolicyAssignment[];
}) {
  const [validation] = await validateScheduleDraftCandidates({
    draftId: input.draftId,
    ownerUserId: input.ownerUserId,
    candidates: [input.assignments],
  });
  return validation;
}

const savedValidationReport = (value: Prisma.JsonValue) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Prisma.JsonObject
    : null;

const assertLatestDraftVersion = async (
  client: SchedulePolicyClient,
  draft: { id: string; lineageId: string; createdByUserId: string },
  ownerUserId: string,
) => {
  const latest = await client.aiScheduleDraft.findFirst({
    where: { lineageId: draft.lineageId, createdByUserId: ownerUserId },
    orderBy: { version: "desc" },
    select: { id: true },
  });
  if (latest?.id !== draft.id) {
    throw new SchedulePolicyServiceError("Only the latest draft version can be approved or published.");
  }
};

const verifyCurrentValidation = (input: {
  draft: {
    draftFingerprint: string;
    sourceFingerprint: string;
    validatedFingerprint: string | null;
    validatedSourceFingerprint: string | null;
    validationReport: Prisma.JsonValue;
  };
  context: SchedulePolicyContext;
  currentSourceFingerprint: string;
}) => {
  if (
    input.context.isSourceStale ||
    input.currentSourceFingerprint !== input.draft.sourceFingerprint ||
    input.currentSourceFingerprint !== input.draft.validatedSourceFingerprint
  ) {
    throw new SchedulePolicyServiceError("Live schedules, overrides, employees, shifts, or staffing rules changed after validation. Create a fresh draft before proceeding.");
  }
  const issues = validateSchedule(input.context);
  const report = makeValidationReport(issues, new Date());
  const fingerprint = createValidationFingerprint({
    draftFingerprint: input.draft.draftFingerprint,
    sourceFingerprint: input.currentSourceFingerprint,
    issues,
  });
  const storedReport = savedValidationReport(input.draft.validationReport);
  if (
    !report.isValid ||
    !storedReport ||
    storedReport.isValid !== true ||
    input.draft.validatedFingerprint !== fingerprint
  ) {
    throw new SchedulePolicyServiceError("This exact draft version no longer matches its saved validation. Validate it again.");
  }
  return report;
};

export async function approveScheduleDraft(input: {
  draftId: string;
  ownerUserId: string;
  actorUserId: string;
  acknowledgeWarnings: boolean;
}) {
  try {
    await db.$transaction(async (tx) => {
      const { draft, context, currentSourceFingerprint } = await loadDraftPolicyContext(input, tx);
      if (draft.status !== AiScheduleDraftStatus.VALIDATED) {
        throw new SchedulePolicyServiceError("Validate the latest draft version before approving it.");
      }
      await assertLatestDraftVersion(tx, draft, input.ownerUserId);
      const report = verifyCurrentValidation({ draft, context, currentSourceFingerprint });
      if (report.warningCount > 0 && !input.acknowledgeWarnings) {
        throw new SchedulePolicyServiceError("Acknowledge the validation warnings before approving this version.");
      }

      const now = new Date();
      const updated = await tx.aiScheduleDraft.updateMany({
        where: {
          id: draft.id,
          createdByUserId: input.ownerUserId,
          status: AiScheduleDraftStatus.VALIDATED,
          draftFingerprint: draft.draftFingerprint,
          validatedFingerprint: draft.validatedFingerprint,
        },
        data: {
          status: AiScheduleDraftStatus.APPROVED,
          approvedByUserId: input.actorUserId,
          approvedAt: now,
          warningsAcknowledgedAt: report.warningCount > 0 ? now : null,
          warningsAcknowledgedByUserId: report.warningCount > 0 ? input.actorUserId : null,
        },
      });
      if (updated.count !== 1) {
        throw new SchedulePolicyServiceError("Draft changed during approval. Reload and try again.");
      }
      await tx.aiActionAudit.create({
        data: {
          actorUserId: input.actorUserId,
          action: "DRAFT_APPROVED",
          draftId: draft.id,
          outcome: "SUCCEEDED",
          metadata: {
            version: draft.version,
            draftFingerprint: draft.draftFingerprint,
            validatedFingerprint: draft.validatedFingerprint,
            warningCount: report.warningCount,
            warningsAcknowledged: report.warningCount === 0 || input.acknowledgeWarnings,
          } as Prisma.InputJsonObject,
        },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      throw new SchedulePolicyServiceError("Schedule data changed during approval. Reload, validate, and approve again.");
    }
    throw error;
  }
  return getScheduleDraftVersion({ draftId: input.draftId, ownerUserId: input.ownerUserId });
}

const getOutboxRecipientIds = (value: Prisma.JsonValue) =>
  Array.isArray(value)
    ? Array.from(new Set(value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)))
    : [];

async function dispatchSchedulePublicationOutbox(outboxId: string) {
  const now = new Date();
  const staleLease = new Date(now.getTime() - 5 * 60 * 1000);
  const claimed = await db.$transaction(async (tx) => {
    const updated = await tx.schedulePublicationOutbox.updateMany({
      where: {
        id: outboxId,
        OR: [
          { status: { in: [SchedulePublicationNotificationStatus.PENDING, SchedulePublicationNotificationStatus.FAILED] } },
          { status: SchedulePublicationNotificationStatus.PROCESSING, updatedAt: { lt: staleLease } },
        ],
      },
      data: {
        status: SchedulePublicationNotificationStatus.PROCESSING,
        attempts: { increment: 1 },
        lastError: null,
      },
    });
    const outbox = await tx.schedulePublicationOutbox.findUnique({
      where: { id: outboxId },
      include: { draft: { select: { id: true, weekStart: true, approvedByUserId: true } } },
    });
    return { claimed: updated.count === 1, outbox };
  });
  if (!claimed.outbox) return { status: null, error: "Publication notification record not found." };
  if (!claimed.claimed) {
    return { status: claimed.outbox.status, error: claimed.outbox.lastError };
  }

  try {
    const recordedRecipientIds = getOutboxRecipientIds(claimed.outbox.recipientUserIds);
    const activeRecipients = recordedRecipientIds.length
      ? await db.user.findMany({
          where: { userId: { in: recordedRecipientIds }, isDisabled: false },
          select: { userId: true },
        })
      : [];
    const recipientUserIds = activeRecipients.map((user) => user.userId);
    if (recipientUserIds.length === 0) {
      await db.schedulePublicationOutbox.update({
        where: { id: outboxId },
        data: { status: SchedulePublicationNotificationStatus.SKIPPED, deliveredAt: new Date() },
      });
      return { status: SchedulePublicationNotificationStatus.SKIPPED, error: null };
    }

    const weekStart = toPlannerDateKey(claimed.outbox.draft.weekStart);
    const created = await createAndDispatchNotification({
      dedupeKey: `schedule-publication:${claimed.outbox.draft.id}`,
      eventType: NotificationEventType.SCHEDULE_UPDATED,
      module: NotificationModule.SCHEDULE,
      title: "Schedule published",
      message: `Your schedule for the week of ${weekStart} is available.`,
      severity: NotificationSeverity.SUCCESS,
      actorUserId: claimed.outbox.draft.approvedByUserId,
      entityType: "AI_SCHEDULE_DRAFT",
      entityId: claimed.outbox.draft.id,
      linkHref: "/employee/schedule",
      metadata: { weekStart, draftId: claimed.outbox.draft.id },
      emailEligible: false,
      recipients: { userIds: recipientUserIds },
    });
    if (!created.notificationId) {
      await db.schedulePublicationOutbox.update({
        where: { id: outboxId },
        data: { status: SchedulePublicationNotificationStatus.SKIPPED, deliveredAt: new Date() },
      });
      return { status: SchedulePublicationNotificationStatus.SKIPPED, error: null };
    }
    await db.schedulePublicationOutbox.update({
      where: { id: outboxId },
      data: {
        status: SchedulePublicationNotificationStatus.DELIVERED,
        notificationId: created.notificationId,
        deliveredAt: new Date(),
        lastError: null,
      },
    });
    return { status: SchedulePublicationNotificationStatus.DELIVERED, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "Notification delivery failed.";
    await db.schedulePublicationOutbox.update({
      where: { id: outboxId },
      data: { status: SchedulePublicationNotificationStatus.FAILED, lastError: message },
    });
    return { status: SchedulePublicationNotificationStatus.FAILED, error: message };
  }
}

export async function publishScheduleDraft(input: {
  draftId: string;
  ownerUserId: string;
  actorUserId: string;
  confirmed: boolean;
}) {
  if (!input.confirmed) throw new SchedulePolicyServiceError("Confirm publication to continue.");
  let outboxId: string | null = null;
  try {
    await db.$transaction(async (tx) => {
      const existing = await tx.aiScheduleDraft.findFirst({
        where: { id: input.draftId, createdByUserId: input.ownerUserId },
        select: { id: true, status: true },
      });
      if (!existing) throw new SchedulePolicyServiceError("Draft not found.");
      if (existing.status === AiScheduleDraftStatus.PUBLISHED) {
        const outbox = await tx.schedulePublicationOutbox.findUnique({
          where: { draftId: existing.id },
          select: { id: true },
        });
        outboxId = outbox?.id ?? null;
        return;
      }

      const { draft, context, currentSourceFingerprint } = await loadDraftPolicyContext(input, tx);
      if (draft.status !== AiScheduleDraftStatus.APPROVED) {
        throw new SchedulePolicyServiceError("Approve the validated draft version before publishing.");
      }
      await assertLatestDraftVersion(tx, draft, input.ownerUserId);
      const report = verifyCurrentValidation({ draft, context, currentSourceFingerprint });
      if (report.warningCount > 0 && (!draft.warningsAcknowledgedAt || !draft.warningsAcknowledgedByUserId)) {
        throw new SchedulePolicyServiceError("Validation warnings were not acknowledged for this approved version.");
      }

      const employeeIds = Array.from(new Set(draft.assignments.map((assignment) => assignment.employeeId))).sort();
      const workDates = getWeekDates(draft.weekStart);
      const dateToDayKey = new Map(workDates.map(({ dayKey, date }) => [toPlannerDateKey(date), dayKey]));
      const assignmentsAreComplete = areDraftAssignmentsComplete({
        employeeIds,
        weekStart: draft.weekStart,
        assignments: draft.assignments.map((assignment) => ({
          employeeId: assignment.employeeId,
          workDate: toPlannerDateKey(assignment.workDate),
        })),
      });
      if (!assignmentsAreComplete) {
        throw new SchedulePolicyServiceError("Draft must contain one assignment for every employee and day before publication.");
      }

      const byEmployee = new Map<string, Partial<Record<WeekPlannerDayKey, number | null>>>(
        employeeIds.map((employeeId) => [employeeId, {}]),
      );
      for (const assignment of draft.assignments) {
        const dayKey = dateToDayKey.get(toPlannerDateKey(assignment.workDate));
        const days = byEmployee.get(assignment.employeeId);
        if (!dayKey || !days) throw new SchedulePolicyServiceError("Draft assignment is outside its saved week scope.");
        // Overrides stay authoritative; preserve their underlying weekly value.
        days[dayKey] = assignment.hasBaselineOverride ? assignment.baselineShiftId : assignment.shiftId;
      }

      await persistWeekPlannerAssignmentsInTransaction(tx, draft.weekStart, employeeIds.map((employeeId) => ({
        employeeId,
        days: byEmployee.get(employeeId) ?? {},
      })));

      const updated = await tx.aiScheduleDraft.updateMany({
        where: {
          id: draft.id,
          createdByUserId: input.ownerUserId,
          status: AiScheduleDraftStatus.APPROVED,
          draftFingerprint: draft.draftFingerprint,
          validatedFingerprint: draft.validatedFingerprint,
        },
        data: { status: AiScheduleDraftStatus.PUBLISHED, publishedAt: new Date() },
      });
      if (updated.count !== 1) throw new SchedulePolicyServiceError("Draft changed during publication. No schedule changes were committed.");

      const activeEmployees = await tx.employee.findMany({
        where: {
          employeeId: { in: employeeIds },
          userId: { not: null },
          user: { isDisabled: false },
        },
        select: { userId: true },
      });
      const recipientUserIds = Array.from(new Set(activeEmployees.flatMap((employee) => employee.userId ? [employee.userId] : [])));
      const outbox = await tx.schedulePublicationOutbox.create({
        data: {
          draftId: draft.id,
          recipientUserIds: recipientUserIds as Prisma.InputJsonArray,
          status: recipientUserIds.length > 0
            ? SchedulePublicationNotificationStatus.PENDING
            : SchedulePublicationNotificationStatus.SKIPPED,
          deliveredAt: recipientUserIds.length > 0 ? null : new Date(),
        },
        select: { id: true },
      });
      outboxId = outbox.id;

      await tx.aiActionAudit.create({
        data: {
          actorUserId: input.actorUserId,
          action: "SCHEDULE_PUBLISHED",
          draftId: draft.id,
          outcome: "SUCCEEDED",
          metadata: {
            version: draft.version,
            weekStart: toPlannerDateKey(draft.weekStart),
            employeeCount: employeeIds.length,
            assignmentCount: draft.assignments.length,
            recipientCount: recipientUserIds.length,
            draftFingerprint: draft.draftFingerprint,
            validatedFingerprint: draft.validatedFingerprint,
          } as Prisma.InputJsonObject,
        },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      throw new SchedulePolicyServiceError("Schedule data changed during publication. Revalidate and approve the latest version, then retry.");
    }
    throw error;
  }

  const notification = outboxId
    ? await dispatchSchedulePublicationOutbox(outboxId)
    : { status: null, error: null };
  const draft = await getScheduleDraftVersion({ draftId: input.draftId, ownerUserId: input.ownerUserId });
  return { draft, notificationStatus: notification.status, notificationError: notification.error };
}

export async function retrySchedulePublicationNotification(input: {
  draftId: string;
  ownerUserId: string;
}) {
  const draft = await db.aiScheduleDraft.findFirst({
    where: { id: input.draftId, createdByUserId: input.ownerUserId },
    select: { id: true, status: true },
  });
  if (!draft) throw new SchedulePolicyServiceError("Draft not found.");
  if (draft.status !== AiScheduleDraftStatus.PUBLISHED) {
    throw new SchedulePolicyServiceError("Only a published schedule can retry employee notifications.");
  }
  const outbox = await db.schedulePublicationOutbox.findUnique({
    where: { draftId: draft.id },
    select: { id: true },
  });
  if (!outbox) throw new SchedulePolicyServiceError("Publication notification record not found.");
  const notification = await dispatchSchedulePublicationOutbox(outbox.id);
  const refreshedDraft = await getScheduleDraftVersion({ draftId: input.draftId, ownerUserId: input.ownerUserId });
  return { draft: refreshedDraft, notificationStatus: notification.status, notificationError: notification.error };
}

export async function generateScheduleDraft(input: {
  draftId: string;
  ownerUserId: string;
  actorUserId: string;
}) {
  const { draft, context } = await loadDraftPolicyContext(input);
  if (draft.sourceMode !== AiScheduleDraftSource.REFERENCE_WEEK && draft.sourceMode !== AiScheduleDraftSource.EMPTY) {
    throw new SchedulePolicyServiceError("Create a reference-week or empty draft before running generation.");
  }
  const result = generateScheduleFromReference(context);
  let savedDraft;
  try {
    savedDraft = await saveScheduleDraftVersion({
      requestKey: `generator:${randomUUID()}`,
      draftId: input.draftId,
      ownerUserId: input.ownerUserId,
      changeSource: "GENERATOR",
      assignments: result.assignments.map((assignment) => ({
        employeeId: assignment.employeeId,
        workDate: assignment.workDate,
        shiftId: assignment.shiftId,
        assignmentKind: assignment.assignmentKind,
        reason: assignment.shiftId === context.assignments.find((before) =>
          before.employeeId === assignment.employeeId && before.workDate === assignment.workDate)?.shiftId
          ? null
          : `Generated by ${result.algorithm}`,
      })),
    });
  } catch (error) {
    if (error instanceof ScheduleDraftServiceError) {
      throw new SchedulePolicyServiceError(error.message);
    }
    throw error;
  }
  const counts = issueCounts(result.issues);
  await db.aiActionAudit.create({
    data: {
      actorUserId: input.actorUserId,
      action: "DRAFT_GENERATED",
      draftId: savedDraft.id,
      outcome: result.issues.some((issue) => issue.severity === "BLOCKER") ? "GENERATED_WITH_BLOCKERS" : "SUCCEEDED",
      metadata: {
        algorithm: result.algorithm,
        objective: result.objective,
        changedCells: result.changedCells,
        issueCounts: counts,
        activeRuleIds: context.rules.map((rule) => rule.id),
      } as Prisma.InputJsonObject,
    },
  });
  return { draft: savedDraft, ...result };
}

export async function previewScheduleDraftGeneration(input: {
  draftId: string;
  ownerUserId: string;
}) {
  const { draft, context } = await loadDraftPolicyContext(input);
  if (draft.sourceMode !== AiScheduleDraftSource.REFERENCE_WEEK && draft.sourceMode !== AiScheduleDraftSource.EMPTY) {
    throw new SchedulePolicyServiceError("Create a reference-week or empty draft before balancing configured coverage.");
  }
  const result = generateScheduleFromReference(context);
  return {
    draftVersion: draft.version,
    sourceStale: context.isSourceStale,
    assignments: result.assignments,
    issues: result.issues,
    changedCells: result.changedCells,
    objective: result.objective,
    algorithm: result.algorithm,
  };
}
