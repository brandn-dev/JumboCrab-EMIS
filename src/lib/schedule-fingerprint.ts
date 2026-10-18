import { createHash } from "node:crypto";
import { WEEK_PLANNER_DAYS, WEEK_SHIFT_FIELD_MAP } from "@/lib/week-planner";

export type WeeklyScheduleFingerprintRow = {
  employeeId: string;
  weekStart: Date;
  updatedAt: Date;
  monShiftId: number | null;
  tueShiftId: number | null;
  wedShiftId: number | null;
  thuShiftId: number | null;
  friShiftId: number | null;
  satShiftId: number | null;
  sunShiftId: number | null;
};

export type ScheduleOverrideFingerprintRow = {
  employeeId: string;
  workDate: Date;
  shiftId: number | null;
  source: string;
  updatedAt: Date;
};

export type ApprovedLeaveFingerprintRow = {
  employeeId: string;
  startDate: Date;
  endDate: Date;
  leaveType: string;
  updatedAt: Date;
};

export type ScheduleEmployeeFingerprintRow = {
  employeeId: string;
  departmentId: string | null;
  positionId: string | null;
  isArchived: boolean;
  currentStatus: string;
  updatedAt: Date;
};

export type ScheduleShiftFingerprintRow = {
  id: number;
  isActive: boolean;
  isDayOff: boolean;
  startMinutes: number;
  endMinutes: number;
  spansMidnight: boolean;
  paidHoursPerDay: number | string | null;
  updatedAt: Date;
};

export type ScheduleRuleFingerprintRow = {
  id: string;
  name: string;
  departmentId: string | null;
  positionId: string | null;
  shiftId: number | null;
  weekday: number;
  minimumStaff: number;
  maximumStaff: number | null;
  priority: string;
  isActive: boolean;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  updatedAt: Date;
};

export type ScheduleSourceScope = {
  selectionMode: "ALL" | "DEPARTMENT" | "SELECTED";
  departmentId: string | null;
};

export function createScheduleSourceFingerprint(input: {
  weeklySchedules: WeeklyScheduleFingerprintRow[];
  overrides: ScheduleOverrideFingerprintRow[];
  approvedLeaves?: ApprovedLeaveFingerprintRow[];
  employees?: ScheduleEmployeeFingerprintRow[];
  rosterEmployees?: ScheduleEmployeeFingerprintRow[];
  shifts?: ScheduleShiftFingerprintRow[];
  coverageRules?: ScheduleRuleFingerprintRow[];
  scope?: ScheduleSourceScope;
}) {
  const weeklySchedules = input.weeklySchedules
    .map((row) => ({
      employeeId: row.employeeId,
      weekStart: row.weekStart.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      shifts: WEEK_PLANNER_DAYS.map((dayKey) => row[WEEK_SHIFT_FIELD_MAP[dayKey]]),
    }))
    .sort((left, right) =>
      left.employeeId.localeCompare(right.employeeId) ||
      left.weekStart.localeCompare(right.weekStart),
    );
  const overrides = input.overrides
    .map((row) => ({
      employeeId: row.employeeId,
      workDate: row.workDate.toISOString(),
      shiftId: row.shiftId,
      source: row.source,
      updatedAt: row.updatedAt.toISOString(),
    }))
    .sort((left, right) =>
      left.employeeId.localeCompare(right.employeeId) ||
      left.workDate.localeCompare(right.workDate),
    );
  const approvedLeaves = (input.approvedLeaves ?? [])
    .map((row) => ({
      employeeId: row.employeeId,
      startDate: row.startDate.toISOString(),
      endDate: row.endDate.toISOString(),
      leaveType: row.leaveType,
      updatedAt: row.updatedAt.toISOString(),
    }))
    .sort((left, right) =>
      left.employeeId.localeCompare(right.employeeId) ||
      left.startDate.localeCompare(right.startDate) ||
      left.endDate.localeCompare(right.endDate),
    );

  const serializeEmployees = (rows: ScheduleEmployeeFingerprintRow[] = []) => rows
    .map((row) => ({
      employeeId: row.employeeId,
      departmentId: row.departmentId,
      positionId: row.positionId,
      isArchived: row.isArchived,
      currentStatus: row.currentStatus,
      updatedAt: row.updatedAt.toISOString(),
    }))
    .sort((left, right) => left.employeeId.localeCompare(right.employeeId));
  const employees = serializeEmployees(input.employees);
  const rosterEmployees = serializeEmployees(input.rosterEmployees);
  const shifts = (input.shifts ?? [])
    .map((row) => ({
      id: row.id,
      isActive: row.isActive,
      isDayOff: row.isDayOff,
      startMinutes: row.startMinutes,
      endMinutes: row.endMinutes,
      spansMidnight: row.spansMidnight,
      paidHoursPerDay: row.paidHoursPerDay == null ? null : Number(row.paidHoursPerDay),
      updatedAt: row.updatedAt.toISOString(),
    }))
    .sort((left, right) => left.id - right.id);
  const coverageRules = (input.coverageRules ?? [])
    .map((row) => ({
      ...row,
      effectiveFrom: row.effectiveFrom?.toISOString() ?? null,
      effectiveTo: row.effectiveTo?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const scope = {
    selectionMode: input.scope?.selectionMode ?? "SELECTED",
    departmentId: input.scope?.departmentId ?? null,
  };

  return createHash("sha256")
    .update(JSON.stringify({
      version: 3,
      scope,
      weeklySchedules,
      overrides,
      approvedLeaves,
      employees,
      rosterEmployees,
      shifts,
      coverageRules,
    }))
    .digest("hex");
}
