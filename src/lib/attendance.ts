import {
  ATTENDANCE_STATUS,
  CURRENT_STATUS,
  LeaveRequestStatus,
  LeaveRequestType,
  PUNCH_TYPE,
  Shift,
} from "@prisma/client";
import { db } from "./db";
import {
  ATTENDANCE_SHIFT_END_GRACE_MINUTES,
  buildAttendanceWorkdayWindow,
  isActiveOvernightCarryover,
  type AttendanceWorkdayWindow,
} from "./attendance-workday";
import { startOfZonedDay, endOfZonedDay, TZ } from "./timezone";
import { normalizeWeekStart } from "./week-planner";

export type ExpectedShift = {
  shift: Shift | null;
  scheduledStartMinutes: number | null;
  scheduledEndMinutes: number | null;
  source: "override" | "weekly_schedule" | "none";
};

type DayKey = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";
const DEFAULT_LATE_GRACE_MINUTES = 0;
const DAY_MS = 24 * 60 * 60 * 1000;

const parseNonNegativeMinutes = (
  value: string | undefined,
  fallback: number,
) => {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.max(0, parsed);
};

// Configurable grace before an employee is marked late.
// Example: ATTENDANCE_LATE_GRACE_MINUTES=10 means first 10 minutes are not late.
export const LATE_GRACE_MINUTES = parseNonNegativeMinutes(
  process.env.ATTENDANCE_LATE_GRACE_MINUTES,
  DEFAULT_LATE_GRACE_MINUTES,
);

const leaveTypeToCurrentStatus = (
  leaveType: LeaveRequestType,
): CURRENT_STATUS => {
  switch (leaveType) {
    case LeaveRequestType.VACATION:
      return CURRENT_STATUS.VACATION;
    case LeaveRequestType.SICK:
      return CURRENT_STATUS.SICK_LEAVE;
    case LeaveRequestType.SIL:
    case LeaveRequestType.PERSONAL:
    case LeaveRequestType.EMERGENCY:
    case LeaveRequestType.UNPAID:
    default:
      return CURRENT_STATUS.ON_LEAVE;
  }
};

const syncEmployeeCurrentStatusFromApprovedLeave = async (
  employeeId: string,
  referenceDate = new Date(),
) => {
  const employee = await db.employee.findUnique({
    where: { employeeId },
    select: {
      currentStatus: true,
    },
  });

  if (!employee) return;
  if (
    employee.currentStatus === CURRENT_STATUS.INACTIVE ||
    employee.currentStatus === CURRENT_STATUS.ENDED
  ) {
    return;
  }

  const dayStart = startOfZonedDay(referenceDate);
  const dayEnd = new Date(dayStart.getTime() + DAY_MS);

  const activeLeave = await db.leaveRequest.findFirst({
    where: {
      employeeId,
      status: LeaveRequestStatus.APPROVED,
      startDate: {
        lt: dayEnd,
      },
      endDate: {
        gte: dayStart,
      },
    },
    orderBy: [{ startDate: "desc" }, { createdAt: "desc" }],
    select: {
      leaveType: true,
    },
  });

  const nextStatus = activeLeave
    ? leaveTypeToCurrentStatus(activeLeave.leaveType)
    : CURRENT_STATUS.ACTIVE;

  if (employee.currentStatus !== nextStatus) {
    await db.employee.update({
      where: { employeeId },
      data: {
        currentStatus: nextStatus,
      },
    });
  }
};

const minutesBetween = (a: Date, b: Date) =>
  Math.round((b.getTime() - a.getTime()) / 60000);

// Converts Decimal/number-like values into a finite number.
const toFiniteNumber = (value: unknown): number | null => {
  if (value == null) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "object") {
    const withToString = value as { toString?: () => string };
    if (typeof withToString.toString === "function") {
      const parsed = Number.parseFloat(withToString.toString());
      return Number.isFinite(parsed) ? parsed : null;
    }
  }
  return null;
};

