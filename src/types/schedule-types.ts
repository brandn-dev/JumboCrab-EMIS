import { DateRange } from "react-day-picker";
import { TZ } from "@/lib/timezone";
import {
  computeCoverageSummary,
  getShiftBucket,
  normalizeWeekStart,
  toPlannerDateKey,
  WEEK_PLANNER_DAYS,
  WEEKDAY_LABELS,
  type CoverageSummary,
  type PlannerShiftLike,
  type ShiftBucket,
  type WeekPlannerDayKey,
  type WeekShiftMap,
} from "@/lib/week-planner";

export type { CoverageSummary, ShiftBucket, WeekPlannerDayKey, WeekShiftMap };

export type EmployeeLite = {
  employeeId: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  img?: string | null;
  department?: { departmentId?: string | null; name: string | null } | null;
  position?: { positionId?: string | null; name: string | null } | null;
};

export type ShiftLite = {
  id: number;
  code: string;
  name: string;
  colorHex?: string | null;
  isDayOff?: boolean;
  startMinutes: number;
  endMinutes: number;
  spansMidnight?: boolean;
  breakStartMinutes?: number | null;
  breakEndMinutes?: number | null;
  breakMinutesUnpaid?: number | null;
  paidHoursPerDay?: number | null;
  notes?: string | null;
};

export type ScheduleEntry = {
  employee: EmployeeLite;
  shift: ShiftLite | null;
  source: "override" | "weekly_schedule" | "none";
  scheduledStartMinutes: number | null;
  scheduledEndMinutes: number | null;
};

export type OverrideRow = {
  id: string;
  workDate: string;
  source: string;
  note?: string | null;
  employee: EmployeeLite;
  shift: ShiftLite | null;
};

export type WeekPlannerLeaveInfo = {
  leaveType:
    | "VACATION"
    | "SICK"
    | "SIL"
    | "PERSONAL"
    | "EMERGENCY"
    | "UNPAID";
  isPaidLeave: boolean;
};

export type WeekPlannerDayDraft = {
  workDate: string;
  compareWorkDate: string;
  shiftId: number | null;
  shift: ShiftLite | null;
  compareShiftId: number | null;
  compareShift: ShiftLite | null;
  hasOverride: boolean;
  overrideShiftId: number | null;
  leave: WeekPlannerLeaveInfo | null;
};

export type WeekPlannerRow = {
  employee: EmployeeLite;
  days: Record<WeekPlannerDayKey, WeekPlannerDayDraft>;
};

export type PlannerDepartmentOption = {
  departmentId: string;
  name: string;
};

export type WeekPlannerAlternatePair = {
  leftShiftId: number;
  rightShiftId: number;
};

export type WeekPlannerDayOffToolInput = {
  mode: "assignOff" | "clearOff" | "clearAllOff";
  dayKeys: WeekPlannerDayKey[];
  employeeIdsByDay: Partial<Record<WeekPlannerDayKey, string[]>>;
  replaceExistingOff: boolean;
};

export type WeekPlannerQuickSelectOption = {
  weekStart: string;
  isAssigned: boolean;
  unassignedCount: number;
};

export type WeekPlannerSnapshot = {
  weekStart: string;
  compareWeekStart: string;
  rows: WeekPlannerRow[];
  shifts: ShiftLite[];
  departments: PlannerDepartmentOption[];
  coverage: CoverageSummary;
  scheduleWeekOptions: WeekPlannerQuickSelectOption[];
  referenceWeekOptions: WeekPlannerQuickSelectOption[];
};

export type WeekPlannerBulkReplaceInput = {
  mode: "replace";
  dayKeys: WeekPlannerDayKey[];
  employeeIds: string[] | null;
  positionNames: string[] | null;
  sourceMode: "any" | "dayOff" | "unassigned" | "shift";
  sourceShiftId: number | null;
  targetShiftId: number | null;
};

export type WeekPlannerBulkHeadcountInput = {
  mode: "headcount";
  dayKeys: WeekPlannerDayKey[];
  employeeIds: string[] | null;
  positionNames: string[] | null;
  targetMode: "bucket" | "shift";
  targetBucket: ShiftBucket | null;
  targetShiftId: number | null;
  assignShiftId: number | null;
  targetCount: number;
};

export type WeekPlannerBulkPositionAllocateInput = {
  mode: "positionAllocate";
  dayKeys: WeekPlannerDayKey[];
  employeeIds: string[] | null;
  allocations: Array<{
    positionName: string;
    shiftId: number | null;
    targetCount: number;
  }>;
};

export type WeekPlannerBulkActionInput =
  | WeekPlannerBulkReplaceInput
  | WeekPlannerBulkHeadcountInput
  | WeekPlannerBulkPositionAllocateInput;

type ShiftInput = {
  id: number;
  code: string;
  name: string;
  colorHex?: string | null;
  isDayOff?: boolean | null;
  startMinutes: number;
  endMinutes: number;
  spansMidnight?: boolean | null;
  breakStartMinutes?: number | null;
  breakEndMinutes?: number | null;
  breakMinutesUnpaid?: number | null;
  paidHoursPerDay?: number | string | null;
  notes?: string | null;
};

