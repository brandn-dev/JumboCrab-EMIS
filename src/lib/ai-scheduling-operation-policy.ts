import { z } from "zod";

export const scheduleOperationActionSchema = z.object({
  targetType: z.enum(["ALL", "POSITION", "DEPARTMENT", "EMPLOYEE"]).nullable().default(null),
  targetQuery: z.string().trim().max(120).nullable().default(null),
  targetEmployeeQueries: z.array(z.string().trim().min(1).max(120)).max(25).default([]),
  excludeTargetQueries: z.array(z.string().trim().min(1).max(120)).max(10).default([]),
  allocationGroup: z.string().trim().min(1).max(48).nullable().default(null),
  assignmentKind: z.enum(["WORK", "DAY_OFF", "UNASSIGNED"]).default("WORK"),
  shiftRef: z.string().trim().max(64).nullable().default(null),
  workDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(7).default([]),
  usePlannerWeek: z.boolean().default(false),
  dateSelectionMode: z.enum(["UNRESOLVED", "PICK_DAYS"]).default("UNRESOLVED"),
  preserveExistingDayOff: z.boolean().default(false),
  onlyUnassigned: z.boolean().default(false),
}).strict().superRefine((action, context) => {
  if (["POSITION", "DEPARTMENT"].includes(action.targetType ?? "") && !action.targetQuery) {
    context.addIssue({ code: "custom", path: ["targetQuery"], message: "Target query is required for this action scope." });
  }
  if (action.targetType === "EMPLOYEE" && !action.targetQuery && action.targetEmployeeQueries.length === 0) {
    context.addIssue({ code: "custom", path: ["targetQuery"], message: "An employee name or code is required for this action scope." });
  }
  if (new Set(action.workDates).size !== action.workDates.length) {
    context.addIssue({ code: "custom", path: ["workDates"], message: "Dates must be unique." });
  }
  if (action.assignmentKind === "WORK" && action.shiftRef === "") {
    context.addIssue({ code: "custom", path: ["shiftRef"], message: "Working assignments need a shift code or name." });
  }
  if (action.assignmentKind === "UNASSIGNED" && action.shiftRef !== null) {
    context.addIssue({ code: "custom", path: ["shiftRef"], message: "Unassigned cells do not take a shift reference." });
  }
});