type ScheduledPaidMinutesInput = {
  paidHoursPerDay: unknown;
  scheduledStartMinutes: number | null | undefined;
  scheduledEndMinutes: number | null | undefined;
  scheduledBreakMinutes: number | null | undefined;
};

// Returns target paid minutes for payroll comparisons.
// Priority:
// 1) Shift paidHoursPerDay (explicit payroll target)
// 2) Scheduled span minus scheduled unpaid break (fallback)
export const computeScheduledPaidMinutes = ({
  paidHoursPerDay,
  scheduledStartMinutes,
  scheduledEndMinutes,
  scheduledBreakMinutes,
}: ScheduledPaidMinutesInput): number | null => {
  const paidHours = toFiniteNumber(paidHoursPerDay);
  if (paidHours != null && paidHours > 0) {
    return Math.max(0, Math.round(paidHours * 60));
  }

  if (
    typeof scheduledStartMinutes !== "number" ||
    typeof scheduledEndMinutes !== "number"
  ) {
    return null;
  }

  let scheduledSpanMinutes = scheduledEndMinutes - scheduledStartMinutes;
  if (scheduledSpanMinutes < 0) {
    scheduledSpanMinutes += 24 * 60;
  }

  const scheduledBreak =
    typeof scheduledBreakMinutes === "number" &&
    Number.isFinite(scheduledBreakMinutes)
      ? Math.max(0, Math.round(scheduledBreakMinutes))
      : 0;

  return Math.max(0, scheduledSpanMinutes - scheduledBreak);
};

type PayrollVarianceInput = {
  netWorkedMinutes: number | null | undefined;
  scheduledPaidMinutes: number | null | undefined;
  lateGraceCreditMinutes?: number | null | undefined;
};

// Payroll-accurate variance:
// - overtime is minutes above paid target
// - undertime is minutes below paid target
export const computePayrollVariance = ({
  netWorkedMinutes,
  scheduledPaidMinutes,
  lateGraceCreditMinutes,
}: PayrollVarianceInput) => {
  if (
    typeof netWorkedMinutes !== "number" ||
    !Number.isFinite(netWorkedMinutes) ||
    typeof scheduledPaidMinutes !== "number" ||
    !Number.isFinite(scheduledPaidMinutes)
  ) {
    return { undertimeMinutes: 0, overtimeMinutesRaw: 0 };
  }

  const net = Math.max(0, Math.round(netWorkedMinutes));
  const target = Math.max(0, Math.round(scheduledPaidMinutes));
  const credit =
    typeof lateGraceCreditMinutes === "number" &&
    Number.isFinite(lateGraceCreditMinutes)
      ? Math.max(0, Math.round(lateGraceCreditMinutes))
      : 0;
  const adjustedNetForUndertime = Math.min(target, net + credit);

  return {
    // Grace credit can only reduce undertime, never create overtime.
    undertimeMinutes: Math.max(0, target - adjustedNetForUndertime),
    overtimeMinutesRaw: Math.max(0, net - target),
  };
};

type MinuteRateInput = {
  dailyRate: unknown;
  scheduledPaidMinutes: number | null | undefined;
};

// Per-minute payroll rate from daily base pay.
// Formula: dailyRate / scheduledPaidMinutes
export const computeRatePerMinute = ({
  dailyRate,
  scheduledPaidMinutes,
}: MinuteRateInput): number | null => {
  const normalizedDailyRate = toFiniteNumber(dailyRate);
  if (
    normalizedDailyRate == null ||
    normalizedDailyRate < 0 ||
    typeof scheduledPaidMinutes !== "number" ||
    !Number.isFinite(scheduledPaidMinutes) ||
    scheduledPaidMinutes <= 0
  ) {
    return null;
  }

  return normalizedDailyRate / scheduledPaidMinutes;
};

type PayableAmountInput = {
  netWorkedMinutes: number | null | undefined;
  ratePerMinute: number | null | undefined;
};

