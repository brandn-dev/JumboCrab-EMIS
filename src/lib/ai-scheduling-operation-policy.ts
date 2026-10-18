import { z } from "zod";

export const scheduleOperationIntentSchema = z.object({
  operation: z.enum(["ASSIGN_SHIFT", "DISTRIBUTE_DAY_OFF", "SWAP_SHIFTS", "NO_DAY_OFF", "BALANCE_COVERAGE"]),
  targetType: z.enum(["ALL", "POSITION", "DEPARTMENT", "EMPLOYEE"]).default("ALL"),
  targetQuery: z.string().trim().max(120).nullable().default(null),
  targetEmployeeQueries: z.array(z.string().trim().min(1).max(120)).max(25).default([]),
  excludeTargetQueries: z.array(z.string().trim().min(1).max(120)).max(10).default([]),
  shiftRef: z.string().trim().max(64).nullable().default(null),
  workDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(7).default([]),
  usePlannerWeek: z.boolean().default(false),
  preserveExistingDayOff: z.boolean().default(false),
  onlyUnassigned: z.boolean().default(false),
  dayOffCount: z.number().int().min(1).max(7).nullable().default(null),
  minimumOnly: z.boolean().default(false),
  noDayOffWeekdays: z.array(z.number().int().min(1).max(7)).max(7).default([]),
  sourceEmployeeQuery: z.string().trim().max(120).nullable().default(null),
  targetEmployeeQuery: z.string().trim().max(120).nullable().default(null),
  sourceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
}).strict().superRefine((intent, context) => {
  if (["POSITION", "DEPARTMENT"].includes(intent.targetType) && !intent.targetQuery) {
    context.addIssue({ code: "custom", path: ["targetQuery"], message: "Target query is required for this scope." });
  }
  if (intent.targetType === "EMPLOYEE" && !intent.targetQuery && intent.targetEmployeeQueries.length === 0) {
    context.addIssue({ code: "custom", path: ["targetQuery"], message: "At least one employee name or code is required." });
  }
  if (intent.operation === "SWAP_SHIFTS" && (!intent.sourceEmployeeQuery || !intent.targetEmployeeQuery)) {
    context.addIssue({ code: "custom", path: ["sourceEmployeeQuery"], message: "Swap needs two employees." });
  }
  if (intent.operation === "NO_DAY_OFF" && intent.noDayOffWeekdays.length === 0 && intent.workDates.length === 0) {
    context.addIssue({ code: "custom", path: ["workDates"], message: "No-day-off restriction needs a date." });
  }
  if (new Set(intent.workDates).size !== intent.workDates.length) {
    context.addIssue({ code: "custom", path: ["workDates"], message: "Dates must be unique." });
  }
  if (new Set(intent.noDayOffWeekdays).size !== intent.noDayOffWeekdays.length) {
    context.addIssue({ code: "custom", path: ["noDayOffWeekdays"], message: "Weekdays must be unique." });
  }
});

export type ScheduleOperationIntent = z.infer<typeof scheduleOperationIntentSchema>;

export const isScheduleOperationExpired = (expiresAt: string, now = Date.now()) =>
  new Date(expiresAt).getTime() < now;

export const matchesScheduleOperationDraftVersion = (expected: {
  draftId: string;
  version: number;
  draftFingerprint: string;
  sourceFingerprint: string;
}, actual: {
  draftId: string;
  version: number;
  draftFingerprint: string;
  sourceFingerprint: string;
  isLatestVersion: boolean;
  isSourceStale: boolean;
}) => expected.draftId === actual.draftId &&
  expected.version === actual.version &&
  expected.draftFingerprint === actual.draftFingerprint &&
  expected.sourceFingerprint === actual.sourceFingerprint &&
  actual.isLatestVersion &&
  !actual.isSourceStale;

export const isValidScheduleOperationSelection = (input: {
  availableOptionIds: string[];
  selectedOptionIds: string[];
  selectionMode: "single" | "multiple";
}) => input.selectedOptionIds.length > 0 &&
  new Set(input.selectedOptionIds).size === input.selectedOptionIds.length &&
  input.selectedOptionIds.every((id) => input.availableOptionIds.includes(id)) &&
  (input.selectionMode === "multiple" || input.selectedOptionIds.length === 1);

export const canApplyScheduleOperation = (input: {
  status: string;
  canApply: boolean;
  hasAssignments: boolean;
  expiresAt: string;
  now?: number;
}) => input.status === "PROPOSAL" && input.canApply && input.hasAssignments && !isScheduleOperationExpired(input.expiresAt, input.now);