type OverrideInput = {
  id: string;
  workDate: string;
  source: string;
  note?: string | null;
  employee: EmployeeLite;
  shift?: ShiftInput | null;
};

type WeekPlannerDayDraftInput = {
  workDate: string;
  compareWorkDate: string;
  shiftId?: number | null;
  shift?: ShiftInput | null;
  compareShiftId?: number | null;
  compareShift?: ShiftInput | null;
  hasOverride?: boolean;
  overrideShiftId?: number | null;
  leave?: WeekPlannerLeaveInfo | null;
};

type WeekPlannerRowInput = {
  employee: EmployeeLite;
  days: Partial<Record<WeekPlannerDayKey, WeekPlannerDayDraftInput>>;
};

type WeekPlannerSnapshotInput = {
  weekStart: string;
  compareWeekStart: string;
  rows: WeekPlannerRowInput[];
  shifts: ShiftInput[];
  departments: PlannerDepartmentOption[];
  coverage: CoverageSummary;
  scheduleWeekOptions?: WeekPlannerQuickSelectOption[];
  referenceWeekOptions?: WeekPlannerQuickSelectOption[];
};

export const todayISO = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: TZ });

export const formatMinutes = (minutes: number | null) => {
  if (minutes == null) return "—";
  const total = ((minutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const h24 = Math.floor(total / 60);
  const m = total % 60;
  const suffix = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 || 12;
  return `${h12}:${m.toString().padStart(2, "0")} ${suffix}`;
};

export const minutesToTimeInput = (minutes: number) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
};

export const formatDateDisplay = (value: string) => {
  const d = new Date(value);
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: TZ,
  });
};

export const normalizeShift = (s: ShiftInput): ShiftLite => ({
  id: s.id,
  code: s.code,
  name: s.name,
  colorHex: s.colorHex ?? null,
  isDayOff: Boolean(s.isDayOff),
  startMinutes: s.startMinutes,
  endMinutes: s.endMinutes,
  spansMidnight: Boolean(s.spansMidnight),
  breakStartMinutes:
    typeof s.breakStartMinutes === "number" ? s.breakStartMinutes : null,
  breakEndMinutes: typeof s.breakEndMinutes === "number" ? s.breakEndMinutes : null,
  breakMinutesUnpaid:
    typeof s.breakMinutesUnpaid === "number" ? s.breakMinutesUnpaid : 0,
  paidHoursPerDay:
    s.paidHoursPerDay != null
      ? typeof s.paidHoursPerDay === "number"
        ? s.paidHoursPerDay
        : Number(s.paidHoursPerDay)
      : 0,
  notes: s.notes ?? "",
});

export const normalizeOverride = (o: OverrideInput): OverrideRow => ({
  id: o.id,
  workDate: o.workDate,
  source: o.source,
  note: o.note ?? "",
  employee: o.employee,
  shift: o.shift ? normalizeShift(o.shift) : null,
});

export const normalizeWeekPlannerRow = (row: WeekPlannerRowInput): WeekPlannerRow => ({
  employee: row.employee,
  days: WEEK_PLANNER_DAYS.reduce(
    (acc, dayKey) => {
      const day = row.days[dayKey];
      acc[dayKey] = {
        workDate: day?.workDate ?? "",
        compareWorkDate: day?.compareWorkDate ?? "",
        shiftId:
          typeof day?.shiftId === "number" ? day.shiftId : day?.shift?.id ?? null,
        shift: day?.shift ? normalizeShift(day.shift) : null,
        compareShiftId:
          typeof day?.compareShiftId === "number"
            ? day.compareShiftId
            : day?.compareShift?.id ?? null,
        compareShift: day?.compareShift ? normalizeShift(day.compareShift) : null,
        hasOverride: Boolean(day?.hasOverride),
        overrideShiftId: typeof day?.overrideShiftId === "number" ? day.overrideShiftId : null,
        leave: day?.leave ?? null,
      };
      return acc;
    },
    {} as Record<WeekPlannerDayKey, WeekPlannerDayDraft>,
  ),
});

export const normalizeWeekPlannerSnapshot = (
  snapshot: WeekPlannerSnapshotInput,
): WeekPlannerSnapshot => ({
  weekStart: snapshot.weekStart,
  compareWeekStart: snapshot.compareWeekStart,
  rows: snapshot.rows.map(normalizeWeekPlannerRow),
  shifts: snapshot.shifts.map(normalizeShift),
  departments: snapshot.departments,
  coverage: snapshot.coverage,
  scheduleWeekOptions: snapshot.scheduleWeekOptions ?? [],
  referenceWeekOptions: snapshot.referenceWeekOptions ?? [],
});

export const toDateInputValue = (value: string) =>
  new Date(value).toLocaleDateString("en-CA", { timeZone: TZ });

export const formatRangeLabel = (range: DateRange) => {
  const fmt = (d?: Date) =>
    d
      ? d.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
          timeZone: TZ,
        })
      : "";
  return range?.from
    ? `${fmt(range.from)}${range.to ? ` → ${fmt(range.to)}` : ""}`
    : "Pick dates";
};

