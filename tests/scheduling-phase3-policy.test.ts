import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AI_SCHEDULING_CHAT_TOOLS,
  MAX_CHAT_COMPLETION_TOKENS,
  MAX_CHAT_FINAL_RESPONSE_TOKENS,
  MAX_CHAT_HISTORY_MESSAGES,
  MAX_CHAT_MESSAGE_LENGTH,
  MAX_CHAT_MESSAGES_PER_CONVERSATION,
  MAX_CHAT_MESSAGES_PER_DAY,
  MAX_CHAT_MESSAGES_PER_MINUTE,
  MAX_CHAT_TOOL_CALLS_PER_TURN,
  MAX_CHAT_TOOL_RESULT_CHARS,
  MAX_CHAT_TOOL_ROUNDS,
  buildSchedulingChatSystemPrompt,
  chatRequestSchema,
  isAiSchedulingChatEnabled,
  parseTextualProviderToolCalls,
  sanitizeSchedulingAssistantMessage,
  extractShiftReferenceFromMessage,
  isExplicitBulkScheduleRequest,
  inferExplicitGroupShiftAssignment,
  inferSchedulingAssignmentTarget,
  needsBulkScheduleDateClarification,
  redactSensitiveText,
  requiresEmployeeSelectionConfirmation,
  resolveExplicitEmployeeSelection,
  resolveExplicitBulkScheduleDates,
  resolveShiftReference,
  shouldPreserveExistingDayOff,
  shouldUsePlannerWeekForShiftAssignment,
} from "../src/lib/ai-scheduling-chat-policy";
import {
  applyShiftAssignmentProposal,
  distributeDayOffAssignments,
  canApplyScheduleOperation,
  isScheduleOperationExpired,
  isValidScheduleOperationSelection,
  matchesNaturalGroupName,
  matchesScheduleOperationDraftVersion,
  scheduleOperationIntentSchema,
} from "../src/lib/ai-scheduling-operation-policy";

test("chat stays disabled unless both scheduling and chat flags are explicitly enabled", () => {
  assert.equal(isAiSchedulingChatEnabled({ schedulingFlag: undefined, chatFlag: "true" }), false);
  assert.equal(isAiSchedulingChatEnabled({ schedulingFlag: "true", chatFlag: undefined }), false);
  assert.equal(isAiSchedulingChatEnabled({ schedulingFlag: "TRUE", chatFlag: "true" }), false);
  assert.equal(isAiSchedulingChatEnabled({ schedulingFlag: "true", chatFlag: "true" }), true);
});

test("chat request validates idempotency key and bounds user text", () => {
  const valid = chatRequestSchema.safeParse({
    requestKey: "ba0b8280-7a6a-4c4a-a89e-2cd6a9838fb3",
    message: "Create next week's draft",
  });
  assert.equal(valid.success, true);
  assert.equal(chatRequestSchema.safeParse({ requestKey: "bad", message: "hi" }).success, false);
  assert.equal(chatRequestSchema.safeParse({
    requestKey: "ba0b8280-7a6a-4c4a-a89e-2cd6a9838fb3",
    message: "x".repeat(MAX_CHAT_MESSAGE_LENGTH + 1),
  }).success, false);
  assert.equal(chatRequestSchema.safeParse({
    requestKey: "ba0b8280-7a6a-4c4a-a89e-2cd6a9838fb3",
    weekStart: "2026-10-18",
    message: "Use this week",
  }).success, false);
  assert.equal(chatRequestSchema.safeParse({
    requestKey: "ba0b8280-7a6a-4c4a-a89e-2cd6a9838fb3",
    message: "Apply reviewed changes",
    bulkAction: "confirm",
  }).success, false);
  assert.equal(chatRequestSchema.safeParse({
    requestKey: "ba0b8280-7a6a-4c4a-a89e-2cd6a9838fb3",
    message: "Apply reviewed changes",
    bulkAction: "confirm",
    bulkSourceMessage: "Set all employees to shift 2 on Friday",
    bulkExpectedDraftVersion: 2,
  }).success, true);
  assert.equal(chatRequestSchema.safeParse({
    requestKey: "ba0b8280-7a6a-4c4a-a89e-2cd6a9838fb3",
    message: "Choose Friday",
    interactionAction: "select",
    interactionId: "ba0b8280-7a6a-4c4a-a89e-2cd6a9838fb3",
    optionIds: ["ba0b8280-7a6a-4c4a-a89e-2cd6a9838fb3"],
  }).success, false, "interaction actions must be bound to an existing conversation");
  assert.equal(chatRequestSchema.safeParse({
    requestKey: "ba0b8280-7a6a-4c4a-a89e-2cd6a9838fb3",
    conversationId: "conversation-1",
    message: "Choose Friday",
    interactionAction: "select",
    interactionId: "ba0b8280-7a6a-4c4a-a89e-2cd6a9838fb3",
    optionIds: ["ba0b8280-7a6a-4c4a-a89e-2cd6a9838fb3"],
  }).success, true);
});

