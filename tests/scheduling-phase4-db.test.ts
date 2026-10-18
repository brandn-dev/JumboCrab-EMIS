import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { CURRENT_STATUS, Roles } from "@prisma/client";
import {
  approveScheduleDraft,
  publishScheduleDraft,
  retrySchedulePublicationNotification,
  SchedulePolicyServiceError,
  validateScheduleDraft,
} from "../src/lib/schedule-policy-service";
import { createScheduleDraft, saveScheduleDraftVersion } from "../src/lib/schedule-draft-service";
import { getPrismaClient } from "../src/lib/prisma";
import { getWeekDates, normalizeWeekStart, toPlannerDateKey } from "../src/lib/week-planner";
import { startOfZonedDay } from "../src/lib/timezone";

if (!process.env.DATABASE_URL_TEST || process.env.DATABASE_URL !== process.env.DATABASE_URL_TEST) {
  throw new Error("Test runner must explicitly set DATABASE_URL_TEST to its selected database URL");
}

const prisma = getPrismaClient();
const fixtureTag = randomUUID().replaceAll("-", "").slice(0, 14).toUpperCase();
const weekStart = normalizeWeekStart(new Date("2026-10-19T04:00:00.000Z"));
const dateByDay = new Map(getWeekDates(weekStart).map(({ dayKey, date }) => [dayKey, toPlannerDateKey(date)]));
const fixtureUsers: string[] = [];
const fixtureDrafts: string[] = [];
let employeeId = "";
let employeeUserId = "";
let managerUserId = "";
let otherManagerUserId = "";
let departmentId = "";
let positionId = "";
let coverageRuleId = "";
let shiftIds: number[] = [];
let publishedDraftId = "";

const createUser = async (suffix: string, role: Roles) => {
  const user = await prisma.user.create({
    data: {
      username: `p4-${suffix}-${fixtureTag}`.toLowerCase(),
      email: `p4-${suffix}-${fixtureTag.toLowerCase()}@example.test`,
      password: "phase4-test-only",
      salt: "phase4-test-only",
      role,
    },
    select: { userId: true },
  });
  fixtureUsers.push(user.userId);
  return user.userId;
};

const makeDraft = async () => {
  const draft = await createScheduleDraft({
    requestKey: randomUUID(),
    weekStart: toPlannerDateKey(weekStart),
    departmentId,
    sourceMode: "CURRENT_SCHEDULE",
    ownerUserId: managerUserId,
  });
  fixtureDrafts.push(draft.id);
  return draft;
};

before(async () => {
  managerUserId = await createUser("manager", Roles.Manager);
  otherManagerUserId = await createUser("other-manager", Roles.Manager);
  employeeUserId = await createUser("employee", Roles.Employee);

  const department = await prisma.department.create({ data: { name: `P4 ${fixtureTag}` }, select: { departmentId: true } });
  departmentId = department.departmentId;
  const position = await prisma.position.create({
    data: { name: `P4 role ${fixtureTag}`, departmentId },
    select: { positionId: true },
  });
  positionId = position.positionId;
  const employee = await prisma.employee.create({
    data: {
      employeeCode: `P4-${fixtureTag}`,
      firstName: "Phase",
      lastName: "Four",
      sex: "FEMALE",
      civilStatus: "SINGLE",
      birthdate: new Date("1990-01-01T00:00:00.000Z"),
      startDate: new Date("2020-01-01T00:00:00.000Z"),
      employmentStatus: "REGULAR",
      currentStatus: CURRENT_STATUS.ACTIVE,
      departmentId,
      positionId,
      userId: employeeUserId,
    },
    select: { employeeId: true },
  });
  employeeId = employee.employeeId;

  const shifts = await Promise.all([
    prisma.shift.create({ data: { code: `P4A-${fixtureTag}`, name: "Phase 4 Day", startMinutes: 540, endMinutes: 1020, paidHoursPerDay: 8 }, select: { id: true } }),
    prisma.shift.create({ data: { code: `P4B-${fixtureTag}`, name: "Phase 4 Alternate", startMinutes: 600, endMinutes: 1080, paidHoursPerDay: 8 }, select: { id: true } }),
  ]);
  shiftIds = shifts.map((shift) => shift.id);

  await prisma.weeklySchedule.create({
    data: {
      employeeId,
      weekStart,
      monShiftId: shiftIds[0],
      tueShiftId: shiftIds[0],
      wedShiftId: shiftIds[0],
      thuShiftId: shiftIds[0],
      friShiftId: shiftIds[0],
      satShiftId: shiftIds[0],
      sunShiftId: shiftIds[0],
    },
  });
  await prisma.employeeShiftOverride.create({
    data: { employeeId, workDate: startOfZonedDay(new Date(`${dateByDay.get("wed")}T12:00:00.000Z`)), shiftId: shiftIds[1], source: "MANUAL" },
  });
  const rule = await prisma.scheduleCoverageRule.create({
    data: {
      name: `P4 soft minimum ${fixtureTag}`,
      departmentId,
      positionId,
      shiftId: shiftIds[1],
      weekday: 1,
      minimumStaff: 1,
      priority: "SOFT",
      createdByUserId: managerUserId,
    },
    select: { id: true },
  });
  coverageRuleId = rule.id;
});

