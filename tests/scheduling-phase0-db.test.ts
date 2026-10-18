import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { CURRENT_STATUS } from "@prisma/client";
import { getExpectedShiftForDate } from "../src/lib/attendance";
import { buildAttendanceWorkdayWindow } from "../src/lib/attendance-workday";
import { getPrismaClient } from "../src/lib/prisma";
import { getScheduleSourceFingerprint } from "../src/lib/schedule-source-fingerprint";
import { normalizeWeekStart } from "../src/lib/week-planner";
import { persistWeekPlannerAssignments } from "../src/lib/week-planner-persistence";

if (!process.env.DATABASE_URL_TEST) {
  throw new Error("DATABASE_URL_TEST is required for scheduling DB tests");
}
if (process.env.DATABASE_URL !== process.env.DATABASE_URL_TEST) {
  throw new Error("Test runner must set DATABASE_URL to DATABASE_URL_TEST");
}

const prisma = getPrismaClient();
const fixtureTag = randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase();
const weekStart = normalizeWeekStart(new Date("2026-10-19T04:00:00.000Z"));
let employeeId = "";
let shiftIds: number[] = [];

before(async () => {
  const employee = await prisma.employee.create({
    data: {
      employeeCode: `P0-${fixtureTag}`,
      firstName: "Phase",
      lastName: "Zero Test",
      sex: "FEMALE",
      civilStatus: "SINGLE",
      birthdate: new Date("1990-01-01T00:00:00.000Z"),
      startDate: new Date("2020-01-01T00:00:00.000Z"),
      employmentStatus: "REGULAR",
      currentStatus: CURRENT_STATUS.ACTIVE,
    },
    select: { employeeId: true },
  });
  employeeId = employee.employeeId;

  const shifts = await Promise.all([
    prisma.shift.create({
      data: {
        code: `P0A-${fixtureTag}`,
        name: "Phase 0 Morning",
        startMinutes: 540,
        endMinutes: 1020,
        paidHoursPerDay: 8,
      },
      select: { id: true },
    }),
    prisma.shift.create({
      data: {
        code: `P0B-${fixtureTag}`,
        name: "Phase 0 Overnight",
        startMinutes: 1320,
        endMinutes: 420,
        paidHoursPerDay: 8,
        spansMidnight: true,
      },
      select: { id: true },
    }),
  ]);
  shiftIds = shifts.map((shift) => shift.id);
});

after(async () => {
  if (employeeId) {
    await prisma.employeeShiftOverride.deleteMany({ where: { employeeId } });
    await prisma.weeklySchedule.deleteMany({ where: { employeeId } });
    await prisma.employee.deleteMany({ where: { employeeId } });
  }
  if (shiftIds.length) {
    await prisma.shift.deleteMany({ where: { id: { in: shiftIds } } });
  }
  await prisma.$disconnect();
});

test("manual planner persistence keeps omitted days null and deletes all-null rows", async () => {
  await prisma.weeklySchedule.create({
    data: {
      employeeId,
      weekStart,
      monShiftId: shiftIds[0],
      tueShiftId: shiftIds[1],
    },
  });

  await persistWeekPlannerAssignments(prisma, weekStart, [
    { employeeId, days: { mon: shiftIds[0] } },
  ]);
  const saved = await prisma.weeklySchedule.findUnique({
    where: { employeeId_weekStart: { employeeId, weekStart } },
  });
  assert.equal(saved?.monShiftId, shiftIds[0]);
  assert.equal(saved?.tueShiftId, null);
  assert.equal(saved?.sunShiftId, null);

  await persistWeekPlannerAssignments(prisma, weekStart, [
    { employeeId, days: {} },
  ]);
  assert.equal(
    await prisma.weeklySchedule.findUnique({
      where: { employeeId_weekStart: { employeeId, weekStart } },
    }),
    null,
  );
});

test("source fingerprint detects weekly assignment and override changes", async () => {
  await prisma.weeklySchedule.create({
    data: { employeeId, weekStart, monShiftId: shiftIds[0] },
  });
  const initial = await getScheduleSourceFingerprint({
    employeeIds: [employeeId],
    weekStart,
  });

  await prisma.weeklySchedule.update({
    where: { employeeId_weekStart: { employeeId, weekStart } },
    data: { monShiftId: shiftIds[1] },
  });
  const afterScheduleChange = await getScheduleSourceFingerprint({
    employeeIds: [employeeId],
    weekStart,
  });
  assert.notEqual(initial, afterScheduleChange);

  await prisma.employeeShiftOverride.create({
    data: {
      employeeId,
      workDate: weekStart,
      shiftId: shiftIds[1],
      source: "MANUAL",
    },
  });
  const afterOverrideChange = await getScheduleSourceFingerprint({
    employeeIds: [employeeId],
    weekStart,
  });
  assert.notEqual(afterScheduleChange, afterOverrideChange);

  const effective = await getExpectedShiftForDate(employeeId, weekStart);
  assert.equal(effective.source, "override");
  assert.equal(effective.shift?.id, shiftIds[1]);
  assert.equal(effective.shift?.spansMidnight, true);
  const overnightWindow = buildAttendanceWorkdayWindow(weekStart, {
    startMinutes: effective.scheduledStartMinutes,
    endMinutes: effective.scheduledEndMinutes,
    spansMidnight: effective.shift?.spansMidnight ?? false,
  });
  assert.equal(overnightWindow.normalizedEndMinutes, 31 * 60);
});