// Pro-rated payable amount from net payable minutes.
// Formula: netWorkedMinutes * ratePerMinute
export const computePayableAmountFromNetMinutes = ({
  netWorkedMinutes,
  ratePerMinute,
}: PayableAmountInput): number | null => {
  if (
    typeof netWorkedMinutes !== "number" ||
    !Number.isFinite(netWorkedMinutes) ||
    typeof ratePerMinute !== "number" ||
    !Number.isFinite(ratePerMinute)
  ) {
    return null;
  }

  const gross = Math.max(0, netWorkedMinutes) * Math.max(0, ratePerMinute);
  return Math.round(gross * 100) / 100;
};

export const computeLateMinutes = (
  scheduledStartMinutes: number | null | undefined,
  actualInMinutes: number | null | undefined,
) => {
  if (scheduledStartMinutes == null || actualInMinutes == null) return null;
  const lateStartMinute = scheduledStartMinutes + LATE_GRACE_MINUTES;
  return Math.max(0, actualInMinutes - lateStartMinute);
};

export const computeLateGraceCreditMinutes = ({
  scheduledStartMinutes,
  actualInMinutes,
  lateGraceMinutes = LATE_GRACE_MINUTES,
}: {
  scheduledStartMinutes: number | null | undefined;
  actualInMinutes: number | null | undefined;
  lateGraceMinutes?: number | null | undefined;
}) => {
  if (scheduledStartMinutes == null || actualInMinutes == null) return 0;
  const rawLateMinutes = Math.max(0, actualInMinutes - scheduledStartMinutes);
  if (rawLateMinutes <= 0) return 0;
  const grace =
    typeof lateGraceMinutes === "number" && Number.isFinite(lateGraceMinutes)
      ? Math.max(0, Math.round(lateGraceMinutes))
      : 0;
  if (grace <= 0) return 0;
  return Math.min(rawLateMinutes, grace);
};

type BreakDeductionInput = {
  workedMinutes: number | null | undefined;
  actualBreakMinutes: number | null | undefined;
  scheduledBreakMinutes: number | null | undefined;
  breakStartMinutes: number | null | undefined;
  breakEndMinutes: number | null | undefined;
  actualInMinutes: number | null | undefined;
  actualOutMinutes: number | null | undefined;
};

// Computes policy break deduction and net work minutes.
// Rule:
// - If a configured break window is fully covered by the worked span, enforce at least scheduled break.
// - Otherwise, only deduct actual recorded break punches.
export const computeBreakDeduction = ({
  workedMinutes,
  actualBreakMinutes,
  scheduledBreakMinutes,
  breakStartMinutes,
  breakEndMinutes,
  actualInMinutes,
  actualOutMinutes,
}: BreakDeductionInput) => {
  if (workedMinutes == null) {
    // Incomplete shift: net time cannot be computed yet.
    return {
      deductedBreakMinutes: 0,
      netWorkedMinutes: null,
      fixedBreakApplied: false,
    };
  }

  let grossWorkedMinutes = Math.round(workedMinutes); // Gross = clock-out minus clock-in.
  if (grossWorkedMinutes < 0) grossWorkedMinutes = 0;

  let actualBreak = 0;
  if (
    typeof actualBreakMinutes === "number" &&
    Number.isFinite(actualBreakMinutes)
  ) {
    // Normalize punch derived break.
    actualBreak = Math.round(actualBreakMinutes);
    if (actualBreak < 0) actualBreak = 0;
  }

  let scheduledBreak = 0;
  if (
    typeof scheduledBreakMinutes === "number" &&
    Number.isFinite(scheduledBreakMinutes)
  ) {
    // Normalize shift-configured break minutes.
    scheduledBreak = Math.round(scheduledBreakMinutes);
    if (scheduledBreak < 0) scheduledBreak = 0;
  }

  if (scheduledBreak === 0) {
    // No shift break policy: deduct only actual break punches.
    let netWorkedMinutes = grossWorkedMinutes - actualBreak;
    if (netWorkedMinutes < 0) netWorkedMinutes = 0;
    return {
      deductedBreakMinutes: actualBreak,
      netWorkedMinutes,
      fixedBreakApplied: false,
    };
  }

  let fixedBreakApplied = false;
  const hasBreakWindow = // Shift has explicit break window and we have in/out times to compare.
    typeof breakStartMinutes === "number" &&
    typeof breakEndMinutes === "number" &&
    typeof actualInMinutes === "number" &&
    typeof actualOutMinutes === "number";

  if (hasBreakWindow) {
    const inMinutes = actualInMinutes;
    let outMinutes = actualOutMinutes;
    let breakStart = breakStartMinutes;
    let breakEnd = breakEndMinutes;

    if (outMinutes < inMinutes) outMinutes += 24 * 60; // Handle overnight worked span.
    if (breakEnd < breakStart) breakEnd += 24 * 60; // Handle overnight break window.

    while (breakStart > outMinutes) {
      // Shift break window backward until it can intersect work span.
      breakStart -= 24 * 60;
      breakEnd -= 24 * 60;
    }
    while (breakEnd < inMinutes) {
      // Shift break window forward until it can intersect work span.
      breakStart += 24 * 60;
      breakEnd += 24 * 60;
    }

    fixedBreakApplied = inMinutes <= breakStart && outMinutes >= breakEnd; // Worked span fully covers break window.
  } else {
    // Fallback when break window is not configured.
    if (grossWorkedMinutes > scheduledBreak) {
      fixedBreakApplied = true;
    }
  }

  let deductedBreakMinutes = actualBreak; // Default deduction is actual break only.
  if (fixedBreakApplied) {
    deductedBreakMinutes = Math.max(scheduledBreak, actualBreak); // Enforce minimum scheduled deduction.
  }

  let netWorkedMinutes = grossWorkedMinutes - deductedBreakMinutes; // Net payable minutes.
  if (netWorkedMinutes < 0) netWorkedMinutes = 0;

  return { deductedBreakMinutes, netWorkedMinutes, fixedBreakApplied };
};

