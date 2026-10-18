import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { CURRENT_STATUS, LeaveRequestStatus, LeaveRequestType, Prisma, Roles } from "@prisma/client";
import { getPrismaClient } from "../src/lib/prisma";
import {
  createScheduleDraft,
  discardScheduleDraft,
  discardScheduleDraftsForWeek,
  getScheduleDraftVersion,
  listScheduleDraftsForWeek,
  saveScheduleDraftVersion,
} from "../src/lib/schedule-draft-service";
import { toPlannerDateKey } from "../src/lib/week-planner";
import { normalizeWeekStart } from "../src/lib/week-planner";
import { startOfZonedDay } from "../src/lib/timezone";

if (!process.env.DATABASE_URL_TEST || process.env.DATABASE_URL !== process.env.DATABASE_URL_TEST) {
  throw new Error("Test runner must explicitly set DATABASE_URL_TEST to its selected database URL");
}

const prisma = getPrismaClient();
const fixtureTag = randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase();
const weekStart = normalizeWeekStart(new Date("2026-10-19T04:00:00.000Z"));
const referenceWeekStart = new Date(weekStart.getTime() - 7 * 24 * 60 * 60 * 1000);
const dateKey = (offset: number) => {
  const date = new Date(weekStart);
  date.setUTCDate(date.getUTCDate() + offset);
  return toPlannerDateKey(date);
};

let ownerUserId = "";
let employeeId = "";
let shiftIds: number[] = [];
let leaveRequestId = "";
const draftIds: string[] = [];
const requestKeys = [
  `phase1-${fixtureTag}-current`,
  `phase1-${fixtureTag}-reference`,
  `phase1-${fixtureTag}-save`,
];

before(async () => {
  const owner = await prisma.user.findFirst({
    where: { isDisabled: false, role: { in: [Roles.Admin, Roles.Manager] } },
    select: { userId: true },
  });
  if (!owner) throw new Error("Scheduling DB test requires an enabled Admin or Manager fixture");
  ownerUserId = owner.userId;

  const employee = await prisma.employee.create({
    data: {
      employeeCode: `P1-${fixtureTag}`,
      firstName: "Phase",
      lastName: "One Test",
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
        code: `P1A-${fixtureTag}`,
        name: "Phase 1 Morning",
        startMinutes: 540,
        endMinutes: 1020,
        paidHoursPerDay: new Prisma.Decimal(8),
      },
      select: { id: true },
    }),
    prisma.shift.create({
      data: {
        code: `P1B-${fixtureTag}`,
        name: "Phase 1 Evening",
        startMinutes: 1320,
        endMinutes: 420,
        spansMidnight: true,
        paidHoursPerDay: new Prisma.Decimal(8),
      },
      select: { id: true },
    }),
  ]);
  shiftIds = shifts.map(({ id }) => id);

  await prisma.weeklySchedule.createMany({
    data: [
      {
        employeeId,
        weekStart,
        monShiftId: shiftIds[0],
        tueShiftId: shiftIds[0],
        wedShiftId: shiftIds[0],
        thuShiftId: shiftIds[0],
      },
      {
        employeeId,
        weekStart: referenceWeekStart,
        monShiftId: shiftIds[1],
        tueShiftId: shiftIds[0],
        wedShiftId: shiftIds[1],
      },
    ],
  });
  await prisma.employeeShiftOverride.create({
    data: {
      employeeId,
      workDate: startOfZonedDay(new Date(`${dateKey(1)}T12:00:00.000Z`)),
      shiftId: shiftIds[1],
      source: "MANUAL",
    },
  });
  const leave = await prisma.leaveRequest.create({
    data: {
      employeeId,
      leaveType: LeaveRequestType.VACATION,
      startDate: startOfZonedDay(new Date(`${dateKey(2)}T12:00:00.000Z`)),
      endDate: startOfZonedDay(new Date(`${dateKey(2)}T12:00:00.000Z`)),
      status: LeaveRequestStatus.APPROVED,
    },
    select: { id: true },
  });
  leaveRequestId = leave.id;
});

after(async () => {
  if (draftIds.length) {
    await prisma.aiActionAudit.deleteMany({ where: { draftId: { in: draftIds } } });
    await prisma.aiScheduleDraft.deleteMany({ where: { id: { in: draftIds } } });
  }
  if (leaveRequestId) await prisma.leaveRequest.deleteMany({ where: { id: leaveRequestId } });
  if (employeeId) {
    await prisma.employeeShiftOverride.deleteMany({ where: { employeeId } });
    await prisma.weeklySchedule.deleteMany({ where: { employeeId } });
    await prisma.employee.deleteMany({ where: { employeeId } });
  }
  if (shiftIds.length) await prisma.shift.deleteMany({ where: { id: { in: shiftIds } } });
  await prisma.$disconnect();
});

