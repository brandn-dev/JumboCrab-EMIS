import { z } from "zod";

export const AI_SCHEDULING_CHAT_TOOLS = [
  "get_schedule_context",
  "search_employees",
  "list_staffing_rules",
  "create_schedule_draft",
  "propose_schedule_operation",
  "explain_assignment",
  "compare_draft",
  "validate_schedule_draft",
] as const;

export const MAX_CHAT_MESSAGE_LENGTH = 2_000;
export const MAX_CHAT_HISTORY_MESSAGES = 40;
export const MAX_CHAT_TOOL_ROUNDS = 5;
export const MAX_CHAT_TOOL_CALLS_PER_TURN = 5;
export const MAX_CHAT_COMPLETION_TOKENS = 5_000;
export const MAX_CHAT_FINAL_RESPONSE_TOKENS = 600;
export const MAX_CHAT_INITIAL_TOOL_TOKENS = 2_400;
export const MAX_CHAT_MESSAGES_PER_DAY = 120;
export const MAX_CHAT_MESSAGES_PER_MINUTE = 8;
export const MAX_CHAT_MESSAGES_PER_CONVERSATION = 200;
export const MAX_CHAT_TOOL_RESULT_CHARS = 12_000;

export type TextualProviderToolCall = { name: string; arguments: string };
export type ValidatedProviderToolCall = { id: string; name: string; arguments: string };

export function getCompletionBudget(totalTokens: number, usedTokens: number, finalReservation: number) {
  const remainingTokens = Math.max(0, totalTokens - usedTokens);
  return {
    remainingTokens,
    toolTokens: Math.max(0, remainingTokens - finalReservation),
    finalTokens: Math.min(remainingTokens, finalReservation),
  };
}

export function shouldRetryIncompleteCompletion(input: {
  finishReason: string | null;
  content: string;
  validToolCallCount: number;
  rejectedToolCallCount: number;
}) {
  if (input.finishReason === "length") return true;
  if (input.validToolCallCount > 0) return false;
  return input.rejectedToolCallCount > 0 || input.content.trim().length === 0;
}

export function validateProviderToolCalls(input: {
  value: unknown;
  allowedToolNames: readonly string[];
  maxCalls: number;
}) {
  const rawCalls = Array.isArray(input.value) ? input.value : [];
  const overflow = rawCalls.length > input.maxCalls;
  const calls: ValidatedProviderToolCall[] = [];
  let rejectedCount = overflow ? rawCalls.length - input.maxCalls : input.value == null || Array.isArray(input.value) ? 0 : 1;
  for (const entry of rawCalls.slice(0, input.maxCalls)) {
    if (!entry || typeof entry !== "object") {
      rejectedCount += 1;
      continue;
    }
    const call = entry as Record<string, unknown>;
    const fn = call.function && typeof call.function === "object" ? call.function as Record<string, unknown> : null;
    const rawArguments = fn && (typeof fn.arguments === "string" || (fn.arguments && typeof fn.arguments === "object"))
      ? typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments)
      : null;
    let decoded: unknown = null;
    try {
      decoded = rawArguments ? JSON.parse(rawArguments) as unknown : null;
    } catch {
      rejectedCount += 1;
      continue;
    }
    if (
      typeof call.id !== "string" || call.id.length > 120 ||
      !fn || typeof fn.name !== "string" || !input.allowedToolNames.includes(fn.name) ||
      !rawArguments || rawArguments.length > 8_000 ||
      !decoded || typeof decoded !== "object" || Array.isArray(decoded)
    ) {
      rejectedCount += 1;
      continue;
    }
    calls.push({ id: call.id, name: fn.name, arguments: rawArguments });
  }
  return { calls, rawCallCount: rawCalls.length, rejectedCount, overflow };
}

export const sanitizeSchedulingAssistantMessage = (content: string) => {
  const hasMarkupToolCall = /<tool_call\s*>|<function\s*=|<parameter\s*=/i.test(content);
  const hasJsonToolCall = (() => {
    const normalized = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    if (!normalized.startsWith("{")) return false;
    try {
      const parsed = JSON.parse(normalized) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
      const record = parsed as Record<string, unknown>;
      return typeof record.name === "string" || typeof record.tool === "string" || typeof record.function === "string" ||
        Boolean(record.function && typeof record.function === "object");
    } catch {
      return false;
    }
  })();
  return hasMarkupToolCall || hasJsonToolCall
    ? "Internal scheduling output was hidden. Check the draft preview before retrying."
    : content;
};