const dayKey = (date: Date): DayKey => {
  const dayStr = date
    .toLocaleDateString("en-US", { weekday: "short", timeZone: TZ })
    .toLowerCase();
  switch (dayStr.slice(0, 3)) {
    case "sun":
      return "sun";
    case "mon":
      return "mon";
    case "tue":
      return "tue";
    case "wed":
      return "wed";
    case "thu":
      return "thu";
    case "fri":
      return "fri";
    case "sat":
      return "sat";
    default:
      return "sun";
  }
};

export async function getExpectedShiftForDate(
  employeeId: string,
  workDate: Date,
): Promise<ExpectedShift> {
  const dayStart = startOfZonedDay(workDate);
  const dayEnd = endOfZonedDay(workDate);

  const override = await db.employeeShiftOverride.findFirst({
    where: { employeeId, workDate: { gte: dayStart, lt: dayEnd } },
    include: { shift: true },
  });
  if (override) {
    const shift = override.shift;
    return {
      shift,
      scheduledStartMinutes: shift?.startMinutes ?? null,
      scheduledEndMinutes: shift?.endMinutes ?? null,
      source: "override",
    };
  }

  const weeklySchedule = await db.weeklySchedule.findUnique({
    where: {
      employeeId_weekStart: {
        employeeId,
        weekStart: normalizeWeekStart(dayStart),
      },
    },
  });

  if (!weeklySchedule) {
    return {
      shift: null,
      scheduledStartMinutes: null,
      scheduledEndMinutes: null,
      source: "none",
    };
  }

  const key = dayKey(dayStart);
  const shiftId =
    key === "sun"
      ? weeklySchedule.sunShiftId
      : key === "mon"
        ? weeklySchedule.monShiftId
        : key === "tue"
          ? weeklySchedule.tueShiftId
          : key === "wed"
            ? weeklySchedule.wedShiftId
            : key === "thu"
              ? weeklySchedule.thuShiftId
              : key === "fri"
                ? weeklySchedule.friShiftId
                : weeklySchedule.satShiftId;

  if (!shiftId) {
    return {
      shift: null,
      scheduledStartMinutes: null,
      scheduledEndMinutes: null,
      source: "none",
    };
  }

  const shift = await db.shift.findUnique({ where: { id: shiftId } });
  if (!shift) {
    return {
      shift: null,
      scheduledStartMinutes: null,
      scheduledEndMinutes: null,
      source: "none",
    };
  }

  return {
    shift,
    scheduledStartMinutes: shift.isDayOff ? null : shift.startMinutes,
    scheduledEndMinutes: shift.isDayOff ? null : shift.endMinutes,
    source: "weekly_schedule",
  };
}