const normalizeRoleTerm = (value: string) => value
  .toLocaleLowerCase()
  .normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/[^a-z0-9]+/g, " ")
  .trim()
  .split(/\s+/)
  .map((word) => word.endsWith("ies") && word.length > 4
    ? `${word.slice(0, -3)}y`
    : word.endsWith("s") && word.length > 3
      ? word.slice(0, -1)
      : word)
  .join(" ");

export const matchesNaturalGroupName = (query: string, name: string) => {
  const normalizedQuery = normalizeRoleTerm(query);
  const normalizedName = normalizeRoleTerm(name);
  return Boolean(normalizedQuery && normalizedName) && (
    normalizedQuery === normalizedName ||
    normalizedName.includes(normalizedQuery) ||
    normalizedQuery.includes(normalizedName)
  );
};

export type DayOffPlanningAssignment = {
  employeeId: string;
  workDate: string;
  shiftId: number | null;
  assignmentKind: "WORK" | "DAY_OFF" | "UNASSIGNED" | "PROTECTED_LEAVE";
  isProtected: boolean;
  hasBaselineOverride: boolean;
  reason?: string | null;
};

export type ShiftAssignmentProposalCell = {
  employeeId: string;
  workDate: string;
  shiftId: number | null;
  assignmentKind: "WORK" | "DAY_OFF" | "UNASSIGNED" | "PROTECTED_LEAVE";
  isProtected: boolean;
  hasBaselineOverride: boolean;
  reason: string | null;
};

export function applyShiftAssignmentProposal(input: {
  assignments: ShiftAssignmentProposalCell[];
  employeeIds: string[];
  dates: string[];
  shiftId: number;
  assignmentKind: "WORK" | "DAY_OFF";
  preserveExistingDayOff: boolean;
  onlyUnassigned: boolean;
}) {
  const employeeIds = new Set(input.employeeIds);
  const dates = new Set(input.dates);
  const preservedCells: Array<{ employeeId: string; workDate: string; reason: "existing day off" | "approved leave" | "schedule override" }> = [];
  const assignments = input.assignments.map((assignment) => {
    if (!employeeIds.has(assignment.employeeId) || !dates.has(assignment.workDate)) return assignment;
    if (input.onlyUnassigned && assignment.assignmentKind !== "UNASSIGNED") return assignment;
    if (input.preserveExistingDayOff && assignment.assignmentKind === "DAY_OFF") {
      preservedCells.push({ employeeId: assignment.employeeId, workDate: assignment.workDate, reason: "existing day off" });
      return assignment;
    }
    if (assignment.isProtected || assignment.hasBaselineOverride || assignment.assignmentKind === "PROTECTED_LEAVE") {
      preservedCells.push({
        employeeId: assignment.employeeId,
        workDate: assignment.workDate,
        reason: assignment.isProtected ? "approved leave" : "schedule override",
      });
      return assignment;
    }
    return {
      ...assignment,
      shiftId: input.shiftId,
      assignmentKind: input.assignmentKind,
      reason: "Assignment proposed by scheduling assistant.",
    };
  });
  return { assignments, preservedCells };
}

const stableRank = (value: string) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

