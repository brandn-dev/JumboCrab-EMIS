import { createHash } from "node:crypto";
import {
  getWeekDates,
  WEEK_PLANNER_DAYS,
  toPlannerDateKey,
  type WeekPlannerDayKey,
} from "@/lib/week-planner";

export type DraftSourceMode = "CURRENT_SCHEDULE" | "REFERENCE_WEEK" | "EMPTY";
export type DraftAssignmentKind =
  | "WORK"
  | "DAY_OFF"
  | "UNASSIGNED"
  | "PROTECTED_LEAVE";
export type DraftAssignmentSource =
  | "CURRENT_SCHEDULE"
  | "REFERENCE_WEEK"
  | "EMPTY"
  | "MANUAL"
  | "GENERATOR"
  | "AI";

export type DraftScope = {
  departmentId: string | null;
  employeeIds: string[];
  selectionMode: "ALL" | "DEPARTMENT" | "SELECTED";
};

export type DraftAssignmentInput = {
  employeeId: string;
  workDate: string;
  shiftId: number | null;
  assignmentKind: DraftAssignmentKind;
  isProtected: boolean;
  source: DraftAssignmentSource;
  reason?: string | null;
};

export type DraftAssignmentWithBaseline = DraftAssignmentInput & {
  baselineShiftId: number | null;
  baselineOverrideShiftId: number | null;
  hasBaselineOverride: boolean;
};

export type DraftScheduleMap = {
  employeeId: string;
  days: Partial<Record<WeekPlannerDayKey, number | null>>;
};

export type DraftOverrideInput = {
  employeeId: string;
  workDate: string;
  shiftId: number | null;
};

export type DraftLeaveInput = {
  employeeId: string;
  workDate: string;
};

export type DraftShiftInput = {
  id: number;
  isDayOff: boolean;
};

export function normalizeDraftScope(input: {
  departmentId?: string | null;
  selectedEmployeeIds?: string[];
  employeeIds: string[];
}): DraftScope {
  const employeeIds = Array.from(new Set(input.employeeIds.map((id) => id.trim()).filter(Boolean))).sort();
  const selected = Array.from(new Set((input.selectedEmployeeIds ?? []).map((id) => id.trim()).filter(Boolean)));
  const departmentId = input.departmentId?.trim() || null;
  return {
    departmentId,
    employeeIds,
    selectionMode: selected.length > 0 ? "SELECTED" : departmentId ? "DEPARTMENT" : "ALL",
  };
}

