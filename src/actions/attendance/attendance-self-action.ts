"use server";

import { PUNCH_TYPE } from "@prisma/client";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
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
  computeBreakStats,
  getAttendanceFreezeStateForMoment,
  isSelfPunchIpAllowed,
  serializePunch,
  serializePunchNullable,
} from "./attendance-shared";
import { captureAttendanceSecurityEvent } from "./attendance-security-service";
import {
  ensureAttendanceSecuritySettings,
  resolveAttendanceRequestMetadata,
  serializeAttendanceSecurityClientConfig,
} from "./attendance-security-shared";

export async function getSelfAttendanceStatus(input?: { date?: string }) {
  try {
    const session = await getSession();
    if (!session.isLoggedIn || !session.userId) {
      return { success: false, error: "Unauthorized", reason: "unauthorized" };
    }

    const dateParam = typeof input?.date === "string" ? input.date : null;
    const day = dateParam ? new Date(dateParam) : new Date();
    if (Number.isNaN(day.getTime())) {
      return { success: false, error: "Invalid date", reason: "invalid_date" };
    }
    const requestedDayStart = startOfZonedDay(day);

    const employee = await db.employee.findUnique({
      where: { userId: session.userId },
      select: {
        employeeId: true,
        employeeCode: true,
        firstName: true,
        lastName: true,
        department: { select: { name: true } },
        position: { select: { name: true } },
      },
    });
    if (!employee) {
      return {
        success: false,
        error: "Employee not found for user",
        reason: "employee_not_found",
      };
    }

    const workday = dateParam
      ? buildExpectedShiftWorkday(
          requestedDayStart,
          await getExpectedShiftForDate(employee.employeeId, requestedDayStart),
        )
      : await resolveAttendanceWorkdayForMoment(employee.employeeId, day);
    const expected = workday.expected;
    const punches = await db.punch.findMany({
      where: {
        employeeId: employee.employeeId,
        punchTime: {
          gte: workday.punchWindowStart,
          lt: workday.punchWindowEnd,
        },
      },
      orderBy: { punchTime: "asc" },
    });

    const breakStats = computeBreakStats(punches);
    const lastPunch = punches[punches.length - 1] ?? null;
    const securitySettings = await ensureAttendanceSecuritySettings();

    return {
      success: true,
      data: {
        username: session.username ?? "",
        employee,
        expected: {
          start: expected.scheduledStartMinutes,
          end: expected.scheduledEndMinutes,
          shiftName: expected.shift?.name ?? null,
          source: expected.source,
        },
        punches: punches.map((p) => serializePunch(p)),
        lastPunch: serializePunchNullable(lastPunch),
        breakCount: breakStats.breakCount,
        breakMinutes: breakStats.breakMinutes,
        security: serializeAttendanceSecurityClientConfig(securitySettings),
      },
    };
  } catch (error) {
    console.error("Failed to fetch self attendance status", error);
    return {
      success: false,
      error: "Failed to load attendance status",
    };
  }
}

export async function recordSelfPunch(input: {
  punchType: string;
  latitude?: number | null;
  longitude?: number | null;
}) {
  try {
    const session = await getSession();
    if (!session.isLoggedIn || !session.userId) {
      return { success: false, error: "Unauthorized" };
    }

    const requestMetadata = await resolveAttendanceRequestMetadata();
    const clientIp = requestMetadata.ipAddress;
    if (!isSelfPunchIpAllowed(clientIp)) {
      return {
        success: false,
        error: "Punching not allowed from this device",
        reason: "ip_not_allowed",
      };
    }

    const punchType =
      typeof input?.punchType === "string" ? input.punchType : "";
    if (!Object.values(PUNCH_TYPE).includes(punchType as PUNCH_TYPE)) {
      return {
        success: false,
        error: "Invalid punchType",
        reason: "invalid_punch_type",
      };
    }

    const employee = await db.employee.findUnique({
      where: { userId: session.userId },
      select: { employeeId: true },
    });
    if (!employee) {
      return {
        success: false,
        error: "Employee not found for user",
        reason: "employee_not_found",
      };
    }

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

    if (punchType === PUNCH_TYPE.TIME_IN) {
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
          error:
            "Too early to clock in. You can time in at the scheduled start time.",
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

    const punch = await createPunchAndMaybeRecompute({
      employeeId: employee.employeeId,
      punchType: punchType as PUNCH_TYPE,
      punchTime: now,
      workDate: workday.dayStart,
      source: "WEB_SELF",
      recompute: true,
    });

    if (punch.attendance?.id) {
      await captureAttendanceSecurityEvent({
        punchId: punch.punch.id,
        attendanceId: punch.attendance.id,
        employeeId: employee.employeeId,
        punchTime: now,
        payload: {
          ...requestMetadata,
          latitude: input.latitude ?? null,
          longitude: input.longitude ?? null,
        },
      });
    }

    await publishAttendanceUpdate({
      employeeId: employee.employeeId,
      workDate: workday.dayStart,
      punchId: punch.punch.id,
    });

    return {
      success: true,
      data: serializePunch(punch.punch),
    };
  } catch (error) {
    console.error("Failed to record self punch", error);
    return { success: false, error: "Failed to record punch" };
  }
}
