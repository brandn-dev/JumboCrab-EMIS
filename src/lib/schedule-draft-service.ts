import "server-only";

import {
  AiScheduleAssignmentKind,
  AiScheduleAssignmentSource,
  AiScheduleDraftSource,
  AiScheduleDraftStatus,
  CURRENT_STATUS,
  LeaveRequestStatus,
  Prisma,
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { getScheduleSourceFingerprint } from "@/lib/schedule-source-fingerprint";
import {
  areDraftAssignmentsComplete,
  buildScheduleDraftAssignments,
  createDraftFingerprint,
  createDraftScopeKey,
  normalizeDraftScope,
  type DraftAssignmentInput,
  type DraftScope,
  type DraftSourceMode,
} from "@/lib/schedule-draft-policy";
import {
  getWeekDates,
  parseWeekStartInput,
  toPlannerDateKey,
  WEEK_PLANNER_DAYS,
  WEEK_SHIFT_FIELD_MAP,
  type WeekPlannerDayKey,
} from "@/lib/week-planner";
import { startOfZonedDay } from "@/lib/timezone";
import type { ScheduleDraftDetails } from "@/types/schedule-draft-types";

export class ScheduleDraftServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleDraftServiceError";
  }
}

const draftEmployeeSelect = {
  employeeId: true,
  employeeCode: true,
  firstName: true,
  lastName: true,
  department: { select: { departmentId: true, name: true } },
} as const;

type DraftDbRow = Prisma.AiScheduleDraftGetPayload<{
  include: { _count: { select: { assignments: true } } };
}>;

const isDraftSourceMode = (value: unknown): value is DraftSourceMode =>
  value === "CURRENT_SCHEDULE" || value === "REFERENCE_WEEK" || value === "EMPTY";

const isAssignmentKind = (value: unknown): value is DraftAssignmentInput["assignmentKind"] =>
  value === "WORK" ||
  value === "DAY_OFF" ||
  value === "UNASSIGNED" ||
  value === "PROTECTED_LEAVE";

const readDraftScope = (value: Prisma.JsonValue): DraftScope => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ScheduleDraftServiceError("Draft scope is invalid.");
  }
  const record = value as Record<string, Prisma.JsonValue>;
  const employeeIds = Array.isArray(record.employeeIds)
    ? record.employeeIds.filter((entry): entry is string => typeof entry === "string")
    : [];
  const departmentId = typeof record.departmentId === "string" ? record.departmentId : null;
  const selectionMode =
    record.selectionMode === "ALL" ||
    record.selectionMode === "DEPARTMENT" ||
    record.selectionMode === "SELECTED"
      ? record.selectionMode
      : "ALL";
  return { departmentId, employeeIds, selectionMode };
};

const normalizeScheduleMaps = (
  rows: Array<{
    employeeId: string;
    monShiftId: number | null;
    tueShiftId: number | null;
    wedShiftId: number | null;
    thuShiftId: number | null;
    friShiftId: number | null;
    satShiftId: number | null;
    sunShiftId: number | null;
  }>,
) =>
  rows.map((row) => ({
    employeeId: row.employeeId,
    days: WEEK_PLANNER_DAYS.reduce(
      (days, dayKey) => {
        days[dayKey] = row[WEEK_SHIFT_FIELD_MAP[dayKey]];
        return days;
      },
      {} as Partial<Record<WeekPlannerDayKey, number | null>>,
    ),
  }));

const loadScheduleMaps = async (employeeIds: string[], weekStart: Date) => {
  if (employeeIds.length === 0) return [];
  const rows = await db.weeklySchedule.findMany({
    where: { employeeId: { in: employeeIds }, weekStart },
    select: {
      employeeId: true,
      monShiftId: true,
      tueShiftId: true,
      wedShiftId: true,
      thuShiftId: true,
      friShiftId: true,
      satShiftId: true,
      sunShiftId: true,
    },
  });
  return normalizeScheduleMaps(rows);
};

const loadApprovedLeaveDays = async (employeeIds: string[], weekStart: Date) => {
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
  const requests = employeeIds.length
    ? await db.leaveRequest.findMany({
        where: {
          employeeId: { in: employeeIds },
          status: LeaveRequestStatus.APPROVED,
          startDate: { lt: weekEnd },
          endDate: { gte: weekStart },
        },
        select: { employeeId: true, startDate: true, endDate: true },
      })
    : [];

  const weekKeys = getWeekDates(weekStart).map(({ date }) => toPlannerDateKey(date));
  return requests.flatMap((request) => {
    const startKey = toPlannerDateKey(request.startDate);
    const endKey = toPlannerDateKey(request.endDate);
    return weekKeys
      .filter((workDate) => workDate >= startKey && workDate <= endKey)
      .map((workDate) => ({ employeeId: request.employeeId, workDate }));
  });
};

