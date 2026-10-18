import { getWeekDates, toPlannerDateKey } from "@/lib/week-planner";
import {
  validateSchedule,
  type ScheduleCoverageRuleInput,
  type SchedulePolicyAssignment,
  type SchedulePolicyContext,
  type ScheduleValidationIssue,
} from "@/lib/schedule-validation";

export const SCHEDULE_GENERATOR_OBJECTIVE =
  "Minimize changes from the starting draft; break ties by fewer scheduled paid hours, then employee ID.";
export const SCHEDULE_GENERATOR_VERSION = "deterministic-greedy-v1";

export type ScheduleGenerationResult = {
  assignments: SchedulePolicyAssignment[];
  issues: ScheduleValidationIssue[];
  changedCells: number;
  objective: string;
  algorithm: string;
};

const keyFor = (assignment: Pick<SchedulePolicyAssignment, "employeeId" | "workDate">) =>
  `${assignment.employeeId}:${assignment.workDate}`;

const isWorking = (assignment: SchedulePolicyAssignment | undefined) =>
  Boolean(assignment && assignment.assignmentKind === "WORK" && assignment.shiftId != null && !assignment.isProtected);

const matchesRuleEmployee = (rule: ScheduleCoverageRuleInput, employee: SchedulePolicyContext["employees"][number]) =>
  (!rule.departmentId || employee.departmentId === rule.departmentId) &&
  (!rule.positionId || employee.positionId === rule.positionId);

const appliesOnDate = (rule: ScheduleCoverageRuleInput, date: string) =>
  rule.isActive &&
  (rule.effectiveFrom == null || rule.effectiveFrom <= date) &&
  (rule.effectiveTo == null || rule.effectiveTo >= date);

const ruleCount = (
  rule: ScheduleCoverageRuleInput,
  date: string,
  assignments: Map<string, SchedulePolicyAssignment>,
  employees: SchedulePolicyContext["employees"],
) => employees
  .filter((employee) => employee.isActive && matchesRuleEmployee(rule, employee))
  .map((employee) => assignments.get(keyFor({ employeeId: employee.employeeId, workDate: date })))
  .filter((assignment) => isWorking(assignment) && (rule.shiftId == null || assignment?.shiftId === rule.shiftId))
  .length;

const wouldPreserveHardRules = (
  target: ScheduleCoverageRuleInput,
  assignment: SchedulePolicyAssignment,
  nextShiftId: number,
  date: string,
  assignments: Map<string, SchedulePolicyAssignment>,
  rules: ScheduleCoverageRuleInput[],
  employees: SchedulePolicyContext["employees"],
) => {
  const before = assignments.get(keyFor(assignment));
  if (!before) return false;
  assignments.set(keyFor(assignment), {
    ...before,
    shiftId: nextShiftId,
    assignmentKind: "WORK",
    isProtected: false,
  });
  const preserves = rules
    .filter((rule) => rule.isActive && rule.priority === "HARD" && appliesOnDate(rule, date))
    .every((rule) => {
      const afterCount = ruleCount(rule, date, assignments, employees);
      const beforeCount = (() => {
        assignments.set(keyFor(assignment), before);
        const count = ruleCount(rule, date, assignments, employees);
        assignments.set(keyFor(assignment), {
          ...before,
          shiftId: nextShiftId,
          assignmentKind: "WORK",
          isProtected: false,
        });
        return count;
      })();
      if (rule.maximumStaff != null && afterCount > rule.maximumStaff) return false;
      if (afterCount < rule.minimumStaff && afterCount < beforeCount) return false;
      return true;
    });
  assignments.set(keyFor(assignment), before);
  if (!preserves) return false;
  // The candidate must be eligible for the rule being filled and actually count toward it.
  return matchesRuleEmployee(target, employees.find((employee) => employee.employeeId === assignment.employeeId)!) &&
    (target.shiftId === nextShiftId || target.shiftId == null);
};

const scheduledHours = (
  employeeId: string,
  assignments: Map<string, SchedulePolicyAssignment>,
  shifts: SchedulePolicyContext["shifts"],
) => {
  const hoursByShift = new Map(shifts.map((shift) => [shift.id, shift.paidHoursPerDay]));
  return Array.from(assignments.values())
    .filter((assignment) => assignment.employeeId === employeeId && isWorking(assignment) && assignment.shiftId != null)
    .reduce((sum, assignment) => sum + (hoursByShift.get(assignment.shiftId!) ?? 0), 0);
};

const modificationCost = (assignment: SchedulePolicyAssignment) => {
  if (assignment.shiftId == null || assignment.assignmentKind === "UNASSIGNED") return 0;
  if (assignment.assignmentKind === "DAY_OFF") return 1;
  return 2;
};

