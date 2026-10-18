import assert from "node:assert/strict";
import test from "node:test";
import { parseWeekStartInput, getWeekDates, toPlannerDateKey } from "@/lib/week-planner";
import { generateScheduleFromReference } from "@/lib/schedule-generator";
import {
  validateSchedule,
  type ScheduleCoverageRuleInput,
  type SchedulePolicyAssignment,
  type SchedulePolicyContext,
} from "@/lib/schedule-validation";

const weekStart = parseWeekStartInput("2026-10-19")!;
const weekDates = getWeekDates(weekStart).map(({ date }) => toPlannerDateKey(date));

const employees = [
  { employeeId: "e1", departmentId: "d1", positionId: "p1", isActive: true },
  { employeeId: "e2", departmentId: "d1", positionId: "p1", isActive: true },
  { employeeId: "e3", departmentId: "d1", positionId: "p1", isActive: true },
];

const shifts = [
  { id: 10, isActive: true, isDayOff: false, startMinutes: 540, endMinutes: 1020, spansMidnight: false, paidHoursPerDay: 8 },
  { id: 11, isActive: true, isDayOff: false, startMinutes: 1320, endMinutes: 420, spansMidnight: true, paidHoursPerDay: 8 },
  { id: 12, isActive: true, isDayOff: true, startMinutes: 0, endMinutes: 0, spansMidnight: false, paidHoursPerDay: 0 },
  { id: 13, isActive: false, isDayOff: false, startMinutes: 600, endMinutes: 1080, spansMidnight: false, paidHoursPerDay: 8 },
  { id: 14, isActive: true, isDayOff: false, startMinutes: 300, endMinutes: 780, spansMidnight: false, paidHoursPerDay: 8 },
];

const makeAssignment = (
  employeeId: string,
  workDate: string,
  overrides: Partial<SchedulePolicyAssignment> = {},
): SchedulePolicyAssignment => ({
  employeeId,
  workDate,
  shiftId: null,
  assignmentKind: "UNASSIGNED",
  isProtected: false,
  hasBaselineOverride: false,
  baselineOverrideShiftId: null,
  ...overrides,
});

const completeAssignments = (ids = employees.map(({ employeeId }) => employeeId)) =>
  ids.flatMap((employeeId) => weekDates.map((workDate) => makeAssignment(employeeId, workDate)));

const context = (overrides: Partial<SchedulePolicyContext> = {}): SchedulePolicyContext => ({
  weekStart,
  employees,
  shifts,
  rules: [],
  assignments: completeAssignments(),
  approvedLeaveKeys: [],
  isSourceStale: false,
  ...overrides,
});

const rule = (overrides: Partial<ScheduleCoverageRuleInput> = {}): ScheduleCoverageRuleInput => ({
  id: "rule-1",
  name: "Kitchen morning coverage",
  departmentId: "d1",
  positionId: "p1",
  shiftId: 10,
  weekday: 1,
  minimumStaff: 2,
  maximumStaff: null,
  priority: "HARD",
  isActive: true,
  effectiveFrom: null,
  effectiveTo: null,
  ...overrides,
});

test("reports unconfigured rules and policies without treating coverage as passed", () => {
  const issues = validateSchedule(context());
  assert.ok(issues.some((issue) => issue.code === "COVERAGE_RULES_NOT_CONFIGURED" && issue.severity === "INFO"));
  assert.ok(issues.some((issue) => issue.code === "REST_POLICY_NOT_CONFIGURED"));
  assert.ok(issues.some((issue) => issue.code === "WEEKLY_HOURS_POLICY_NOT_CONFIGURED"));
  assert.equal(issues.some((issue) => issue.code === "COVERAGE_RULES_PASSED"), false);
});

test("blocks a complete coverage claim for a selected partial employee scope", () => {
  const issues = validateSchedule(context({ scopeIsComplete: false, rules: [rule({ minimumStaff: 0 })] }));
  assert.ok(issues.some((issue) => issue.code === "COVERAGE_SCOPE_INCOMPLETE" && issue.severity === "BLOCKER"));
});