test("ambiguous names need explicit employee-code or numbered selection", () => {
  const candidates = [
    { employeeId: "one", employeeCode: "JC-101", displayName: "Brandon Lee" },
    { employeeId: "two", employeeCode: "JC-202", displayName: "Brandon Lee" },
  ];
  assert.equal(resolveExplicitEmployeeSelection("Brandon Friday off", candidates), null);
  assert.equal(resolveExplicitEmployeeSelection("Use JC-202", candidates), "two");
  assert.equal(resolveExplicitEmployeeSelection("the second one", candidates), "two");
  assert.equal(resolveExplicitEmployeeSelection("Brandon Lee", candidates), null);
  assert.equal(requiresEmployeeSelectionConfirmation({
    employeeId: "two",
    confirmedEmployeeIds: new Set(),
    pendingCandidates: candidates,
    hasDuplicateName: false,
  }), true);
  assert.equal(requiresEmployeeSelectionConfirmation({
    employeeId: "two",
    confirmedEmployeeIds: new Set(["two"]),
    pendingCandidates: candidates,
    hasDuplicateName: true,
  }), false);
});

test("shift references resolve by code or name, including a spoken 'shift 2' label", () => {
  const shifts = [
    { id: 7, code: "SHIFT-2", name: "Evening" },
    { id: 8, code: "AM-1", name: "Morning" },
  ];
  assert.deepEqual(resolveShiftReference("shift 2", shifts), { status: "resolved", shift: shifts[0] });
  assert.deepEqual(resolveShiftReference("am-1", shifts), { status: "resolved", shift: shifts[1] });
  assert.deepEqual(resolveShiftReference("Morning", shifts), { status: "resolved", shift: shifts[1] });
  assert.deepEqual(resolveShiftReference("unknown", shifts), { status: "not_found" });
  assert.deepEqual(resolveShiftReference("shift 2", [
    ...shifts,
    { id: 9, code: "2", name: "Night" },
  ]), { status: "ambiguous" });
  assert.deepEqual(resolveShiftReference("2", [
    ...shifts,
    { id: 9, code: "2", name: "Night" },
  ]), { status: "resolved", shift: { id: 9, code: "2", name: "Night" } });
  assert.deepEqual(extractShiftReferenceFromMessage("set all employees to shift 2 on Friday", shifts), {
    status: "resolved",
    shift: shifts[0],
  });
  assert.deepEqual(extractShiftReferenceFromMessage("set all employees to AM-1 on Friday", shifts), {
    status: "resolved",
    shift: shifts[1],
  });
  const numericShifts = [
    shifts[0],
    { id: 10, code: "10", name: "Ten" },
    { id: 19, code: "19", name: "Nineteen" },
  ];
  assert.deepEqual(extractShiftReferenceFromMessage("Set all employees to shift SHIFT-2 on 2026-10-19", numericShifts), {
    status: "resolved",
    shift: shifts[0],
  });
  const pmShift = { id: 9, code: "3", name: "PM (Afternoon)" };
  assert.deepEqual(resolveShiftReference("PM", [pmShift]), { status: "resolved", shift: pmShift });
  assert.deepEqual(extractShiftReferenceFromMessage("set all cashier shifts to pm and dont change current day off", [pmShift]), {
    status: "resolved",
    shift: pmShift,
  });
});