export type ResolvedAttendanceWorkday = AttendanceWorkdayWindow & {
  expected: ExpectedShift;
};

export const buildExpectedShiftWorkday = (
  dayStart: Date,
  expected: ExpectedShift,
): ResolvedAttendanceWorkday => {
  const window = buildAttendanceWorkdayWindow(dayStart, {
    startMinutes: expected.scheduledStartMinutes,
    endMinutes: expected.scheduledEndMinutes,
    spansMidnight: Boolean(expected.shift?.spansMidnight),
  });
  return { ...window, expected };
};

export async function resolveAttendanceWorkdayForMoment(
  employeeId: string,
  moment: Date,
): Promise<ResolvedAttendanceWorkday> {
  const currentDayStart = startOfZonedDay(moment);
  const previousDayStart = new Date(currentDayStart.getTime() - DAY_MS);
  const previousExpected = await getExpectedShiftForDate(
    employeeId,
    previousDayStart,
  );
  const previousWorkday = buildExpectedShiftWorkday(
    previousDayStart,
    previousExpected,
  );
  if (isActiveOvernightCarryover(previousWorkday, moment)) {
    return previousWorkday;
  }

  const currentExpected = await getExpectedShiftForDate(
    employeeId,
    currentDayStart,
  );
  return buildExpectedShiftWorkday(currentDayStart, currentExpected);
}

