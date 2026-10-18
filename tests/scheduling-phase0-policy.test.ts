import assert from "node:assert/strict";
import test from "node:test";
import {
  assertScheduleRole,
  canReadEmployeeSchedule,
  resolveScheduleActor,
  SCHEDULE_MANAGER_ROLES,
} from "../src/lib/scheduling-access";
import { isAiSchedulingFlagEnabled } from "../src/lib/ai-scheduling-feature-policy";
import { createScheduleSourceFingerprint } from "../src/lib/schedule-fingerprint";
import {
  getWeekDates,
  parsePlannerDateInput,
  parseWeekStartInput,
  toPlannerDateKey,
} from "../src/lib/week-planner";
import { buildWeekShiftMap } from "../src/lib/week-planner-persistence";

test("schedule actor uses current database role and rejects missing or disabled accounts", () => {
  const staleSession = {
    isLoggedIn: true,
    userId: "user-1",
    role: "Manager",
  };
  const currentEmployee = resolveScheduleActor(staleSession, {
    userId: "user-1",
    role: "Employee",
    isDisabled: false,
    employeeId: "employee-1",
  });

  assert.equal(currentEmployee.actor?.role, "employee");
  assert.throws(
    () => assertScheduleRole(currentEmployee.actor!, SCHEDULE_MANAGER_ROLES),
    { message: "Forbidden" },
  );
  assert.deepEqual(
    resolveScheduleActor({ isLoggedIn: false, userId: "user-1" }, null),
    { actor: null, error: "Unauthorized" },
  );
  assert.deepEqual(
    resolveScheduleActor({ isLoggedIn: true, userId: "user-1" }, {
      userId: "user-1",
      role: "Manager",
      isDisabled: true,
    }),
    { actor: null, error: "Unauthorized" },
  );
});

test("scheduling role policy keeps manager access and denies general manager", () => {
  const manager = resolveScheduleActor(
    { isLoggedIn: true, userId: "manager-1" },
    { userId: "manager-1", role: "Manager", isDisabled: false },
  ).actor!;
  const admin = resolveScheduleActor(
    { isLoggedIn: true, userId: "admin-1" },
    { userId: "admin-1", role: "Admin", isDisabled: false },
  ).actor!;
  const generalManager = resolveScheduleActor(
    { isLoggedIn: true, userId: "gm-1" },
    { userId: "gm-1", role: "GeneralManager", isDisabled: false },
  ).actor!;
  const supervisor = resolveScheduleActor(
    { isLoggedIn: true, userId: "supervisor-1" },
    { userId: "supervisor-1", role: "Supervisor", isDisabled: false },
  ).actor!;
  const employee = resolveScheduleActor(
    { isLoggedIn: true, userId: "employee-1" },
    { userId: "employee-1", role: "Employee", isDisabled: false },
  ).actor!;

  assert.doesNotThrow(() => assertScheduleRole(manager, SCHEDULE_MANAGER_ROLES));
  assert.doesNotThrow(() => assertScheduleRole(admin, SCHEDULE_MANAGER_ROLES));
  assert.throws(
    () => assertScheduleRole(generalManager, SCHEDULE_MANAGER_ROLES),
    { message: "Forbidden" },
  );
  assert.throws(
    () => assertScheduleRole(supervisor, SCHEDULE_MANAGER_ROLES),
    { message: "Forbidden" },
  );
  assert.throws(
    () => assertScheduleRole(employee, SCHEDULE_MANAGER_ROLES),
    { message: "Forbidden" },
  );
});

test("employee schedule reads stay self-scoped and supervisors stay team-scoped", () => {
  const employee = resolveScheduleActor(
    { isLoggedIn: true, userId: "employee-user" },
    {
      userId: "employee-user",
      role: "Employee",
      isDisabled: false,
      employeeId: "employee-1",
    },
  ).actor!;
  const supervisor = resolveScheduleActor(
    { isLoggedIn: true, userId: "supervisor-user" },
    { userId: "supervisor-user", role: "Supervisor", isDisabled: false },
  ).actor!;
  const target = { userId: "employee-user", supervisorUserId: "supervisor-user" };

  assert.equal(canReadEmployeeSchedule(employee, target), true);
  assert.equal(
    canReadEmployeeSchedule(employee, { userId: "someone-else", supervisorUserId: null }),
    false,
  );
  assert.equal(canReadEmployeeSchedule(supervisor, target), true);
  assert.equal(
    canReadEmployeeSchedule(supervisor, { userId: "employee-user", supervisorUserId: "other" }),
    false,
  );
});