export function createDraftScopeKey(scope: DraftScope) {
  const canonical = JSON.stringify({
    departmentId: scope.departmentId,
    employeeIds: [...scope.employeeIds].sort(),
    selectionMode: scope.selectionMode,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function createDraftFingerprint(assignments: DraftAssignmentInput[]) {
  const canonical = assignments
    .map((assignment) => ({
      employeeId: assignment.employeeId,
      workDate: assignment.workDate,
      shiftId: assignment.shiftId,
      assignmentKind: assignment.assignmentKind,
      isProtected: assignment.isProtected,
      source: assignment.source,
      reason: assignment.reason?.trim() || null,
    }))
    .sort((left, right) =>
      left.employeeId.localeCompare(right.employeeId) || left.workDate.localeCompare(right.workDate),
    );

  return createHash("sha256")
    .update(JSON.stringify({ version: 1, assignments: canonical }))
    .digest("hex");
}

const getAssignmentKind = (
  shiftId: number | null,
  shiftById: Map<number, DraftShiftInput>,
): DraftAssignmentKind => {
  if (shiftId == null || !shiftById.has(shiftId)) return "UNASSIGNED";
  return shiftById.get(shiftId)!.isDayOff ? "DAY_OFF" : "WORK";
};

export function buildScheduleDraftAssignments(input: {
  employeeIds: string[];
  weekStart: Date;
  referenceWeekStart?: Date | null;
  sourceMode: DraftSourceMode;
  targetSchedules: DraftScheduleMap[];
  referenceSchedules?: DraftScheduleMap[];
  overrides?: DraftOverrideInput[];
  referenceOverrides?: DraftOverrideInput[];
  approvedLeaveDays?: DraftLeaveInput[];
  shifts: DraftShiftInput[];
}): DraftAssignmentWithBaseline[] {
  const targetByEmployee = new Map(input.targetSchedules.map((row) => [row.employeeId, row]));
  const referenceByEmployee = new Map((input.referenceSchedules ?? []).map((row) => [row.employeeId, row]));
  const overrideByKey = new Map(
    (input.overrides ?? []).map((override) => [
      `${override.employeeId}:${override.workDate}`,
      override,
    ]),
  );
  const referenceOverrideByKey = new Map(
    (input.referenceOverrides ?? []).map((override) => [
      `${override.employeeId}:${override.workDate}`,
      override,
    ]),
  );
  const leaveKeys = new Set(
    (input.approvedLeaveDays ?? []).map((leave) => `${leave.employeeId}:${leave.workDate}`),
  );
  const shiftById = new Map(input.shifts.map((shift) => [shift.id, shift]));
  const referenceDateByDay = new Map(
    (input.referenceWeekStart ? getWeekDates(input.referenceWeekStart) : []).map(({ dayKey, date }) => [
      dayKey,
      toPlannerDateKey(date),
    ]),
  );

  return input.employeeIds.flatMap((employeeId) =>
    getWeekDates(input.weekStart).map(({ dayKey, date }) => {
      const workDate = toPlannerDateKey(date);
      const targetSchedule = targetByEmployee.get(employeeId);
      const referenceSchedule = referenceByEmployee.get(employeeId);
      const baselineShiftId = targetSchedule?.days[dayKey] ?? null;
      const override = overrideByKey.get(`${employeeId}:${workDate}`);
      const referenceDate = referenceDateByDay.get(dayKey);
      const referenceOverride = referenceDate
        ? referenceOverrideByKey.get(`${employeeId}:${referenceDate}`)
        : null;
      const isProtected = leaveKeys.has(`${employeeId}:${workDate}`);

      let shiftId: number | null = null;
      let source: DraftAssignmentSource = input.sourceMode;
      if (isProtected) {
        shiftId = baselineShiftId;
      } else if (override) {
        // A target-week override remains authoritative even when the draft starts
        // from a reference week or an empty template.
        shiftId = override.shiftId;
        source = "CURRENT_SCHEDULE";
      } else if (input.sourceMode === "CURRENT_SCHEDULE") {
        shiftId = baselineShiftId;
      } else if (input.sourceMode === "REFERENCE_WEEK") {
        shiftId = referenceOverride
          ? referenceOverride.shiftId
          : referenceSchedule?.days[dayKey] ?? null;
      }

      const assignmentKind = isProtected
        ? "PROTECTED_LEAVE"
        : getAssignmentKind(shiftId, shiftById);

      return {
        employeeId,
        workDate,
        shiftId,
        baselineShiftId,
        baselineOverrideShiftId: override?.shiftId ?? null,
        hasBaselineOverride: override != null,
        assignmentKind,
        isProtected,
        source,
        reason: null,
      };
    }),
  );
}

export function areDraftAssignmentsComplete(input: {
  employeeIds: string[];
  weekStart: Date;
  assignments: Array<Pick<DraftAssignmentInput, "employeeId" | "workDate">>;
}) {
  const expected = new Set(
    input.employeeIds.flatMap((employeeId) =>
      getWeekDates(input.weekStart).map(
        ({ date }) => `${employeeId}:${toPlannerDateKey(date)}`,
      ),
    ),
  );
  const actual = input.assignments.map(({ employeeId, workDate }) => `${employeeId}:${workDate}`);
  return actual.length === expected.size && new Set(actual).size === actual.length && actual.every((key) => expected.has(key));
}

export function toDraftWeekMap(assignments: DraftAssignmentInput[]) {
  return assignments.reduce<Record<string, Partial<Record<WeekPlannerDayKey, number | null>>>>(
    (result, assignment) => {
      const [year, month, day] = assignment.workDate.split("-").map(Number);
      const date = new Date(Date.UTC(year, month - 1, day, 12));
      const weekDay = date.getUTCDay();
      const dayKey = WEEK_PLANNER_DAYS[weekDay === 0 ? 6 : weekDay - 1];
      result[assignment.employeeId] ??= {};
      result[assignment.employeeId][dayKey] = assignment.shiftId;
      return result;
    },
    {},
  );
}
