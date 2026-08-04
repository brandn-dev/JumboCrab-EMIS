"use server";

import { CURRENT_STATUS, LeaveRequestStatus } from "@prisma/client";
import type { LeaveRequestType } from "@prisma/client";
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { normalizeRole } from "@/lib/rbac";
import { getExpectedShiftForDate } from "@/lib/attendance";
import { serializeShift } from "@/lib/serializers/schedule";
import { endOfZonedDay, startOfZonedDay } from "@/lib/timezone";
import {
  computeCoverageSummary,
  getWeekDates,
  normalizeWeekStart,
  toPlannerDateKey,
  WEEK_SHIFT_FIELD_MAP,
  WEEK_PLANNER_DAYS,
  type WeekPlannerDayKey,
  type WeekShiftMap,
} from "@/lib/week-planner";
import { shiftSelect } from "./schedule-shared";

const employeeSelect = {
  employeeId: true,
  employeeCode: true,
  firstName: true,
  lastName: true,
  img: true,
  department: { select: { departmentId: true, name: true } },
  position: { select: { name: true } },
} as const;

const ensureWeekPlannerAccess = async () => {
  const session = await getSession();
  const role = normalizeRole(session.role);
  if (!session.isLoggedIn || !role) {
    throw new Error("Unauthorized");
  }
  if (role !== "admin" && role !== "manager") {
    throw new Error("Forbidden");
  }
};

const buildEmptyWeekMap = (): WeekShiftMap => ({
  mon: null,
  tue: null,
  wed: null,
  thu: null,
  fri: null,
  sat: null,
  sun: null,
});

const addDays = (date: Date, days: number) =>
  new Date(date.getTime() + days * 24 * 60 * 60 * 1000);

const addWeeks = (date: Date, weeks: number) => addDays(date, weeks * 7);

const buildLeaveMap = async (employeeIds: string[], weekStart: Date) => {
  const weekEndExclusive = endOfZonedDay(addDays(weekStart, 6));
  const leaveRequests = await db.leaveRequest.findMany({
    where: {
      employeeId: { in: employeeIds },
      status: LeaveRequestStatus.APPROVED,
      startDate: { lt: weekEndExclusive },
      endDate: { gte: weekStart },
    },
    select: {
      employeeId: true,
      leaveType: true,
      startDate: true,
      endDate: true,
    },
    orderBy: [{ employeeId: "asc" }, { submittedAt: "desc" }],
  });

  const leaveMap = new Map<
    string,
    {
      leaveType: LeaveRequestType;
      isPaidLeave: boolean;
    }
  >();

  for (const leave of leaveRequests) {
    const start = startOfZonedDay(leave.startDate > weekStart ? leave.startDate : weekStart);
    const end = endOfZonedDay(
      leave.endDate < addDays(weekStart, 6) ? leave.endDate : addDays(weekStart, 6),
    );

    for (let cursor = start; cursor < end; cursor = addDays(cursor, 1)) {
      const key = `${leave.employeeId}:${toPlannerDateKey(cursor)}`;
      if (leaveMap.has(key)) continue;
      leaveMap.set(key, {
        leaveType: leave.leaveType,
        isPaidLeave: leave.leaveType !== "UNPAID",
      });
    }
  }

  return leaveMap;
};

const buildWeekQuickSelectOptions = async (
  employeeIds: string[],
  anchorWeekStart: Date,
) => {
  const weekStarts = Array.from({ length: 4 }, (_, index) => addWeeks(anchorWeekStart, index));
  const weeklySchedules = await db.weeklySchedule.findMany({
    where: {
      employeeId: { in: employeeIds },
      weekStart: { in: weekStarts },
    },
    select: {
      employeeId: true,
      weekStart: true,
      monShiftId: true,
      tueShiftId: true,
      wedShiftId: true,
      thuShiftId: true,
      friShiftId: true,
      satShiftId: true,
      sunShiftId: true,
    },
  });

  const scheduleByKey = new Map(
    weeklySchedules.map((schedule) => [
      `${schedule.employeeId}:${toPlannerDateKey(schedule.weekStart)}`,
      schedule,
    ] as const),
  );

  return Promise.all(
    weekStarts.map(async (weekStart) => {
      const leaveMap = await buildLeaveMap(employeeIds, weekStart);
      let unassignedCount = 0;

      for (const employeeId of employeeIds) {
        const schedule = scheduleByKey.get(`${employeeId}:${toPlannerDateKey(weekStart)}`) ?? null;
        for (const { dayKey, date } of getWeekDates(weekStart)) {
          if (leaveMap.has(`${employeeId}:${toPlannerDateKey(date)}`)) continue;
          const field = WEEK_SHIFT_FIELD_MAP[dayKey];
          if (!schedule?.[field]) {
            unassignedCount += 1;
          }
        }
      }

      return {
        weekStart: toPlannerDateKey(weekStart),
        isAssigned: unassignedCount === 0,
        unassignedCount,
      };
    }),
  );
};