test("bulk shift edits without a date ask for the day scope before changing draft cells", () => {
  assert.equal(isExplicitBulkScheduleRequest("set all employee shift to 2"), true);
  assert.equal(needsBulkScheduleDateClarification("set all employee shift to 2"), true);
  assert.equal(needsBulkScheduleDateClarification("set all employees to shift 2 on Friday"), false);
  assert.equal(needsBulkScheduleDateClarification("give Brandon Friday off"), false);
  assert.deepEqual(resolveExplicitBulkScheduleDates("set all employees to shift 2 on Friday", "2026-10-19"), ["2026-10-23"]);
  assert.equal(needsBulkScheduleDateClarification("set all employees shift 2 on October 23, 2026"), false);
  assert.deepEqual(resolveExplicitBulkScheduleDates("set all employees shift 2 on Friday, October 23, 2026", "2026-10-19"), ["2026-10-23"]);
  assert.equal(resolveExplicitBulkScheduleDates("set all employees shift 2 on Friday, October 24, 2026", "2026-10-19"), null);
  assert.equal(resolveExplicitBulkScheduleDates("set all employees shift 2 next Friday", "2026-10-19"), null);
  assert.deepEqual(resolveExplicitBulkScheduleDates("set all employees to shift 2 this week", "2026-10-19"), [
    "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25",
  ]);
  assert.deepEqual(resolveExplicitBulkScheduleDates("set all employees to shift 2 tomorrow", "2026-10-19", "2026-10-20"), ["2026-10-21"]);
  assert.equal(resolveExplicitBulkScheduleDates("set all employees shift 2 except Friday", "2026-10-19"), null);
});

test("chat prompt and tool allowlist propose structured changes without exposing direct writes", () => {
  const prompt = buildSchedulingChatSystemPrompt("2026-10-19");
  assert.match(prompt, /Asia\/Manila/);
  assert.match(prompt, /never guess/i);
  assert.match(prompt, /propose_schedule_operation/i);
  assert.match(prompt, /weekday alone means exactly that date in that week/i);
  assert.match(prompt, /Never ask the manager for a database shift ID/i);
  assert.match(prompt, /as shiftRef/i);
  assert.match(prompt, /Approval and publication are not available/i);
  assert.match(prompt, /Combine group, shift, date, and preservation details into one/i);
  assert.match(prompt, /preserveExistingDayOff=true/i);
  assert.ok(AI_SCHEDULING_CHAT_TOOLS.includes("propose_schedule_operation"));
  assert.equal(AI_SCHEDULING_CHAT_TOOLS.includes("revise_schedule_draft" as never), false);
  assert.equal(AI_SCHEDULING_CHAT_TOOLS.includes("assign_shift_to_draft_scope" as never), false);
  assert.equal(AI_SCHEDULING_CHAT_TOOLS.some((name) => /approve|publish|payroll|violation/i.test(name)), false);
  assert.equal(MAX_CHAT_COMPLETION_TOKENS, 3_000);
  assert.equal(MAX_CHAT_FINAL_RESPONSE_TOKENS, 400);
  assert.equal(MAX_CHAT_HISTORY_MESSAGES, 40);
  assert.equal(MAX_CHAT_TOOL_ROUNDS, 5);
  assert.equal(MAX_CHAT_TOOL_CALLS_PER_TURN, 5);
  assert.equal(MAX_CHAT_MESSAGES_PER_DAY, 120);
  assert.equal(MAX_CHAT_MESSAGES_PER_MINUTE, 8);
  assert.equal(MAX_CHAT_MESSAGES_PER_CONVERSATION, 200);
  assert.equal(MAX_CHAT_TOOL_RESULT_CHARS, 12_000);
  const contextualPrompt = buildSchedulingChatSystemPrompt("2026-10-19", {
    weekStart: "2026-10-19",
    referenceWeekStart: "2026-10-12",
    scope: { departmentId: "dept-1", selectedEmployeeCount: 3 },
    activeDraft: { id: "draft-1", version: 2, status: "DRAFT", isSourceStale: false },
  });
  assert.match(contextualPrompt, /Current planner week starts Monday 2026-10-19/);
  assert.match(contextualPrompt, /Current reference week starts Monday 2026-10-12/);
  assert.match(contextualPrompt, /Current planner employee selection contains 3 employee\(s\)/);
  assert.match(contextualPrompt, /Active draft: ID draft-1, version 2/);
});