test("blocks missing cells, stale source, approved leave work, and changed target overrides", () => {
  const assignments = completeAssignments();
  assignments.pop();
  assignments[0] = makeAssignment("e1", weekDates[0], {
    shiftId: 10,
    assignmentKind: "WORK",
    hasBaselineOverride: true,
    baselineOverrideShiftId: 11,
  });
  assignments[1] = makeAssignment("e1", weekDates[1], {
    shiftId: 10,
    assignmentKind: "WORK",
  });
  const issues = validateSchedule(context({
    assignments,
    approvedLeaveKeys: [`e1:${weekDates[1]}`],
    isSourceStale: true,
  }));
  assert.ok(issues.some((issue) => issue.code === "ASSIGNMENT_MISSING"));
  assert.ok(issues.some((issue) => issue.code === "SOURCE_STALE"));
  assert.ok(issues.some((issue) => issue.code === "APPROVED_LEAVE_CONFLICT"));
  assert.ok(issues.some((issue) => issue.code === "OVERRIDE_NOT_PRESERVED"));
});

test("coverage minimum blocks for hard rules and warns for soft rules", () => {
  const assignments = completeAssignments();
  assignments[0] = makeAssignment("e1", weekDates[0], { shiftId: 10, assignmentKind: "WORK" });
  const hardIssues = validateSchedule(context({ assignments, rules: [rule()] }));
  assert.ok(hardIssues.some((issue) => issue.code === "COVERAGE_MINIMUM_NOT_MET" && issue.severity === "BLOCKER"));

  const softIssues = validateSchedule(context({ assignments, rules: [rule({ priority: "SOFT" })] }));
  assert.ok(softIssues.some((issue) => issue.code === "COVERAGE_MINIMUM_NOT_MET" && issue.severity === "WARNING"));
});

test("blocks inactive employees and inactive shifts; coverage scope follows employee position", () => {
  const assignments = completeAssignments();
  assignments[0] = makeAssignment("e1", weekDates[0], { shiftId: 13, assignmentKind: "WORK" });
  const scopedRule = rule({ positionId: "p2", minimumStaff: 1 });
  const issues = validateSchedule(context({
    assignments,
    employees: employees.map((employee) => employee.employeeId === "e1" ? { ...employee, isActive: false } : employee),
    rules: [scopedRule],
  }));
  assert.ok(issues.some((issue) => issue.code === "EMPLOYEE_INACTIVE"));
  assert.ok(issues.some((issue) => issue.code === "SHIFT_INACTIVE"));
  assert.ok(issues.some((issue) => issue.code === "COVERAGE_SCOPE_HAS_NO_EMPLOYEES" && issue.ruleId === scopedRule.id));
  assert.ok(issues.some((issue) => issue.code === "POSITION_SHIFT_ELIGIBILITY_NOT_CONFIGURED"));
});

test("checks overlapping overnight work across the Monday week boundary", () => {
  const assignments = completeAssignments();
  assignments[0] = makeAssignment("e1", weekDates[0], { shiftId: 14, assignmentKind: "WORK" });
  const issues = validateSchedule(context({
    assignments,
    boundaryAssignments: [makeAssignment("e1", "2026-10-18", { shiftId: 11, assignmentKind: "WORK" })],
  }));
  assert.ok(issues.some((issue) => issue.code === "SHIFT_OVERLAP" && issue.workDate === weekDates[0]));
});

test("checks an overnight Sunday draft shift against the following Monday schedule", () => {
  const assignments = completeAssignments();
  assignments[assignments.findIndex((assignment) => assignment.employeeId === "e1" && assignment.workDate === weekDates[6])] = makeAssignment("e1", weekDates[6], {
    shiftId: 11,
    assignmentKind: "WORK",
  });
  const issues = validateSchedule(context({
    assignments,
    boundaryAssignments: [makeAssignment("e1", "2026-10-26", { shiftId: 14, assignmentKind: "WORK" })],
  }));
  assert.ok(issues.some((issue) => issue.code === "SHIFT_OVERLAP" && issue.workDate === weekDates[6]));
});

