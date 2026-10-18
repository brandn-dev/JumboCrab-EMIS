import { getWeekDates, toPlannerDateKey } from "@/lib/week-planner";

export type SchedulePolicyPriority = "HARD" | "SOFT";
export type ScheduleIssueSeverity = "BLOCKER" | "WARNING" | "INFO";

export type ScheduleValidationIssue = {
  code: string;
  severity: ScheduleIssueSeverity;
  employeeId?: string;
  workDate?: string;
  shiftId?: number;
  ruleId?: string;
  message: string;
  suggestedFix?: string;
};

export type SchedulePolicyEmployee = {
  employeeId: string;
  departmentId: string | null;
  positionId: string | null;
  isActive: boolean;
};

export type SchedulePolicyShift = {
  id: number;
  isActive: boolean;
  isDayOff: boolean;
  startMinutes: number;
  endMinutes: number;
  spansMidnight: boolean;
  paidHoursPerDay: number | null;
};

export type ScheduleCoverageRuleInput = {
  id: string;
  name: string;
  departmentId: string | null;
  positionId: string | null;
  shiftId: number | null;
  weekday: number;
  minimumStaff: number;
  maximumStaff: number | null;
  priority: SchedulePolicyPriority;
  isActive: boolean;
  effectiveFrom: string | null;
  effectiveTo: string | null;
};

export type SchedulePolicyAssignment = {
  employeeId: string;
  workDate: string;
  shiftId: number | null;
  assignmentKind: "WORK" | "DAY_OFF" | "UNASSIGNED" | "PROTECTED_LEAVE";
  isProtected: boolean;
  hasBaselineOverride: boolean;
  baselineOverrideShiftId: number | null;
};

export type SchedulePolicyContext = {
  weekStart: Date;
  employees: SchedulePolicyEmployee[];
  shifts: SchedulePolicyShift[];
  rules: ScheduleCoverageRuleInput[];
  assignments: SchedulePolicyAssignment[];
  approvedLeaveKeys: string[];
  isSourceStale: boolean;
  scopeIsComplete?: boolean;
  /** Adjacent live assignments let overnight/rest checks cross the selected week boundary. */
  boundaryAssignments?: SchedulePolicyAssignment[];
  /** Null means the company has not configured this policy. No default is inferred. */
  minimumRestMinutes?: number | null;
  /** Null means the company has not configured this policy. No default is inferred. */
  maximumWeeklyPaidHours?: number | null;
};

const keyFor = (employeeId: string, workDate: string) => `${employeeId}:${workDate}`;
const isValidDateKey = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
const dayNumber = (dateKey: string) => {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  return Math.floor(date.getTime() / 86_400_000);
};
const weekdayIso = (dateKey: string) => {
  const weekday = new Date(`${dateKey}T00:00:00.000Z`).getUTCDay();
  return weekday === 0 ? 7 : weekday;
};

const issueSeverityForRule = (priority: SchedulePolicyPriority): ScheduleIssueSeverity =>
  priority === "HARD" ? "BLOCKER" : "WARNING";

const matchesRuleEmployee = (rule: ScheduleCoverageRuleInput, employee: SchedulePolicyEmployee) =>
  (!rule.departmentId || employee.departmentId === rule.departmentId) &&
  (!rule.positionId || employee.positionId === rule.positionId);

const ruleActiveOn = (rule: ScheduleCoverageRuleInput, date: string) =>
  rule.isActive &&
  (rule.effectiveFrom == null || rule.effectiveFrom <= date) &&
  (rule.effectiveTo == null || rule.effectiveTo >= date);

const isWorking = (assignment: SchedulePolicyAssignment) =>
  assignment.assignmentKind === "WORK" && !assignment.isProtected && assignment.shiftId != null;

const shiftInterval = (assignment: SchedulePolicyAssignment, shift: SchedulePolicyShift) => {
  if (
    !Number.isInteger(shift.startMinutes) ||
    !Number.isInteger(shift.endMinutes) ||
    shift.startMinutes < 0 || shift.startMinutes >= 1440 ||
    shift.endMinutes < 0 || shift.endMinutes >= 1440 ||
    (!shift.spansMidnight && shift.endMinutes <= shift.startMinutes) ||
    (shift.spansMidnight && shift.endMinutes > shift.startMinutes)
  ) return null;
  const start = dayNumber(assignment.workDate) * 1440 + shift.startMinutes;
  const end = dayNumber(assignment.workDate) * 1440 + shift.endMinutes +
    (shift.spansMidnight || shift.endMinutes <= shift.startMinutes ? 1440 : 0);
  return { start, end };
};