export const scheduleOperationIntentSchema = z.object({
  operation: z.enum(["ASSIGN_SHIFT", "DISTRIBUTE_DAY_OFF", "SWAP_SHIFTS", "NO_DAY_OFF", "BALANCE_COVERAGE"]),
  targetType: z.enum(["ALL", "POSITION", "DEPARTMENT", "EMPLOYEE"]).default("ALL"),
  targetQuery: z.string().trim().max(120).nullable().default(null),
  targetEmployeeQueries: z.array(z.string().trim().min(1).max(120)).max(25).default([]),
  excludeTargetQueries: z.array(z.string().trim().min(1).max(120)).max(10).default([]),
  shiftRef: z.string().trim().max(64).nullable().default(null),
  workDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(7).default([]),
  usePlannerWeek: z.boolean().default(false),
  dateSelectionMode: z.enum(["UNRESOLVED", "PICK_DAYS"]).default("UNRESOLVED"),
  preserveExistingDayOff: z.boolean().default(false),
  onlyUnassigned: z.boolean().default(false),
  dayOffCount: z.number().int().min(1).max(7).nullable().default(null),
  minimumOnly: z.boolean().default(false),
  noDayOffWeekdays: z.array(z.number().int().min(1).max(7)).max(7).default([]),
  sourceEmployeeQuery: z.string().trim().max(120).nullable().default(null),
  targetEmployeeQuery: z.string().trim().max(120).nullable().default(null),
  sourceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  actions: z.array(scheduleOperationActionSchema).max(7).default([]),
}).strict().superRefine((intent, context) => {
  const actionHasTarget = intent.actions.some((action) => action.targetType !== null || action.targetQuery !== null ||
    action.targetEmployeeQueries.length > 0 || action.excludeTargetQueries.length > 0);
  if (!actionHasTarget && ["POSITION", "DEPARTMENT"].includes(intent.targetType) && !intent.targetQuery) {
    context.addIssue({ code: "custom", path: ["targetQuery"], message: "Target query is required for this scope." });
  }
  if (!actionHasTarget && intent.targetType === "EMPLOYEE" && !intent.targetQuery && intent.targetEmployeeQueries.length === 0) {
    context.addIssue({ code: "custom", path: ["targetQuery"], message: "At least one employee name or code is required." });
  }
  if (intent.operation === "SWAP_SHIFTS" && (!intent.sourceEmployeeQuery || !intent.targetEmployeeQuery)) {
    context.addIssue({ code: "custom", path: ["sourceEmployeeQuery"], message: "Swap needs two employees." });
  }
  if (intent.operation === "NO_DAY_OFF" && intent.noDayOffWeekdays.length === 0 && intent.workDates.length === 0) {
    context.addIssue({ code: "custom", path: ["workDates"], message: "No-day-off restriction needs a date." });
  }
  if (intent.actions.length > 0 && intent.operation !== "ASSIGN_SHIFT") {
    context.addIssue({ code: "custom", path: ["actions"], message: "Combined assignment plans require the ASSIGN_SHIFT operation." });
  }
  const allocationGroups = new Map<string, number>();
  for (const action of intent.actions) {
    if (action.allocationGroup) allocationGroups.set(action.allocationGroup, (allocationGroups.get(action.allocationGroup) ?? 0) + 1);
  }
  for (const [group, count] of allocationGroups) {
    if (count < 2) context.addIssue({ code: "custom", path: ["actions"], message: `Allocation group ${group} needs at least two actions.` });
  }
  if (new Set(intent.workDates).size !== intent.workDates.length) {
    context.addIssue({ code: "custom", path: ["workDates"], message: "Dates must be unique." });
  }
  if (new Set(intent.noDayOffWeekdays).size !== intent.noDayOffWeekdays.length) {
    context.addIssue({ code: "custom", path: ["noDayOffWeekdays"], message: "Weekdays must be unique." });
  }
});

export type ScheduleOperationIntent = z.infer<typeof scheduleOperationIntentSchema>;
export type ScheduleOperationAction = z.infer<typeof scheduleOperationActionSchema>;

export function mergePendingScheduleIntent(previous: ScheduleOperationIntent, next: ScheduleOperationIntent) {
  const hasNewTarget = next.targetQuery !== null || next.targetEmployeeQueries.length > 0 || next.targetType !== "ALL";
  return hasNewTarget ? next : {
    ...next,
    targetType: previous.targetType,
    targetQuery: previous.targetQuery,
    targetEmployeeQueries: previous.targetEmployeeQueries,
    excludeTargetQueries: previous.excludeTargetQueries,
  };
}

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

export const containsNaturalGroupName = (message: string, name: string) => {
  const normalizedMessage = normalizeRoleTerm(message);
  const normalizedName = normalizeRoleTerm(name);
  return Boolean(normalizedMessage && normalizedName) && ` ${normalizedMessage} `.includes(` ${normalizedName} `);
};

type ScheduleScopeCandidate = {
  id: string;
  type: "POSITION" | "DEPARTMENT";
  name: string;
  employeeIds: string[];
};

type MentionedShift = { id: number; code: string; name: string; isDayOff: boolean };