export function parseTextualProviderToolCalls(input: {
  content: string;
  allowedToolNames: readonly string[];
  maxCalls?: number;
}) {
  const content = input.content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const hasTextEnvelope = /<tool_call\s*>|<function\s*=|<parameter\s*=/i.test(content);
  const hasJsonEnvelope = (() => {
    if (!content.startsWith("{")) return false;
    try {
      const parsed = JSON.parse(content) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
      const record = parsed as Record<string, unknown>;
      return typeof record.name === "string" || typeof record.tool === "string" || typeof record.function === "string" ||
        Boolean(record.function && typeof record.function === "object");
    } catch {
      return false;
    }
  })();
  const looksLikeToolCall = hasTextEnvelope || hasJsonEnvelope;
  if (!looksLikeToolCall) return { detected: false, calls: [] as TextualProviderToolCall[] };

  const hasToolBlocks = /<tool_call\s*>/i.test(content);
  const blocks = hasToolBlocks
    ? Array.from(content.matchAll(/<tool_call\s*>([\s\S]*?)(?:<\/tool_call\s*>|(?=<tool_call\s*>)|$)/gi), (match) => match[1])
    : [content];
  if (blocks.length === 0 || blocks.length > (input.maxCalls ?? MAX_CHAT_TOOL_CALLS_PER_TURN)) {
    return { detected: true, calls: [] as TextualProviderToolCall[] };
  }

  const calls: TextualProviderToolCall[] = [];
  for (const block of blocks) {
    const functionMatch = block.match(/<function\s*=\s*([a-z0-9_.-]+)\s*>/i);
    const parseArgumentObject = (value: unknown): Record<string, unknown> | null => {
      let parsed = value;
      if (typeof parsed === "string") {
        try {
          parsed = JSON.parse(parsed) as unknown;
        } catch {
          return null;
        }
      }
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    };
    const envelope = (() => {
      const raw = block.trim();
      if (!raw.startsWith("{")) return null;
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        const record = parsed as Record<string, unknown>;
        const fn = record.function && typeof record.function === "object"
          ? record.function as Record<string, unknown>
          : null;
        const name = typeof record.name === "string" ? record.name
          : typeof record.tool === "string" ? record.tool
            : typeof record.function === "string" ? record.function
            : typeof fn?.name === "string" ? fn.name
              : null;
        const args = parseArgumentObject(record.arguments ?? record.parameters ?? record.input ?? fn?.arguments);
        return name && args ? { name, args } : null;
      } catch {
        return null;
      }
    })();
    const name = functionMatch?.[1] ?? envelope?.name;
    if (!name || !input.allowedToolNames.includes(name)) {
      return { detected: true, calls: [] as TextualProviderToolCall[] };
    }
    const parameters = new Map<string, unknown>(envelope ? Object.entries(envelope.args) : []);
    const parameterPattern = /<parameter\s*=\s*([a-zA-Z0-9_]+)\s*>([\s\S]*?)<\/parameter\s*>/gi;
    for (const match of block.matchAll(parameterPattern)) {
      const name = match[1];
      if (parameters.has(name)) return { detected: true, calls: [] as TextualProviderToolCall[] };
      const raw = match[2].trim();
      let value: unknown = raw;
      if (raw) {
        try {
          value = JSON.parse(raw) as unknown;
        } catch {
          value = raw;
        }
      }
      parameters.set(name, value);
    }
    const unparsed = envelope ? "" : block
      .replace(/<function\s*=\s*[a-z0-9_.-]+\s*>/i, "")
      .replace(/<\/function\s*>/gi, "")
      .replace(parameterPattern, "")
      .replace(/<arguments\s*>|<\/arguments\s*>/gi, "")
      .trim();
    if (/<\/?(?:parameter\s*=|function\s*=|arguments\s*>)/i.test(unparsed)) {
      return { detected: true, calls: [] as TextualProviderToolCall[] };
    }
    if (unparsed) {
      if (parameters.size > 0) return { detected: true, calls: [] as TextualProviderToolCall[] };
      const rawArgs = parseArgumentObject(unparsed);
      if (!rawArgs) return { detected: true, calls: [] as TextualProviderToolCall[] };
      for (const [key, value] of Object.entries(rawArgs)) parameters.set(key, value);
    }
    calls.push({ name, arguments: JSON.stringify(Object.fromEntries(parameters)) });
  }
  return { detected: true, calls };
}

