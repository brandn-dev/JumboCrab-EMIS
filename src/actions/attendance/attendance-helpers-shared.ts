import { db } from "@/lib/db";
import {
  buildCompensationLookupKey,
  resolveEmployeeCompensationSnapshots,
} from "@/lib/payroll/compensation";
import { endOfZonedDay, startOfZonedDay, TZ } from "@/lib/timezone";

export const toNumberOrNull = (value: unknown) => {
  if (value === null || typeof value === "undefined") return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof (value as { toString?: () => string })?.toString === "function") {
    const parsed = Number.parseFloat(
      (value as { toString: () => string }).toString(),
    );
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

export const buildRateLookupKey = buildCompensationLookupKey;

export const DAY_MS = 24 * 60 * 60 * 1000;

export const toDayKey = (date: Date) =>
  date.toLocaleDateString("en-CA", { timeZone: TZ });

export const buildEmployeeDayKey = (employeeId: string, date: Date) =>
  `${employeeId}::${toDayKey(date)}`;

export const resolveEffectiveDailyRates = async ({
  employeeDates,
}: {
  employeeDates: Map<string, Date[]>;
}) => {
  const compensationSnapshots = await resolveEmployeeCompensationSnapshots({
    employeeDates,
  });
  const resolved = new Map<string, number | null>();
  compensationSnapshots.forEach((snapshot, key) => {
    resolved.set(key, snapshot?.dailyRate ?? null);
  });

  return resolved;
};

const isIpAllowed = (ip: string | null, raw: string | undefined) => {
  if (!raw) return true;
  const list = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!list.length) return true;
  return Boolean(ip && list.includes(ip));
};

export const isSelfPunchIpAllowed = (ip: string | null) =>
  isIpAllowed(ip, process.env.ALLOWED_SELF_PUNCH_IPS);

export const parseDateInput = (value: string) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

export const getRangeBounds = (start: Date, end?: Date) => {
  const rangeStart = startOfZonedDay(start);
  const rangeEnd = end ? endOfZonedDay(end) : endOfZonedDay(start);
  return { rangeStart, rangeEnd };
};

export type AttendanceFreezeState = {
  isLocked: boolean;
  payrollPeriodId: string | null;
};

export const getAttendanceFreezeStateForMoment = async (
  employeeId: string,
  punchTime: Date,
  workDate: Date = punchTime,
) => {
  const dayStart = startOfZonedDay(workDate);
  const dayEnd = endOfZonedDay(workDate);
  const attendance = await db.attendance.findFirst({
    where: {
      employeeId,
      workDate: { gte: dayStart, lt: dayEnd },
    },
    select: {
      isLocked: true,
      payrollPeriodId: true,
    },
  });
  if (!attendance) return null;
  return {
    isLocked: Boolean(attendance.isLocked),
    payrollPeriodId: attendance.payrollPeriodId ?? null,
  } satisfies AttendanceFreezeState;
};

export const getAttendanceFreezeError = (
  state: AttendanceFreezeState | null,
  lockedMessage: string,
) => {
  if (!state) return null;
  if (state.payrollPeriodId) {
    return "Attendance is already linked to payroll. Use payroll adjustments instead of editing punches.";
  }
  if (state.isLocked) {
    return lockedMessage;
  }
  return null;
};
