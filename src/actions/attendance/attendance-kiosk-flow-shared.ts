import { createHmac, timingSafeEqual } from "node:crypto";
import { PUNCH_TYPE } from "@prisma/client";
import { db } from "@/lib/db";
import { resolveAttendanceWorkdayForMoment } from "@/lib/attendance";
import { getTimeInRestriction } from "@/lib/attendance-workday";
import { zonedNow } from "@/lib/timezone";
import { getAttendanceFreezeStateForMoment } from "./attendance-shared";

const EMPLOYEE_QR_PREFIX = "JC_ATT_V1";

export type ActiveEmployeeIdentity = {
  userId: string;
  username: string;
  employeeId: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  isDisabled: boolean;
  isArchived: boolean;
};

export type KioskPunchContext = {
  employee: ActiveEmployeeIdentity;
  nextPunch: PUNCH_TYPE;
  now: Date;
  dayStart: Date;
};

export const getExpectedNextPunch = (lastType?: PUNCH_TYPE | null) => {
  const allowedNext: Record<PUNCH_TYPE | "NONE", PUNCH_TYPE> = {
    NONE: PUNCH_TYPE.TIME_IN,
    TIME_OUT: PUNCH_TYPE.TIME_IN,
    TIME_IN: PUNCH_TYPE.BREAK_IN,
    BREAK_IN: PUNCH_TYPE.BREAK_OUT,
    BREAK_OUT: PUNCH_TYPE.TIME_OUT,
  };
  return allowedNext[lastType ?? "NONE"];
};

const getEmployeeQrSecret = () => {
  const secret = process.env.SESSION_PASSWORD?.trim();
  if (!secret) {
    throw new Error("SESSION_PASSWORD is required for employee attendance QR.");
  }
  return secret;
};

const signEmployeeQrPayload = (payload: string) =>
  createHmac("sha256", getEmployeeQrSecret()).update(payload).digest("base64url");

export const encodeEmployeeQrToken = (payload: object) => {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = signEmployeeQrPayload(encodedPayload);
  return `${EMPLOYEE_QR_PREFIX}.${encodedPayload}.${signature}`;
};

export const decodeEmployeeQrToken = (
  token: string,
): { userId: string; employeeId: string; exp: number } | null => {
  const trimmed = typeof token === "string" ? token.trim() : "";
  const [prefix, encodedPayload, signature] = trimmed.split(".");
  if (prefix !== EMPLOYEE_QR_PREFIX || !encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = signEmployeeQrPayload(encodedPayload);
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as {
      userId?: string;
      employeeId?: string;
      exp?: number;
    };

    if (
      typeof parsed.userId !== "string" ||
      typeof parsed.employeeId !== "string" ||
      typeof parsed.exp !== "number"
    ) {
      return null;
    }

    return {
      userId: parsed.userId,
      employeeId: parsed.employeeId,
      exp: parsed.exp,
    };
  } catch {
    return null;
  }
};

export const loadActiveEmployeeIdentityByUserId = async (userId: string) => {
  return db.user.findUnique({
    where: { userId },
    select: {
      userId: true,
      username: true,
      isDisabled: true,
      employee: {
        select: {
          employeeId: true,
          employeeCode: true,
          firstName: true,
          lastName: true,
          isArchived: true,
        },
      },
    },
  });
};

export const loadActiveEmployeeIdentityByEmployeeId = async (employeeId: string) => {
  return db.employee.findUnique({
    where: { employeeId },
    select: {
      employeeId: true,
      employeeCode: true,
      firstName: true,
      lastName: true,
      isArchived: true,
      user: {
        select: {
          userId: true,
          username: true,
          isDisabled: true,
        },
      },
    },
  });
};