const isMondayDate = (value: string) => {
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day, 12));
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day &&
    parsed.getUTCDay() === 1;
};

export const chatRequestSchema = z.object({
  requestKey: z.string().uuid(),
  conversationId: z.string().trim().min(1).max(64).optional(),
  draftId: z.string().trim().min(1).max(64).nullable().optional(),
  weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isMondayDate, "Week must start on Monday.").optional(),
  referenceWeekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isMondayDate, "Reference week must start on Monday.").optional(),
  departmentId: z.string().trim().min(1).max(64).nullable().optional(),
  selectedEmployeeIds: z.array(z.string().trim().min(1).max(64)).max(200).optional(),
  bulkAction: z.enum(["all_week", "confirm", "cancel"]).optional(),
  bulkSourceMessage: z.string().trim().min(1).max(MAX_CHAT_MESSAGE_LENGTH).optional(),
  bulkExpectedDraftVersion: z.number().int().positive().optional(),
  interactionAction: z.enum(["select", "apply", "cancel", "edit", "undo", "back"]).optional(),
  interactionId: z.string().uuid().optional(),
  optionIds: z.array(z.string().uuid()).max(100).optional(),
  message: z.string().trim().min(1).max(MAX_CHAT_MESSAGE_LENGTH),
}).strict().superRefine((request, context) => {
  if (request.bulkAction && !request.bulkSourceMessage) {
    context.addIssue({ code: "custom", path: ["bulkSourceMessage"], message: "Bulk actions require the reviewed request." });
  }
  if (request.bulkAction === "confirm" && request.bulkExpectedDraftVersion == null) {
    context.addIssue({ code: "custom", path: ["bulkExpectedDraftVersion"], message: "Bulk confirmation requires the reviewed draft version." });
  }
  if (request.interactionAction && !request.interactionId) {
    context.addIssue({ code: "custom", path: ["interactionId"], message: "Structured interaction action requires an opaque interaction ID." });
  }
  if (request.interactionAction && !request.conversationId) {
    context.addIssue({ code: "custom", path: ["conversationId"], message: "Structured interaction action requires its existing conversation." });
  }
  if (request.interactionAction === "select" && (!request.optionIds || request.optionIds.length === 0)) {
    context.addIssue({ code: "custom", path: ["optionIds"], message: "Choose one or more server-provided options." });
  }
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;

export type EmployeeSelectionCandidate = {
  employeeId: string;
  employeeCode: string;
  displayName: string;
};

export function matchesScheduleEmployeeQuery(query: string, employee: {
  employeeId: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
}) {
  const trimmedQuery = query.trim();
  const normalizedQuery = trimmedQuery.toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const fullName = `${employee.firstName} ${employee.lastName}`.toLocaleLowerCase();
  const reverseName = `${employee.lastName} ${employee.firstName}`.toLocaleLowerCase();

  // Internal IDs are accepted only as an exact server-side match, for compatibility
  // with older model-visible tool results. Never display them to the manager.
  return employee.employeeId === trimmedQuery ||
    employee.employeeCode.toLocaleLowerCase() === trimmedQuery.toLocaleLowerCase() ||
    fullName === normalizedQuery || reverseName === normalizedQuery ||
    fullName.includes(normalizedQuery) || reverseName.includes(normalizedQuery) ||
    fullName.split(/\s+/).some((part) => part === normalizedQuery);
}

export type ShiftReferenceCandidate = {
  id: number;
  code: string;
  name: string;
  isDayOff?: boolean;
};

const normalizeShiftReference = (value: string) => value
  .trim()
  .toLocaleLowerCase()
  .replace(/^(?:(?:shift)(?:\s+code)?|code)(?:\s+|[-:#])+/i, "")
  .replace(/[\s_-]+/g, "");

export function resolveShiftReference(
  reference: string,
  candidates: ShiftReferenceCandidate[],
) {
  const normalized = normalizeShiftReference(reference);
  if (!normalized) return { status: "not_found" as const };

  const exactCodeMatches = candidates.filter((candidate) => candidate.code.trim().toLocaleLowerCase() === reference.trim().toLocaleLowerCase());
  if (exactCodeMatches.length === 1) return { status: "resolved" as const, shift: exactCodeMatches[0] };
  if (exactCodeMatches.length > 1) return { status: "ambiguous" as const };

  const codeMatches = candidates.filter((candidate) =>
    normalizeShiftReference(candidate.code) === normalized,
  );
  if (codeMatches.length === 1) return { status: "resolved" as const, shift: codeMatches[0] };
  if (codeMatches.length > 1) return { status: "ambiguous" as const };

  const nameMatches = candidates.filter((candidate) =>
    normalizeShiftReference(candidate.name) === normalized,
  );
  if (nameMatches.length === 1) return { status: "resolved" as const, shift: nameMatches[0] };
  if (nameMatches.length > 1) return { status: "ambiguous" as const };

  const abbreviationMatches = candidates.filter((candidate) =>
    (candidate.name.match(/\b[A-Z]{2,4}\b/g) ?? []).some((abbreviation) => normalizeShiftReference(abbreviation) === normalized),
  );
  if (abbreviationMatches.length === 1) return { status: "resolved" as const, shift: abbreviationMatches[0] };
  if (abbreviationMatches.length > 1) return { status: "ambiguous" as const };
  return { status: "not_found" as const };
}

export function extractShiftReferenceFromMessage(message: string, candidates: ShiftReferenceCandidate[]) {
  const reference = message.match(/\bshift(?:\s+code)?(?:\s+(?:(?:to|is|be)\s+)*|\s*[=:]\s*)([a-z0-9][a-z0-9_-]*)\b/i)?.[1];
  if (reference) return resolveShiftReference(reference, candidates);

  const mentionedCodes = candidates.filter((candidate) => {
    const code = candidate.code.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return code && new RegExp(`(?:^|[^\\w])${code}(?:$|[^\\w])`, "i").test(message);
  });
  if (mentionedCodes.length === 1) return { status: "resolved" as const, shift: mentionedCodes[0] };
  if (mentionedCodes.length > 1) return { status: "ambiguous" as const };

  const mentionedNames = candidates.filter((candidate) => {
    const name = candidate.name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return name && new RegExp(`(?:^|[^\\w])${name}(?:$|[^\\w])`, "i").test(message);
  });
  if (mentionedNames.length === 1) return { status: "resolved" as const, shift: mentionedNames[0] };
  if (mentionedNames.length > 1) return { status: "ambiguous" as const };

  const mentionedAbbreviations = candidates.filter((candidate) =>
    (candidate.name.match(/\b[A-Z]{2,4}\b/g) ?? []).some((abbreviation) =>
      new RegExp(`(?:^|[^\\w])${abbreviation}(?:$|[^\\w])`, "i").test(message),
    ),
  );
  if (mentionedAbbreviations.length === 1) return { status: "resolved" as const, shift: mentionedAbbreviations[0] };
  if (mentionedAbbreviations.length > 1) return { status: "ambiguous" as const };
  return { status: "not_found" as const };
}

export function isExplicitBulkScheduleRequest(message: string) {
  const requestsBulkScope = /\b(?:all\s+(?:the\s+)?(?:employees?|staff|team)|every(?:one|body|\s+employee|\s+staff)|whole\s+team)\b/i.test(message);
  const requestsScheduleChange = /\b(?:set|assign|change|switch|move|put|give|make|update)\b/i.test(message) &&
    /\b(?:shift|schedule|day\s+off|off)\b/i.test(message);
  return requestsBulkScope && requestsScheduleChange;
}

export function explicitlyRequestsUnassignedScheduleCells(message: string) {
  return /\bunassigned\b/i.test(message);
}

export function needsBulkScheduleDateClarification(message: string) {
  const monthDate = /\b(?:january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|sept|october|oct|november|nov|december|dec)\s+\d{1,2}(?:,?\s+(?:19|20)\d{2})?\b/i;
  const specifiesDateScope = /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|this\s+week|next\s+week|whole\s+week|all\s+week|entire\s+week|every\s+day|each\s+day)\b|\b\d{4}-\d{2}-\d{2}\b/i.test(message) || monthDate.test(message);
  return isExplicitBulkScheduleRequest(message) && !specifiesDateScope;
}

export function resolveExplicitBulkScheduleDates(message: string, weekStart: string, todayManila?: string) {
  if (/\b(?:except|but\s+not|excluding)\b/i.test(message)) return null;
  if (/\bnext\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(message)) return null;
  const allWeek = /\b(?:this\s+week|next\s+week|whole\s+week|all\s+week|entire\s+week|every\s+day|each\s+day)\b/i.test(message);
  const relativeDateOffsets = [
    ...(/\btoday\b/i.test(message) ? [0] : []),
    ...(/\btomorrow\b/i.test(message) ? [1] : []),
  ];
  const weekdayPatterns = [
    /\b(?:monday|mon)\b/i,
    /\b(?:tuesday|tue|tues)\b/i,
    /\b(?:wednesday|wed)\b/i,
    /\b(?:thursday|thu|thur|thurs)\b/i,
    /\b(?:friday|fri)\b/i,
    /\b(?:saturday|sat)\b/i,
    /\b(?:sunday|sun)\b/i,
  ];
  const days = weekdayPatterns.flatMap((pattern, index) => pattern.test(message) ? [index] : []);
  const explicitDates = Array.from(message.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g), (match) => match[0]);
  const [weekYear] = weekStart.split("-").map(Number);
  const monthNames = new Map([
    ["january", 1], ["jan", 1], ["february", 2], ["feb", 2], ["march", 3], ["mar", 3],
    ["april", 4], ["apr", 4], ["may", 5], ["june", 6], ["jun", 6], ["july", 7], ["jul", 7],
    ["august", 8], ["aug", 8], ["september", 9], ["sep", 9], ["sept", 9], ["october", 10], ["oct", 10],
    ["november", 11], ["nov", 11], ["december", 12], ["dec", 12],
  ]);
  const monthDatePattern = /\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|sept|october|oct|november|nov|december|dec)\s+(\d{1,2})(?:,?\s+((?:19|20)\d{2}))?\b/gi;
  for (const match of message.matchAll(monthDatePattern)) {
    const month = monthNames.get(match[1].toLocaleLowerCase());
    const dateNumber = Number(match[2]);
    const year = Number(match[3] ?? weekYear);
    if (!month) return null;
    const parsed = new Date(Date.UTC(year, month - 1, dateNumber, 12));
    if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== dateNumber) return null;
    explicitDates.push(`${year}-${String(month).padStart(2, "0")}-${String(dateNumber).padStart(2, "0")}`);
  }
  if (!allWeek && days.length === 0 && explicitDates.length === 0 && relativeDateOffsets.length === 0) return null;

  const [year, month, day] = weekStart.split("-").map(Number);
  const monday = new Date(Date.UTC(year, month - 1, day, 12));
  if (
    monday.getUTCFullYear() !== year ||
    monday.getUTCMonth() !== month - 1 ||
    monday.getUTCDate() !== day ||
    monday.getUTCDay() !== 1
  ) return null;
  const weekDates = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(monday);
    date.setUTCDate(date.getUTCDate() + index);
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  });
  if (explicitDates.length && days.length) {
    const dateWeekdays = new Set(explicitDates.map((date) => (new Date(`${date}T12:00:00.000Z`).getUTCDay() + 6) % 7));
    if (days.some((weekday) => !dateWeekdays.has(weekday))) return null;
  }
  const dates = new Set<string>(allWeek ? weekDates : explicitDates);
  if (explicitDates.length === 0) {
    for (const index of days) dates.add(weekDates[index]);
  }
  if (relativeDateOffsets.length) {
    if (!todayManila) return null;
    const [todayYear, todayMonth, todayDay] = todayManila.split("-").map(Number);
    for (const offset of relativeDateOffsets) {
      const relativeDate = new Date(Date.UTC(todayYear, todayMonth - 1, todayDay + offset, 12));
      dates.add(`${relativeDate.getUTCFullYear()}-${String(relativeDate.getUTCMonth() + 1).padStart(2, "0")}-${String(relativeDate.getUTCDate()).padStart(2, "0")}`);
    }
  }
  return Array.from(dates).sort();
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const findExplicitCode = (
  message: string,
  candidates: EmployeeSelectionCandidate[],
) => {
  const matches = candidates.filter((candidate) => {
    const code = candidate.employeeCode.trim();
    if (!code) return false;
    return new RegExp(`(?:^|[^\\w])${escapeRegExp(code)}(?:$|[^\\w])`, "i").test(message);
  });
  return matches.length === 1 ? matches[0].employeeId : null;
};