export function distributeDayOffAssignments(input: {
  assignments: DayOffPlanningAssignment[];
  employeeIds: string[];
  dates: string[];
  dayOffShiftId: number;
  dayOffShiftIds: number[];
  noDayOffDates?: string[];
  weekStart: string;
  seed: string;
  minimumOnly?: boolean;
  dayOffCount?: number;
}) {
  const dayOffIds = new Set(input.dayOffShiftIds);
  const noDayOffDates = new Set(input.noDayOffDates ?? []);
  const assignments = input.assignments.map((assignment) => ({ ...assignment }));
  const assignmentIndex = new Map(assignments.map((assignment, index) => [
    `${assignment.employeeId}:${assignment.workDate}`,
    index,
  ]));
  const dailyLoad = new Map<string, number>();
  for (const assignment of assignments) {
    if (assignment.assignmentKind === "DAY_OFF" || (assignment.shiftId != null && dayOffIds.has(assignment.shiftId))) {
      dailyLoad.set(assignment.workDate, (dailyLoad.get(assignment.workDate) ?? 0) + 1);
    }
  }

  const assigned: Array<{ employeeId: string; workDate: string }> = [];
  const retained: Array<{ employeeId: string; workDate: string }> = [];
  const blocked: Array<{ employeeId: string; reason: string }> = [];
  const requiredDaysOff = input.dayOffCount ?? 1;
  for (const employeeId of [...new Set(input.employeeIds)].sort()) {
    const employeeAssignments = assignments.filter((assignment) => assignment.employeeId === employeeId);
    const existingDaysOff = employeeAssignments.filter((assignment) =>
      assignment.assignmentKind === "DAY_OFF" || (assignment.shiftId != null && dayOffIds.has(assignment.shiftId)),
    );
    const prohibitedExistingDaysOff = existingDaysOff.filter((assignment) => noDayOffDates.has(assignment.workDate));
    if (prohibitedExistingDaysOff.length > 0) {
      blocked.push({
        employeeId,
        reason: `Existing OFF falls on a prohibited date (${prohibitedExistingDaysOff.map((assignment) => assignment.workDate).join(", ")}); no safe replacement shift was invented.`,
      });
      continue;
    }
    if (existingDaysOff.length > 0 && input.minimumOnly) {
      retained.push(...existingDaysOff.map((assignment) => ({ employeeId, workDate: assignment.workDate })));
      continue;
    }
    if (existingDaysOff.length > requiredDaysOff) {
      blocked.push({
        employeeId,
        reason: `Already has ${existingDaysOff.length} day-off assignments on ${existingDaysOff.map((assignment) => assignment.workDate).join(", ")}, above requested ${requiredDaysOff}; existing days preserved.`,
      });
      continue;
    }
    retained.push(...existingDaysOff.map((assignment) => ({ employeeId, workDate: assignment.workDate })));
    let remaining = requiredDaysOff - existingDaysOff.length;
    while (remaining > 0) {
      const candidates = input.dates.flatMap((workDate) => {
        if (noDayOffDates.has(workDate)) return [];
        const index = assignmentIndex.get(`${employeeId}:${workDate}`);
        if (index == null) return [];
        const assignment = assignments[index];
        if (
          assignment.assignmentKind === "DAY_OFF" || (assignment.shiftId != null && dayOffIds.has(assignment.shiftId)) ||
          assignment.isProtected || assignment.hasBaselineOverride || assignment.assignmentKind === "PROTECTED_LEAVE"
        ) return [];
        return [{ assignment, index, load: dailyLoad.get(workDate) ?? 0 }];
      });
      if (candidates.length === 0) {
        const protectedDates = employeeAssignments
          .filter((assignment) => assignment.isProtected || assignment.assignmentKind === "PROTECTED_LEAVE")
          .map((assignment) => assignment.workDate);
        const overrideDates = employeeAssignments.filter((assignment) => assignment.hasBaselineOverride).map((assignment) => assignment.workDate);
        const restrictedDates = input.dates.filter((date) => noDayOffDates.has(date));
        const existingDates = employeeAssignments
          .filter((assignment) => assignment.assignmentKind === "DAY_OFF" || (assignment.shiftId != null && dayOffIds.has(assignment.shiftId)))
          .map((assignment) => assignment.workDate);
        blocked.push({
          employeeId,
          reason: `Only ${requiredDaysOff - remaining} of ${requiredDaysOff} requested day-off assignment(s) fit. Protected leave: ${protectedDates.join(", ") || "none"}; overrides: ${overrideDates.join(", ") || "none"}; restricted weekdays: ${restrictedDates.join(", ") || "none"}; existing OFF: ${existingDates.join(", ") || "none"}.`,
        });
        break;
      }
      const lowestLoad = Math.min(...candidates.map((candidate) => candidate.load));
      const leastLoaded = candidates.filter((candidate) => candidate.load === lowestLoad);
      leastLoaded.sort((left, right) =>
        stableRank(`${input.seed}:${input.weekStart}:${employeeId}:${left.assignment.workDate}`) -
          stableRank(`${input.seed}:${input.weekStart}:${employeeId}:${right.assignment.workDate}`),
      );
      const chosen = leastLoaded[0];
      assignments[chosen.index] = {
        ...chosen.assignment,
        shiftId: input.dayOffShiftId,
        assignmentKind: "DAY_OFF",
        reason: "Day-off assignment proposed by scheduling assistant.",
      };
      dailyLoad.set(chosen.assignment.workDate, chosen.load + 1);
      assigned.push({ employeeId, workDate: chosen.assignment.workDate });
      remaining -= 1;
    }
  }

  return { assignments, assigned, retained, blocked };
}
