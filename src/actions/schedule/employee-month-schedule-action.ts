"use server";

import { ATTENDANCE_STATUS } from "@prisma/client";
import {
  addDays,
  endOfMonth,
  startOfMonth,
} from "date-fns";
import { db } from "@/lib/db";
import { getExpectedShiftForDate } from "@/lib/attendance";
import { requireScheduleActor } from "@/lib/scheduling-auth";
import {
  canReadEmployeeSchedule,
  scheduleAccessError,
} from "@/lib/scheduling-access";
import { serializeShift } from "@/lib/serializers/schedule";
import {
  endOfZonedDay,
  startOfZonedDay,
  TZ,
  zonedNow,
} from "@/lib/timezone";
import { toTzDateKey } from "./schedule-shared";

function buildDateRangeDays(start: Date, end: Date) {
  const days: Date[] = [];
  let cursor = new Date(start);
  while (cursor <= end) {
    days.push(new Date(cursor));
    cursor = addDays(cursor, 1);
  }
  return days;
}

export async function getEmployeeMonthSchedule(input: {
  employeeId: string;
  anchorDate?: string | null;
}) {
  try {
    const actor = await requireScheduleActor();
    const employeeId =
      typeof input?.employeeId === "string" ? input.employeeId.trim() : "";
    const anchorDateRaw =
      typeof input?.anchorDate === "string" ? input.anchorDate : "";

    if (!employeeId) {
      return { success: false, error: "employeeId is required" };
    }

    const employee = await db.employee.findUnique({
      where: { employeeId },
      select: {
        employeeId: true,
        userId: true,
        supervisorUserId: true,
      },
    });
    if (!employee || !canReadEmployeeSchedule(actor, employee)) {
      return { success: false, error: "Employee not found" };
    }

    const anchorDate = anchorDateRaw ? new Date(anchorDateRaw) : zonedNow();
    if (Number.isNaN(anchorDate.getTime())) {
      return { success: false, error: "Invalid anchorDate" };
    }

    const anchorInTz = new Date(
      anchorDate.toLocaleString("en-US", { timeZone: TZ }),
    );
    const monthStartLocal = startOfMonth(anchorInTz);
    const monthEndLocal = endOfMonth(anchorInTz);

    const monthDates = buildDateRangeDays(
      new Date(
        Date.UTC(
          monthStartLocal.getFullYear(),
          monthStartLocal.getMonth(),
          monthStartLocal.getDate(),
          12,
          0,
          0,
        ),
      ),
      new Date(
        Date.UTC(
          monthEndLocal.getFullYear(),
          monthEndLocal.getMonth(),
          monthEndLocal.getDate(),
          12,
          0,
          0,
        ),
      ),
    );
    const monthStart = startOfZonedDay(monthDates[0]);
    const monthEnd = endOfZonedDay(monthDates[monthDates.length - 1]);
    const today = zonedNow();
    const todayStart = startOfZonedDay(today);
    const todayEnd = endOfZonedDay(today);
    const leaveQueryStart = todayStart < monthStart ? todayStart : monthStart;
    const leaveQueryEnd = todayEnd > monthEnd ? todayEnd : monthEnd;

    const leaveAttendances = await db.attendance.findMany({
      where: {
        employeeId,
        workDate: {
          gte: leaveQueryStart,
          lt: leaveQueryEnd,
        },
        status: ATTENDANCE_STATUS.LEAVE,
      },
      select: {
        workDate: true,
        isPaidLeave: true,
        leaveRequestId: true,
        leaveRequest: {
          select: {
            leaveType: true,
          },
        },
      },
    });

    const leaveByDate = new Map(
      leaveAttendances.map((row) => [
        toTzDateKey(row.workDate),
        {
          requestId: row.leaveRequestId,
          leaveType: row.leaveRequest?.leaveType ?? "PERSONAL",
          isPaidLeave: row.isPaidLeave,
        },
      ]),
    );

    const buildDay = async (date: Date) => {
      const expected = await getExpectedShiftForDate(employeeId, date);
      return {
        date: toTzDateKey(date),
        shift: expected.shift ? serializeShift(expected.shift) : null,
        source: expected.source,
        leave: leaveByDate.get(toTzDateKey(date)) ?? null,
        scheduledStartMinutes: expected.scheduledStartMinutes,
        scheduledEndMinutes: expected.scheduledEndMinutes,
      };
    };

    const days = await Promise.all(monthDates.map(buildDay));
    const todayDay = await buildDay(today);

    return {
      success: true,
      month: `${monthStartLocal.getFullYear()}-${String(monthStartLocal.getMonth() + 1).padStart(2, "0")}`,
      days,
      todayDay,
    };
  } catch (error) {
    console.error("Failed to fetch employee month schedule", error);
    return {
      success: false,
      error: scheduleAccessError(error, "Failed to load employee schedule"),
    };
  }
}