after(async () => {
  if (fixtureDrafts.length) {
    await prisma.aiActionAudit.deleteMany({ where: { draftId: { in: fixtureDrafts } } });
    await prisma.schedulePublicationOutbox.deleteMany({ where: { draftId: { in: fixtureDrafts } } });
    await prisma.aiScheduleDraft.deleteMany({ where: { id: { in: fixtureDrafts } } });
  }
  if (publishedDraftId) {
    await prisma.notification.deleteMany({ where: { dedupeKey: `schedule-publication:${publishedDraftId}` } });
  }
  if (coverageRuleId) await prisma.scheduleCoverageRule.deleteMany({ where: { id: coverageRuleId } });
  if (employeeId) {
    await prisma.employeeShiftOverride.deleteMany({ where: { employeeId } });
    await prisma.weeklySchedule.deleteMany({ where: { employeeId } });
    await prisma.employee.deleteMany({ where: { employeeId } });
  }
  if (shiftIds.length) await prisma.shift.deleteMany({ where: { id: { in: shiftIds } } });
  if (positionId) await prisma.position.deleteMany({ where: { positionId } });
  if (departmentId) await prisma.department.deleteMany({ where: { departmentId } });
  if (fixtureUsers.length) await prisma.user.deleteMany({ where: { userId: { in: fixtureUsers } } });
  await prisma.$disconnect();
});

test("validation requires warning acknowledgment and stale live sources prevent approval flow from publishing", async () => {
  const draft = await makeDraft();
  const validation = await validateScheduleDraft({ draftId: draft.id, ownerUserId: managerUserId, actorUserId: managerUserId });
  assert.equal(validation.isValid, true);
  assert.equal(validation.warningCount, 1);
  assert.equal(validation.draft.status, "VALIDATED");
  assert.equal(validation.draft.assignments.find((assignment) => assignment.workDate === dateByDay.get("wed"))?.shiftId, shiftIds[1]);
  await assert.rejects(
    approveScheduleDraft({ draftId: draft.id, ownerUserId: otherManagerUserId, actorUserId: otherManagerUserId, acknowledgeWarnings: true }),
    (error: unknown) => error instanceof SchedulePolicyServiceError && /Draft not found/.test(error.message),
  );

  await assert.rejects(
    approveScheduleDraft({ draftId: draft.id, ownerUserId: managerUserId, actorUserId: managerUserId, acknowledgeWarnings: false }),
    (error: unknown) => error instanceof SchedulePolicyServiceError && /Acknowledge/.test(error.message),
  );
  await approveScheduleDraft({ draftId: draft.id, ownerUserId: managerUserId, actorUserId: managerUserId, acknowledgeWarnings: true });
  const approvedLiveRow = await prisma.weeklySchedule.findUniqueOrThrow({
    where: { employeeId_weekStart: { employeeId, weekStart } },
  });
  assert.deepEqual(
    [approvedLiveRow.monShiftId, approvedLiveRow.tueShiftId, approvedLiveRow.wedShiftId, approvedLiveRow.thuShiftId, approvedLiveRow.friShiftId, approvedLiveRow.satShiftId, approvedLiveRow.sunShiftId],
    Array.from({ length: 7 }, () => shiftIds[0]),
    "draft creation, validation, and approval must leave live schedules untouched",
  );

  await prisma.weeklySchedule.update({
    where: { employeeId_weekStart: { employeeId, weekStart } },
    data: { tueShiftId: shiftIds[1] },
  });
  await assert.rejects(
    publishScheduleDraft({ draftId: draft.id, ownerUserId: managerUserId, actorUserId: managerUserId, confirmed: true }),
    (error: unknown) => error instanceof SchedulePolicyServiceError && /changed after validation/.test(error.message),
  );
  const live = await prisma.weeklySchedule.findUniqueOrThrow({ where: { employeeId_weekStart: { employeeId, weekStart } } });
  assert.equal(live.tueShiftId, shiftIds[1], "stale rejection must leave the external live edit untouched");
  assert.equal((await prisma.aiScheduleDraft.findUniqueOrThrow({ where: { id: draft.id } })).status, "APPROVED");
  assert.equal(await prisma.schedulePublicationOutbox.count({ where: { draftId: draft.id } }), 0);
});