test("provider-style textual tool calls are normalized safely and never accept unknown tools", () => {
  const content = `<tool_call>
<function=propose_schedule_operation>
<parameter=operation>
DISTRIBUTE_DAY_OFF
</parameter>
<parameter=targetEmployeeQueries>
[]
</parameter>
<parameter=dayOffCount>
2
</parameter>
</tool_call>`;
  const parsed = parseTextualProviderToolCalls({
    content,
    allowedToolNames: ["propose_schedule_operation"],
  });
  assert.equal(parsed.detected, true);
  assert.deepEqual(parsed.calls, [{
    name: "propose_schedule_operation",
    arguments: JSON.stringify({ operation: "DISTRIBUTE_DAY_OFF", targetEmployeeQueries: [], dayOffCount: 2 }),
  }]);
  assert.deepEqual(parseTextualProviderToolCalls({
    content: content.replace("propose_schedule_operation", "write_to_database"),
    allowedToolNames: ["propose_schedule_operation"],
  }), { detected: true, calls: [] });
  assert.deepEqual(parseTextualProviderToolCalls({
    content: "ordinary scheduling explanation",
    allowedToolNames: ["propose_schedule_operation"],
  }), { detected: false, calls: [] });
  const jsonEnvelope = parseTextualProviderToolCalls({
    content: '<tool_call>{"name":"propose_schedule_operation","arguments":{"operation":"ASSIGN_SHIFT","targetType":"POSITION","targetQuery":"Cashier","shiftRef":"PM","usePlannerWeek":true,"preserveExistingDayOff":true}}</tool_call>',
    allowedToolNames: ["propose_schedule_operation"],
  });
  assert.deepEqual(jsonEnvelope.calls, [{
    name: "propose_schedule_operation",
    arguments: JSON.stringify({ operation: "ASSIGN_SHIFT", targetType: "POSITION", targetQuery: "Cashier", shiftRef: "PM", usePlannerWeek: true, preserveExistingDayOff: true }),
  }]);
  const functionJson = parseTextualProviderToolCalls({
    content: '<tool_call><function=propose_schedule_operation><arguments>{"operation":"ASSIGN_SHIFT","shiftRef":"PM"}</arguments></function></tool_call>',
    allowedToolNames: ["propose_schedule_operation"],
  });
  assert.deepEqual(functionJson.calls, [{
    name: "propose_schedule_operation",
    arguments: JSON.stringify({ operation: "ASSIGN_SHIFT", shiftRef: "PM" }),
  }]);
  const bareJson = parseTextualProviderToolCalls({
    content: '```json\n{"function":"propose_schedule_operation","parameters":{"operation":"ASSIGN_SHIFT","shiftRef":"PM"}}\n```',
    allowedToolNames: ["propose_schedule_operation"],
  });
  assert.deepEqual(bareJson.calls, [{
    name: "propose_schedule_operation",
    arguments: JSON.stringify({ operation: "ASSIGN_SHIFT", shiftRef: "PM" }),
  }]);
  assert.equal(
    sanitizeSchedulingAssistantMessage(content),
    "Internal scheduling output was hidden. Check the draft preview before retrying.",
  );
  assert.equal(sanitizeSchedulingAssistantMessage('{"name":"propose_schedule_operation","arguments":{}}'), "Internal scheduling output was hidden. Check the draft preview before retrying.");
  assert.equal(sanitizeSchedulingAssistantMessage("Your preview is ready."), "Your preview is ready.");
});