export async function recomputeAttendanceForDay(
  employeeId: string,
  workDate: Date,
) {
  const dayStart = startOfZonedDay(workDate);
  const now = new Date();
  const nowMinutes = minutesBetween(dayStart, now);

  const expected = await getExpectedShiftForDate(employeeId, dayStart);
  const workday = buildExpectedShiftWorkday(dayStart, expected);

  let punches = await db.punch.findMany({
    where: {
      employeeId,
      punchTime: {
        gte: workday.punchWindowStart,
        lt: workday.punchWindowEnd,
      },
    },
    orderBy: { punchTime: "asc" },
  });

  const expectedWorkShift =
    expected.shift && !expected.shift.isDayOff ? expected.shift : null;
  const paidHoursPerDay = expectedWorkShift?.paidHoursPerDay ?? null;
  const approvedLeave = await db.leaveRequest.findFirst({
    where: {
      employeeId,
      status: LeaveRequestStatus.APPROVED,
      startDate: { lte: dayStart },
      endDate: { gte: dayStart },
    },
    orderBy: { submittedAt: "desc" },
    select: { id: true },
  });

  let firstClockIn =
    punches.find((p) => p.punchType === PUNCH_TYPE.TIME_IN) ?? null;
  let lastClockOut =
    [...punches].reverse().find((p) => p.punchType === PUNCH_TYPE.TIME_OUT) ??
    null;

  //!AUTO TIMEOUT LOGIC
  // Auto timeout rule: after scheduled end + 60 minutes, and create AUTO TIME OUT.
  // This keeps attendance from staying INCOMPLETE forever when someone forgets to clock out.
  const autoTimeoutCutoffMinutes =
    workday.normalizedEndMinutes != null
      ? Math.max(
          0,
          workday.normalizedEndMinutes + ATTENDANCE_SHIFT_END_GRACE_MINUTES,
        )
      : null;
  const shouldAutoTimeout =
    workday.normalizedEndMinutes != null &&
    firstClockIn != null &&
    !lastClockOut &&
    autoTimeoutCutoffMinutes != null &&
    nowMinutes >= autoTimeoutCutoffMinutes;

  if (shouldAutoTimeout && workday.normalizedEndMinutes != null) {
    const autoTimeoutAt = new Date(
      dayStart.getTime() + workday.normalizedEndMinutes * 60 * 1000,
    );
    const hasTimeoutAtScheduledEnd = punches.some(
      (p) =>
        p.punchType === PUNCH_TYPE.TIME_OUT &&
        p.punchTime.getTime() === autoTimeoutAt.getTime(),
    );

    if (!hasTimeoutAtScheduledEnd) {
      await db.punch.create({
        data: {
          employeeId,
          punchType: PUNCH_TYPE.TIME_OUT,
          punchTime: autoTimeoutAt,
          source: "AUTO_TIMEOUT",
        },
      });
    }

    punches = await db.punch.findMany({
      where: {
        employeeId,
        punchTime: {
          gte: workday.punchWindowStart,
          lt: workday.punchWindowEnd,
        },
      },
      orderBy: { punchTime: "asc" },
    });
    firstClockIn =
      punches.find((p) => p.punchType === PUNCH_TYPE.TIME_IN) ?? null;
    lastClockOut =
      [...punches].reverse().find((p) => p.punchType === PUNCH_TYPE.TIME_OUT) ??
      null;
  }

  //! BREAK LOGIC - pairs break start and break end then it
  // computes the duration of the break.
  let breakCount = 0;
  let breakMinutes = 0;
  let breakStart: Date | null = null;
  punches.forEach((p) => {
    if (
      p.punchType === PUNCH_TYPE.BREAK_IN ||
      p.punchType === PUNCH_TYPE.BREAK_OUT
    ) {
      if (!breakStart) {
        breakStart = p.punchTime;
      } else {
        breakCount += 1;
        breakMinutes += Math.max(0, minutesBetween(breakStart, p.punchTime));
        breakStart = null;
      }
    }
  });

  // Lock and mark incomplete once we're 5 minutes after scheduled end (clamped to 0).
  const cutoffMinutes =
    workday.normalizedEndMinutes != null
      ? Math.max(0, workday.normalizedEndMinutes + 5)
      : null;
  const cutoffPassed =
    cutoffMinutes != null ? nowMinutes >= cutoffMinutes : false;

  const actualInAt = firstClockIn?.punchTime ?? punches[0]?.punchTime ?? null;
  const actualOutAt = lastClockOut?.punchTime ?? null;
  const actualInMinutes = actualInAt
    ? minutesBetween(dayStart, actualInAt)
    : null;
  const actualOutMinutes = actualOutAt
    ? minutesBetween(dayStart, actualOutAt)
    : null;

  const workedMinutes =
    actualInAt && actualOutAt
      ? Math.max(0, minutesBetween(actualInAt, actualOutAt))
      : null;
  const scheduledBreakMinutes = Math.max(
    0,
    expectedWorkShift?.breakMinutesUnpaid ?? 0,
  );
  const { deductedBreakMinutes, netWorkedMinutes } = computeBreakDeduction({
    workedMinutes,
    actualBreakMinutes: breakMinutes,
    scheduledBreakMinutes,
    breakStartMinutes: expectedWorkShift?.breakStartMinutes ?? null,
    breakEndMinutes: expectedWorkShift?.breakEndMinutes ?? null,
    actualInMinutes,
    actualOutMinutes,
  });
  const scheduledPaidMinutes = computeScheduledPaidMinutes({
    paidHoursPerDay,
    scheduledStartMinutes: expected.scheduledStartMinutes,
    scheduledEndMinutes: expected.scheduledEndMinutes,
    scheduledBreakMinutes,
  });
  const lateGraceCreditMinutes = computeLateGraceCreditMinutes({
    scheduledStartMinutes: expected.scheduledStartMinutes,
    actualInMinutes,
  });
  const { undertimeMinutes, overtimeMinutesRaw } = computePayrollVariance({
    netWorkedMinutes,
    scheduledPaidMinutes,
    lateGraceCreditMinutes,
  });

  const lateMinutes =
    computeLateMinutes(expected.scheduledStartMinutes, actualInMinutes) ?? 0;
  // ATTENDANCE - Rest Day / Day Off Logic
  // If no schedule exists for the day, treat it as REST by default.
  let status: ATTENDANCE_STATUS = expectedWorkShift
    ? ATTENDANCE_STATUS.ABSENT
    : ATTENDANCE_STATUS.REST;
  if (approvedLeave && !actualInAt && !actualOutAt) {
    status = ATTENDANCE_STATUS.LEAVE;
  } else if (actualInAt || actualOutAt) {
    if (!actualOutAt && cutoffPassed) {
      status = ATTENDANCE_STATUS.INCOMPLETE;
    } else {
      status =
        lateMinutes > 0 ? ATTENDANCE_STATUS.LATE : ATTENDANCE_STATUS.PRESENT;
    }
  }

  // Locking is manual now; recompute must not auto-lock by elapsed time.
  // Preserve current lock state for existing rows.
  const existingAttendance = await db.attendance.findUnique({
    where: {
      employeeId_workDate: {
        employeeId,
        workDate: dayStart,
      },
    },
    select: {
      isLocked: true,
      isPaidLeave: true,
      leaveRequestId: true,
    },
  });
  const shouldLock = existingAttendance?.isLocked ?? false;
  const leaveRequestId =
    status === ATTENDANCE_STATUS.LEAVE
      ? approvedLeave?.id ?? existingAttendance?.leaveRequestId ?? null
      : null;
  const isPaidLeave =
    status === ATTENDANCE_STATUS.LEAVE
      ? existingAttendance?.isPaidLeave ?? false
      : false;

  const attendance = await db.attendance.upsert({
    where: { employeeId_workDate: { employeeId, workDate: dayStart } },
    update: {
      status,
      isPaidLeave,
      leaveRequestId,
      expectedShiftId: expected.shift?.id ?? null,
      scheduledStartMinutes: expected.scheduledStartMinutes,
      scheduledEndMinutes: expected.scheduledEndMinutes,
      paidHoursPerDay,
      actualInAt,
      actualOutAt,
      workedMinutes,
      breakMinutes,
      deductedBreakMinutes,
      netWorkedMinutes,
      breakCount,
      lateMinutes,
      undertimeMinutes,
      overtimeMinutesRaw,
      isLocked: shouldLock,
    },
    create: {
      employeeId,
      workDate: dayStart,
      status,
      isPaidLeave,
      leaveRequestId,
      expectedShiftId: expected.shift?.id ?? null,
      scheduledStartMinutes: expected.scheduledStartMinutes,
      scheduledEndMinutes: expected.scheduledEndMinutes,
      paidHoursPerDay,
      actualInAt,
      actualOutAt,
      workedMinutes,
      breakMinutes,
      deductedBreakMinutes,
      netWorkedMinutes,
      breakCount,
      lateMinutes,
      undertimeMinutes,
      overtimeMinutesRaw,
      isLocked: shouldLock,
    },
  });

  // Link punches to the attendance record for traceability
  if (attendance?.id) {
    await db.punch.updateMany({
      where: {
        employeeId,
        punchTime: {
          gte: workday.punchWindowStart,
          lt: workday.punchWindowEnd,
        },
      },
      data: { attendanceId: attendance.id },
    });
  }

  await syncEmployeeCurrentStatusFromApprovedLeave(employeeId, now);

  return { attendance, punches };
}

export async function createPunchAndMaybeRecompute(options: {
  employeeId: string;
  punchType: PUNCH_TYPE;
  punchTime: Date;
  workDate?: Date;
  source?: string | null;
  recompute?: boolean;
}) {
  const { employeeId, punchType, punchTime, workDate, source, recompute } =
    options;
  const punch = await db.punch.create({
    data: {
      employeeId,
      punchType,
      punchTime,
      source: source ?? "WEB",
    },
  });

  let attendance = null;
  if (recompute) {
    const workday = workDate
      ? { dayStart: startOfZonedDay(workDate) }
      : await resolveAttendanceWorkdayForMoment(employeeId, punchTime);
    const { attendance: updated } = await recomputeAttendanceForDay(
      employeeId,
      workday.dayStart,
    );
    attendance = updated;
  }

  return { punch, attendance };
}