test("approved publication writes the full week, preserves overrides, and sends one idempotent notification", async () => {
  const draft = await makeDraft();
  const manualAssignments = draft.assignments.map((assignment) => assignment.workDate === dateByDay.get("thu")
    ? { ...assignment, shiftId: shiftIds[1], assignmentKind: "WORK" }
    : assignment);
  const edited = await saveScheduleDraftVersion({
    requestKey: randomUUID(),
    draftId: draft.id,
    ownerUserId: managerUserId,
    changeSource: "MANUAL",
    assignments: manualAssignments.map(({ employeeId: assignedEmployeeId, workDate, shiftId, assignmentKind }) => ({
      employeeId: assignedEmployeeId,
      workDate,
      shiftId,
      assignmentKind,
    })),
  });
  fixtureDrafts.push(edited.id);

  const validation = await validateScheduleDraft({ draftId: edited.id, ownerUserId: managerUserId, actorUserId: managerUserId });
  assert.equal(validation.isValid, true);
  assert.equal(validation.warningCount, 1);
  const approved = await approveScheduleDraft({
    draftId: edited.id,
    ownerUserId: managerUserId,
    actorUserId: managerUserId,
    acknowledgeWarnings: true,
  });
  assert.equal(approved.status, "APPROVED");

  const published = await publishScheduleDraft({ draftId: edited.id, ownerUserId: managerUserId, actorUserId: managerUserId, confirmed: true });
  publishedDraftId = edited.id;
  assert.equal(published.draft.status, "PUBLISHED");
  assert.equal(published.notificationStatus, "DELIVERED");

  const live = await prisma.weeklySchedule.findUniqueOrThrow({ where: { employeeId_weekStart: { employeeId, weekStart } } });
  assert.deepEqual(
    [live.monShiftId, live.tueShiftId, live.wedShiftId, live.thuShiftId, live.friShiftId, live.satShiftId, live.sunShiftId],
    [shiftIds[0], shiftIds[1], shiftIds[0], shiftIds[1], shiftIds[0], shiftIds[0], shiftIds[0]],
  );
  const override = await prisma.employeeShiftOverride.findUniqueOrThrow({
    where: { employeeId_workDate: { employeeId, workDate: startOfZonedDay(new Date(`${dateByDay.get("wed")}T12:00:00.000Z`)) } },
  });
  assert.equal(override.shiftId, shiftIds[1]);

  const outbox = await prisma.schedulePublicationOutbox.findUniqueOrThrow({ where: { draftId: edited.id } });
  assert.equal(outbox.status, "DELIVERED");
  assert.equal(outbox.attempts, 1);
  await retrySchedulePublicationNotification({ draftId: edited.id, ownerUserId: managerUserId });
  await publishScheduleDraft({ draftId: edited.id, ownerUserId: managerUserId, actorUserId: managerUserId, confirmed: true });
  assert.equal(await prisma.notification.count({ where: { dedupeKey: `schedule-publication:${edited.id}` } }), 1);
  assert.equal(await prisma.userNotification.count({ where: { userId: employeeUserId, notification: { dedupeKey: `schedule-publication:${edited.id}` } } }), 1);
});