test("all group shifts imply planner week and keep-day-off wording enables day-off preservation", () => {
  assert.equal(shouldUsePlannerWeekForShiftAssignment("set all cashier shifts to PM and don't change the current day off"), true);
  assert.equal(shouldUsePlannerWeekForShiftAssignment("set all cashier shifts to PM on Friday"), false);
  assert.equal(shouldUsePlannerWeekForShiftAssignment("set cashier shifts to PM for the whole week"), true);
  assert.equal(shouldPreserveExistingDayOff("set all cashier shifts to PM and don't change the current day off"), true);
  assert.equal(shouldPreserveExistingDayOff("set all cashier shifts to PM and dont change the current day off"), true);
  assert.equal(shouldPreserveExistingDayOff("set all cashier shifts to PM Friday"), false);
  assert.deepEqual(inferSchedulingAssignmentTarget("set all cashier shifts to PM"), { targetType: "POSITION", targetQuery: "Cashier" });
  assert.equal(inferSchedulingAssignmentTarget("set all employees to PM except cashiers"), null);
  const departmentIntent = inferExplicitGroupShiftAssignment("set cashier department shift to PM whole week");
  assert.equal(departmentIntent?.targetType, "DEPARTMENT");
  assert.equal(departmentIntent?.usePlannerWeek, true);
  const unassignedIntent = inferExplicitGroupShiftAssignment("set unassigned shift of cashier to be PM");
  assert.equal(unassignedIntent?.targetType, "POSITION");
  assert.equal(unassignedIntent?.onlyUnassigned, true);
  assert.equal(unassignedIntent?.usePlannerWeek, true);
});

test("working-shift proposal preserves existing days off when manager requests it", () => {
  const assignments = [
    { employeeId: "cashier-1", workDate: "2026-10-19", shiftId: 1, assignmentKind: "WORK" as const, isProtected: false, hasBaselineOverride: false, reason: null },
    { employeeId: "cashier-1", workDate: "2026-10-20", shiftId: 9, assignmentKind: "DAY_OFF" as const, isProtected: false, hasBaselineOverride: false, reason: null },
    { employeeId: "cashier-2", workDate: "2026-10-19", shiftId: 1, assignmentKind: "WORK" as const, isProtected: true, hasBaselineOverride: false, reason: null },
  ];
  const result = applyShiftAssignmentProposal({
    assignments,
    employeeIds: ["cashier-1", "cashier-2"],
    dates: ["2026-10-19", "2026-10-20"],
    shiftId: 2,
    assignmentKind: "WORK",
    preserveExistingDayOff: true,
    onlyUnassigned: false,
  });
  assert.equal(result.assignments[0].shiftId, 2);
  assert.equal(result.assignments[1].shiftId, 9);
  assert.equal(result.assignments[1].assignmentKind, "DAY_OFF");
  assert.equal(result.assignments[2].shiftId, 1);
  assert.deepEqual(result.preservedCells.map(({ employeeId, reason }) => ({ employeeId, reason })), [
    { employeeId: "cashier-1", reason: "existing day off" },
    { employeeId: "cashier-2", reason: "approved leave" },
  ]);
});

test("unassigned-only shift proposal leaves working and day-off cells unchanged", () => {
  const assignments = [
    { employeeId: "cashier-1", workDate: "2026-10-19", shiftId: null, assignmentKind: "UNASSIGNED" as const, isProtected: false, hasBaselineOverride: false, reason: null },
    { employeeId: "cashier-1", workDate: "2026-10-20", shiftId: 1, assignmentKind: "WORK" as const, isProtected: false, hasBaselineOverride: false, reason: null },
    { employeeId: "cashier-1", workDate: "2026-10-21", shiftId: 9, assignmentKind: "DAY_OFF" as const, isProtected: false, hasBaselineOverride: false, reason: null },
  ];
  const result = applyShiftAssignmentProposal({
    assignments,
    employeeIds: ["cashier-1"],
    dates: assignments.map((assignment) => assignment.workDate),
    shiftId: 2,
    assignmentKind: "WORK",
    preserveExistingDayOff: false,
    onlyUnassigned: true,
  });
  assert.equal(result.assignments[0].shiftId, 2);
  assert.equal(result.assignments[0].assignmentKind, "WORK");
  assert.equal(result.assignments[1].shiftId, 1);
  assert.equal(result.assignments[2].shiftId, 9);
  assert.equal(result.assignments[2].assignmentKind, "DAY_OFF");
});

