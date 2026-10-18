import type { Prisma, PrismaClient } from "@prisma/client";
import {
  WEEK_PLANNER_DAYS,
  type WeekPlannerDayKey,
  type WeekShiftMap,
} from "@/lib/week-planner";

export type WeekPlannerAssignmentInput = {
  employeeId: string;
  days: Partial<Record<WeekPlannerDayKey, number | null>>;
};

export function buildWeekShiftMap(
  days?: Partial<Record<WeekPlannerDayKey, number | null>>,
): WeekShiftMap {
  return WEEK_PLANNER_DAYS.reduce<WeekShiftMap>(
    (map, dayKey) => {
      map[dayKey] = typeof days?.[dayKey] === "number" ? days[dayKey]! : null;
      return map;
    },
    {
      mon: null,
      tue: null,
      wed: null,
      thu: null,
      fri: null,
      sat: null,
      sun: null,
    },
  );
}

export async function persistWeekPlannerAssignments(
  client: PrismaClient,
  weekStart: Date,
  rows: WeekPlannerAssignmentInput[],
) {
  await client.$transaction((tx) =>
    persistWeekPlannerAssignmentsInTransaction(tx, weekStart, rows),
  );
}

export async function persistWeekPlannerAssignmentsInTransaction(
  client: Prisma.TransactionClient,
  weekStart: Date,
  rows: WeekPlannerAssignmentInput[],
) {
  for (const row of rows) {
    const weekMap = buildWeekShiftMap(row.days);
    const hasAnyValue = WEEK_PLANNER_DAYS.some((dayKey) => weekMap[dayKey] != null);

    if (!hasAnyValue) {
      await client.weeklySchedule.deleteMany({
        where: { employeeId: row.employeeId, weekStart },
      });
      continue;
    }

    await client.weeklySchedule.upsert({
      where: {
        employeeId_weekStart: { employeeId: row.employeeId, weekStart },
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
  }
}