const resolveWeekForEmployee = async (
  employeeId: string,
  weekStart: Date,
  leaveMap?: Map<
    string,
    {
      leaveType: LeaveRequestType;
      isPaidLeave: boolean;
    }
  >,
) => {
  const dates = getWeekDates(weekStart);
  const results = await Promise.all(
    dates.map(async ({ dayKey, date }) => {
      const expected = await getExpectedShiftForDate(employeeId, date);
      return {
        dayKey,
        workDate: toPlannerDateKey(date),
        shift: expected.shift ? serializeShift(expected.shift) : null,
        leave: leaveMap?.get(`${employeeId}:${toPlannerDateKey(date)}`) ?? null,
      };
    }),
  );

  return results.reduce(
    (acc, entry) => {
      acc[entry.dayKey] = {
        workDate: entry.workDate,
        shiftId: entry.shift?.id ?? null,
        shift: entry.shift,
        leave: entry.leave,
      };
      return acc;
    },
	          {} as Record<
	            WeekPlannerDayKey,
	            {
        workDate: string;
        shiftId: number | null;
        shift: ReturnType<typeof serializeShift>;
        leave: {
          leaveType: LeaveRequestType;
          isPaidLeave: boolean;
        } | null;
      }
    >,
  );
};

export async function getWeekPlannerSnapshot(input?: {
  weekStart?: string;
  compareWeekStart?: string;
}) {
  try {
    await ensureWeekPlannerAccess();

    const weekStart = normalizeWeekStart(input?.weekStart);
    const compareWeekStart = input?.compareWeekStart
      ? normalizeWeekStart(input.compareWeekStart)
      : new Date(weekStart.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [employees, departments, shifts] = await Promise.all([
      db.employee.findMany({
        where: {
          isArchived: false,
          currentStatus: {
            notIn: [CURRENT_STATUS.INACTIVE, CURRENT_STATUS.ENDED],
          },
        },
        orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
        select: employeeSelect,
      }),
      db.department.findMany({
        where: { isActive: true },
        orderBy: { name: "asc" },
        select: { departmentId: true, name: true },
      }),
      db.shift.findMany({
        where: { isActive: true },
        orderBy: [{ isDayOff: "asc" }, { startMinutes: "asc" }, { name: "asc" }],
        select: shiftSelect,
      }),
    ]);

    const leaveMap = await buildLeaveMap(
      employees.map((employee) => employee.employeeId),
      weekStart,
    );
    const employeeIds = employees.map((employee) => employee.employeeId);
    const [scheduleWeekOptions, referenceWeekOptions] = await Promise.all([
      buildWeekQuickSelectOptions(employeeIds, weekStart),
      buildWeekQuickSelectOptions(employeeIds, compareWeekStart),
    ]);

    const rows = await Promise.all(
      employees.map(async (employee) => {
        const [targetWeek, compareWeek] = await Promise.all([
          resolveWeekForEmployee(employee.employeeId, weekStart, leaveMap),
          resolveWeekForEmployee(employee.employeeId, compareWeekStart),
        ]);

        const days = WEEK_PLANNER_DAYS.reduce(
          (acc, dayKey) => {
            acc[dayKey] = {
              workDate: targetWeek[dayKey].workDate,
              compareWorkDate: compareWeek[dayKey].workDate,
              shiftId: targetWeek[dayKey].shiftId,
              shift: targetWeek[dayKey].shift,
              compareShiftId: compareWeek[dayKey].shiftId,
              compareShift: compareWeek[dayKey].shift,
              leave: targetWeek[dayKey].leave,
            };
            return acc;
          },
          {} as Record<
            WeekPlannerDayKey,
            {
              workDate: string;
              compareWorkDate: string;
              shiftId: number | null;
              shift: ReturnType<typeof serializeShift>;
	              compareShiftId: number | null;
	              compareShift: ReturnType<typeof serializeShift>;
	              leave: {
	                leaveType: LeaveRequestType;
	                isPaidLeave: boolean;
	              } | null;
	            }
	          >,
        );

        return { employee, days };
      }),
    );

    const shiftsById = new Map(shifts.map((shift) => [shift.id, shift] as const));
    const coverage = computeCoverageSummary(rows, shiftsById);

    return {
      success: true,
      data: {
        weekStart: toPlannerDateKey(weekStart),
        compareWeekStart: toPlannerDateKey(compareWeekStart),
        rows,
        shifts: shifts.map((shift) => serializeShift(shift)),
        departments,
        coverage,
        scheduleWeekOptions,
        referenceWeekOptions,
      },
    };
  } catch (error) {
    console.error("Failed to load week planner snapshot", error);
    return {
      success: false,
      error:
        error instanceof Error &&
        (error.message === "Unauthorized" || error.message === "Forbidden")
          ? error.message
          : "Failed to load week planner snapshot",
    };
  }
}

export async function saveWeekPlannerAssignments(input: {
  weekStart: string;
  rows: Array<{
    employeeId: string;
    days: Partial<Record<WeekPlannerDayKey, number | null>>;
  }>;
}) {
  try {
    await ensureWeekPlannerAccess();

    if (!Array.isArray(input?.rows) || input.rows.length === 0) {
      return { success: false, error: "At least one row is required" };
    }

    const weekStart = normalizeWeekStart(input.weekStart);
    const employeeIds = input.rows
      .map((row) => row.employeeId?.trim())
      .filter((employeeId): employeeId is string => Boolean(employeeId));

    if (employeeIds.length !== input.rows.length) {
      return { success: false, error: "Each row must include an employeeId" };
    }

    const shiftIds = Array.from(
      new Set(
        input.rows.flatMap((row) =>
          WEEK_PLANNER_DAYS.map((dayKey) => row.days?.[dayKey]).filter(
            (value): value is number => typeof value === "number",
          ),
        ),
      ),
    );

    const [employees, shifts] = await Promise.all([
      db.employee.findMany({
        where: {
          employeeId: { in: employeeIds },
          isArchived: false,
          currentStatus: {
            notIn: [CURRENT_STATUS.INACTIVE, CURRENT_STATUS.ENDED],
          },
        },
        select: { employeeId: true },
      }),
      shiftIds.length
        ? db.shift.findMany({
            where: { id: { in: shiftIds }, isActive: true },
            select: { id: true, isDayOff: true },
          })
        : Promise.resolve([]),
    ]);

    if (employees.length !== employeeIds.length) {
      return { success: false, error: "One or more employees were not found" };
    }
    if (shifts.length !== shiftIds.length) {
      return { success: false, error: "One or more shifts were not found" };
    }

    await db.$transaction(
      input.rows.map((row) => {
        const weekMap = WEEK_PLANNER_DAYS.reduce(
          (acc, dayKey) => {
            acc[dayKey] =
              typeof row.days?.[dayKey] === "number" ? row.days[dayKey]! : null;
            return acc;
          },
          buildEmptyWeekMap(),
        );

        const hasAnyValue = WEEK_PLANNER_DAYS.some((dayKey) => weekMap[dayKey] != null);
        if (!hasAnyValue) {
          return db.weeklySchedule.deleteMany({
            where: {
              employeeId: row.employeeId,
              weekStart,
            },
          });
        }

        return db.weeklySchedule.upsert({
          where: {
            employeeId_weekStart: {
              employeeId: row.employeeId,
              weekStart,
            },
          },
          update: {
            monShiftId: weekMap.mon,
            tueShiftId: weekMap.tue,
            wedShiftId: weekMap.wed,
            thuShiftId: weekMap.thu,
            friShiftId: weekMap.fri,
            satShiftId: weekMap.sat,
            sunShiftId: weekMap.sun,
          },
          create: {
            employeeId: row.employeeId,
            weekStart,
            monShiftId: weekMap.mon,
            tueShiftId: weekMap.tue,
            wedShiftId: weekMap.wed,
            thuShiftId: weekMap.thu,
            friShiftId: weekMap.fri,
            satShiftId: weekMap.sat,
            sunShiftId: weekMap.sun,
          },
        });
      }),
    );

    return { success: true };
  } catch (error) {
    console.error("Failed to save week planner", error);
    return {
      success: false,
      error:
        error instanceof Error &&
        (error.message === "Unauthorized" || error.message === "Forbidden")
          ? error.message
          : "Failed to save week planner",
    };
  }
}