test("natural role matching accepts plural job titles and department phrases", () => {
  assert.equal(matchesNaturalGroupName("cashiers", "Cashier"), true);
  assert.equal(matchesNaturalGroupName("the front desk team", "Front Desk"), true);
  assert.equal(matchesNaturalGroupName("cashiers", "Managers"), false);
});

test("day-off distribution is deterministic, balances load, and preserves existing OFF and protected cells", () => {
  const dates = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"];
  const assignments = ["a", "b", "existing", "blocked", "protected"].flatMap((employeeId) => dates.map((workDate, index) => ({
    employeeId,
    workDate,
    shiftId: employeeId === "existing" && index === 1 ? 9 : employeeId === "blocked" && index < 2 ? 9 : 1,
    assignmentKind: employeeId === "existing" && index === 1 || employeeId === "blocked" && index < 2 ? "DAY_OFF" as const : "WORK" as const,
    isProtected: employeeId === "protected",
    hasBaselineOverride: false,
    reason: null,
  })));
  const input = {
    assignments,
    employeeIds: ["b", "a", "existing", "blocked", "protected"],
    dates,
    dayOffShiftId: 9,
    dayOffShiftIds: [9],
    noDayOffDates: ["2026-10-19"],
    weekStart: "2026-10-19",
    seed: "stable-seed",
  };
  const first = distributeDayOffAssignments(input);
  const second = distributeDayOffAssignments({ ...input, employeeIds: [...input.employeeIds].reverse() });
  assert.deepEqual(first, second, "ordering must not change seeded result");
  assert.equal(first.assigned.length, 2);
  assert.notEqual(first.assigned[0].workDate, first.assigned[1].workDate, "least-loaded dates should spread assignments");
  assert.deepEqual(first.retained.find((row) => row.employeeId === "existing"), { employeeId: "existing", workDate: dates[1] });
  assert.ok(first.blocked.some((row) => row.employeeId === "blocked"));
  assert.ok(first.blocked.some((row) => row.employeeId === "protected"));
  assert.ok(first.assigned.every((row) => row.workDate !== dates[0]));
});

test("a day-off restriction blocks conflicting existing OFF instead of silently moving it", () => {
  const assignments = [
    { employeeId: "cashier-1", workDate: "2026-10-25", shiftId: 9, assignmentKind: "DAY_OFF" as const, isProtected: false, hasBaselineOverride: false },
    { employeeId: "cashier-1", workDate: "2026-10-24", shiftId: 1, assignmentKind: "WORK" as const, isProtected: false, hasBaselineOverride: false },
  ];
  const result = distributeDayOffAssignments({
    assignments,
    employeeIds: ["cashier-1"],
    dates: ["2026-10-24", "2026-10-25"],
    dayOffShiftId: 9,
    dayOffShiftIds: [9],
    noDayOffDates: ["2026-10-25"],
    weekStart: "2026-10-19",
    seed: "sunday-restriction",
  });
  assert.equal(result.assigned.length, 0);
  assert.ok(result.blocked[0].reason.includes("2026-10-25"));
  assert.equal(result.assignments.find((assignment) => assignment.workDate === "2026-10-25")?.assignmentKind, "DAY_OFF");
});

test("day-off distribution honors a requested count while retaining compliant existing OFF", () => {
  const dates = ["2026-10-19", "2026-10-20", "2026-10-21"];
  const assignments = dates.map((workDate, index) => ({
    employeeId: "employee-1",
    workDate,
    shiftId: index === 0 ? 9 : 1,
    assignmentKind: index === 0 ? "DAY_OFF" as const : "WORK" as const,
    isProtected: false,
    hasBaselineOverride: false,
  }));
  const result = distributeDayOffAssignments({
    assignments,
    employeeIds: ["employee-1"],
    dates,
    dayOffShiftId: 9,
    dayOffShiftIds: [9],
    weekStart: "2026-10-19",
    seed: "two-offs",
    dayOffCount: 2,
  });
  assert.equal(result.assigned.length, 1);
  assert.equal(result.retained.length, 1);
  assert.equal(result.assignments.filter((assignment) => assignment.assignmentKind === "DAY_OFF").length, 2);
});