export const makeDate = (val?: string | null) => {
  if (!val) return undefined;
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

export const weekPlannerDayKeys = WEEK_PLANNER_DAYS;

export const weekPlannerDayLabel = (dayKey: WeekPlannerDayKey) =>
  WEEKDAY_LABELS[dayKey];

export const plannerDateInputValue = (value?: string | Date | null) =>
  toPlannerDateKey(normalizeWeekStart(value));

export const weekPlannerRowToShiftMap = (row: WeekPlannerRow): WeekShiftMap =>
  WEEK_PLANNER_DAYS.reduce(
    (acc, dayKey) => {
      acc[dayKey] = row.days[dayKey].shiftId ?? null;
      return acc;
    },
    {} as WeekShiftMap,
  );

export const applyWeekPlannerShiftMap = (
  row: WeekPlannerRow,
  shiftMap: WeekShiftMap,
): WeekPlannerRow => ({
  ...row,
  days: WEEK_PLANNER_DAYS.reduce(
    (acc, dayKey) => {
      const previousDay = row.days[dayKey];
      acc[dayKey] = {
        ...previousDay,
        shiftId: shiftMap[dayKey] ?? null,
      };
      return acc;
    },
    {} as Record<WeekPlannerDayKey, WeekPlannerDayDraft>,
  ),
});

export const hydrateWeekPlannerRowShifts = (
  row: WeekPlannerRow,
  shiftsById: Map<number, ShiftLite>,
): WeekPlannerRow => ({
  ...row,
  days: WEEK_PLANNER_DAYS.reduce(
    (acc, dayKey) => {
      const day = row.days[dayKey];
      acc[dayKey] = {
        ...day,
        shift: day.shiftId != null ? shiftsById.get(day.shiftId) ?? null : null,
        compareShift:
          day.compareShiftId != null
            ? shiftsById.get(day.compareShiftId) ?? day.compareShift ?? null
            : null,
      };
      return acc;
    },
    {} as Record<WeekPlannerDayKey, WeekPlannerDayDraft>,
  ),
});

export const copyCompareWeekIntoRow = (row: WeekPlannerRow): WeekPlannerRow =>
  applyWeekPlannerShiftMap(
    row,
    WEEK_PLANNER_DAYS.reduce(
      (acc, dayKey) => {
        acc[dayKey] = row.days[dayKey].compareShiftId ?? null;
        return acc;
      },
      {} as WeekShiftMap,
    ),
  );

export const swapCompareWeekIntoRow = (
  row: WeekPlannerRow,
  pairs: WeekPlannerAlternatePair[],
) =>
  applyWeekPlannerShiftMap(
    row,
    WEEK_PLANNER_DAYS.reduce(
      (acc, dayKey) => {
        const compareShiftId = row.days[dayKey].compareShiftId ?? null;
        if (compareShiftId == null) {
          acc[dayKey] = null;
          return acc;
        }
        const matchedPair = pairs.find(
          (pair) =>
            pair.leftShiftId === compareShiftId || pair.rightShiftId === compareShiftId,
        );
        if (!matchedPair) {
          acc[dayKey] = compareShiftId;
          return acc;
        }
        acc[dayKey] =
          matchedPair.leftShiftId === compareShiftId
            ? matchedPair.rightShiftId
            : matchedPair.leftShiftId;
        return acc;
      },
      {} as WeekShiftMap,
    ),
  );

export const clearWeekPlannerRow = (row: WeekPlannerRow): WeekPlannerRow =>
  applyWeekPlannerShiftMap(
    row,
    WEEK_PLANNER_DAYS.reduce(
      (acc, dayKey) => {
        acc[dayKey] = null;
        return acc;
      },
      {} as WeekShiftMap,
    ),
  );

export const computeWeekPlannerCoverage = (
  rows: WeekPlannerRow[],
  shiftsById: Map<number, ShiftLite>,
) => computeCoverageSummary(rows, shiftsById as Map<number, PlannerShiftLike>);

export const getPlannerShiftBucket = (shift: ShiftLite | null | undefined) =>
  getShiftBucket(shift as PlannerShiftLike | null | undefined);

export const shiftColorStyle = (shift: ShiftLite | null | undefined) =>
  shift?.colorHex
    ? {
        borderColor: shift.colorHex,
        color: shift.colorHex,
        backgroundColor: `${shift.colorHex}1A`,
      }
    : undefined;

export const isWeekPlannerDayEditable = (day: WeekPlannerDayDraft) => !day.leave;

export const isWeekPlannerDayUnassigned = (day: WeekPlannerDayDraft) =>
  isWeekPlannerDayEditable(day) && day.shiftId == null;

export const countWeekPlannerUnassignedDays = (rows: WeekPlannerRow[]) =>
  rows.reduce(
    (count, row) =>
      count +
      WEEK_PLANNER_DAYS.reduce(
        (dayCount, dayKey) =>
          dayCount + (isWeekPlannerDayUnassigned(row.days[dayKey]) ? 1 : 0),
        0,
      ),
    0,
  );
