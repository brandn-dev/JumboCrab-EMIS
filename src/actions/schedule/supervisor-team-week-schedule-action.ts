"use server";

import { ATTENDANCE_STATUS } from "@prisma/client";
import { addDays, startOfWeek } from "date-fns";
import { db } from "@/lib/db";
import { requireScheduleActor } from "@/lib/scheduling-auth";
import { scheduleAccessError } from "@/lib/scheduling-access";
import { getExpectedShiftForDate } from "@/lib/attendance";
import { serializeShift } from "@/lib/serializers/schedule";
import {
  endOfZonedDay,
  startOfZonedDay,
  TZ,
  zonedNow,
} from "@/lib/timezone";
import { toTzDateKey } from "./schedule-shared";

const buildWeekDays = (anchorDate: Date) => {
  const anchorInTz = new Date(
    anchorDate.toLocaleString("en-US", { timeZone: TZ }),
  );
  const weekStartLocal = startOfWeek(anchorInTz, { weekStartsOn: 1 });

  return Array.from({ length: 7 }, (_, dayIndex) => {
    const localDay = addDays(weekStartLocal, dayIndex);
    return new Date(
      Date.UTC(
        localDay.getFullYear(),
        localDay.getMonth(),
        localDay.getDate(),
        12,
        0,
        0,
      ),
    );
  });
};

export async function getSupervisorTeamWeekSchedule(input?: {
  anchorDate?: string | null;
}) {
  try {
    const actor = await requireScheduleActor(["supervisor"]);

    const anchorDateRaw =
      typeof input?.anchorDate === "string" ? input.anchorDate : "";
    const anchorDate = anchorDateRaw ? new Date(anchorDateRaw) : zonedNow();
    if (Number.isNaN(anchorDate.getTime())) {
      return { success: false, error: "Invalid anchorDate" };
    }

    const weekDates = buildWeekDays(anchorDate);
    const weekStart = startOfZonedDay(weekDates[0]);
    const weekEnd = endOfZonedDay(weekDates[6]);

    const employees = await db.employee.findMany({
      where: {
        supervisorUserId: actor.userId,
        isArchived: false,
      },
      orderBy: [{ employeeCode: "asc" }, { lastName: "asc" }],
      select: {
        employeeId: true,
        employeeCode: true,
        firstName: true,
        lastName: true,
        department: { select: { name: true } },
        position: { select: { name: true } },
      },
    });

    const leaveAttendances = await db.attendance.findMany({
      where: {
        employeeId: { in: employees.map((employee) => employee.employeeId) },
        workDate: {
          gte: weekStart,
          lt: weekEnd,
        },
        status: ATTENDANCE_STATUS.LEAVE,
      },
      select: {
        employeeId: true,
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

    const leaveByEmployeeDate = new Map(
      leaveAttendances.map((row) => [
        `${row.employeeId}:${toTzDateKey(row.workDate)}`,
        {
          requestId: row.leaveRequestId,
          leaveType: row.leaveRequest?.leaveType ?? "PERSONAL",
          isPaidLeave: row.isPaidLeave,
        },
      ]),
    );

    const rows = await Promise.all(
      employees.map(async (employee) => {
        const cells = await Promise.all(
          weekDates.map(async (date) => {
            const expected = await getExpectedShiftForDate(
              employee.employeeId,
              date,
            );
            const dateKey = toTzDateKey(date);

            return {
              employeeId: employee.employeeId,
              date: dateKey,
              shift: expected.shift ? serializeShift(expected.shift) : null,
              source: expected.source,
              leave:
                leaveByEmployeeDate.get(`${employee.employeeId}:${dateKey}`) ??
                null,
              scheduledStartMinutes: expected.scheduledStartMinutes,
              scheduledEndMinutes: expected.scheduledEndMinutes,
            };
          }),
        );

        return {
          employee: {
            employeeId: employee.employeeId,
            employeeCode: employee.employeeCode,
            firstName: employee.firstName,
            lastName: employee.lastName,
            departmentName: employee.department?.name ?? null,
            positionName: employee.position?.name ?? null,
          },
          cells,
        };
      }),
    );

    return {
      success: true,
      weekStart: toTzDateKey(weekDates[0]),
      weekEnd: toTzDateKey(weekDates[6]),
      days: weekDates.map((date) => ({
        date: toTzDateKey(date),
        label: date.toLocaleDateString(undefined, {
          timeZone: TZ,
          weekday: "short",
          month: "short",
          day: "numeric",
        }),
      })),
      employees: rows.map((row) => row.employee),
      rows,
    };
  } catch (error) {
    console.error("Failed to fetch supervisor team schedule", error);
    const accessError = scheduleAccessError(error, "Failed to load team schedule.");
    return {
      success: false,
      error:
        accessError === "Unauthorized" || accessError === "Forbidden"
          ? "You are not allowed to view team schedules."
          : accessError,
    };
  }
}