const loadCreateAssignments = async (input: {
  employeeIds: string[];
  weekStart: Date;
  sourceMode: DraftSourceMode;
  sourceWeekStart: Date | null;
}) => {
  const weekEnd = new Date(input.weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
  const referenceWeekEnd = input.sourceWeekStart
    ? new Date(input.sourceWeekStart.getTime() + 7 * 24 * 60 * 60 * 1000)
    : null;
  const [targetSchedules, referenceSchedules, overrides, referenceOverrides, approvedLeaveDays] = await Promise.all([
    loadScheduleMaps(input.employeeIds, input.weekStart),
    input.sourceMode === "REFERENCE_WEEK" && input.sourceWeekStart
      ? loadScheduleMaps(input.employeeIds, input.sourceWeekStart)
      : Promise.resolve([]),
    input.employeeIds.length
      ? db.employeeShiftOverride.findMany({
          where: {
            employeeId: { in: input.employeeIds },
            workDate: { gte: input.weekStart, lt: weekEnd },
          },
          select: { employeeId: true, workDate: true, shiftId: true },
        })
      : Promise.resolve([]),
    input.sourceMode === "REFERENCE_WEEK" && input.sourceWeekStart && referenceWeekEnd && input.employeeIds.length
      ? db.employeeShiftOverride.findMany({
          where: {
            employeeId: { in: input.employeeIds },
            workDate: { gte: input.sourceWeekStart, lt: referenceWeekEnd },
          },
          select: { employeeId: true, workDate: true, shiftId: true },
        })
      : Promise.resolve([]),
    loadApprovedLeaveDays(input.employeeIds, input.weekStart),
  ]);

  const overrideInputs = overrides.map((override) => ({
    employeeId: override.employeeId,
    workDate: toPlannerDateKey(override.workDate),
    shiftId: override.shiftId,
  }));
  const referenceOverrideInputs = referenceOverrides.map((override) => ({
    employeeId: override.employeeId,
    workDate: toPlannerDateKey(override.workDate),
    shiftId: override.shiftId,
  }));
  const scheduleShiftIds = [
    ...targetSchedules,
    ...referenceSchedules,
  ].flatMap((schedule) => Object.values(schedule.days));
  const shiftIds = Array.from(
    new Set([
      ...scheduleShiftIds,
      ...overrideInputs.map((override) => override.shiftId),
      ...referenceOverrideInputs.map((override) => override.shiftId),
    ].filter((id): id is number => typeof id === "number")),
  );
  const shifts = shiftIds.length
    ? await db.shift.findMany({ where: { id: { in: shiftIds } }, select: { id: true, isDayOff: true } })
    : [];

  const assignments = buildScheduleDraftAssignments({
    employeeIds: input.employeeIds,
    weekStart: input.weekStart,
    referenceWeekStart: input.sourceWeekStart,
    sourceMode: input.sourceMode,
    targetSchedules,
    referenceSchedules,
    overrides: overrideInputs,
    referenceOverrides: referenceOverrideInputs,
    approvedLeaveDays,
    shifts,
  });
  return { assignments, targetSchedules, referenceSchedules, overrides: overrideInputs };
};

const serializeDraftSummary = (draft: DraftDbRow) => ({
  id: draft.id,
  lineageId: draft.lineageId,
  version: draft.version,
  weekStart: toPlannerDateKey(draft.weekStart),
  scope: readDraftScope(draft.scope),
  sourceMode: draft.sourceMode,
  sourceWeekStart: draft.sourceWeekStart ? toPlannerDateKey(draft.sourceWeekStart) : null,
  status: draft.status,
  sourceFingerprint: draft.sourceFingerprint,
  draftFingerprint: draft.draftFingerprint,
  assignmentCount: draft._count.assignments,
  createdAt: draft.createdAt.toISOString(),
  updatedAt: draft.updatedAt.toISOString(),
});

const getDraftDetailsForOwner = async (input: { draftId: string; ownerUserId: string }) => {
  const draft = await db.aiScheduleDraft.findFirst({
    where: { id: input.draftId, createdByUserId: input.ownerUserId },
    include: {
      _count: { select: { assignments: true } },
      assignments: {
        orderBy: [{ employeeId: "asc" }, { workDate: "asc" }],
        include: { employee: { select: { employeeCode: true, firstName: true, lastName: true } } },
      },
      createdBy: { select: { username: true } },
    },
  });
  if (!draft) throw new ScheduleDraftServiceError("Draft not found.");
  const draftScope = readDraftScope(draft.scope);

  const [versions, currentFingerprint, publicationOutbox] = await Promise.all([
    db.aiScheduleDraft.findMany({
      where: { lineageId: draft.lineageId, createdByUserId: input.ownerUserId },
      orderBy: { version: "desc" },
      include: { _count: { select: { assignments: true } } },
    }),
    getScheduleSourceFingerprint({
      employeeIds: draftScope.employeeIds,
      weekStart: draft.weekStart,
      referenceWeekStart: draft.sourceWeekStart,
      scope: draftScope,
    }),
    db.schedulePublicationOutbox.findUnique({
      where: { draftId: draft.id },
      select: { status: true, lastError: true },
    }),
  ]);

  return {
    ...serializeDraftSummary(draft),
    createdByUsername: draft.createdBy.username,
    isLatestVersion: versions[0]?.id === draft.id,
    isSourceStale: currentFingerprint !== draft.sourceFingerprint,
    validationReport: draft.validationReport && typeof draft.validationReport === "object" && !Array.isArray(draft.validationReport)
      ? draft.validationReport as unknown as ScheduleDraftDetails["validationReport"]
      : null,
    warningsAcknowledgedAt: draft.warningsAcknowledgedAt?.toISOString() ?? null,
    approvedAt: draft.approvedAt?.toISOString() ?? null,
    publishedAt: draft.publishedAt?.toISOString() ?? null,
    notificationStatus: publicationOutbox?.status ?? null,
    notificationError: publicationOutbox?.lastError ?? null,
    assignments: draft.assignments.map((assignment) => ({
      employeeId: assignment.employeeId,
      employeeCode: assignment.employee.employeeCode,
      employeeName: `${assignment.employee.firstName} ${assignment.employee.lastName}`.trim(),
      workDate: toPlannerDateKey(assignment.workDate),
      shiftId: assignment.shiftId,
      baselineShiftId: assignment.baselineShiftId,
      baselineOverrideShiftId: assignment.baselineOverrideShiftId,
      hasBaselineOverride: assignment.hasBaselineOverride,
      assignmentKind: assignment.assignmentKind,
      isProtected: assignment.isProtected,
      source: assignment.source,
      reason: assignment.reason,
    })),
    versions: versions.map((version) => ({
      ...serializeDraftSummary(version),
    })),
  };
};

const ensureRequestKey = (requestKey: string) => {
  const normalized = typeof requestKey === "string" ? requestKey.trim() : "";
  if (!normalized || normalized.length > 100) throw new ScheduleDraftServiceError("A valid request key is required.");
  return normalized;
};

const getExistingRequest = async (requestKey: string, ownerUserId: string) => {
  const existing = await db.aiScheduleDraft.findUnique({ where: { requestKey } });
  if (!existing) return null;
  if (existing.createdByUserId !== ownerUserId) throw new ScheduleDraftServiceError("Forbidden");
  return getDraftDetailsForOwner({ draftId: existing.id, ownerUserId });
};

const resolveEmployeeScope = async (input: {
  departmentId?: string | null;
  selectedEmployeeIds?: string[];
}) => {
  const selectedIds = Array.from(
    new Set((input.selectedEmployeeIds ?? []).map((id) => id.trim()).filter(Boolean)),
  );
  const departmentId = input.departmentId?.trim() || null;
  const where: Prisma.EmployeeWhereInput = {
    isArchived: false,
    currentStatus: { notIn: [CURRENT_STATUS.INACTIVE, CURRENT_STATUS.ENDED] },
    ...(selectedIds.length ? { employeeId: { in: selectedIds } } : {}),
    ...(departmentId ? { departmentId } : {}),
  };
  const employees = await db.employee.findMany({
    where,
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    select: draftEmployeeSelect,
  });
  if (selectedIds.length && employees.length !== selectedIds.length) {
    throw new ScheduleDraftServiceError("One or more selected employees are outside the active scheduling scope.");
  }
  if (employees.length === 0) throw new ScheduleDraftServiceError("Select at least one employee for the draft.");
  const scope = normalizeDraftScope({
    departmentId,
    selectedEmployeeIds: selectedIds,
    employeeIds: employees.map((employee) => employee.employeeId),
  });
  return { employees, scope, scopeKey: createDraftScopeKey(scope) };
};

const createDraftAudit = (
  tx: Prisma.TransactionClient,
  input: {
    actorUserId: string;
    action: string;
    draftId: string;
    outcome: string;
    metadata: Record<string, string | number | boolean | null>;
  },
) =>
  tx.aiActionAudit.create({
    data: {
      actorUserId: input.actorUserId,
      action: input.action,
      draftId: input.draftId,
      outcome: input.outcome,
      metadata: input.metadata as Prisma.InputJsonObject,
    },
  });

export async function listScheduleDraftsForWeek(input: { weekStart: string; ownerUserId: string }) {
  const weekStart = parseWeekStartInput(input.weekStart);
  if (!weekStart) throw new ScheduleDraftServiceError("Invalid weekStart.");

  const rows = await db.aiScheduleDraft.findMany({
    where: { weekStart, createdByUserId: input.ownerUserId },
    orderBy: [{ lineageId: "asc" }, { version: "desc" }],
    include: { _count: { select: { assignments: true } } },
  });
  const byLineage = new Map<string, DraftDbRow[]>();
  for (const row of rows) {
    byLineage.set(row.lineageId, [...(byLineage.get(row.lineageId) ?? []), row]);
  }

  return Array.from(byLineage.values())
    .filter((versions) => versions[0]?.status !== AiScheduleDraftStatus.DISCARDED)
    .map((versions) => ({
      latest: serializeDraftSummary(versions[0]),
      versions: versions.map(serializeDraftSummary),
    }))
    .sort((left, right) => right.latest.updatedAt.localeCompare(left.latest.updatedAt));
}

export async function getScheduleDraftVersion(input: { draftId: string; ownerUserId: string }) {
  return getDraftDetailsForOwner(input);
}

export async function createScheduleDraft(input: {
  requestKey: string;
  weekStart: string;
  referenceWeekStart?: string | null;
  departmentId?: string | null;
  selectedEmployeeIds?: string[];
  sourceMode: DraftSourceMode;
  ownerUserId: string;
}) {
  const requestKey = ensureRequestKey(input.requestKey);
  const existingRequest = await getExistingRequest(requestKey, input.ownerUserId);
  if (existingRequest) return existingRequest;

  const weekStart = parseWeekStartInput(input.weekStart);
  if (!weekStart || !isDraftSourceMode(input.sourceMode)) throw new ScheduleDraftServiceError("Draft input is invalid.");
  const referenceWeekStart = input.referenceWeekStart
    ? parseWeekStartInput(input.referenceWeekStart)
    : null;
  if (input.sourceMode === "REFERENCE_WEEK" && !referenceWeekStart) {
    throw new ScheduleDraftServiceError("Choose a valid reference week.");
  }
  if (referenceWeekStart?.getTime() === weekStart.getTime()) {
    throw new ScheduleDraftServiceError("Reference week must differ from the draft week.");
  }

  const { employees, scope, scopeKey } = await resolveEmployeeScope(input);
  const employeeIds = employees.map((employee) => employee.employeeId);
  const sourceFingerprint = await getScheduleSourceFingerprint({
    employeeIds,
    weekStart,
    referenceWeekStart: input.sourceMode === "REFERENCE_WEEK" ? referenceWeekStart : null,
    scope,
  });
  const { assignments } = await loadCreateAssignments({
    employeeIds,
    weekStart,
    sourceMode: input.sourceMode,
    sourceWeekStart: referenceWeekStart,
  });
  const draftFingerprint = createDraftFingerprint(assignments);
  const lineageId = randomUUID();
  const sourceMode = input.sourceMode as AiScheduleDraftSource;

  let draftId: string;
  try {
    const created = await db.$transaction(async (tx) => {
      const draft = await tx.aiScheduleDraft.create({
        data: {
          lineageId,
          version: 1,
          requestKey,
          weekStart,
          scope: scope as Prisma.InputJsonObject,
          scopeKey,
          sourceMode,
          sourceWeekStart: input.sourceMode === "REFERENCE_WEEK" ? referenceWeekStart : null,
          createdByUserId: input.ownerUserId,
          sourceFingerprint,
          draftFingerprint,
          assignments: {
            create: assignments.map((assignment) => ({
              employeeId: assignment.employeeId,
              workDate: startOfZonedDay(new Date(`${assignment.workDate}T12:00:00.000Z`)),
              shiftId: assignment.shiftId,
              baselineShiftId: assignment.baselineShiftId,
              baselineOverrideShiftId: assignment.baselineOverrideShiftId,
              hasBaselineOverride: assignment.hasBaselineOverride,
              assignmentKind: assignment.assignmentKind as AiScheduleAssignmentKind,
              isProtected: assignment.isProtected,
              source: assignment.source as AiScheduleAssignmentSource,
              reason: assignment.reason,
            })),
          },
        },
        select: { id: true },
      });
      await createDraftAudit(tx, {
        actorUserId: input.ownerUserId,
        action: "DRAFT_CREATED",
        draftId: draft.id,
        outcome: "SUCCEEDED",
        metadata: {
          lineageId,
          version: 1,
          assignmentCount: assignments.length,
          sourceMode: input.sourceMode,
        },
      });
      return draft;
    });
    draftId = created.id;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const duplicate = await getExistingRequest(requestKey, input.ownerUserId);
      if (duplicate) return duplicate;
    }
    throw error;
  }

  return getDraftDetailsForOwner({ draftId, ownerUserId: input.ownerUserId });
}

