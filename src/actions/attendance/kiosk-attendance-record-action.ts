"use server";

import { timingSafeEqual } from "node:crypto";
import { PUNCH_TYPE } from "@prisma/client";
import { db } from "@/lib/db";
import { consumeKioskQrScanAck, storeKioskQrScanAck } from "@/lib/kiosk-qr-ack";
import { verifyPassword } from "@/lib/auth";
import {
  buildExpectedShiftWorkday,
  createPunchAndMaybeRecompute,
  getExpectedShiftForDate,
  resolveAttendanceWorkdayForMoment,
} from "@/lib/attendance";
import { getTimeInRestriction } from "@/lib/attendance-workday";
import { publishAttendanceUpdate } from "@/lib/attendance-live/service";
import { startOfZonedDay, zonedNow } from "@/lib/timezone";
import {
  isKioskPunchIpAllowed,
  serializeKioskPunch,
} from "./kiosk-attendance-shared";
import { captureAttendanceSecurityEvent } from "./attendance-security-service";
import { resolveAttendanceRequestMetadata } from "./attendance-security-shared";

const matchesConfiguredSecret = (
  providedSecret: string,
  expectedSecret: string | undefined,
) => {
  if (!expectedSecret || !providedSecret) {
    return false;
  }

  const providedBuffer = Buffer.from(providedSecret);
  const expectedBuffer = Buffer.from(expectedSecret);

  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
};

const matchesKioskFallbackPassword = (password: string) =>
  matchesConfiguredSecret(
    password,
    process.env.KIOSK_FALLBACK_PASSWORD?.trim(),
  );

export async function recordKioskPunch(input: {
  username: string;
  password: string;
  punchType: string;
  date?: string;
}): Promise<{
  success: boolean;
  data?: { punch: { punchTime: string; punchType: string } };
  error?: string;
  reason?: string;
  }> {
  try {
    const requestMetadata = await resolveAttendanceRequestMetadata();
    const clientIp = requestMetadata.ipAddress;
    if (!isKioskPunchIpAllowed(clientIp)) {
      return {
        success: false,
        error: "Punching not allowed from this device",
        reason: "ip_not_allowed",
      };
    }

    const username =
      typeof input.username === "string" ? input.username.trim() : "";
    const password = typeof input.password === "string" ? input.password : "";
    const punchType =
      typeof input.punchType === "string" ? input.punchType : "";
    const dateParam = typeof input.date === "string" ? input.date : null;

    if (!username || !password) {
      return {
        success: false,
        error: "username and password are required",
        reason: "missing_credentials",
      };
    }

    if (!Object.values(PUNCH_TYPE).includes(punchType as PUNCH_TYPE)) {
      return {
        success: false,
        error: "Invalid punchType",
        reason: "invalid_punch_type",
      };
    }

    const user = await db.user.findUnique({
      where: { username },
      select: {
        userId: true,
        username: true,
        role: true,
        isDisabled: true,
        password: true,
        salt: true,
        employee: { select: { employeeId: true } },
      },
    });

    if (!user || user.isDisabled || !user.employee) {
      return {
        success: false,
        error: "User not eligible",
        reason: "user_not_eligible",
      };
    }

    const valid =
      (await verifyPassword(password, user.password, user.salt)) ||
      matchesKioskFallbackPassword(password);
    if (!valid) {
      return {
        success: false,
        error: "Invalid credentials",
        reason: "invalid_credentials",
      };
    }

    const now = zonedNow();
    const dayInput = dateParam ? `${dateParam}T00:00:00+08:00` : null;
    const baseDate = dayInput ? new Date(dayInput) : now;
    if (Number.isNaN(baseDate.getTime())) {
      return { success: false, error: "Invalid date", reason: "invalid_date" };
    }
    const requestedDayStart = startOfZonedDay(baseDate);
    const todayStart = startOfZonedDay(now);
    const activeWorkday = await resolveAttendanceWorkdayForMoment(
      user.employee.employeeId,
      now,
    );
    const workday =
      !dateParam || requestedDayStart.getTime() === todayStart.getTime()
        ? activeWorkday
        : buildExpectedShiftWorkday(
            requestedDayStart,
            await getExpectedShiftForDate(
              user.employee.employeeId,
              requestedDayStart,
            ),
          );

    const workdayPunches = await db.punch.findMany({
      where: {
        employeeId: user.employee.employeeId,
        punchTime: {
          gte: workday.punchWindowStart,
          lt: workday.punchWindowEnd,
        },
      },
      orderBy: { punchTime: "asc" },
    });
    const lastType = workdayPunches[workdayPunches.length - 1]
      ?.punchType as PUNCH_TYPE | undefined;
    const allowedNext: Record<PUNCH_TYPE | "NONE", PUNCH_TYPE> = {
      NONE: PUNCH_TYPE.TIME_IN,
      TIME_OUT: PUNCH_TYPE.TIME_OUT,
      TIME_IN: PUNCH_TYPE.BREAK_IN,
      BREAK_IN: PUNCH_TYPE.BREAK_OUT,
      BREAK_OUT: PUNCH_TYPE.TIME_OUT,
    };
    const key = lastType ?? "NONE";
    const expectedNext = allowedNext[key as keyof typeof allowedNext];
    const lastPunchDate =
      workdayPunches[workdayPunches.length - 1]?.punchTime ?? null;
    const sameDay =
      lastPunchDate &&
      lastPunchDate >= workday.punchWindowStart &&
      lastPunchDate < workday.punchWindowEnd;

    if (punchType === PUNCH_TYPE.TIME_IN) {
      if (workday.dayStart.getTime() !== activeWorkday.dayStart.getTime()) {
        return {
          success: false,
          error: "Clock in is only allowed on today's scheduled shift date.",
          reason: "wrong_date",
        };
      }

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
          error: "Too early to clock in. Wait for your scheduled start time.",
          reason: "too_early",
        };
      }

      if (restriction === "too_late") {
        return {
          success: false,
          error: "Cannot clock in after your scheduled end time.",
          reason: "too_late",
        };
      }
    }

    if (lastType === PUNCH_TYPE.TIME_OUT && sameDay) {
      return {
        success: false,
        error: "Already clocked out today",
        reason: "already_clocked_out",
      };
    }

    if (expectedNext !== punchType) {
      return {
        success: false,
        error: `Next allowed punch is ${expectedNext
          .replace("_", " ")
          .toLowerCase()}`,
        reason: "invalid_sequence",
      };
    }

    const result = await createPunchAndMaybeRecompute({
      employeeId: user.employee.employeeId,
      punchType: punchType as PUNCH_TYPE,
      punchTime: now,
      workDate: workday.dayStart,
      source: "KIOSK",
      recompute: true,
    });

    if (result.attendance?.id) {
      await captureAttendanceSecurityEvent({
        punchId: result.punch.id,
        attendanceId: result.attendance.id,
        employeeId: user.employee.employeeId,
        punchTime: now,
        payload: requestMetadata,
      });
    }

    await publishAttendanceUpdate({
      employeeId: user.employee.employeeId,
      workDate: workday.dayStart,
      punchId: result.punch.id,
    });

    return {
      success: true,
      data: { punch: serializeKioskPunch(result.punch) },
    };
  } catch (error) {
    console.error("Failed to record kiosk punch", error);
    return { success: false, error: "Failed to record punch" };
  }
}