test("operation intent allows server-side shift and swap clarification", () => {
  const base = {
    targetType: "ALL",
    targetQuery: null,
    excludeTargetQueries: [],
    shiftRef: null,
    workDates: [],
    usePlannerWeek: false,
    preserveExistingDayOff: false,
    onlyUnassigned: false,
    dayOffCount: null,
    minimumOnly: false,
    noDayOffWeekdays: [],
    sourceEmployeeQuery: null,
    targetEmployeeQuery: null,
    sourceDate: null,
    targetDate: null,
  };
  assert.equal(scheduleOperationIntentSchema.safeParse({ ...base, operation: "ASSIGN_SHIFT" }).success, true);
  assert.equal(scheduleOperationIntentSchema.safeParse({ ...base, operation: "SWAP_SHIFTS", sourceEmployeeQuery: "Alex", targetEmployeeQuery: "Jamie" }).success, true);
  assert.equal(scheduleOperationIntentSchema.safeParse({
    ...base,
    operation: "ASSIGN_SHIFT",
    targetType: "EMPLOYEE",
    targetEmployeeQueries: ["Brandon Lee", "Maya Cruz"],
    shiftRef: "2",
  }).success, true, "one request can target several individually resolved employees");
});

test("pending interactions expire and reject changed draft versions or fingerprints", () => {
  assert.equal(isScheduleOperationExpired("2026-10-19T00:00:00.000Z", Date.parse("2026-10-19T00:30:01.000Z")), true);
  assert.equal(isScheduleOperationExpired("2026-10-19T00:31:00.000Z", Date.parse("2026-10-19T00:30:00.000Z")), false);
  const expected = { draftId: "draft-1", version: 3, draftFingerprint: "draft-hash", sourceFingerprint: "source-hash" };
  const current = { ...expected, isLatestVersion: true, isSourceStale: false };
  assert.equal(matchesScheduleOperationDraftVersion(expected, current), true);
  assert.equal(matchesScheduleOperationDraftVersion(expected, { ...current, version: 4 }), false);
  assert.equal(matchesScheduleOperationDraftVersion(expected, { ...current, sourceFingerprint: "changed" }), false);
  assert.equal(matchesScheduleOperationDraftVersion(expected, { ...current, isLatestVersion: false }), false);
  assert.equal(matchesScheduleOperationDraftVersion(expected, { ...current, isSourceStale: true }), false);
  assert.equal(isValidScheduleOperationSelection({ availableOptionIds: ["one", "two"], selectedOptionIds: ["one"], selectionMode: "single" }), true);
  assert.equal(isValidScheduleOperationSelection({ availableOptionIds: ["one"], selectedOptionIds: ["forged"], selectionMode: "single" }), false);
  assert.equal(isValidScheduleOperationSelection({ availableOptionIds: ["one", "two"], selectedOptionIds: ["one", "one"], selectionMode: "multiple" }), false);
  const proposal = { status: "PROPOSAL", canApply: true, hasAssignments: true, expiresAt: "2026-10-20T00:00:00.000Z", now: Date.parse("2026-10-19T00:00:00.000Z") };
  assert.equal(canApplyScheduleOperation(proposal), true);
  assert.equal(canApplyScheduleOperation({ ...proposal, status: "APPLIED" }), false, "repeated Apply is rejected after first transition");
  assert.equal(canApplyScheduleOperation({ ...proposal, expiresAt: "2026-10-18T00:00:00.000Z" }), false);
});

test("chat redacts credentials and unrelated contact details before storage/provider use", () => {
  const redacted = redactSensitiveText("password: super-secret email donny@example.com call 09171234567 sk-or-v1-12345678901234567890");
  assert.doesNotMatch(redacted, /super-secret|donny@example\.com|09171234567|sk-or-v1-/);
  assert.match(redacted, /\[REDACTED\]/);
  assert.match(redacted, /\[email redacted\]/);
  assert.match(redacted, /\[phone redacted\]/);
  assert.match(redacted, /\[secret redacted\]/);
});
