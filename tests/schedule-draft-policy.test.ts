import assert from "node:assert/strict";
import test from "node:test";
import {
  areDraftAssignmentsComplete,
  buildScheduleDraftAssignments,
  createDraftScopeKey,
} from "../src/lib/schedule-draft-policy";
import { toPlannerDateKey } from "../src/lib/week-planner";

const weekStart = new Date("2026-10-19T04:00:00.000Z");
const dates = Array.from({ length: 7 }, (_, day) => {
  const date = new Date(weekStart);
  date.setUTCDate(date.getUTCDate() + day);
  return toPlannerDateKey(date);
});

test("reference drafts preserve target-week overrides and protect approved leave", () => {
  const [monday, tuesday, wednesday] = dates;
  const assignments = buildScheduleDraftAssignments({
    employeeIds: ["employee-1"],
    weekStart,
    referenceWeekStart: new Date("2026-10-12T04:00:00.000Z"),
    sourceMode: "REFERENCE_WEEK",
    targetSchedules: [{
      employeeId: "employee-1",
      days: { mon: 1, tue: 1, wed: 1 },
    }],
    referenceSchedules: [{
      employeeId: "employee-1",
      days: { mon: 2, tue: 2, wed: 2 },
    }],
    overrides: [{ employeeId: "employee-1", workDate: tuesday, shiftId: 3 }],
    referenceOverrides: [{ employeeId: "employee-1", workDate: "2026-10-13", shiftId: 2 }],
    approvedLeaveDays: [{ employeeId: "employee-1", workDate: wednesday }],
    shifts: [
      { id: 1, isDayOff: false },
      { id: 2, isDayOff: false },
      { id: 3, isDayOff: false },
    ],
  });

  assert.equal(assignments.length, 7);
  assert.equal(assignments[0].workDate, monday);
  assert.equal(assignments[0].shiftId, 2);
  assert.equal(assignments[0].source, "REFERENCE_WEEK");

  assert.equal(assignments[1].shiftId, 3);
  assert.equal(assignments[1].source, "CURRENT_SCHEDULE");
  assert.equal(assignments[1].hasBaselineOverride, true);
  assert.equal(assignments[1].baselineOverrideShiftId, 3);

  assert.equal(assignments[2].assignmentKind, "PROTECTED_LEAVE");
  assert.equal(assignments[2].isProtected, true);
  assert.equal(assignments[2].shiftId, 1);
});

test("empty drafts retain existing target overrides and distinguish rest from unassigned", () => {
  const assignments = buildScheduleDraftAssignments({
    employeeIds: ["employee-1"],
    weekStart,
    sourceMode: "EMPTY",
    targetSchedules: [],
    overrides: [{ employeeId: "employee-1", workDate: dates[0], shiftId: 4 }],
    shifts: [{ id: 4, isDayOff: true }],
  });

  assert.equal(assignments[0].assignmentKind, "DAY_OFF");
  assert.equal(assignments[0].shiftId, 4);
  assert.equal(assignments[0].source, "CURRENT_SCHEDULE");
  assert.equal(assignments[1].assignmentKind, "UNASSIGNED");
  assert.equal(assignments[1].shiftId, null);
});

test("draft scope key ignores employee ordering and draft completeness rejects duplicates", () => {
  const scope = { departmentId: null, selectionMode: "SELECTED" as const };
  assert.equal(
    createDraftScopeKey({ ...scope, employeeIds: ["b", "a"] }),
    createDraftScopeKey({ ...scope, employeeIds: ["a", "b"] }),
  );

  const assignments = dates.map((workDate) => ({ employeeId: "employee-1", workDate }));
  assert.equal(areDraftAssignmentsComplete({
    employeeIds: ["employee-1"],
    weekStart,
    assignments,
  }), true);
  assert.equal(areDraftAssignmentsComplete({
    employeeIds: ["employee-1"],
    weekStart,
    assignments: [...assignments, assignments[0]],
  }), false);
});