test("checks a configured rest period and weekly paid-hours limit without choosing defaults", () => {
  const assignments = completeAssignments();
  for (const date of weekDates.slice(0, 5)) {
    const index = assignments.findIndex((assignment) => assignment.employeeId === "e1" && assignment.workDate === date);
    assignments[index] = makeAssignment("e1", date, { shiftId: 10, assignmentKind: "WORK" });
  }
  const issues = validateSchedule(context({
    assignments,
    boundaryAssignments: [makeAssignment("e1", "2026-10-18", { shiftId: 11, assignmentKind: "WORK" })],
    minimumRestMinutes: 180,
    maximumWeeklyPaidHours: 35,
  }));
  assert.ok(issues.some((issue) => issue.code === "INSUFFICIENT_CONFIGURED_REST"));
  assert.ok(issues.some((issue) => issue.code === "MAX_WEEKLY_HOURS_EXCEEDED"));
  assert.equal(issues.some((issue) => issue.code === "REST_POLICY_NOT_CONFIGURED"), false);
  assert.equal(issues.some((issue) => issue.code === "WEEKLY_HOURS_POLICY_NOT_CONFIGURED"), false);
});

test("generator is deterministic, fills reviewed shift coverage, and preserves leave and overrides", () => {
  const assignments = completeAssignments();
  assignments[assignments.findIndex((assignment) => assignment.employeeId === "e1" && assignment.workDate === weekDates[0])] = makeAssignment("e1", weekDates[0], {
    shiftId: 10,
    assignmentKind: "PROTECTED_LEAVE",
    isProtected: true,
  });
  assignments[assignments.findIndex((assignment) => assignment.employeeId === "e2" && assignment.workDate === weekDates[0])] = makeAssignment("e2", weekDates[0], {
    shiftId: 11,
    assignmentKind: "WORK",
    hasBaselineOverride: true,
    baselineOverrideShiftId: 11,
  });
  const input = context({
    assignments,
    approvedLeaveKeys: [`e1:${weekDates[0]}`],
    rules: [rule({ minimumStaff: 1 })],
  });
  const first = generateScheduleFromReference(input);
  const second = generateScheduleFromReference(input);
  assert.deepEqual(first.assignments, second.assignments);
  assert.equal(first.assignments.find((assignment) => assignment.employeeId === "e1" && assignment.workDate === weekDates[0])?.assignmentKind, "PROTECTED_LEAVE");
  assert.equal(first.assignments.find((assignment) => assignment.employeeId === "e2" && assignment.workDate === weekDates[0])?.shiftId, 11);
  assert.equal(first.assignments.find((assignment) => assignment.employeeId === "e3" && assignment.workDate === weekDates[0])?.shiftId, 10);
  assert.equal(first.changedCells, 1);
});

test("new-schedule generation spreads equal work toward the lower-hours employee", () => {
  const rules = [
    rule({ id: "monday", weekday: 1, minimumStaff: 1 }),
    rule({ id: "tuesday", weekday: 2, minimumStaff: 1 }),
  ];
  const result = generateScheduleFromReference(context({ assignments: completeAssignments(), rules }));
  assert.equal(result.assignments.find((assignment) => assignment.workDate === weekDates[0] && assignment.shiftId === 10)?.employeeId, "e1");
  assert.equal(result.assignments.find((assignment) => assignment.workDate === weekDates[1] && assignment.shiftId === 10)?.employeeId, "e2");
});

test("generator returns a concrete infeasibility issue when all candidates are protected", () => {
  const assignments = completeAssignments();
  for (const employeeId of employees.map(({ employeeId }) => employeeId)) {
    const index = assignments.findIndex((assignment) => assignment.employeeId === employeeId && assignment.workDate === weekDates[0]);
    assignments[index] = makeAssignment(employeeId, weekDates[0], {
      assignmentKind: "PROTECTED_LEAVE",
      isProtected: true,
    });
  }
  const result = generateScheduleFromReference(context({
    assignments,
    rules: [rule({ minimumStaff: 1 })],
  }));
  assert.ok(result.issues.some((issue) => issue.code === "GENERATION_MINIMUM_INFEASIBLE" && issue.ruleId === "rule-1"));
});