export function generateScheduleFromReference(context: SchedulePolicyContext): ScheduleGenerationResult {
  const original = context.assignments.map((assignment) => ({ ...assignment }));
  const current = new Map(original.map((assignment) => [keyFor(assignment), assignment]));
  const shiftById = new Map(context.shifts.map((shift) => [shift.id, shift]));
  const approvedLeave = new Set(context.approvedLeaveKeys);
  const generationIssues: ScheduleValidationIssue[] = [];
  const dates = getWeekDates(context.weekStart).map(({ date }) => toPlannerDateKey(date));
  const rules = context.rules
    .filter((rule) => rule.isActive)
    .slice()
    .sort((left, right) =>
      (left.priority === "HARD" ? 0 : 1) - (right.priority === "HARD" ? 0 : 1) ||
      left.id.localeCompare(right.id),
    );

  for (const date of dates) {
    const isoWeekday = new Date(`${date}T00:00:00.000Z`).getUTCDay() || 7;
    for (const rule of rules) {
      if (rule.weekday !== isoWeekday || !appliesOnDate(rule, date) || rule.minimumStaff <= 0) continue;
      if (rule.shiftId == null) {
        if (ruleCount(rule, date, current, context.employees) < rule.minimumStaff) {
          generationIssues.push({
            code: "GENERATION_NEEDS_SHIFT_SCOPE",
            severity: rule.priority === "HARD" ? "BLOCKER" : "WARNING",
            workDate: date,
            ruleId: rule.id,
            message: `Rule “${rule.name}” does not name a shift, so the generator cannot choose a target shift.`,
            suggestedFix: "Set a shift on the coverage rule or assign eligible staff manually.",
          });
        }
        continue;
      }
      const targetShift = shiftById.get(rule.shiftId);
      if (!targetShift || !targetShift.isActive || targetShift.isDayOff) {
        generationIssues.push({
          code: "GENERATION_TARGET_SHIFT_UNAVAILABLE",
          severity: rule.priority === "HARD" ? "BLOCKER" : "WARNING",
          workDate: date,
          ruleId: rule.id,
          shiftId: rule.shiftId,
          message: `Rule “${rule.name}” targets a missing, inactive, or day-off shift.`,
          suggestedFix: "Choose an active working shift on the coverage rule.",
        });
        continue;
      }

      let count = ruleCount(rule, date, current, context.employees);
      while (count < rule.minimumStaff) {
        const candidates = context.employees
          .filter((employee) => employee.isActive && matchesRuleEmployee(rule, employee))
          .map((employee) => current.get(keyFor({ employeeId: employee.employeeId, workDate: date })))
          .filter((assignment): assignment is SchedulePolicyAssignment => Boolean(assignment))
          .filter((assignment) =>
            !assignment.isProtected &&
            !assignment.hasBaselineOverride &&
            !approvedLeave.has(keyFor(assignment)) &&
            assignment.shiftId !== rule.shiftId &&
            (assignment.assignmentKind === "UNASSIGNED" || assignment.assignmentKind === "DAY_OFF" || assignment.assignmentKind === "WORK"),
          )
          .sort((left, right) =>
            modificationCost(left) - modificationCost(right) ||
            scheduledHours(left.employeeId, current, context.shifts) - scheduledHours(right.employeeId, current, context.shifts) ||
            left.employeeId.localeCompare(right.employeeId),
          );
        const candidate = candidates.find((assignment) =>
          wouldPreserveHardRules(rule, assignment, targetShift.id, date, current, rules, context.employees),
        );
        if (!candidate) {
          generationIssues.push({
            code: "GENERATION_MINIMUM_INFEASIBLE",
            severity: rule.priority === "HARD" ? "BLOCKER" : "WARNING",
            workDate: date,
            ruleId: rule.id,
            shiftId: targetShift.id,
            message: `Could not reach ${rule.minimumStaff} staff for “${rule.name}”; only ${count} eligible assignment(s) are available without breaking a hard rule or protected constraint.`,
            suggestedFix: "Review employee scope, protected leave, overrides, active shifts, and overlapping hard coverage rules.",
          });
          break;
        }
        current.set(keyFor(candidate), {
          ...candidate,
          shiftId: targetShift.id,
          assignmentKind: "WORK",
          isProtected: false,
        });
        count = ruleCount(rule, date, current, context.employees);
      }
    }
  }

  const assignments = Array.from(current.values()).sort((left, right) =>
    left.employeeId.localeCompare(right.employeeId) || left.workDate.localeCompare(right.workDate),
  );
  const changes = assignments.filter((assignment) => {
    const before = original.find((candidate) => keyFor(candidate) === keyFor(assignment));
    return !before || before.shiftId !== assignment.shiftId || before.assignmentKind !== assignment.assignmentKind;
  }).length;
  const issues = [...validateSchedule({ ...context, assignments }), ...generationIssues]
    .sort((left, right) =>
      (left.workDate ?? "").localeCompare(right.workDate ?? "") ||
      left.code.localeCompare(right.code) ||
      (left.ruleId ?? "").localeCompare(right.ruleId ?? ""),
    );

  return {
    assignments,
    issues,
    changedCells: changes,
    objective: SCHEDULE_GENERATOR_OBJECTIVE,
    algorithm: SCHEDULE_GENERATOR_VERSION,
  };
}
