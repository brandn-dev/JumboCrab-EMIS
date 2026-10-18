"use server";

import { db } from "@/lib/db";
import {
  buildExpectedShiftWorkday,
  getExpectedShiftForDate,
  resolveAttendanceWorkdayForMoment,
} from "@/lib/attendance";
import { startOfZonedDay, zonedNow } from "@/lib/timezone";
import {
  computeKioskBreakStats,
  serializeKioskPunch,
  serializeKioskPunchNullable,
} from "./kiosk-attendance-shared";

export async function searchKioskUsers(input?: { query?: string }) {
  try {
    const query = typeof input?.query === "string" ? input.query.trim() : "";
    const matches = await db.user.findMany({
      where: {
        ...(query ? { username: { contains: query, mode: "insensitive" } } : {}),
        isDisabled: false,
        employee: { isNot: null },
      },
      select: {
        username: true,
        role: true,
        employee: {
          select: {
            employeeId: true,
            employeeCode: true,
            firstName: true,
            lastName: true,
          },
        },
      },
      orderBy: { username: "asc" },
      take: 10,
    });

    return { success: true, data: matches };
  } catch (error) {
    console.error("Failed to load kiosk suggestions", error);
    return { success: false, error: "Failed to load suggestions" };
  }
}

export async function getKioskStatus(input: {
  username: string;
  date?: string;
}) {
  try {
    const username =
      typeof input.username === "string" ? input.username.trim() : "";
    const dateParam = typeof input.date === "string" ? input.date : null;

    if (!username) {
      return { success: false, error: "username is required" };
    }

    const user = await db.user.findUnique({
      where: { username },
      select: {
        userId: true,
        username: true,
        role: true,
        isDisabled: true,
        employee: {
          select: {
            employeeId: true,
            employeeCode: true,
            firstName: true,
            lastName: true,
            department: { select: { name: true } },
            position: { select: { name: true } },
          },
        },
      },
    });

    if (!user || user.isDisabled || !user.employee) {
      return { success: false, error: "User not eligible", reason: "user_not_eligible" };
    }

    const now = zonedNow();
    const dayInput = dateParam ? `${dateParam}T00:00:00+08:00` : null;
    const baseDate = dayInput ? new Date(dayInput) : now;
    if (Number.isNaN(baseDate.getTime())) {
      return { success: false, error: "Invalid date", reason: "invalid_date" };
    }
    const requestedDayStart = startOfZonedDay(baseDate);
    const todayStart = startOfZonedDay(now);
    const workday =
      !dateParam || requestedDayStart.getTime() === todayStart.getTime()
        ? await resolveAttendanceWorkdayForMoment(
            user.employee.employeeId,
            now,
          )
        : buildExpectedShiftWorkday(
            requestedDayStart,
            await getExpectedShiftForDate(
              user.employee.employeeId,
              requestedDayStart,
            ),
          );
    const expected = workday.expected;
    const punches = await db.punch.findMany({
      where: {
        employeeId: user.employee.employeeId,
        punchTime: {
          gte: workday.punchWindowStart,
          lt: workday.punchWindowEnd,
        },
      },
      orderBy: { punchTime: "asc" },
      select: { punchTime: true, punchType: true },
    });
    const lastPunch = punches[punches.length - 1] ?? null;
    const breakStats = computeKioskBreakStats(punches);

    return {
      success: true,
      data: {
        user: { username: user.username, role: user.role },
        employee: user.employee,
        expected: {
          start: expected.scheduledStartMinutes,
          end: expected.scheduledEndMinutes,
          shiftName: expected.shift?.name ?? null,
          source: expected.source,
        },
        punches: punches.map((punch) => serializeKioskPunch(punch)),
        lastPunch: serializeKioskPunchNullable(lastPunch),
        breakCount: breakStats.breakCount,
        breakMinutes: breakStats.breakMinutes,
      },
    };
  } catch (error) {
    console.error("Failed to load kiosk status", error);
    return { success: false, error: "Failed to load status" };
  }
}