const ORDINAL_INDEX: Record<string, number> = {
  first: 0,
  "1": 0,
  "1st": 0,
  second: 1,
  "2": 1,
  "2nd": 1,
  third: 2,
  "3": 2,
  "3rd": 2,
  fourth: 3,
  "4": 3,
  "4th": 3,
  fifth: 4,
  "5": 4,
  "5th": 4,
};

export function resolveExplicitEmployeeSelection(
  message: string,
  candidates: EmployeeSelectionCandidate[],
) {
  const byCode = findExplicitCode(message, candidates);
  if (byCode) return byCode;

  const normalized = message.trim().toLocaleLowerCase().replace(/[.!?]+$/, "").trim();
  const ordinal = normalized.match(/^(?:(?:the\s+)?(first|1st|1|second|2nd|2|third|3rd|3|fourth|4th|4|fifth|5th|5)(?:\s+one)?|(?:choose|select|option|number|#)\s*(first|1st|1|second|2nd|2|third|3rd|3|fourth|4th|4|fifth|5th|5))$/i);
  if (ordinal) {
    const index = ORDINAL_INDEX[(ordinal[1] ?? ordinal[2]).toLocaleLowerCase()];
    return candidates[index]?.employeeId ?? null;
  }

  const byExactName = candidates.filter((candidate) =>
    candidate.displayName.trim().toLocaleLowerCase() === normalized,
  );
  return byExactName.length === 1 ? byExactName[0].employeeId : null;
}

export function requiresEmployeeSelectionConfirmation(input: {
  employeeId: string;
  confirmedEmployeeIds: Set<string>;
  pendingCandidates: EmployeeSelectionCandidate[];
  hasDuplicateName: boolean;
}) {
  return !input.confirmedEmployeeIds.has(input.employeeId) && (
    input.hasDuplicateName || input.pendingCandidates.some((candidate) => candidate.employeeId === input.employeeId)
  );
}

export const isAiSchedulingChatEnabled = (input: {
  schedulingFlag: string | undefined;
  chatFlag: string | undefined;
}) => input.schedulingFlag === "true" && input.chatFlag === "true";

export function redactSensitiveText(value: string) {
  return value
    .replace(/\b(password|passcode|secret|api[ _-]?key|access[ _-]?token|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[secret redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, "Bearer [secret redacted]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email redacted]")
    .replace(/\b(?:\+?63|0)[\s().-]*\d(?:[\s().-]*\d){8,}\b/g, "[phone redacted]");
}

export function buildSchedulingChatSystemPrompt(todayManila: string, context?: {
  weekStart?: string | null;
  referenceWeekStart?: string | null;
  scope?: { departmentId?: string | null; selectedEmployeeCount?: number };
  activeDraft?: { id: string; version: number; status: string; isSourceStale: boolean } | null;
  pendingOperationSummary?: string | null;
  pendingOperationDetails?: string | null;
}) {
  const lines = [
    "You are JumboCrab EMIS's manager-only weekly scheduling assistant.",
    `Today is ${todayManila} in Asia/Manila. Weeks run Monday through Sunday.`,
    "Use only facts returned by the scheduling tools. Do not invent staffing, rest, hours, or eligibility policies; say Not configured when absent.",
    "Interpret ordinary conversational English, Filipino, or mixed phrasing. Resolve all names, roles, departments, dates, and shifts using authorized tool results. Never invent entities or IDs. Employee tool results show names and employee codes only: use those exact human-readable values in employee queries; never use or output database IDs.",
    "You may read context and propose changes to an isolated schedule draft. Never write schedule cells yourself and never claim a live schedule changed. Use propose_schedule_operation for requested assignments, day-off plans, and swaps; server validates and previews before a manager can apply changes to the draft.",
    "Approval and publication are not available to you. Refuse requests to publish, approve, or bypass validation.",
    "Before changing a cell, ensure the target draft, employee, and date are known. Ask only when one is missing or the employee name is ambiguous; then show employee codes and wait for the manager to choose. Never guess the employee identity.",
    "Never ask the manager for a database shift ID.",
    "Resolve shifts from active shift options by code or name. Use Shift.isDayOff=true to find day-off shifts. Never ask the manager for a database shift ID.",
    "For working shift assignments, include the exact shift code or shift name as shiftRef (for example, manager saying 'shift 2' means resolve active code 2). If no unique shift matches, return a clickable shift choice.",
    "Return one propose_schedule_operation call per scheduling request. Include every distinct requested group and assignment as an ordered action; action-level target scopes may differ. Never replace named groups with only unassigned employees. Later actions override earlier ones only for overlapping employees and dates.",
    "For 'cashiers PM, half the cooks AM and half PM, rest MID', create four whole-week WORK actions: POSITION Cashier to PM; POSITION Cook to AM and POSITION Cook to PM with the same allocationGroup on both; then ALL to MID with excludeTargetQueries [Cashier, Cook]. The server splits cooks into balanced, stable groups. Do not use onlyUnassigned unless the manager explicitly says unassigned.",
    "For weekly planner requests without named dates, use the selected planner week and set usePlannerWeek=true on each action. For multi-scope plans, keep the proposal-level target as ALL and set each action's own targetType and targetQuery.",
    "For requests like 'set all cashier shifts to PM', target the matching POSITION, resolve the active PM shift, and set usePlannerWeek=true when no specific date is named. If manager says keep or do not change current day off, set preserveExistingDayOff=true; server will retain each existing DAY_OFF cell and propose PM only on other requested days. If manager says unassigned shifts, set onlyUnassigned=true so every already assigned shift and day off stays unchanged.",
    "For day-off planning, default to exactly one OFF assignment per person in the selected planner week unless the manager says at least one. Use the active Shift definition with isDayOff=true. Preserve existing compliant OFF assignments. Never replace protected leave, overrides, extra OFF assignments, or locked/published schedules with an invented working shift.",
    "For group requests, identify whether target is all, a position, a department, or named employee. 'Cashiers' usually means position; use database position and department relationships to resolve it. Respect exclusions such as 'except managers'. If target is ambiguous, propose a clarification instead of guessing.",
    "For multiple individually named employees, put each separate name or code in targetEmployeeQueries. Resolve every name inside active draft scope; do not combine names into one query string.",
    "For corrections like 'make it Friday instead', use the pending operation context and return a complete revised plan, retaining every prior action except the detail the manager corrected. Never create a second partial proposal.",
    "A one-off restriction such as 'no cashier OFF Sunday' applies only to the day-off proposal being discussed unless a manager explicitly asks to configure a standing policy. Do not invent or persist company policy.",
    "Use the displayed planner week in context for 'this week'. Include exact returned dates in proposed operations. Ask when the date or scope cannot be safely resolved.",
    "Resolve a weekday from the selected planner week: a weekday alone means exactly that date in that week. Do not add dates from another week or change multiple dates unless the manager explicitly asks.",
    "Use exact draft dates returned by tools. Keep revisions limited to requested cells and let backend validation enforce constraints.",
    "Ask only for required missing details. If a tool rejects an action, explain the returned reason and do not claim success.",
    "Avoid unnecessary personal data. Use English, Filipino, or Cebuano to match the manager.",
  ];
  if (context?.weekStart) lines.push(`Current planner week starts Monday ${context.weekStart}. Resolve weekdays only within this selected week unless the manager explicitly names a date or another week.`);
  if (context?.referenceWeekStart) lines.push(`Current reference week starts Monday ${context.referenceWeekStart}. Use it when manager says reference week or last week.`);
  if (context?.scope) {
    lines.push(context.scope.selectedEmployeeCount
      ? `Current planner employee selection contains ${context.scope.selectedEmployeeCount} employee(s). Use it as draft scope unless manager asks for another department.`
      : context.scope.departmentId
        ? `Current planner department ID is ${context.scope.departmentId}. Use it as draft scope unless manager asks for another department.`
        : "No employees or department are selected in the planner. New draft defaults to all active employees unless manager narrows scope.");
  }
  if (context?.activeDraft) {
    lines.push(`Active draft: ID ${context.activeDraft.id}, version ${context.activeDraft.version}, status ${context.activeDraft.status}, source stale=${context.activeDraft.isSourceStale}. Use this exact ID for draft tools.`);
  } else {
    lines.push("No draft is currently selected. If a draft edit is requested, ask to create/select a draft first.");
  }
  if (context?.pendingOperationSummary) {
    lines.push(`Pending manager operation: ${context.pendingOperationSummary}. Interpret follow-up corrections as edits to this operation. Do not apply it; return a revised structured proposal.`);
  }
  if (context?.pendingOperationDetails) lines.push(`Pending plan details: ${context.pendingOperationDetails}`);
  return lines.join("\n");
}