export const toActiveEmployeeIdentity = (
  row:
    | Awaited<ReturnType<typeof loadActiveEmployeeIdentityByUserId>>
    | Awaited<ReturnType<typeof loadActiveEmployeeIdentityByEmployeeId>>,
): ActiveEmployeeIdentity | null => {
  if (!row) return null;

  if ("employee" in row) {
    if (!row.employee) return null;
    return {
      userId: row.userId,
      username: row.username,
      employeeId: row.employee.employeeId,
      employeeCode: row.employee.employeeCode,
      firstName: row.employee.firstName,
      lastName: row.employee.lastName,
      isDisabled: row.isDisabled,
      isArchived: row.employee.isArchived,
    };
  }

  if (!row.user) return null;
  return {
    userId: row.user.userId,
    username: row.user.username,
    employeeId: row.employeeId,
    employeeCode: row.employeeCode,
    firstName: row.firstName,
    lastName: row.lastName,
    isDisabled: row.user.isDisabled,
    isArchived: row.isArchived,
  };
};

export const ensureEmployeeQrIdentity = async (token: string) => {
  const decoded = decodeEmployeeQrToken(token);
  if (!decoded) {
    return { success: false as const, error: "Invalid employee QR.", reason: "invalid_qr" };
  }
  if (Date.now() > decoded.exp) {
    return { success: false as const, error: "Employee QR expired.", reason: "qr_expired" };
  }

  const identity = toActiveEmployeeIdentity(
    await loadActiveEmployeeIdentityByUserId(decoded.userId),
  );
  if (
    !identity ||
    identity.employeeId !== decoded.employeeId ||
    identity.isDisabled ||
    identity.isArchived
  ) {
    return {
      success: false as const,
      error: "Employee is not eligible for QR attendance.",
      reason: "user_not_eligible",
    };
  }

  return { success: true as const, data: identity, expiresAt: decoded.exp };
};

export const prepareKioskPunchContext = async (
  employee: ActiveEmployeeIdentity,
): Promise<
  | { success: true; data: KioskPunchContext }
  | { success: false; error: string; reason: string }
> => {
  const now = zonedNow();
  const workday = await resolveAttendanceWorkdayForMoment(
    employee.employeeId,
    now,
  );
  const dayState = await getAttendanceFreezeStateForMoment(
    employee.employeeId,
    now,
    workday.dayStart,
  );

  if (dayState?.payrollPeriodId) {
    return {
      success: false,
      error:
        "Attendance is already linked to payroll for today. Contact payroll admin for adjustment.",
      reason: "payroll_linked",
    };
  }
  if (dayState?.isLocked) {
    return {
      success: false,
      error: "Attendance is locked for today. Contact admin to unlock.",
      reason: "attendance_locked",
    };
  }

  const workdayPunches = await db.punch.findMany({
    where: {
      employeeId: employee.employeeId,
      punchTime: {
        gte: workday.punchWindowStart,
        lt: workday.punchWindowEnd,
      },
    },
    orderBy: { punchTime: "asc" },
  });
  const lastPunch = workdayPunches[workdayPunches.length - 1] ?? null;
  if (lastPunch?.punchType === PUNCH_TYPE.TIME_OUT) {
    return {
      success: false,
      error: "Already clocked out today",
      reason: "already_clocked_out",
    };
  }

  const nextPunch = getExpectedNextPunch(lastPunch?.punchType ?? null);
  if (nextPunch === PUNCH_TYPE.TIME_IN) {
    const restriction = getTimeInRestriction(workday, now);
    if (restriction === "no_shift_today") {
      return {
        success: false,
        error: "No scheduled shift for today",
        reason: "no_shift_today",
      };
    }
    if (restriction === "too_early") {
      return {
        success: false,
        error: "Too early to clock in. Wait for scheduled start time.",
        reason: "too_early",
      };
    }
    if (restriction === "too_late") {
      return {
        success: false,
        error: "Cannot clock in after scheduled end time.",
        reason: "too_late",
      };
    }
  }

  return {
    success: true,
    data: {
      employee,
      nextPunch,
      now,
      dayStart: workday.dayStart,
    },
  };
};

export const buildPunchSuccessPayload = (
  context: KioskPunchContext,
  punch: { punchTime: Date; punchType: string },
) => ({
  username: context.employee.username,
  employeeId: context.employee.employeeId,
  employeeName:
    `${context.employee.firstName} ${context.employee.lastName}`.trim(),
  employeeCode: context.employee.employeeCode,
  punchType: punch.punchType,
  punchTime: punch.punchTime.toISOString(),
});
