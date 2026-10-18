import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AI_SCHEDULING_CHAT_TOOLS,
  MAX_CHAT_COMPLETION_TOKENS,
  MAX_CHAT_FINAL_RESPONSE_TOKENS,
  MAX_CHAT_HISTORY_MESSAGES,
  MAX_CHAT_INITIAL_TOOL_TOKENS,
  MAX_CHAT_MESSAGE_LENGTH,
  MAX_CHAT_MESSAGES_PER_CONVERSATION,
  MAX_CHAT_MESSAGES_PER_DAY,
  MAX_CHAT_MESSAGES_PER_MINUTE,
  MAX_CHAT_TOOL_CALLS_PER_TURN,
  MAX_CHAT_TOOL_RESULT_CHARS,
  MAX_CHAT_TOOL_ROUNDS,
  buildSchedulingChatSystemPrompt,
  chatRequestSchema,
  explicitlyRequestsUnassignedScheduleCells,
  getCompletionBudget,
  isAiSchedulingChatEnabled,
  parseTextualProviderToolCalls,
  sanitizeSchedulingAssistantMessage,
  extractShiftReferenceFromMessage,
  isExplicitBulkScheduleRequest,
  matchesScheduleEmployeeQuery,
  needsBulkScheduleDateClarification,
  redactSensitiveText,
  requiresEmployeeSelectionConfirmation,
  resolveExplicitEmployeeSelection,
  resolveExplicitBulkScheduleDates,
  resolveShiftReference,
  shouldRetryIncompleteCompletion,
  validateProviderToolCalls,
} from "../src/lib/ai-scheduling-chat-policy";
import {
  applyShiftAssignmentProposal,
  applyScheduleAssignmentSequence,
  containsNaturalGroupName,
  inferScheduleActionScopesFromText,
  distributeDayOffAssignments,
  canApplyScheduleOperation,
  isScheduleOperationExpired,
  isValidScheduleOperationSelection,
  matchesNaturalGroupName,
  matchesScheduleOperationDraftVersion,
  mergePendingScheduleIntent,
  scheduleOperationIntentSchema,
  selectRepresentativeScheduleChanges,
  splitEmployeesEvenly,
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

test("employee target matching accepts human identifiers and exact legacy database IDs", () => {
  const employee = {
    employeeId: "cmomo2r5k0033ptxch73uy80i",
    employeeCode: "JC-042",
    firstName: "Debbie",
    lastName: "Considine",
  };
  assert.equal(matchesScheduleEmployeeQuery("Debbie Considine", employee), true);
  assert.equal(matchesScheduleEmployeeQuery("considine debbie", employee), true);
  assert.equal(matchesScheduleEmployeeQuery("JC-042", employee), true);
  assert.equal(matchesScheduleEmployeeQuery("cmomo2r5k0033ptxch73uy80i", employee), true);
  assert.equal(matchesScheduleEmployeeQuery("cmomo2r5k0033ptxch73uy8", employee), false);
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
  assert.deepEqual(extractShiftReferenceFromMessage("Set Debbie Considine whole week shift to be PM", [pmShift]), {
    status: "resolved",
    shift: pmShift,
  });
  assert.deepEqual(extractShiftReferenceFromMessage("set shift to be PM", [
    pmShift,
    { id: 10, code: "4", name: "PM (Late)" },
  ]), { status: "ambiguous" });
});

test("provider response handling retries only incomplete, unexecuted output and reserves final tokens", () => {
  assert.equal(MAX_CHAT_INITIAL_TOOL_TOKENS, 2_400);
  assert.equal(MAX_CHAT_COMPLETION_TOKENS, 5_000);
  assert.equal(MAX_CHAT_FINAL_RESPONSE_TOKENS, 600);
  assert.equal(shouldRetryIncompleteCompletion({ finishReason: "stop", content: "", validToolCallCount: 0, rejectedToolCallCount: 0 }), true);
  assert.equal(shouldRetryIncompleteCompletion({ finishReason: "length", content: "partial", validToolCallCount: 0, rejectedToolCallCount: 0 }), true);
  assert.equal(shouldRetryIncompleteCompletion({ finishReason: "length", content: "", validToolCallCount: 1, rejectedToolCallCount: 0 }), true, "length responses stay incomplete even if one tool call parses");
  assert.deepEqual(getCompletionBudget(3_000, 2_500, 400), { remainingTokens: 500, toolTokens: 100, finalTokens: 400 });
  assert.deepEqual(getCompletionBudget(3_000, 3_000, 400), { remainingTokens: 0, toolTokens: 0, finalTokens: 0 });

  const malformed = validateProviderToolCalls({
    value: [
      { id: "bad", function: { name: "propose_schedule_operation", arguments: "{broken" } },
      { id: "unknown", function: { name: "write_to_live_schedule", arguments: "{}" } },
    ],
    allowedToolNames: ["propose_schedule_operation"],
    maxCalls: 3,
  });
  assert.equal(malformed.rawCallCount, 2);
  assert.equal(malformed.rejectedCount, 2);
  assert.deepEqual(malformed.calls, []);
  assert.equal(validateProviderToolCalls({
    value: { id: "invalid-envelope" },
    allowedToolNames: ["propose_schedule_operation"],
    maxCalls: 3,
  }).rejectedCount, 1);
});

test("only an explicit unassigned request can restrict shift edits to unassigned cells", () => {
  assert.equal(explicitlyRequestsUnassignedScheduleCells("set cashier PM, cooks AM and PM, rest MID"), false);
  assert.equal(explicitlyRequestsUnassignedScheduleCells("set only unassigned cashier cells to PM"), true);
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
  assert.match(prompt, /Include every distinct requested group and assignment as an ordered action/i);
  assert.match(prompt, /Never replace named groups with only unassigned employees/i);
  assert.match(prompt, /complete revised plan/i);
  assert.match(prompt, /preserveExistingDayOff=true/i);
  assert.ok(AI_SCHEDULING_CHAT_TOOLS.includes("propose_schedule_operation"));
  assert.equal(AI_SCHEDULING_CHAT_TOOLS.includes("revise_schedule_draft" as never), false);
  assert.equal(AI_SCHEDULING_CHAT_TOOLS.includes("assign_shift_to_draft_scope" as never), false);
  assert.equal(AI_SCHEDULING_CHAT_TOOLS.some((name) => /approve|publish|payroll|violation/i.test(name)), false);
  assert.equal(MAX_CHAT_COMPLETION_TOKENS, 5_000);
  assert.equal(MAX_CHAT_FINAL_RESPONSE_TOKENS, 600);
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

test("ordered compound intent represents Debbie week PM with Saturday OFF", () => {
  const intent = scheduleOperationIntentSchema.parse({
    operation: "ASSIGN_SHIFT",
    targetType: "EMPLOYEE",
    targetQuery: "Debbie Considine",
    actions: [
      { assignmentKind: "WORK", shiftRef: "PM", workDates: [], usePlannerWeek: true, preserveExistingDayOff: false, onlyUnassigned: false },
      { assignmentKind: "DAY_OFF", shiftRef: null, workDates: ["2026-10-24"], usePlannerWeek: false, preserveExistingDayOff: false, onlyUnassigned: false },
    ],
  });
  assert.equal(intent.actions.length, 2);
  assert.equal(intent.actions[0].usePlannerWeek, true);
  assert.deepEqual(intent.actions[1].workDates, ["2026-10-24"]);

  const dates = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"];
  const assignments = dates.map((workDate) => ({
    employeeId: "debbie-id",
    workDate,
    shiftId: 1,
    assignmentKind: "WORK" as const,
    reason: null,
    isProtected: false,
    hasBaselineOverride: false,
  }));
  const combined = applyScheduleAssignmentSequence({
    assignments,
    employeeIds: ["debbie-id"],
    actions: [
      { dates, shiftId: 2, assignmentKind: "WORK", preserveExistingDayOff: false, onlyUnassigned: false },
      { dates: ["2026-10-24"], shiftId: 9, assignmentKind: "DAY_OFF", preserveExistingDayOff: false, onlyUnassigned: false },
    ],
  });
  assert.deepEqual(combined.assignments.map((assignment) => assignment.assignmentKind), ["WORK", "WORK", "WORK", "WORK", "WORK", "DAY_OFF", "WORK"]);
  assert.deepEqual(combined.assignments.map((assignment) => assignment.shiftId), [2, 2, 2, 2, 2, 9, 2]);
  assert.equal(canApplyScheduleOperation({
    status: "PROPOSAL",
    canApply: true,
    hasAssignments: combined.assignments.length === dates.length,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }), true, "one approval applies the complete combined plan");
});

test("compound group plan can assign separate scopes and split cooks evenly", () => {
  const dates = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"];
  const cashiers = ["cashier-1", "cashier-2", "cashier-3", "cashier-4"];
  const cooks = ["cook-1", "cook-2", "cook-3", "cook-4", "cook-5"];
  const others = ["other-1", "other-2", "other-3"];
  const all = [...cashiers, ...cooks, ...others];
  const [cookAm, cookPm] = splitEmployeesEvenly(cooks, 2, "2026-10-19:Cook");
  assert.equal(cookAm.length, 3);
  assert.equal(cookPm.length, 2);
  assert.deepEqual(splitEmployeesEvenly(cooks, 2, "2026-10-19:Cook"), [cookAm, cookPm]);

  const assignments = all.flatMap((employeeId) => dates.map((workDate) => ({
    employeeId,
    workDate,
    shiftId: 1,
    assignmentKind: "WORK" as const,
    reason: null,
    isProtected: false,
    hasBaselineOverride: false,
  })));
  const result = applyScheduleAssignmentSequence({
    assignments,
    employeeIds: all,
    actions: [
      { employeeIds: cashiers, dates, shiftId: 2, assignmentKind: "WORK", preserveExistingDayOff: false, onlyUnassigned: false },
      { employeeIds: cookAm, dates, shiftId: 3, assignmentKind: "WORK", preserveExistingDayOff: false, onlyUnassigned: false },
      { employeeIds: cookPm, dates, shiftId: 4, assignmentKind: "WORK", preserveExistingDayOff: false, onlyUnassigned: false },
      { employeeIds: others, dates, shiftId: 5, assignmentKind: "WORK", preserveExistingDayOff: false, onlyUnassigned: false },
    ],
  });
  for (const employeeId of cashiers) assert.ok(result.assignments.filter((row) => row.employeeId === employeeId).every((row) => row.shiftId === 2));
  for (const employeeId of cookAm) assert.ok(result.assignments.filter((row) => row.employeeId === employeeId).every((row) => row.shiftId === 3));
  for (const employeeId of cookPm) assert.ok(result.assignments.filter((row) => row.employeeId === employeeId).every((row) => row.shiftId === 4));
  for (const employeeId of others) assert.ok(result.assignments.filter((row) => row.employeeId === employeeId).every((row) => row.shiftId === 5));
  assert.equal(result.assignments.length, all.length * dates.length);

  const intent = scheduleOperationIntentSchema.parse({
    operation: "ASSIGN_SHIFT",
    actions: [
      { targetType: "POSITION", targetQuery: "Cashier", shiftRef: "PM", usePlannerWeek: true },
      { targetType: "POSITION", targetQuery: "Cook", allocationGroup: "cook-split", shiftRef: "AM", usePlannerWeek: true },
      { targetType: "POSITION", targetQuery: "Cook", allocationGroup: "cook-split", shiftRef: "PM", usePlannerWeek: true },
      { targetType: "ALL", excludeTargetQueries: ["Cashier", "Cook"], shiftRef: "MID", usePlannerWeek: true },
    ],
  });
  assert.equal(intent.actions.length, 4);
  assert.equal(intent.targetType, "ALL");
  const prompt = buildSchedulingChatSystemPrompt("2026-10-19", { weekStart: "2026-10-19" });
  assert.match(prompt, /same allocationGroup on both/i);
  assert.match(prompt, /Never replace named groups with only unassigned employees/i);
});

test("natural-language group scopes map Cashier, Cook split, and remaining employees to the right shifts", () => {
  const cashiers = ["cashier-1", "cashier-2", "cashier-3"];
  const cooks = ["cook-1", "cook-2", "cook-3", "cook-4", "cook-5"];
  const others = ["other-1", "other-2"];
  const scopes = inferScheduleActionScopesFromText({
    message: "set cashier pm, set cook half on am and half on pm, and the rest to mid shift",
    groups: [
      { id: "cashier-position", type: "POSITION", name: "Cashier", employeeIds: cashiers },
      { id: "cook-position", type: "POSITION", name: "Cook", employeeIds: cooks },
    ],
    shifts: [
      { id: 2, code: "PM", name: "PM · Afternoon", isDayOff: false },
      { id: 3, code: "AM", name: "AM · Morning", isDayOff: false },
      { id: 5, code: "MID", name: "Mid Shift", isDayOff: false },
    ],
    actionShiftIds: [2, 3, 2, 5],
    allEmployeeIds: [...cashiers, ...cooks, ...others],
  });

  assert.deepEqual(scopes.map((scope) => scope?.targetLabel), [
    "Cashier",
    "Cook",
    "Cook",
    "All employees except Cashier, Cook",
  ]);
  assert.deepEqual(scopes.map((scope) => scope?.employeeIds), [
    cashiers,
    cooks,
    cooks,
    others,
  ]);
  assert.deepEqual(scopes.map((scope) => scope?.splitRequested), [false, true, true, false]);
  const [amCookPartition, pmCookPartition] = splitEmployeesEvenly(cooks, 2, "2026-10-19:POSITION:cook-position");
  assert.equal(amCookPartition.length + pmCookPartition.length, cooks.length);
  assert.equal(new Set([...amCookPartition, ...pmCookPartition]).size, cooks.length);
  const week = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"];
  const employeeIds = [...cashiers, ...cooks, ...others];
  const applied = applyScheduleAssignmentSequence({
    assignments: employeeIds.flatMap((employeeId) => week.map((workDate) => ({
      employeeId,
      workDate,
      shiftId: 1,
      assignmentKind: "WORK" as const,
      isProtected: false,
      hasBaselineOverride: false,
      reason: null,
    }))),
    employeeIds,
    actions: [
      { employeeIds: scopes[0]!.employeeIds, dates: week, shiftId: 2, assignmentKind: "WORK", preserveExistingDayOff: false, onlyUnassigned: false },
      { employeeIds: amCookPartition, dates: week, shiftId: 3, assignmentKind: "WORK", preserveExistingDayOff: false, onlyUnassigned: false },
      { employeeIds: pmCookPartition, dates: week, shiftId: 2, assignmentKind: "WORK", preserveExistingDayOff: false, onlyUnassigned: false },
      { employeeIds: scopes[3]!.employeeIds, dates: week, shiftId: 5, assignmentKind: "WORK", preserveExistingDayOff: false, onlyUnassigned: false },
    ],
  });
  for (const employeeId of cashiers) assert.ok(applied.assignments.filter((row) => row.employeeId === employeeId).every((row) => row.shiftId === 2));
  for (const employeeId of amCookPartition) assert.ok(applied.assignments.filter((row) => row.employeeId === employeeId).every((row) => row.shiftId === 3));
  for (const employeeId of pmCookPartition) assert.ok(applied.assignments.filter((row) => row.employeeId === employeeId).every((row) => row.shiftId === 2));
  for (const employeeId of others) assert.ok(applied.assignments.filter((row) => row.employeeId === employeeId).every((row) => row.shiftId === 5));
});

test("proposal preview selects representative changes across every action group", () => {
  const changes = [
    ...Array.from({ length: 21 }, (_, index) => ({ after: "PM · Afternoon", planLabel: "Cashier → PM · Afternoon", employeeCode: `C${index}` })),
    ...Array.from({ length: 14 }, (_, index) => ({ after: "AM · Morning", planLabel: "Cook → AM · Morning", employeeCode: `A${index}` })),
    ...Array.from({ length: 14 }, (_, index) => ({ after: "PM · Afternoon", planLabel: "Cook → PM · Afternoon", employeeCode: `P${index}` })),
    ...Array.from({ length: 63 }, (_, index) => ({ after: "MID · Mid Shift", planLabel: "All except Cashier, Cook → MID · Mid Shift", employeeCode: `R${index}` })),
  ];
  const preview = selectRepresentativeScheduleChanges(changes, 100);
  assert.equal(preview.length, 100);
  assert.deepEqual(preview.slice(0, 4).map((change) => change.planLabel), [
    "Cashier → PM · Afternoon",
    "Cook → AM · Morning",
    "Cook → PM · Afternoon",
    "All except Cashier, Cook → MID · Mid Shift",
  ]);
  assert.equal(new Set(preview.map((change) => change.planLabel)).size, 4);
});

test("pending corrections inherit resolved target while replacing the complete operation plan", () => {
  const previous = scheduleOperationIntentSchema.parse({
    operation: "ASSIGN_SHIFT",
    targetType: "EMPLOYEE",
    targetQuery: "Debbie Considine",
    actions: [{ assignmentKind: "WORK", shiftRef: "PM", usePlannerWeek: true }],
  });
  const correction = scheduleOperationIntentSchema.parse({
    operation: "ASSIGN_SHIFT",
    actions: [{ assignmentKind: "DAY_OFF", workDates: ["2026-10-23"] }],
  });
  const merged = mergePendingScheduleIntent(previous, correction);
  assert.equal(merged.targetType, "EMPLOYEE");
  assert.equal(merged.targetQuery, "Debbie Considine");
  assert.deepEqual(merged.actions[0].workDates, ["2026-10-23"]);
  assert.equal(merged.actions.length, 1);
});

test("day-off distribution assigns exactly one OFF for every eligible employee", () => {
  const dates = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"];
  const employeeIds = ["cashier-1", "cashier-2", "cashier-3"];
  const assignments = employeeIds.flatMap((employeeId) => dates.map((workDate) => ({
    employeeId,
    workDate,
    shiftId: 1,
    assignmentKind: "WORK" as const,
    isProtected: false,
    hasBaselineOverride: false,
  })));
  const result = distributeDayOffAssignments({
    assignments,
    employeeIds,
    dates,
    dayOffShiftId: 9,
    dayOffShiftIds: [9],
    weekStart: dates[0],
    seed: "exactly-one-off-test",
    dayOffCount: 1,
  });
  assert.deepEqual(result.blocked, []);
  for (const employeeId of employeeIds) {
    assert.equal(result.assignments.filter((assignment) => assignment.employeeId === employeeId && assignment.assignmentKind === "DAY_OFF").length, 1);
  }
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
  assert.equal(containsNaturalGroupName("set all cashiers to PM", "Cashier"), true);
  assert.equal(containsNaturalGroupName("set all cooks to AM", "Cook"), true);
  assert.equal(containsNaturalGroupName("set cooking shift to AM", "Cook"), false);
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
  const normalized = scheduleOperationIntentSchema.parse({ operation: "ASSIGN_SHIFT" });
  assert.equal(normalized.targetType, "ALL");
  assert.deepEqual(normalized.actions, []);
  assert.deepEqual(normalized.workDates, []);
  assert.equal(normalized.usePlannerWeek, false);
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
