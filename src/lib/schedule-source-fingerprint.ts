import "server-only";

import { CURRENT_STATUS, LeaveRequestStatus, Prisma, type PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import {
  createScheduleSourceFingerprint,
  type ScheduleSourceScope,
} from "@/lib/schedule-fingerprint";
import { normalizeWeekStart } from "@/lib/week-planner";

type ScheduleSourceClient = PrismaClient | Prisma.TransactionClient;

export async function getScheduleSourceFingerprint(input: {
  employeeIds: string[];
  weekStart: Date;
  referenceWeekStart?: Date | null;
  scope?: ScheduleSourceScope;
}, client: ScheduleSourceClient = db) {
  const employeeIds = Array.from(new Set(input.employeeIds)).sort();
  const weekStart = normalizeWeekStart(input.weekStart);
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
  const referenceWeekStart = input.referenceWeekStart
    ? normalizeWeekStart(input.referenceWeekStart)
    : null;
  const scheduleWeekStarts = referenceWeekStart
    ? [weekStart, referenceWeekStart]
    : [weekStart];
  const overrideWeekRanges = scheduleWeekStarts.map((start) => ({
    workDate: {
      gte: start,
      lt: new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000),
    },
  }));

  if (employeeIds.length === 0) {
    return createScheduleSourceFingerprint({ weeklySchedules: [], overrides: [] });
  }

  const scope = input.scope ?? { selectionMode: "SELECTED", departmentId: null };
  const activeRosterFilter = {
    isArchived: false,
    currentStatus: { notIn: [CURRENT_STATUS.INACTIVE, CURRENT_STATUS.ENDED] },
    ...(scope.selectionMode === "DEPARTMENT" && scope.departmentId
      ? { departmentId: scope.departmentId }
      : {}),
  };

  const [weeklySchedules, overrides, approvedLeaves, employees, rosterEmployees, shifts, coverageRules] = await Promise.all([
    client.weeklySchedule.findMany({
      where: { employeeId: { in: employeeIds }, weekStart: { in: scheduleWeekStarts } },
      select: {
        employeeId: true,
        weekStart: true,
        updatedAt: true,
        monShiftId: true,
        tueShiftId: true,
        wedShiftId: true,
        thuShiftId: true,
        friShiftId: true,
        satShiftId: true,
        sunShiftId: true,
      },
    }),
    client.employeeShiftOverride.findMany({
      where: {
        employeeId: { in: employeeIds },
        OR: overrideWeekRanges,
      },
      select: {
        employeeId: true,
        workDate: true,
        shiftId: true,
        source: true,
        updatedAt: true,
      },
    }),
    client.leaveRequest.findMany({
      where: {
        employeeId: { in: employeeIds },
        status: LeaveRequestStatus.APPROVED,
        startDate: { lt: weekEnd },
        endDate: { gte: weekStart },
      },
      select: {
        employeeId: true,
        startDate: true,
        endDate: true,
        leaveType: true,
        updatedAt: true,
      },
    }),
    client.employee.findMany({
      where: { employeeId: { in: employeeIds } },
      select: {
        employeeId: true,
        departmentId: true,
        positionId: true,
        isArchived: true,
        currentStatus: true,
        updatedAt: true,
      },
    }),
    scope.selectionMode === "SELECTED"
      ? Promise.resolve([])
      : client.employee.findMany({
          where: activeRosterFilter,
          select: {
            employeeId: true,
            departmentId: true,
            positionId: true,
            isArchived: true,
            currentStatus: true,
            updatedAt: true,
          },
        }),
    client.shift.findMany({
      orderBy: { id: "asc" },
      select: {
        id: true,
        isActive: true,
        isDayOff: true,
        startMinutes: true,
        endMinutes: true,
        spansMidnight: true,
        paidHoursPerDay: true,
        updatedAt: true,
      },
    }),
    client.scheduleCoverageRule.findMany({
      orderBy: { id: "asc" },
      select: {
        id: true,
        name: true,
        departmentId: true,
        positionId: true,
        shiftId: true,
        weekday: true,
        minimumStaff: true,
        maximumStaff: true,
        priority: true,
        isActive: true,
        effectiveFrom: true,
        effectiveTo: true,
        updatedAt: true,
      },
    }),
  ]);

  return createScheduleSourceFingerprint({
    weeklySchedules,
    overrides,
    approvedLeaves,
    employees,
    rosterEmployees,
    shifts: shifts.map((shift) => ({ ...shift, paidHoursPerDay: Number(shift.paidHoursPerDay) })),
    coverageRules,
    scope,
  });
}