export function inferScheduleActionScopesFromText(input: {
  message: string;
  groups: ScheduleScopeCandidate[];
  shifts: MentionedShift[];
  actionShiftIds: Array<number | null>;
  allEmployeeIds: string[];
}) {
  const tokens = Array.from(input.message.matchAll(/[a-z0-9]+/gi), (match) => ({
    word: normalizeRoleTerm(match[0]),
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
  const occurrencesFor = (phrase: string) => {
    const words = normalizeRoleTerm(phrase).split(/\s+/).filter(Boolean);
    if (!words.length) return [] as Array<{ start: number; end: number }>;
    const occurrences: Array<{ start: number; end: number }> = [];
    for (let index = 0; index <= tokens.length - words.length; index += 1) {
      if (words.every((word, offset) => tokens[index + offset]?.word === word)) {
        occurrences.push({ start: tokens[index].start, end: tokens[index + words.length - 1].end });
      }
    }
    return occurrences;
  };

  const groupMentions = input.groups.flatMap((group) => occurrencesFor(group.name).map((occurrence) => ({ ...occurrence, group })))
    .sort((left, right) => left.start - right.start || (right.end - right.start) - (left.end - left.start) || (left.group.type === "POSITION" ? -1 : 1));
  const distinctGroupMentions = groupMentions.filter((mention, index, all) => {
    const sameSpan = all.filter((candidate) => candidate.start === mention.start && candidate.end === mention.end);
    if (sameSpan.length > 1) {
      const positions = sameSpan.filter((candidate) => candidate.group.type === "POSITION");
      const preferred = positions.length ? positions : sameSpan;
      if (!preferred.some((candidate) => candidate.group.id === mention.group.id)) return false;
      if (preferred.length > 1) return false;
      if (mention.group.id !== preferred[0].group.id) return false;
    }
    const isContainedByLongerMention = all.some((candidate) =>
      candidate.start <= mention.start && candidate.end >= mention.end &&
      (candidate.start !== mention.start || candidate.end !== mention.end),
    );
    return !isContainedByLongerMention && all.findIndex((candidate) =>
      candidate.start === mention.start && candidate.end === mention.end && candidate.group.id === mention.group.id,
    ) === index;
  });

  const shiftMentions = input.shifts.filter((shift) => !shift.isDayOff).flatMap((shift) =>
    [...occurrencesFor(shift.code), ...occurrencesFor(shift.name)]
      .filter((occurrence) => {
        const phrase = tokens.filter((token) => token.start >= occurrence.start && token.end <= occurrence.end).map((token) => token.word);
        if (phrase.length === 1 && /^\d+$/.test(phrase[0])) {
          const before = tokens.find((token) => token.end <= occurrence.start);
          return before?.word === "shift" || before?.word === "code";
        }
        return phrase.length > 0;
      })
      .map((occurrence) => ({ ...occurrence, shiftId: shift.id, shift })),
  ).sort((left, right) => left.start - right.start || (right.end - right.start) - (left.end - left.start));
  const unambiguousShiftMentions = shiftMentions.filter((mention, index, all) => {
    const sameSpan = all.filter((candidate) => candidate.start === mention.start && candidate.end === mention.end);
    return new Set(sameSpan.map((candidate) => candidate.shiftId)).size === 1 &&
      all.findIndex((candidate) => candidate.start === mention.start && candidate.shiftId === mention.shiftId) === index;
  });

  const usedMentions = new Set<number>();
  return input.actionShiftIds.map((shiftId) => {
    if (shiftId == null) return null;
    const mentionIndex = unambiguousShiftMentions.findIndex((mention, index) => !usedMentions.has(index) && mention.shiftId === shiftId);
    if (mentionIndex < 0) return null;
    usedMentions.add(mentionIndex);
    const shiftMention = unambiguousShiftMentions[mentionIndex];
    const precedingGroups = distinctGroupMentions.filter((mention) => mention.start < shiftMention.start);
    const lastGroup = precedingGroups.at(-1) ?? null;
    const restMention = tokens.filter((token) => token.word === "rest" && token.start < shiftMention.start).at(-1);

    if (restMention && (!lastGroup || restMention.start > lastGroup.start)) {
      const excluded = distinctGroupMentions.filter((mention) => mention.start < restMention.start);
      const excludedIds = new Set(excluded.flatMap((mention) => mention.group.employeeIds));
      const excludedNames = Array.from(new Set(excluded.map((mention) => mention.group.name)));
      return {
        targetType: "ALL" as const,
        targetLabel: excludedNames.length ? `All employees except ${excludedNames.join(", ")}` : "All employees",
        employeeIds: input.allEmployeeIds.filter((employeeId) => !excludedIds.has(employeeId)),
        groupKey: null,
        splitRequested: false,
      };
    }

    if (!lastGroup) return null;
    const previousWords = tokens.filter((token) => token.end <= lastGroup.start).slice(-2).map((token) => token.word);
    if (previousWords.some((word) => ["except", "excluding", "without", "not"].includes(word))) return null;
    const splitRequested = tokens.some((token) => token.word === "half" && token.start > lastGroup.start && token.start < shiftMention.start);
    return {
      targetType: lastGroup.group.type,
      targetLabel: lastGroup.group.name,
      employeeIds: lastGroup.group.employeeIds,
      groupKey: `${lastGroup.group.type}:${lastGroup.group.id}`,
      splitRequested,
    };
  });
}

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
  shiftId: number | null;
  assignmentKind: "WORK" | "DAY_OFF" | "UNASSIGNED";
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

export function applyScheduleAssignmentSequence(input: {
  assignments: ShiftAssignmentProposalCell[];
  employeeIds: string[];
  actions: Array<{
    dates: string[];
    employeeIds?: string[];
    shiftId: number | null;
    assignmentKind: "WORK" | "DAY_OFF" | "UNASSIGNED";
    preserveExistingDayOff: boolean;
    onlyUnassigned: boolean;
  }>;
}) {
  let assignments = input.assignments;
  const preservedCells = new Map<string, { employeeId: string; workDate: string; reason: "existing day off" | "approved leave" | "schedule override" }>();
  for (const action of input.actions) {
    const result = applyShiftAssignmentProposal({
      assignments,
      employeeIds: action.employeeIds ?? input.employeeIds,
      dates: action.dates,
      shiftId: action.shiftId,
      assignmentKind: action.assignmentKind,
      preserveExistingDayOff: action.preserveExistingDayOff,
      onlyUnassigned: action.onlyUnassigned,
    });
    assignments = result.assignments;
    for (const cell of result.preservedCells) preservedCells.set(`${cell.employeeId}:${cell.workDate}:${cell.reason}`, cell);
  }
  return { assignments, preservedCells: Array.from(preservedCells.values()) };
}

const stableRank = (value: string) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

export function splitEmployeesEvenly(employeeIds: string[], partitionCount: number, seed: string) {
  if (!Number.isInteger(partitionCount) || partitionCount < 2) return [];
  const partitions = Array.from({ length: partitionCount }, () => [] as string[]);
  const orderedIds = Array.from(new Set(employeeIds)).sort((left, right) =>
    stableRank(`${seed}:${left}`) - stableRank(`${seed}:${right}`) || left.localeCompare(right),
  );
  orderedIds.forEach((employeeId, index) => partitions[index % partitionCount].push(employeeId));
  return partitions;
}

export function selectRepresentativeScheduleChanges<T extends { after: string; planLabel?: string }>(changes: T[], limit: number) {
  if (!Number.isInteger(limit) || limit <= 0) return [] as T[];
  const groups = new Map<string, T[]>();
  for (const change of changes) {
    const key = change.planLabel || change.after;
    groups.set(key, [...(groups.get(key) ?? []), change]);
  }
  const representatives: T[] = [];
  while (representatives.length < limit) {
    let addedInRound = false;
    for (const group of groups.values()) {
      const change = group.shift();
      if (!change) continue;
      representatives.push(change);
      addedInRound = true;
      if (representatives.length >= limit) break;
    }
    if (!addedInRound) break;
  }
  return representatives;
}

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