export function validateSchedule(context: SchedulePolicyContext): ScheduleValidationIssue[] {
  const issues: ScheduleValidationIssue[] = [];
  const employees = new Map(context.employees.map((employee) => [employee.employeeId, employee]));
  const shifts = new Map(context.shifts.map((shift) => [shift.id, shift]));
  const weekDateKeys = getWeekDates(context.weekStart).map(({ date }) => toPlannerDateKey(date));
  const expectedKeys = new Set(
    context.employees.flatMap((employee) => weekDateKeys.map((date) => keyFor(employee.employeeId, date))),
  );
  const assignmentByKey = new Map<string, SchedulePolicyAssignment>();

  for (const assignment of context.assignments) {
    if (!isValidDateKey(assignment.workDate) || !expectedKeys.has(keyFor(assignment.employeeId, assignment.workDate))) {
      issues.push({
        code: "ASSIGNMENT_OUT_OF_SCOPE",
        severity: "BLOCKER",
        employeeId: assignment.employeeId,
        workDate: assignment.workDate,
        message: "Assignment is outside the draft employee and week scope.",
        suggestedFix: "Remove the out-of-scope cell and reload the draft.",
      });
      continue;
    }
    const key = keyFor(assignment.employeeId, assignment.workDate);
    if (assignmentByKey.has(key)) {
      issues.push({
        code: "DUPLICATE_ASSIGNMENT",
        severity: "BLOCKER",
        employeeId: assignment.employeeId,
        workDate: assignment.workDate,
        message: "More than one assignment exists for this employee and date.",
      });
    } else {
      assignmentByKey.set(key, assignment);
    }
  }

  for (const employee of context.employees) {
    for (const workDate of weekDateKeys) {
      if (!assignmentByKey.has(keyFor(employee.employeeId, workDate))) {
        issues.push({
          code: "ASSIGNMENT_MISSING",
          severity: "BLOCKER",
          employeeId: employee.employeeId,
          workDate,
          message: "The draft does not contain a cell for this employee and date.",
          suggestedFix: "Restore a complete seven-day draft before validation.",
        });
      }
    }
  }

  if (context.isSourceStale) {
    issues.push({
      code: "SOURCE_STALE",
      severity: "BLOCKER",
      message: "Live schedules, overrides, or approved leave changed after this draft was created.",
      suggestedFix: "Reload the source and create a new draft version before review.",
    });
  }

  if (context.scopeIsComplete === false) {
    issues.push({
      code: "COVERAGE_SCOPE_INCOMPLETE",
      severity: "BLOCKER",
      message: "This draft covers only part of the active employee roster; total coverage and maximum staffing outside the draft scope are not established.",
      suggestedFix: "Use the full employee scope for a complete coverage review.",
    });
  }

  if (context.minimumRestMinutes != null && (!Number.isFinite(context.minimumRestMinutes) || context.minimumRestMinutes < 0)) {
    issues.push({
      code: "REST_POLICY_INVALID",
      severity: "BLOCKER",
      message: "Configured minimum rest period must be a finite non-negative number of minutes.",
    });
  }
  if (context.maximumWeeklyPaidHours != null && (!Number.isFinite(context.maximumWeeklyPaidHours) || context.maximumWeeklyPaidHours < 0)) {
    issues.push({
      code: "WEEKLY_HOURS_POLICY_INVALID",
      severity: "BLOCKER",
      message: "Configured weekly paid-hours limit must be a finite non-negative number.",
    });
  }

  for (const assignment of context.assignments) {
    const employee = employees.get(assignment.employeeId);
    const shift = assignment.shiftId == null ? null : shifts.get(assignment.shiftId);
    const leaveKey = keyFor(assignment.employeeId, assignment.workDate);
    const onApprovedLeave = context.approvedLeaveKeys.includes(leaveKey);
    const isWork = isWorking(assignment);

    if (!employee) continue;
    if (!employee.isActive && isWork) {
      issues.push({
        code: "EMPLOYEE_INACTIVE",
        severity: "BLOCKER",
        employeeId: assignment.employeeId,
        workDate: assignment.workDate,
        shiftId: assignment.shiftId ?? undefined,
        message: "An inactive or archived employee has a working assignment.",
      });
    }
    if (onApprovedLeave && isWork) {
      issues.push({
        code: "APPROVED_LEAVE_CONFLICT",
        severity: "BLOCKER",
        employeeId: assignment.employeeId,
        workDate: assignment.workDate,
        shiftId: assignment.shiftId ?? undefined,
        message: "A working shift overlaps approved leave.",
        suggestedFix: "Keep the approved leave protected for this date.",
      });
    }
    if (onApprovedLeave && assignment.assignmentKind !== "PROTECTED_LEAVE") {
      issues.push({
        code: "APPROVED_LEAVE_NOT_PROTECTED",
        severity: "BLOCKER",
        employeeId: assignment.employeeId,
        workDate: assignment.workDate,
        message: "Approved leave must remain marked as protected in the draft.",
      });
    }
    if (assignment.assignmentKind === "PROTECTED_LEAVE" && !assignment.isProtected) {
      issues.push({
        code: "PROTECTED_LEAVE_FLAG_MISSING",
        severity: "BLOCKER",
        employeeId: assignment.employeeId,
        workDate: assignment.workDate,
        message: "Protected leave assignment is missing its protected marker.",
      });
    }
    if (assignment.assignmentKind === "WORK" && (!shift || shift.isDayOff)) {
      issues.push({
        code: "WORK_SHIFT_INVALID",
        severity: "BLOCKER",
        employeeId: assignment.employeeId,
        workDate: assignment.workDate,
        shiftId: assignment.shiftId ?? undefined,
        message: "Working assignments require a valid working shift.",
      });
    }
    if ((assignment.assignmentKind === "WORK" || assignment.assignmentKind === "DAY_OFF") && !shift) {
      issues.push({
        code: "SHIFT_MISSING",
        severity: "BLOCKER",
        employeeId: assignment.employeeId,
        workDate: assignment.workDate,
        message: "This assignment kind requires a shift.",
      });
    }
    if (shift && !shift.isActive && assignment.shiftId !== null && !assignment.isProtected) {
      issues.push({
        code: "SHIFT_INACTIVE",
        severity: "BLOCKER",
        employeeId: assignment.employeeId,
        workDate: assignment.workDate,
        shiftId: shift.id,
        message: "A draft assignment uses an inactive shift.",
      });
    }
    if (assignment.assignmentKind === "DAY_OFF" && shift && !shift.isDayOff) {
      issues.push({
        code: "DAY_OFF_SHIFT_INVALID",
        severity: "BLOCKER",
        employeeId: assignment.employeeId,
        workDate: assignment.workDate,
        shiftId: shift.id,
        message: "Day-off assignments require a day-off shift.",
      });
    }
    if (assignment.assignmentKind === "UNASSIGNED" && assignment.shiftId != null) {
      issues.push({
        code: "UNASSIGNED_HAS_SHIFT",
        severity: "BLOCKER",
        employeeId: assignment.employeeId,
        workDate: assignment.workDate,
        shiftId: assignment.shiftId,
        message: "Unassigned cells cannot contain a shift.",
      });
    }
    if (assignment.hasBaselineOverride && !onApprovedLeave && assignment.shiftId !== assignment.baselineOverrideShiftId) {
      issues.push({
        code: "OVERRIDE_NOT_PRESERVED",
        severity: "BLOCKER",
        employeeId: assignment.employeeId,
        workDate: assignment.workDate,
        shiftId: assignment.baselineOverrideShiftId ?? undefined,
        message: "The draft differs from the day-specific override, which remains authoritative.",
        suggestedFix: "Keep the override intact or update it through its existing approved workflow.",
      });
    }
    if (assignment.assignmentKind === "WORK" && shift && !shift.isDayOff && !shift.isActive) continue;
    if (isWork && shift) {
      const interval = shiftInterval(assignment, shift);
      if (!interval) {
        issues.push({
          code: "SHIFT_TIME_INVALID",
          severity: "BLOCKER",
          employeeId: assignment.employeeId,
          workDate: assignment.workDate,
          shiftId: shift.id,
          message: "Shift times cannot form a valid work interval.",
        });
      }
    }
  }

  const allIntervals = [...(context.boundaryAssignments ?? []), ...context.assignments]
    .filter((assignment) => isWorking(assignment))
    .flatMap((assignment) => {
      const shift = assignment.shiftId == null ? null : shifts.get(assignment.shiftId);
      if (!shift || !shift.isActive || shift.isDayOff || !isValidDateKey(assignment.workDate)) return [];
      const interval = shiftInterval(assignment, shift);
      return interval ? [{ assignment, shift, ...interval }] : [];
    })
    .sort((left, right) => left.assignment.employeeId.localeCompare(right.assignment.employeeId) || left.start - right.start);

  let latestForEmployee: (typeof allIntervals)[number] | null = null;
  for (const current of allIntervals) {
    if (!latestForEmployee || current.assignment.employeeId !== latestForEmployee.assignment.employeeId) {
      latestForEmployee = current;
      continue;
    }
    const gap = current.start - latestForEmployee.end;
    const currentIsInTarget = expectedKeys.has(keyFor(current.assignment.employeeId, current.assignment.workDate));
    const previousIsInTarget = expectedKeys.has(keyFor(latestForEmployee.assignment.employeeId, latestForEmployee.assignment.workDate));
    const targetParticipant = currentIsInTarget || previousIsInTarget;
    if (gap < 0 && targetParticipant) {
      issues.push({
        code: "SHIFT_OVERLAP",
        severity: "BLOCKER",
        employeeId: current.assignment.employeeId,
        workDate: currentIsInTarget ? current.assignment.workDate : latestForEmployee.assignment.workDate,
        shiftId: currentIsInTarget ? current.shift.id : latestForEmployee.shift.id,
        message: "This shift overlaps an earlier working shift, including overnight time.",
        suggestedFix: "Choose a non-overlapping shift or clear one assignment.",
      });
    } else if (context.minimumRestMinutes != null && gap >= 0 && gap < context.minimumRestMinutes && targetParticipant) {
      issues.push({
        code: "INSUFFICIENT_CONFIGURED_REST",
        severity: "BLOCKER",
        employeeId: current.assignment.employeeId,
        workDate: currentIsInTarget ? current.assignment.workDate : latestForEmployee.assignment.workDate,
        shiftId: currentIsInTarget ? current.shift.id : latestForEmployee.shift.id,
        message: `Only ${gap} minutes separate shifts; configured minimum is ${context.minimumRestMinutes} minutes.`,
      });
    }
    if (current.end > latestForEmployee.end) latestForEmployee = current;
  }

  if (context.maximumWeeklyPaidHours != null) {
    const hoursByEmployee = new Map<string, number>();
    for (const assignment of context.assignments) {
      if (!isWorking(assignment) || assignment.shiftId == null) continue;
      const paidHours = shifts.get(assignment.shiftId)?.paidHoursPerDay;
      if (paidHours != null && Number.isFinite(paidHours)) {
        hoursByEmployee.set(assignment.employeeId, (hoursByEmployee.get(assignment.employeeId) ?? 0) + paidHours);
      }
    }
    for (const [employeeId, paidHours] of hoursByEmployee) {
      if (paidHours > context.maximumWeeklyPaidHours) {
        issues.push({
          code: "MAX_WEEKLY_HOURS_EXCEEDED",
          severity: "BLOCKER",
          employeeId,
          message: `${paidHours} scheduled paid hours exceeds the configured ${context.maximumWeeklyPaidHours}-hour limit.`,
        });
      }
    }
  } else {
    issues.push({
      code: "WEEKLY_HOURS_POLICY_NOT_CONFIGURED",
      severity: "INFO",
      message: "No company-approved weekly hours limit is configured; no hours limit was assumed.",
    });
  }

  if (context.minimumRestMinutes == null) {
    issues.push({
      code: "REST_POLICY_NOT_CONFIGURED",
      severity: "INFO",
      message: "No company-approved minimum rest period is configured; only overlapping shifts are blocked.",
    });
  }

  issues.push({
    code: "POSITION_SHIFT_ELIGIBILITY_NOT_CONFIGURED",
    severity: "INFO",
    message: "No position-to-shift eligibility policy is configured. Active employee/shift status and position-scoped coverage rules are checked; no extra restriction was assumed.",
  });

  const assignmentsByKey = assignmentByKey;
  const activeRules = context.rules.filter((rule) => rule.isActive);
  if (activeRules.length === 0) {
    issues.push({
      code: "COVERAGE_RULES_NOT_CONFIGURED",
      severity: "INFO",
      message: "Coverage rules are not configured. Coverage has not been evaluated as passing.",
      suggestedFix: "Add reviewed staffing rules for the positions and shifts that need minimum coverage.",
    });
  }

  for (const rule of activeRules) {
    if (rule.weekday < 1 || rule.weekday > 7 || rule.minimumStaff < 0 ||
      (rule.maximumStaff != null && rule.maximumStaff < rule.minimumStaff)) {
      issues.push({
        code: "COVERAGE_RULE_INVALID",
        severity: "BLOCKER",
        ruleId: rule.id,
        message: `Coverage rule “${rule.name}” has invalid limits or weekday.`,
      });
      continue;
    }
    if (rule.shiftId != null && !shifts.has(rule.shiftId)) {
      issues.push({
        code: "COVERAGE_RULE_SHIFT_MISSING",
        severity: "BLOCKER",
        ruleId: rule.id,
        shiftId: rule.shiftId,
        message: `Coverage rule “${rule.name}” references a missing shift.`,
      });
      continue;
    }
    const dates = weekDateKeys.filter((date) =>
      weekdayIso(date) === rule.weekday && ruleActiveOn(rule, date),
    );
    for (const workDate of dates) {
      const matchingEmployees = context.employees.filter((employee) => employee.isActive && matchesRuleEmployee(rule, employee));
      const matchingKeys = new Set(matchingEmployees.map((employee) => keyFor(employee.employeeId, workDate)));
      const count = Array.from(matchingKeys)
        .map((key) => assignmentsByKey.get(key))
        .filter((assignment): assignment is SchedulePolicyAssignment =>
          Boolean(assignment && isWorking(assignment) && (rule.shiftId == null || assignment.shiftId === rule.shiftId)),
        ).length;
      const severity = issueSeverityForRule(rule.priority);
      if (matchingEmployees.length === 0 && rule.minimumStaff > 0) {
        issues.push({
          code: "COVERAGE_SCOPE_HAS_NO_EMPLOYEES",
          severity,
          workDate,
          ruleId: rule.id,
          shiftId: rule.shiftId ?? undefined,
          message: `Coverage rule “${rule.name}” requires ${rule.minimumStaff} staff, but its scope has no employees.`,
          suggestedFix: "Review the rule's department and position scope or adjust the required minimum.",
        });
      } else if (count < rule.minimumStaff) {
        issues.push({
          code: "COVERAGE_MINIMUM_NOT_MET",
          severity,
          workDate,
          ruleId: rule.id,
          shiftId: rule.shiftId ?? undefined,
          message: `Coverage rule “${rule.name}” has ${count} assigned; minimum is ${rule.minimumStaff}.`,
          suggestedFix: "Assign eligible staff to this coverage group or review the configured minimum.",
        });
      }
      if (rule.maximumStaff != null && count > rule.maximumStaff) {
        issues.push({
          code: "COVERAGE_MAXIMUM_EXCEEDED",
          severity,
          workDate,
          ruleId: rule.id,
          shiftId: rule.shiftId ?? undefined,
          message: `Coverage rule “${rule.name}” has ${count} assigned; maximum is ${rule.maximumStaff}.`,
          suggestedFix: "Move eligible staff to another shift or review the configured maximum.",
        });
      }
    }
  }

  return issues.sort((left, right) =>
    (left.workDate ?? "").localeCompare(right.workDate ?? "") ||
    (left.severity === "BLOCKER" ? 0 : left.severity === "WARNING" ? 1 : 2) -
      (right.severity === "BLOCKER" ? 0 : right.severity === "WARNING" ? 1 : 2) ||
    left.code.localeCompare(right.code) ||
    (left.ruleId ?? "").localeCompare(right.ruleId ?? ""),
  );
}