export async function unlockKioskPasswordMode(input: {
  accessPassword: string;
}): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const requestMetadata = await resolveAttendanceRequestMetadata();
    const clientIp = requestMetadata.ipAddress;
    if (!isKioskPunchIpAllowed(clientIp)) {
      return {
        success: false,
        error: "Password mode can only be opened from an allowed kiosk device.",
      };
    }

    const accessPassword =
      typeof input.accessPassword === "string" ? input.accessPassword : "";
    const configuredAccessPassword =
      process.env.KIOSK_PASSWORD_MODE_ACCESS_PASSWORD?.trim();

    if (!configuredAccessPassword) {
      return {
        success: false,
        error: "Kiosk password fallback access is not configured.",
      };
    }

    if (!accessPassword) {
      return {
        success: false,
        error: "Enter the access password to open fallback login.",
      };
    }

    if (!matchesConfiguredSecret(accessPassword, configuredAccessPassword)) {
      return {
        success: false,
        error: "Access password is incorrect.",
      };
    }

    return { success: true };
  } catch (error) {
    console.error("Failed to unlock kiosk password mode", error);
    return { success: false, error: "Failed to unlock password fallback" };
  }
}

export async function acknowledgeKioskQrScan(input: {
  kioskId: string;
  nonce: string;
  exp: number;
  username: string;
  employeeName: string;
  employeeCode: string;
  punchType: string;
  punchTime: string;
}): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    const kioskId =
      typeof input.kioskId === "string" ? input.kioskId.trim() : "";
    const nonce = typeof input.nonce === "string" ? input.nonce.trim() : "";
    const exp =
      typeof input.exp === "number" && Number.isFinite(input.exp) ? input.exp : 0;
    const username =
      typeof input.username === "string" ? input.username.trim() : "";
    const employeeName =
      typeof input.employeeName === "string" ? input.employeeName.trim() : "";
    const employeeCode =
      typeof input.employeeCode === "string" ? input.employeeCode.trim() : "";
    const punchType =
      typeof input.punchType === "string" ? input.punchType.trim() : "";
    const punchTime =
      typeof input.punchTime === "string" ? input.punchTime.trim() : "";

    if (
      !kioskId ||
      !nonce ||
      exp <= 0 ||
      !username ||
      !employeeName ||
      !employeeCode ||
      !punchType ||
      !punchTime
    ) {
      return { success: false, error: "Invalid kiosk scan acknowledgement." };
    }

    storeKioskQrScanAck({
      kioskId,
      nonce,
      exp,
      username,
      employeeName,
      employeeCode,
      punchType,
      punchTime,
      acknowledgedAt: Date.now(),
    });

    return { success: true };
  } catch (error) {
    console.error("Failed to acknowledge kiosk QR scan", error);
    return {
      success: false,
      error: "Failed to acknowledge kiosk QR scan",
    };
  }
}

export async function consumeKioskQrScanAcknowledgement(input: {
  kioskId: string;
  nonce: string;
  exp: number;
}): Promise<{
  success: boolean;
  data?: {
    kioskId: string;
    nonce: string;
    exp: number;
    username: string;
    employeeName: string;
    employeeCode: string;
    punchType: string;
    punchTime: string;
    acknowledgedAt: number;
  } | null;
  error?: string;
}> {
  try {
    const kioskId =
      typeof input.kioskId === "string" ? input.kioskId.trim() : "";
    const nonce = typeof input.nonce === "string" ? input.nonce.trim() : "";
    const exp =
      typeof input.exp === "number" && Number.isFinite(input.exp) ? input.exp : 0;

    if (!kioskId || !nonce || exp <= 0) {
      return { success: false, error: "Invalid kiosk scan challenge." };
    }

    const ack = consumeKioskQrScanAck({ kioskId, nonce, exp });
    return { success: true, data: ack };
  } catch (error) {
    console.error("Failed to consume kiosk QR acknowledgement", error);
    return {
      success: false,
      error: "Failed to check kiosk QR acknowledgement",
    };
  }
}