export async function saveScheduleDraftVersion(input: {
  requestKey: string;
  draftId: string;
  assignments: Array<{
    employeeId: string;
    workDate: string;
    shiftId: number | null;
    assignmentKind: string;
    reason?: string | null;
  }>;
  ownerUserId: string;
  changeSource?: "MANUAL" | "GENERATOR" | "AI";
  expectedVersion?: number;
  expectedDraftFingerprint?: string;
  expectedSourceFingerprint?: string;
}) {
  const requestKey = ensureRequestKey(input.requestKey);
  if (!Array.isArray(input.assignments)) throw new ScheduleDraftServiceError("Draft assignments are required.");
  const existingRequest = await getExistingRequest(requestKey, input.ownerUserId);
  if (existingRequest) return existingRequest;

  const existingDraft = await db.aiScheduleDraft.findFirst({
    where: { id: input.draftId, createdByUserId: input.ownerUserId },
    include: { assignments: true },
  });
  if (!existingDraft) throw new ScheduleDraftServiceError("Draft not found.");
  if (input.expectedVersion != null && existingDraft.version !== input.expectedVersion) {
    throw new ScheduleDraftServiceError("Draft changed after this proposal. Review the latest draft before applying.");
  }
  if (input.expectedDraftFingerprint && existingDraft.draftFingerprint !== input.expectedDraftFingerprint) {
    throw new ScheduleDraftServiceError("Draft changed after this proposal. Review the latest draft before applying.");
  }
  if (existingDraft.status === AiScheduleDraftStatus.PUBLISHED || existingDraft.status === AiScheduleDraftStatus.DISCARDED) {
    throw new ScheduleDraftServiceError("Published or discarded drafts cannot be changed.");
  }

  const scope = readDraftScope(existingDraft.scope);
  const latest = await db.aiScheduleDraft.findFirst({
    where: { lineageId: existingDraft.lineageId, createdByUserId: input.ownerUserId },
    orderBy: { version: "desc" },
    select: { id: true, version: true },
  });
  if (latest?.id !== existingDraft.id) {
    throw new ScheduleDraftServiceError("A newer draft version exists. Reload it before saving.");
  }
  if (input.expectedVersion != null && latest.version !== input.expectedVersion) {
    throw new ScheduleDraftServiceError("Draft changed after this proposal. Review the latest draft before applying.");
  }

  const weekDates = getWeekDates(existingDraft.weekStart);
  const expectedDates = new Set(weekDates.map(({ date }) => toPlannerDateKey(date)));
  const normalizedAssignments = input.assignments.map((assignment) => {
    const employeeId = typeof assignment.employeeId === "string" ? assignment.employeeId.trim() : "";
    const workDate = typeof assignment.workDate === "string" ? assignment.workDate.trim() : "";
    if (
      assignment.shiftId !== null &&
      (typeof assignment.shiftId !== "number" || !Number.isSafeInteger(assignment.shiftId) || assignment.shiftId <= 0)
    ) {
      throw new ScheduleDraftServiceError("Draft shift ID is invalid.");
    }
    if (assignment.reason != null && typeof assignment.reason !== "string") {
      throw new ScheduleDraftServiceError("Draft assignment reason is invalid.");
    }
    const shiftId = assignment.shiftId;
    if (!isAssignmentKind(assignment.assignmentKind)) throw new ScheduleDraftServiceError("Draft assignment kind is invalid.");
    if (!employeeId || !workDate || !expectedDates.has(workDate)) {
      throw new ScheduleDraftServiceError("Draft assignment is outside its saved employee/week scope.");
    }
    if (!scope.employeeIds.includes(employeeId)) {
      throw new ScheduleDraftServiceError("Draft assignment is outside its saved employee/week scope.");
    }
    return {
      employeeId,
      workDate,
      shiftId,
      assignmentKind: assignment.assignmentKind,
      reason: assignment.reason?.trim().slice(0, 200) || null,
    };
  });
  if (!areDraftAssignmentsComplete({
    employeeIds: scope.employeeIds,
    weekStart: existingDraft.weekStart,
    assignments: normalizedAssignments,
  })) {
    throw new ScheduleDraftServiceError("Draft must include exactly one assignment for every employee and day.");
  }

  const existingByKey = new Map(
    existingDraft.assignments.map((assignment) => [
      `${assignment.employeeId}:${toPlannerDateKey(assignment.workDate)}`,
      assignment,
    ]),
  );
  const approvedLeaveDays = await loadApprovedLeaveDays(scope.employeeIds, existingDraft.weekStart);
  const approvedLeaveKeys = new Set(
    approvedLeaveDays.map((leave) => `${leave.employeeId}:${leave.workDate}`),
  );
  const shiftIds = Array.from(
    new Set(normalizedAssignments.map((assignment) => assignment.shiftId).filter((id): id is number => id != null)),
  );
  const shifts = shiftIds.length
    ? await db.shift.findMany({ where: { id: { in: shiftIds } }, select: { id: true, isDayOff: true, isActive: true } })
    : [];
  const shiftById = new Map(shifts.map((shift) => [shift.id, shift]));

  const assignments = normalizedAssignments.map((assignment) => {
    const key = `${assignment.employeeId}:${assignment.workDate}`;
    const baseline = existingByKey.get(key);
    if (!baseline) throw new ScheduleDraftServiceError("Draft baseline assignment is missing.");
    const protectedByLeave = approvedLeaveKeys.has(key);
    const assignmentKind =
      assignment.assignmentKind === "PROTECTED_LEAVE" && !protectedByLeave
        ? assignment.shiftId == null
          ? "UNASSIGNED"
          : shiftById.get(assignment.shiftId)?.isDayOff
            ? "DAY_OFF"
            : "WORK"
        : assignment.assignmentKind;
    if (protectedByLeave && assignmentKind !== "PROTECTED_LEAVE") {
      throw new ScheduleDraftServiceError("Approved leave must remain protected in the draft.");
    }
    if (assignmentKind === "UNASSIGNED" && assignment.shiftId != null) {
      throw new ScheduleDraftServiceError("Unassigned draft cells cannot include a shift.");
    }
    if (protectedByLeave && assignment.shiftId !== baseline.baselineShiftId) {
      throw new ScheduleDraftServiceError("Protected leave must preserve the baseline weekly shift.");
    }
    if (
      baseline.hasBaselineOverride &&
      !protectedByLeave &&
      assignment.shiftId !== baseline.baselineOverrideShiftId
    ) {
      throw new ScheduleDraftServiceError("Day-specific schedule overrides must remain unchanged in a draft.");
    }
    if (assignmentKind === "WORK" || assignmentKind === "DAY_OFF") {
      if (assignment.shiftId == null) throw new ScheduleDraftServiceError("Choose a shift for this draft assignment.");
      const shift = shiftById.get(assignment.shiftId);
      if (!shift) throw new ScheduleDraftServiceError("Draft shift was not found.");
      if (!shift.isActive && assignment.shiftId !== baseline.shiftId) {
        throw new ScheduleDraftServiceError("New assignments must use an active shift.");
      }
      if (assignmentKind === "WORK" && shift.isDayOff) {
        throw new ScheduleDraftServiceError("Work assignments require a working shift.");
      }
      if (assignmentKind === "DAY_OFF" && !shift.isDayOff) {
        throw new ScheduleDraftServiceError("Day off assignments require a Day Off shift.");
      }
    }

    const effectiveBaselineShiftId = baseline.hasBaselineOverride
      ? baseline.baselineOverrideShiftId
      : baseline.baselineShiftId;
    const changed =
      assignment.shiftId !== effectiveBaselineShiftId ||
      assignmentKind !== baseline.assignmentKind;
    return {
      ...assignment,
      assignmentKind,
      baselineShiftId: baseline.baselineShiftId,
      baselineOverrideShiftId: baseline.baselineOverrideShiftId,
      hasBaselineOverride: baseline.hasBaselineOverride,
      isProtected: assignmentKind === "PROTECTED_LEAVE",
      source: changed
        ? input.changeSource === "GENERATOR"
          ? AiScheduleAssignmentSource.GENERATOR
          : input.changeSource === "AI"
            ? AiScheduleAssignmentSource.AI
            : AiScheduleAssignmentSource.MANUAL
        : baseline.source,
    };
  });
  const draftFingerprint = createDraftFingerprint(assignments);
  if (draftFingerprint === existingDraft.draftFingerprint) {
    return getDraftDetailsForOwner({ draftId: existingDraft.id, ownerUserId: input.ownerUserId });
  }

  const serializedScope = scope as Prisma.InputJsonObject;
  let nextDraftId: string;
  try {
    const created = await db.$transaction(
      async (tx) => {
        const latestInsideTransaction = await tx.aiScheduleDraft.findFirst({
          where: { lineageId: existingDraft.lineageId, createdByUserId: input.ownerUserId },
          orderBy: { version: "desc" },
          select: { id: true, version: true },
        });
        if (latestInsideTransaction?.id !== existingDraft.id) {
          throw new ScheduleDraftServiceError("A newer draft version exists. Reload it before saving.");
        }
        if (input.expectedVersion != null && latestInsideTransaction.version !== input.expectedVersion) {
          throw new ScheduleDraftServiceError("Draft changed after this proposal. Review the latest draft before applying.");
        }
        if (input.expectedSourceFingerprint) {
          const currentSourceFingerprint = await getScheduleSourceFingerprint({
            employeeIds: scope.employeeIds,
            weekStart: existingDraft.weekStart,
            referenceWeekStart: existingDraft.sourceWeekStart,
            scope,
          }, tx);
          if (currentSourceFingerprint !== input.expectedSourceFingerprint) {
            throw new ScheduleDraftServiceError("Live schedules, overrides, or approved leave changed after this proposal. Reload and review again.");
          }
        }
        const nextVersion = (latestInsideTransaction.version ?? existingDraft.version) + 1;
        const draft = await tx.aiScheduleDraft.create({
          data: {
            lineageId: existingDraft.lineageId,
            version: nextVersion,
            requestKey,
            weekStart: existingDraft.weekStart,
            scope: serializedScope,
            scopeKey: existingDraft.scopeKey,
            sourceMode: existingDraft.sourceMode,
            sourceWeekStart: existingDraft.sourceWeekStart,
            createdByUserId: input.ownerUserId,
            sourceFingerprint: existingDraft.sourceFingerprint,
            draftFingerprint,
            assignments: {
              create: assignments.map((assignment) => ({
                employeeId: assignment.employeeId,
                workDate: startOfZonedDay(new Date(`${assignment.workDate}T12:00:00.000Z`)),
                shiftId: assignment.shiftId,
                baselineShiftId: assignment.baselineShiftId,
                baselineOverrideShiftId: assignment.baselineOverrideShiftId,
                hasBaselineOverride: assignment.hasBaselineOverride,
                assignmentKind: assignment.assignmentKind as AiScheduleAssignmentKind,
                isProtected: assignment.isProtected,
                source: assignment.source,
                reason: assignment.reason,
              })),
            },
          },
          select: { id: true, version: true },
        });
        await createDraftAudit(tx, {
          actorUserId: input.ownerUserId,
          action: "DRAFT_VERSION_SAVED",
          draftId: draft.id,
          outcome: "SUCCEEDED",
          metadata: {
            lineageId: existingDraft.lineageId,
            version: draft.version,
            assignmentCount: assignments.length,
          },
        });
        return draft;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    nextDraftId = created.id;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const duplicate = await getExistingRequest(requestKey, input.ownerUserId);
      if (duplicate) return duplicate;
      throw new ScheduleDraftServiceError("Draft changed in another session. Reload the latest version and try again.");
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      throw new ScheduleDraftServiceError("Draft changed in another session. Reload the latest version and try again.");
    }
    throw error;
  }

  return getDraftDetailsForOwner({ draftId: nextDraftId, ownerUserId: input.ownerUserId });
}

export async function discardScheduleDraft(input: { draftId: string; ownerUserId: string }) {
  const draft = await db.aiScheduleDraft.findFirst({
    where: { id: input.draftId, createdByUserId: input.ownerUserId },
    select: { id: true, lineageId: true, version: true, status: true },
  });
  if (!draft) throw new ScheduleDraftServiceError("Draft not found.");
  if (draft.status === AiScheduleDraftStatus.DISCARDED) return { success: true };
  if (draft.status !== AiScheduleDraftStatus.DRAFT && draft.status !== AiScheduleDraftStatus.VALIDATED) {
    throw new ScheduleDraftServiceError("Only an unapproved draft can be discarded. Approved and published schedules are protected.");
  }
  const latest = await db.aiScheduleDraft.findFirst({
    where: { lineageId: draft.lineageId, createdByUserId: input.ownerUserId },
    orderBy: { version: "desc" },
    select: { id: true },
  });
  if (latest?.id !== draft.id) throw new ScheduleDraftServiceError("Only the latest draft version can be discarded.");

  await db.$transaction(async (tx) => {
    const updated = await tx.aiScheduleDraft.updateMany({
      where: {
        id: draft.id,
        version: draft.version,
        status: { in: [AiScheduleDraftStatus.DRAFT, AiScheduleDraftStatus.VALIDATED] },
      },
      data: { status: AiScheduleDraftStatus.DISCARDED },
    });
    if (updated.count !== 1) throw new ScheduleDraftServiceError("Draft changed while discarding. Reload and try again.");
    await tx.aiConversation.updateMany({
      where: { activeDraftId: draft.id },
      data: { activeDraftId: null, pendingInteraction: Prisma.DbNull },
    });
    await createDraftAudit(tx, {
      actorUserId: input.ownerUserId,
      action: "DRAFT_DISCARDED",
      draftId: draft.id,
      outcome: "SUCCEEDED",
      metadata: { lineageId: draft.lineageId, version: draft.version, previousStatus: draft.status },
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  return { success: true };
}

export async function discardScheduleDraftsForWeek(input: { weekStart: string; ownerUserId: string }) {
  const weekStart = parseWeekStartInput(input.weekStart);
  if (!weekStart) throw new ScheduleDraftServiceError("Invalid weekStart.");

  return db.$transaction(async (tx) => {
    const rows = await tx.aiScheduleDraft.findMany({
      where: { weekStart, createdByUserId: input.ownerUserId },
      orderBy: [{ lineageId: "asc" }, { version: "desc" }],
      select: { id: true, lineageId: true, version: true, status: true },
    });
    const latestByLineage = new Map<string, typeof rows[number]>();
    for (const row of rows) {
      if (!latestByLineage.has(row.lineageId)) latestByLineage.set(row.lineageId, row);
    }
    const discardable = Array.from(latestByLineage.values()).filter((draft) =>
      draft.status === AiScheduleDraftStatus.DRAFT || draft.status === AiScheduleDraftStatus.VALIDATED,
    );
    let discardedCount = 0;
    for (const draft of discardable) {
      const updated = await tx.aiScheduleDraft.updateMany({
        where: {
          id: draft.id,
          version: draft.version,
          status: { in: [AiScheduleDraftStatus.DRAFT, AiScheduleDraftStatus.VALIDATED] },
        },
        data: { status: AiScheduleDraftStatus.DISCARDED },
      });
      if (updated.count !== 1) {
        throw new ScheduleDraftServiceError("A draft changed while discarding. Reload the week and try again.");
      }
      await tx.aiConversation.updateMany({
        where: { activeDraftId: draft.id },
        data: { activeDraftId: null, pendingInteraction: Prisma.DbNull },
      });
      await createDraftAudit(tx, {
        actorUserId: input.ownerUserId,
        action: "DRAFT_DISCARDED",
        draftId: draft.id,
        outcome: "SUCCEEDED",
        metadata: { lineageId: draft.lineageId, version: draft.version, previousStatus: draft.status, bulkWeekDiscard: true },
      });
      discardedCount += 1;
    }
    return { discardedCount };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