test("AI scheduling feature flag fails closed unless exactly enabled", () => {
  assert.equal(isAiSchedulingFlagEnabled(undefined), false);
  assert.equal(isAiSchedulingFlagEnabled("false"), false);
  assert.equal(isAiSchedulingFlagEnabled("TRUE"), false);
  assert.equal(isAiSchedulingFlagEnabled("true"), true);
});

test("week parsing rejects invalid dates and keeps Manila Monday week boundaries", () => {
  assert.equal(parsePlannerDateInput("2026-02-30"), null);
  assert.equal(parseWeekStartInput("not-a-date"), null);

  const weekStart = parseWeekStartInput("2026-10-18");
  assert.ok(weekStart);
  assert.equal(toPlannerDateKey(weekStart), "2026-10-12");
  assert.deepEqual(
    getWeekDates(weekStart).map(({ date }) => toPlannerDateKey(date)),
    [
      "2026-10-12",
      "2026-10-13",
      "2026-10-14",
      "2026-10-15",
      "2026-10-16",
      "2026-10-17",
      "2026-10-18",
    ],
  );
});

test("partial planner maps preserve established omitted-day null semantics", () => {
  assert.deepEqual(buildWeekShiftMap({ mon: 12, wed: 18 }), {
    mon: 12,
    tue: null,
    wed: 18,
    thu: null,
    fri: null,
    sat: null,
    sun: null,
  });
});

test("schedule fingerprint is order-independent and changes with source values", () => {
  const date = new Date("2026-10-12T16:00:00.000Z");
  const updatedAt = new Date("2026-10-10T10:00:00.000Z");
  const schedule = (employeeId: string, monShiftId: number) => ({
    employeeId,
    weekStart: date,
    updatedAt,
    monShiftId,
    tueShiftId: null,
    wedShiftId: null,
    thuShiftId: null,
    friShiftId: null,
    satShiftId: null,
    sunShiftId: null,
  });
  const override = {
    employeeId: "employee-a",
    workDate: date,
    shiftId: 22,
    source: "MANUAL",
    updatedAt,
  };
  const first = createScheduleSourceFingerprint({
    weeklySchedules: [schedule("employee-b", 11), schedule("employee-a", 10)],
    overrides: [override],
  });
  const reordered = createScheduleSourceFingerprint({
    weeklySchedules: [schedule("employee-a", 10), schedule("employee-b", 11)],
    overrides: [override],
  });
  const changed = createScheduleSourceFingerprint({
    weeklySchedules: [schedule("employee-a", 12), schedule("employee-b", 11)],
    overrides: [override],
  });

  assert.equal(first, reordered);
  assert.notEqual(first, changed);
});

test("schedule source fingerprint includes roster, shift and coverage policy inputs", () => {
  const updatedAt = new Date("2026-10-10T10:00:00.000Z");
  const employee = (employeeId: string) => ({
    employeeId,
    departmentId: "department-a",
    positionId: "position-a",
    isArchived: false,
    currentStatus: "ACTIVE",
    updatedAt,
  });
  const shift = (startMinutes: number) => ({
    id: 11,
    isActive: true,
    isDayOff: false,
    startMinutes,
    endMinutes: 1020,
    spansMidnight: false,
    paidHoursPerDay: "8.00",
    updatedAt,
  });
  const rule = (minimumStaff: number) => ({
    id: "rule-a",
    name: "Kitchen morning minimum",
    departmentId: "department-a",
    positionId: "position-a",
    shiftId: 11,
    weekday: 1,
    minimumStaff,
    maximumStaff: null,
    priority: "SOFT",
    isActive: true,
    effectiveFrom: null,
    effectiveTo: null,
    updatedAt,
  });
  const base = {
    weeklySchedules: [],
    overrides: [],
    employees: [employee("employee-a")],
    rosterEmployees: [employee("employee-a"), employee("employee-b")],
    shifts: [shift(540)],
    coverageRules: [rule(2)],
    scope: { selectionMode: "DEPARTMENT" as const, departmentId: "department-a" },
  };
  const initial = createScheduleSourceFingerprint(base);
  const reordered = createScheduleSourceFingerprint({
    ...base,
    employees: [...base.employees].reverse(),
    rosterEmployees: [...base.rosterEmployees].reverse(),
    shifts: [...base.shifts].reverse(),
    coverageRules: [...base.coverageRules].reverse(),
  });

  assert.equal(initial, reordered);
  assert.notEqual(initial, createScheduleSourceFingerprint({ ...base, rosterEmployees: [...base.rosterEmployees, employee("employee-c")] }));
  assert.notEqual(initial, createScheduleSourceFingerprint({ ...base, shifts: [shift(600)] }));
  assert.notEqual(initial, createScheduleSourceFingerprint({ ...base, coverageRules: [rule(3)] }));
});