test("a database failure after schedule writes rolls back the publication transaction", async () => {
  const draft = await makeDraft();
  const validation = await validateScheduleDraft({ draftId: draft.id, ownerUserId: managerUserId, actorUserId: managerUserId });
  assert.equal(validation.isValid, true);
  await approveScheduleDraft({
    draftId: draft.id,
    ownerUserId: managerUserId,
    actorUserId: managerUserId,
    acknowledgeWarnings: validation.warningCount > 0,
  });

  const before = await prisma.weeklySchedule.findUniqueOrThrow({
    where: { employeeId_weekStart: { employeeId, weekStart } },
  });
  const triggerName = `p4_fail_${fixtureTag.toLowerCase()}`;
  const functionName = `${triggerName}_fn`;
  try {
    await prisma.$executeRawUnsafe(`CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."id" = '${draft.id}' AND NEW."status"::text = 'PUBLISHED' THEN RAISE EXCEPTION 'phase4 simulated database failure'; END IF; RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER "${triggerName}" BEFORE UPDATE OF "status" ON "AiScheduleDraft" FOR EACH ROW EXECUTE FUNCTION "${functionName}"()`);
    await assert.rejects(
      publishScheduleDraft({ draftId: draft.id, ownerUserId: managerUserId, actorUserId: managerUserId, confirmed: true }),
      /phase4 simulated database failure/i,
    );
  } finally {
    await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "AiScheduleDraft"`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`);
  }

  const after = await prisma.weeklySchedule.findUniqueOrThrow({
    where: { employeeId_weekStart: { employeeId, weekStart } },
  });
  assert.deepEqual(
    [after.monShiftId, after.tueShiftId, after.wedShiftId, after.thuShiftId, after.friShiftId, after.satShiftId, after.sunShiftId],
    [before.monShiftId, before.tueShiftId, before.wedShiftId, before.thuShiftId, before.friShiftId, before.satShiftId, before.sunShiftId],
  );
  assert.equal((await prisma.aiScheduleDraft.findUniqueOrThrow({ where: { id: draft.id } })).status, "APPROVED");
  assert.equal(await prisma.schedulePublicationOutbox.count({ where: { draftId: draft.id } }), 0);
});

test("optimistic draft saves reject stale versions and changed live sources, and repeat request stays idempotent", async () => {
  const draft = await makeDraft();
  const requestKey = randomUUID();
  const assignments = draft.assignments.map((assignment) => assignment.workDate === dateByDay.get("mon")
    ? { ...assignment, shiftId: shiftIds[1], assignmentKind: "WORK" }
    : assignment);
  const firstSave = await saveScheduleDraftVersion({
    requestKey,
    draftId: draft.id,
    ownerUserId: managerUserId,
    changeSource: "AI",
    expectedVersion: draft.version,
    expectedDraftFingerprint: draft.draftFingerprint,
    expectedSourceFingerprint: draft.sourceFingerprint,
    assignments,
  });
  fixtureDrafts.push(firstSave.id);

  const replay = await saveScheduleDraftVersion({
    requestKey,
    draftId: draft.id,
    ownerUserId: managerUserId,
    changeSource: "AI",
    expectedVersion: draft.version,
    expectedDraftFingerprint: draft.draftFingerprint,
    expectedSourceFingerprint: draft.sourceFingerprint,
    assignments,
  });
  assert.equal(replay.id, firstSave.id);
  assert.equal(replay.version, firstSave.version);

  await assert.rejects(
    saveScheduleDraftVersion({
      requestKey: randomUUID(),
      draftId: draft.id,
      ownerUserId: managerUserId,
      changeSource: "AI",
      expectedVersion: draft.version,
      expectedDraftFingerprint: draft.draftFingerprint,
      expectedSourceFingerprint: draft.sourceFingerprint,
      assignments,
    }),
    /newer draft version exists/i,
  );

  await prisma.weeklySchedule.update({
    where: { employeeId_weekStart: { employeeId, weekStart } },
    data: { friShiftId: shiftIds[1] },
  });
  const changedAssignments = firstSave.assignments.map((assignment) => assignment.workDate === dateByDay.get("tue")
    ? { ...assignment, shiftId: shiftIds[0] === assignment.shiftId ? shiftIds[1] : shiftIds[0], assignmentKind: "WORK" }
    : assignment);
  await assert.rejects(
    saveScheduleDraftVersion({
      requestKey: randomUUID(),
      draftId: firstSave.id,
      ownerUserId: managerUserId,
      changeSource: "AI",
      expectedVersion: firstSave.version,
      expectedDraftFingerprint: firstSave.draftFingerprint,
      expectedSourceFingerprint: firstSave.sourceFingerprint,
      assignments: changedAssignments,
    }),
    /live schedules, overrides, or approved leave changed after this proposal/i,
  );
});