test("draft creation, edits, idempotency, staleness, and discard never write live schedules", async () => {
  const originalLive = await prisma.weeklySchedule.findUniqueOrThrow({
    where: { employeeId_weekStart: { employeeId, weekStart } },
  });

  const current = await createScheduleDraft({
    requestKey: requestKeys[0],
    weekStart: "2026-10-19",
    departmentId: null,
    selectedEmployeeIds: [employeeId],
    sourceMode: "CURRENT_SCHEDULE",
    ownerUserId,
  });
  draftIds.push(current.id);
  assert.equal(current.assignments.length, 7);
  assert.equal(current.assignments[1].shiftId, shiftIds[1]);
  assert.equal(current.assignments[1].hasBaselineOverride, true);
  assert.equal(current.assignments[2].assignmentKind, "PROTECTED_LEAVE");
  assert.equal(current.assignments[2].shiftId, shiftIds[0]);

  const duplicateCreate = await createScheduleDraft({
    requestKey: requestKeys[0],
    weekStart: "2026-10-19",
    departmentId: null,
    selectedEmployeeIds: [employeeId],
    sourceMode: "EMPTY",
    ownerUserId,
  });
  assert.equal(duplicateCreate.id, current.id);

  const thursday = current.assignments.find((assignment) => assignment.workDate === dateKey(3));
  assert.ok(thursday);
  const editedAssignments = current.assignments.map((assignment) => assignment.workDate === dateKey(3)
    ? { ...assignment, shiftId: shiftIds[1], assignmentKind: "WORK" }
    : assignment);
  const version2 = await saveScheduleDraftVersion({
    requestKey: requestKeys[2],
    draftId: current.id,
    assignments: editedAssignments,
    ownerUserId,
  });
  draftIds.push(version2.id);
  assert.equal(version2.version, 2);
  assert.equal(version2.assignments.find((assignment) => assignment.workDate === dateKey(3))?.shiftId, shiftIds[1]);

  const duplicateSave = await saveScheduleDraftVersion({
    requestKey: requestKeys[2],
    draftId: current.id,
    assignments: current.assignments,
    ownerUserId,
  });
  assert.equal(duplicateSave.id, version2.id);

  const liveAfterDraftWrites = await prisma.weeklySchedule.findUniqueOrThrow({
    where: { employeeId_weekStart: { employeeId, weekStart } },
  });
  assert.deepEqual(liveAfterDraftWrites, originalLive);
  assert.equal(await prisma.employeeShiftOverride.count({ where: { employeeId } }), 1);

  const reference = await createScheduleDraft({
    requestKey: requestKeys[1],
    weekStart: "2026-10-19",
    referenceWeekStart: "2026-10-12",
    departmentId: null,
    selectedEmployeeIds: [employeeId],
    sourceMode: "REFERENCE_WEEK",
    ownerUserId,
  });
  draftIds.push(reference.id);
  assert.equal(reference.assignments[1].shiftId, shiftIds[1]);
  assert.equal(reference.assignments[1].source, "CURRENT_SCHEDULE");

  await prisma.weeklySchedule.update({
    where: { employeeId_weekStart: { employeeId, weekStart } },
    data: { friShiftId: shiftIds[1] },
  });
  const stale = await getScheduleDraftVersion({ draftId: version2.id, ownerUserId });
  assert.equal(stale.isSourceStale, true);

  const groups = await listScheduleDraftsForWeek({ weekStart: "2026-10-19", ownerUserId });
  assert.equal(groups.length, 2);
  const currentLineage = groups.find((group) => group.latest.lineageId === current.lineageId);
  assert.equal(currentLineage?.latest.id, version2.id);
  assert.equal(currentLineage?.versions.length, 2);
  assert.equal(groups.find((group) => group.latest.id === reference.id)?.latest.version, 1);

  await discardScheduleDraft({ draftId: reference.id, ownerUserId });
  const discarded = await getScheduleDraftVersion({ draftId: reference.id, ownerUserId });
  assert.equal(discarded.status, "DISCARDED");
  const historyAfterSingleDiscard = await listScheduleDraftsForWeek({ weekStart: "2026-10-19", ownerUserId });
  assert.equal(historyAfterSingleDiscard.some((group) => group.latest.lineageId === discarded.lineageId), false);

  const bulkResult = await discardScheduleDraftsForWeek({ weekStart: "2026-10-19", ownerUserId });
  assert.equal(bulkResult.discardedCount, 1);
  const historyAfterBulkDiscard = await listScheduleDraftsForWeek({ weekStart: "2026-10-19", ownerUserId });
  assert.equal(historyAfterBulkDiscard.length, 0);
  const discardedCurrent = await getScheduleDraftVersion({ draftId: version2.id, ownerUserId });
  assert.equal(discardedCurrent.status, "DISCARDED");
});
