import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { AiMessageRole, Prisma } from "@prisma/client";
import { CURRENT_STATUS } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireScheduleManager } from "@/lib/scheduling-auth";
import {
  isAiSchedulingChatEnabled,
  extractShiftReferenceFromMessage,
  isExplicitBulkScheduleRequest,
  matchesScheduleEmployeeQuery,
  needsBulkScheduleDateClarification,
  resolveExplicitEmployeeSelection,
  resolveExplicitBulkScheduleDates,
  resolveShiftReference,
  requiresEmployeeSelectionConfirmation,
  type EmployeeSelectionCandidate,
} from "@/lib/ai-scheduling-chat-policy";
import {
  applyShiftAssignmentProposal,
  applyScheduleAssignmentSequence,
  containsNaturalGroupName,
  distributeDayOffAssignments,
  canApplyScheduleOperation,
  isScheduleOperationExpired,
  isValidScheduleOperationSelection,
  inferScheduleActionScopesFromText,
  matchesScheduleOperationDraftVersion,
  matchesNaturalGroupName,
  mergePendingScheduleIntent,
  selectRepresentativeScheduleChanges,
  scheduleOperationIntentSchema,
  splitEmployeesEvenly,
  type ScheduleOperationIntent,
} from "@/lib/ai-scheduling-operation-policy";
import {
  createScheduleDraft,
  getScheduleDraftVersion,
  saveScheduleDraftVersion,
  ScheduleDraftServiceError,
} from "@/lib/schedule-draft-service";
import {
  listScheduleCoverageRules,
  SchedulePolicyServiceError,
  previewScheduleDraftGeneration,
  validateScheduleDraftCandidate,
  validateScheduleDraftCandidates,
  validateScheduleDraft,
} from "@/lib/schedule-policy-service";
import { requireAiSchedulingEnabled } from "@/lib/ai-scheduling-feature";
import { getWeekDates, parseWeekStartInput, toPlannerDateKey } from "@/lib/week-planner";
import { startOfZonedDay } from "@/lib/timezone";
import {
  AI_SCHEDULING_CHAT_TOOLS,
  MAX_CHAT_COMPLETION_TOKENS,
  MAX_CHAT_FINAL_RESPONSE_TOKENS,
  MAX_CHAT_HISTORY_MESSAGES,
  MAX_CHAT_INITIAL_TOOL_TOKENS,
  MAX_CHAT_MESSAGES_PER_CONVERSATION,
  MAX_CHAT_MESSAGES_PER_DAY,
  MAX_CHAT_MESSAGES_PER_MINUTE,
  MAX_CHAT_TOOL_CALLS_PER_TURN,
  MAX_CHAT_TOOL_RESULT_CHARS,
  MAX_CHAT_TOOL_ROUNDS,
  buildSchedulingChatSystemPrompt,
  explicitlyRequestsUnassignedScheduleCells,
  getCompletionBudget,
  parseTextualProviderToolCalls,
  redactSensitiveText,
  sanitizeSchedulingAssistantMessage,
  shouldRetryIncompleteCompletion,
  validateProviderToolCalls,
  type ChatRequest,
} from "@/lib/ai-scheduling-chat-policy";

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const MAX_PROVIDER_TIMEOUT_MS = 25_000;
const TOOL_NAMES = new Set<string>([
  ...AI_SCHEDULING_CHAT_TOOLS,
  "revise_schedule_draft",
  "assign_shift_to_draft_scope",
]);

export class ScheduleChatError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "ScheduleChatError";
  }
}

type ChatActor = { userId: string };
type PendingSelection = {
  candidates: EmployeeSelectionCandidate[];
  draftId: string | null;
  createdAt: string;
};
type StoredMessageInput = {
  role: AiMessageRole;
  content: string;
  toolName?: string | null;
  toolCallId?: string | null;
  replyToRequestKey?: string | null;
};
type ProviderToolCall = { id: string; name: string; arguments: string };
type BulkQuickAction = {
  id: "all_week" | "choose_dates" | "confirm" | "cancel";
  label: string;
  bulkAction?: "all_week" | "confirm" | "cancel";
  sourceMessage?: string;
  prefill?: string;
  expectedDraftVersion?: number;
};
type ScheduleInteractionChoice = { id: string; label: string; description?: string };
type ScheduleInteraction = {
  id: string;
  kind: "CLARIFICATION" | "PROPOSAL" | "APPLIED" | "CANCELLED" | "EXPIRED" | "UNDONE";
  title: string;
  summary: string;
  selectionMode?: "single" | "multiple";
  options?: ScheduleInteractionChoice[];
  changes?: Array<{ employeeCode: string; employeeName: string; workDate: string; before: string; after: string; planLabel?: string }>;
  changeCount?: number;
  changesTruncated?: boolean;
  warnings?: string[];
  blockers?: string[];
  canApply?: boolean;
  canUndo?: boolean;
  canGoBack?: boolean;
};
type PendingScheduleOperation = {
  kind: "SCHEDULE_OPERATION";
  id: string;
  createdAt: string;
  expiresAt: string;
  draftId: string;
  draftVersion: number;
  draftFingerprint: string;
  sourceFingerprint: string;
  weekStart: string;
  sourceMessage: string;
  status: "CLARIFICATION" | "PROPOSAL" | "APPLIED" | "CANCELLED" | "UNDONE";
  intent: ScheduleOperationIntent;
  targetEmployeeIds: string[];
  choices?: Array<ScheduleInteractionChoice & { value: Record<string, string | number | boolean | null> }>;
  selectionMode?: "single" | "multiple";
  assignments?: Array<{
    employeeId: string;
    workDate: string;
    shiftId: number | null;
    assignmentKind: "WORK" | "DAY_OFF" | "UNASSIGNED" | "PROTECTED_LEAVE";
    reason?: string | null;
  }>;
  beforeAssignments?: Array<{
    employeeId: string;
    workDate: string;
    shiftId: number | null;
    assignmentKind: "WORK" | "DAY_OFF" | "UNASSIGNED" | "PROTECTED_LEAVE";
    reason?: string | null;
  }>;
  changes?: ScheduleInteraction["changes"];
  warnings?: string[];
  blockers?: string[];
  appliedDraftId?: string;
  appliedDraftVersion?: number;
  appliedDraftFingerprint?: string;
  interaction?: ScheduleInteraction;
  previous?: PendingScheduleOperation;
};
type ProviderMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

const compact = (value: unknown) => {
  const serialized = JSON.stringify(value);
  return serialized.length <= MAX_CHAT_TOOL_RESULT_CHARS
    ? serialized
    : `${serialized.slice(0, MAX_CHAT_TOOL_RESULT_CHARS - 24)}…[result truncated]`;
};

const parseToolArgs = <T>(schema: z.ZodType<T>, value: string): T => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new ScheduleChatError("Tool arguments were invalid.");
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) {
    const details = parsed.error.issues.slice(0, 5).map((issue) => {
      const path = issue.path.map(String).join(".");
      return `${path || "arguments"}: ${issue.message}`;
    });
    throw new ScheduleChatError(`Tool arguments were incomplete or invalid: ${details.join("; ")}`);
  }
  return parsed.data;
};

const requestIdempotencyKey = (outerRequestKey: string, suffix: string) =>
  `ai:${createHash("sha256").update(`${outerRequestKey}:${suffix}`).digest("hex").slice(0, 48)}`;

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
};

const canonicalizeToolArguments = (value: string) => {
  try {
    return JSON.stringify(canonicalize(JSON.parse(value) as unknown));
  } catch {
    return value;
  }
};

const isKnownSchedulingError = (error: unknown) =>
  error instanceof ScheduleDraftServiceError || error instanceof SchedulePolicyServiceError || error instanceof ScheduleChatError;

const safeToolError = (error: unknown) => {
  if (error instanceof ScheduleChatError && error.message === "Scheduling chat is disabled.") throw error;
  if (error instanceof ScheduleChatError) return error.message;
  if (error instanceof ScheduleDraftServiceError || error instanceof SchedulePolicyServiceError) return error.message;
  if (error instanceof Error && ["Unauthorized", "Forbidden", "AI scheduling is disabled"].includes(error.message)) {
    throw error;
  }
  return "Scheduling action could not be completed. Check the draft and inputs, then try again.";
};

const ensureChatEnabled = () => {
  requireAiSchedulingEnabled();
  if (!isAiSchedulingChatEnabled({
    schedulingFlag: process.env.AI_SCHEDULING_ENABLED,
    chatFlag: process.env.AI_SCHEDULING_CHAT_ENABLED,
  })) {
    throw new ScheduleChatError("Scheduling chat is disabled.", 404);
  }
};

const ensureToolActor = async (expectedUserId: string): Promise<ChatActor> => {
  ensureChatEnabled();
  const actor = await requireScheduleManager();
  if (actor.userId !== expectedUserId) throw new Error("Forbidden");
  return actor;
};

const getDayStartManila = () => {
  const dateKey = toPlannerDateKey(new Date());
  return startOfZonedDay(new Date(`${dateKey}T12:00:00.000Z`));
};

const readPendingSelection = (value: Prisma.JsonValue | null): PendingSelection | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, Prisma.JsonValue>;
  if (!Array.isArray(obj.candidates)) return null;
  const candidates = obj.candidates.flatMap((entry): EmployeeSelectionCandidate[] => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const row = entry as Record<string, Prisma.JsonValue>;
    if (
      typeof row.employeeId !== "string" ||
      typeof row.employeeCode !== "string" ||
      typeof row.displayName !== "string"
    ) return [];
    return [{ employeeId: row.employeeId, employeeCode: row.employeeCode, displayName: row.displayName }];
  });
  if (candidates.length < 2) return null;
  return {
    candidates,
    draftId: typeof obj.draftId === "string" ? obj.draftId : null,
    createdAt: typeof obj.createdAt === "string" ? obj.createdAt : "",
  };
};

const readPendingScheduleOperation = (value: Prisma.JsonValue | null): PendingScheduleOperation | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, Prisma.JsonValue>;
  if (
    record.kind !== "SCHEDULE_OPERATION" ||
    typeof record.id !== "string" ||
    typeof record.createdAt !== "string" ||
    typeof record.expiresAt !== "string" ||
    typeof record.draftId !== "string" ||
    typeof record.draftVersion !== "number" ||
    typeof record.draftFingerprint !== "string" ||
    typeof record.sourceFingerprint !== "string" ||
    typeof record.weekStart !== "string" ||
    typeof record.sourceMessage !== "string" ||
    !["CLARIFICATION", "PROPOSAL", "APPLIED", "CANCELLED", "UNDONE"].includes(String(record.status))
  ) return null;
  const intent = scheduleOperationIntentSchema.safeParse(record.intent);
  if (!intent.success || !Array.isArray(record.targetEmployeeIds)) return null;
  return { ...(record as unknown as PendingScheduleOperation), intent: intent.data };
};

const reserveUserMessage = async (input: ChatRequest & { userId: string }) => {
  const dayStart = getDayStartManila();
  const minuteStart = new Date(Date.now() - 60_000);
  const conversation = await db.$transaction(async (tx) => {
    await tx.$queryRaw`WITH user_day_lock AS (SELECT pg_advisory_xact_lock(hashtext(${input.userId}), hashtext(${toPlannerDateKey(new Date())}))) SELECT 1 AS locked FROM user_day_lock`;

    const prior = await tx.aiMessage.findUnique({
      where: { requestKey: input.requestKey },
      include: { conversation: { select: { id: true, userId: true, activeDraftId: true, pendingInteraction: true } } },
    });
    if (prior) {
      if (prior.conversation.userId !== input.userId) throw new ScheduleChatError("Request key is unavailable.", 409);
      const reply = await tx.aiMessage.findUnique({ where: { replyToRequestKey: input.requestKey } });
      if (reply) return { replay: true as const, conversation: prior.conversation, reply };
      throw new ScheduleChatError("This chat request already started. Send a new message to continue.", 409);
    }

    const dailyCount = await tx.aiMessage.count({
      where: {
        role: AiMessageRole.USER,
        createdAt: { gte: dayStart },
        conversation: { userId: input.userId },
      },
    });
    if (dailyCount >= MAX_CHAT_MESSAGES_PER_DAY) throw new ScheduleChatError("Daily scheduling chat limit reached.", 429);

    const minuteCount = await tx.aiMessage.count({
      where: {
        role: AiMessageRole.USER,
        createdAt: { gte: minuteStart },
        conversation: { userId: input.userId },
      },
    });
    if (minuteCount >= MAX_CHAT_MESSAGES_PER_MINUTE) throw new ScheduleChatError("Please wait a moment before sending another scheduling message.", 429);

    const selectedConversation = input.conversationId
      ? await tx.aiConversation.findFirst({
          where: { id: input.conversationId, userId: input.userId },
          select: { id: true, userId: true, activeDraftId: true, pendingInteraction: true },
        })
      : await tx.aiConversation.create({
          data: { userId: input.userId, activeDraftId: input.draftId ?? null },
          select: { id: true, userId: true, activeDraftId: true, pendingInteraction: true },
        });
    if (!selectedConversation) throw new ScheduleChatError("Conversation not found.", 404);

    const conversationCount = await tx.aiMessage.count({
      where: { conversationId: selectedConversation.id, role: AiMessageRole.USER },
    });
    if (conversationCount >= MAX_CHAT_MESSAGES_PER_CONVERSATION) {
      throw new ScheduleChatError("This conversation reached its message limit. Start a new conversation.", 429);
    }

    const activeDraftId = input.draftId ?? selectedConversation.activeDraftId;
    if (activeDraftId !== selectedConversation.activeDraftId) {
      await tx.aiConversation.update({
        where: { id: selectedConversation.id },
        data: { activeDraftId, updatedAt: new Date() },
      });
      selectedConversation.activeDraftId = activeDraftId;
    }
    const latest = await tx.aiMessage.aggregate({
      where: { conversationId: selectedConversation.id },
      _max: { sequence: true },
    });
    await tx.aiMessage.create({
      data: {
        conversationId: selectedConversation.id,
        sequence: (latest._max.sequence ?? 0) + 1,
        role: AiMessageRole.USER,
        content: input.message,
        requestKey: input.requestKey,
      },
    });
    return { replay: false as const, conversation: selectedConversation, reply: null };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  return conversation;
};

const appendMessages = async (
  conversationId: string,
  userId: string,
  messages: StoredMessageInput[],
) => {
  if (messages.length === 0) return;
  await db.$transaction(async (tx) => {
    const owned = await tx.aiConversation.updateMany({
      where: { id: conversationId, userId },
      data: { updatedAt: new Date() },
    });
    if (owned.count !== 1) throw new ScheduleChatError("Conversation not found.", 404);
    const latest = await tx.aiMessage.aggregate({
      where: { conversationId },
      _max: { sequence: true },
    });
    let sequence = (latest._max.sequence ?? 0) + 1;
    await tx.aiMessage.createMany({
      data: messages.map((message) => ({
        conversationId,
        sequence: sequence++,
        role: message.role,
        content: message.content.slice(0, MAX_CHAT_TOOL_RESULT_CHARS),
        toolName: message.toolName ?? null,
        toolCallId: message.toolCallId ?? null,
        replyToRequestKey: message.replyToRequestKey ?? null,
      })),
    });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
};

const savePendingSelection = async (
  conversationId: string,
  userId: string,
  pending: PendingSelection | null,
) => {
  const current = await db.aiConversation.findFirst({
    where: { id: conversationId, userId },
    select: { pendingInteraction: true },
  });
  if (readPendingScheduleOperation(current?.pendingInteraction ?? null)) return;
  await db.aiConversation.updateMany({
    where: { id: conversationId, userId },
    data: { pendingInteraction: pending ? pending as unknown as Prisma.InputJsonObject : Prisma.DbNull },
  });
};

const savePendingScheduleOperation = async (
  conversationId: string,
  userId: string,
  pending: PendingScheduleOperation | null,
  activeDraftId?: string,
) => {
  const updated = await db.aiConversation.updateMany({
    where: { id: conversationId, userId },
    data: {
      pendingInteraction: pending ? pending as unknown as Prisma.InputJsonObject : Prisma.DbNull,
      ...(activeDraftId ? { activeDraftId } : {}),
      updatedAt: new Date(),
    },
  });
  if (updated.count !== 1) throw new ScheduleChatError("Conversation not found.", 404);
};

const setActiveDraft = async (conversationId: string, userId: string, draftId: string) => {
  const updated = await db.aiConversation.updateMany({
    where: { id: conversationId, userId },
    data: { activeDraftId: draftId, updatedAt: new Date() },
  });
  if (updated.count !== 1) throw new ScheduleChatError("Conversation not found.", 404);
};

const assertDraftForOwner = (draftId: string, ownerUserId: string) =>
  getScheduleDraftVersion({ draftId, ownerUserId });

const toolSchemas = {
  get_schedule_context: z.object({ draftId: z.string().min(1).max(64) }).strict(),
  search_employees: z.object({
    query: z.string().trim().min(2).max(80),
    draftId: z.string().min(1).max(64).optional(),
    departmentId: z.string().min(1).max(64).optional(),
  }).strict(),
  list_staffing_rules: z.object({ draftId: z.string().min(1).max(64) }).strict(),
  create_schedule_draft: z.object({
    weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    sourceMode: z.enum(["CURRENT_SCHEDULE", "REFERENCE_WEEK", "EMPTY"]),
    referenceWeekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    departmentId: z.string().min(1).max(64).nullable().optional(),
  }).strict(),
  revise_schedule_draft: z.object({
    draftId: z.string().min(1).max(64),
    employeeId: z.string().min(1).max(64),
    workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    assignmentKind: z.enum(["WORK", "DAY_OFF", "UNASSIGNED"]),
    shiftRef: z.string().trim().min(1).max(64).nullable(),
  }).strict().superRefine((args, context) => {
    if (args.assignmentKind === "WORK" && args.shiftRef === null) {
      context.addIssue({ code: "custom", path: ["shiftRef"], message: "Working assignments need a shift code or name." });
    }
    if (args.assignmentKind !== "WORK" && args.shiftRef !== null) {
      context.addIssue({ code: "custom", path: ["shiftRef"], message: "Day off and unassigned cells do not take a shift reference." });
    }
  }),
  assign_shift_to_draft_scope: z.object({
    draftId: z.string().min(1).max(64),
    shiftRef: z.string().trim().min(1).max(64),
    workDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1).max(7),
  }).strict().superRefine((args, context) => {
    if (new Set(args.workDates).size !== args.workDates.length) {
      context.addIssue({ code: "custom", path: ["workDates"], message: "Dates must be unique." });
    }
  }),
  explain_assignment: z.object({
    draftId: z.string().min(1).max(64),
    employeeId: z.string().min(1).max(64),
    workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }).strict(),
  compare_draft: z.object({ draftId: z.string().min(1).max(64) }).strict(),
  validate_schedule_draft: z.object({ draftId: z.string().min(1).max(64) }).strict(),
  propose_schedule_operation: scheduleOperationIntentSchema,
} as const;

const providerTools = [
  {
    type: "function",
    function: {
      name: "get_schedule_context",
      description: "Read compact, authorized context for an owned schedule draft.",
      parameters: { type: "object", properties: { draftId: { type: "string" } }, required: ["draftId"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "search_employees",
      description: "Find active employees by name or employee code; return employee codes when names are ambiguous.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 2, maxLength: 80 },
          draftId: { type: "string" },
          departmentId: { type: "string" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_staffing_rules",
      description: "Read active staffing policies applicable to this draft's week and scope.",
      parameters: { type: "object", properties: { draftId: { type: "string" } }, required: ["draftId"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "create_schedule_draft",
      description: "Create an isolated schedule draft. This never writes live schedules.",
      parameters: {
        type: "object",
        properties: {
          weekStart: { type: "string", description: "Monday date in YYYY-MM-DD format." },
          sourceMode: { type: "string", enum: ["CURRENT_SCHEDULE", "REFERENCE_WEEK", "EMPTY"] },
          referenceWeekStart: { type: ["string", "null"] },
          departmentId: { type: ["string", "null"] },
        },
        required: ["weekStart", "sourceMode"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "revise_schedule_draft",
      description: "Change one cell in the latest editable owned draft. For WORK, resolve the manager's shift code or name from get_schedule_context.shiftOptions and pass it as shiftRef; never request a database shift ID. For DAY_OFF or UNASSIGNED, pass shiftRef null. Backend preserves all other days and validates the new version.",
      parameters: {
        type: "object",
        properties: {
          draftId: { type: "string" },
          employeeId: { type: "string" },
          workDate: { type: "string", description: "Exact YYYY-MM-DD draft day." },
          assignmentKind: { type: "string", enum: ["WORK", "DAY_OFF", "UNASSIGNED"] },
          shiftRef: { type: ["string", "null"], description: "Exact active shift code or name from shiftOptions; null for DAY_OFF or UNASSIGNED." },
        },
        required: ["draftId", "employeeId", "workDate", "assignmentKind", "shiftRef"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "assign_shift_to_draft_scope",
      description: "Assign one active working shift to every employee already included in the selected draft, for the explicitly named dates only. Resolve shiftRef by exact shift code or name from get_schedule_context.shiftOptions. Never broaden draft scope, overwrite protected leave or overrides, or change the live schedule.",
      parameters: {
        type: "object",
        properties: {
          draftId: { type: "string" },
          shiftRef: { type: "string", description: "Exact active shift code or name; e.g. code '2' can be passed as '2'." },
          workDates: { type: "array", minItems: 1, maxItems: 7, items: { type: "string", description: "Exact YYYY-MM-DD date from the selected draft week." } },
        },
        required: ["draftId", "shiftRef", "workDates"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_schedule_operation",
      description: "Create one validated proposal containing ordered actions, each with its own optional employee/position/department scope and exclusions. Use action-level scopes for requests assigning different groups to different shifts. For an even split of one group across shifts, set the same allocationGroup on each action; server creates stable, balanced employee partitions. Later actions override earlier assignments only for employees and dates they target. Server resolves entities and validates the complete proposal; this tool never writes draft or live assignments.",
      parameters: {
        type: "object",
        properties: {
          operation: { type: "string", enum: ["ASSIGN_SHIFT", "DISTRIBUTE_DAY_OFF", "SWAP_SHIFTS", "NO_DAY_OFF", "BALANCE_COVERAGE"] },
          targetType: { type: "string", enum: ["ALL", "POSITION", "DEPARTMENT", "EMPLOYEE"] },
          targetQuery: { type: ["string", "null"] },
          targetEmployeeQueries: { type: "array", maxItems: 25, items: { type: "string" } },
          excludeTargetQueries: { type: "array", maxItems: 10, items: { type: "string" } },
          shiftRef: { type: ["string", "null"] },
          workDates: { type: "array", maxItems: 7, items: { type: "string", description: "Exact YYYY-MM-DD date from the displayed planner week." } },
          usePlannerWeek: { type: "boolean" },
          preserveExistingDayOff: { type: "boolean", description: "Keep existing DAY_OFF assignments unchanged while applying a working shift to other requested cells." },
          onlyUnassigned: { type: "boolean", description: "Apply the shift only to cells currently marked UNASSIGNED; leave all assigned shifts and days off unchanged." },
          dayOffCount: { type: ["integer", "null"], minimum: 1, maximum: 7 },
          minimumOnly: { type: "boolean" },
          noDayOffWeekdays: { type: "array", maxItems: 7, items: { type: "integer", minimum: 1, maximum: 7, description: "ISO weekday, Monday=1 through Sunday=7." } },
          sourceEmployeeQuery: { type: ["string", "null"] },
          targetEmployeeQuery: { type: ["string", "null"] },
          sourceDate: { type: ["string", "null"] },
          targetDate: { type: ["string", "null"] },
          actions: {
            type: "array",
            maxItems: 7,
            description: "Ordered changes for one combined draft proposal. Use when the sentence includes multiple related assignments or exceptions.",
            items: {
              type: "object",
              properties: {
                targetType: { type: ["string", "null"], enum: ["ALL", "POSITION", "DEPARTMENT", "EMPLOYEE", null], description: "Optional scope for this action; if omitted, inherit the proposal target." },
                targetQuery: { type: ["string", "null"], description: "Position, department, or employee name/code for this action." },
                targetEmployeeQueries: { type: "array", maxItems: 25, items: { type: "string" } },
                excludeTargetQueries: { type: "array", maxItems: 10, items: { type: "string" }, description: "Groups or employees to leave unchanged within this action." },
                allocationGroup: { type: ["string", "null"], description: "Use the same non-empty group name on actions that split one target group evenly across different shifts; server assigns employees to balanced, stable partitions." },
                assignmentKind: { type: "string", enum: ["WORK", "DAY_OFF", "UNASSIGNED"] },
                shiftRef: { type: ["string", "null"], description: "Active shift name/code for WORK; null for DAY_OFF or UNASSIGNED." },
                workDates: { type: "array", maxItems: 7, items: { type: "string", description: "Exact date in the selected planner week." } },
                usePlannerWeek: { type: "boolean" },
                preserveExistingDayOff: { type: "boolean" },
                onlyUnassigned: { type: "boolean" },
              },
              required: ["assignmentKind"],
              additionalProperties: false,
            },
          },
        },
        required: ["operation"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "explain_assignment",
      description: "Explain one draft cell using its source, overrides, leave, and recorded audit facts.",
      parameters: {
        type: "object",
        properties: { draftId: { type: "string" }, employeeId: { type: "string" }, workDate: { type: "string" } },
        required: ["draftId", "employeeId", "workDate"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "compare_draft",
      description: "Compare candidate assignments with each saved baseline and protected override.",
      parameters: { type: "object", properties: { draftId: { type: "string" } }, required: ["draftId"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "validate_schedule_draft",
      description: "Run deterministic backend validation and return blockers, warnings, and information.",
      parameters: { type: "object", properties: { draftId: { type: "string" } }, required: ["draftId"], additionalProperties: false },
    },
  },
].filter((tool) => !["revise_schedule_draft", "assign_shift_to_draft_scope"].includes(tool.function.name))
  .map((tool) => ({ ...tool, type: "function" as const }));

const PROVIDER_TOOL_NAMES = new Set(providerTools.map((tool) => tool.function.name));

const ensureMondayInput = (value: string, label: string) => {
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day, 12));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day ||
    parsed.getUTCDay() !== 1
  ) throw new ScheduleChatError(`${label} must be a valid Monday in YYYY-MM-DD format.`);
};

const resolveEmployeeFromDraft = async (input: {
  draftId: string;
  ownerUserId: string;
  employeeId: string;
  userMessage: string;
  confirmedEmployeeIds: Set<string>;
  pendingCandidates: EmployeeSelectionCandidate[];
}) => {
  const draft = await assertDraftForOwner(input.draftId, input.ownerUserId);
  if (!draft.scope.employeeIds.includes(input.employeeId)) throw new ScheduleChatError("Employee is outside this draft's scope.");
  const employees = await db.employee.findMany({
    where: { employeeId: { in: draft.scope.employeeIds } },
    select: { employeeId: true, employeeCode: true, firstName: true, lastName: true },
  });
  const target = employees.find((employee) => employee.employeeId === input.employeeId);
  if (!target) throw new ScheduleChatError("Employee is not available in this draft.");
  const sameName = employees.filter((employee) =>
    `${employee.firstName} ${employee.lastName}`.trim().toLocaleLowerCase() ===
    `${target.firstName} ${target.lastName}`.trim().toLocaleLowerCase(),
  );
  const needsConfirmation = requiresEmployeeSelectionConfirmation({
    employeeId: target.employeeId,
    confirmedEmployeeIds: input.confirmedEmployeeIds,
    pendingCandidates: input.pendingCandidates,
    hasDuplicateName: sameName.length > 1,
  });
  if (needsConfirmation) {
    const selectedByCode = target.employeeCode && new RegExp(
      `(?:^|[^\\w])${target.employeeCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^\\w])`,
      "i",
    ).test(input.userMessage);
    if (!selectedByCode) {
      const candidateCodes = input.pendingCandidates.length > 1
        ? input.pendingCandidates.map((candidate) => candidate.employeeCode)
        : sameName.map((row) => row.employeeCode);
      throw new ScheduleChatError(
        `Employee name is ambiguous. Ask manager to choose using option number or employee code: ${candidateCodes.join(", ")}.`,
      );
    }
  }
  return { draft, employee: target };
};

const executeTool = async (input: {
  name: string;
  arguments: string;
  ownerUserId: string;
  conversationId: string;
  requestKey: string;
  round: number;
  toolIndex: number;
  departmentId: string | null;
  selectedEmployeeIds: string[];
  userMessage: string;
  confirmedEmployeeIds: Set<string>;
  selectionState: { current: PendingSelection | null };
}) => {
  await ensureToolActor(input.ownerUserId);
  if (!TOOL_NAMES.has(input.name)) return { ok: false, error: "Tool is not allowed." };
  const idempotencyKey = requestIdempotencyKey(
    input.requestKey,
    `${input.name}:${canonicalizeToolArguments(input.arguments)}`,
  );
  try {
    switch (input.name) {
      case "get_schedule_context": {
        const args = parseToolArgs(toolSchemas.get_schedule_context, input.arguments);
        const draft = await assertDraftForOwner(args.draftId, input.ownerUserId);
        const employeeIds = draft.scope.employeeIds;
        const baselineShiftIds = Array.from(new Set(draft.assignments
          .map((assignment) => assignment.baselineShiftId)
          .filter((id): id is number => id != null)));
        const [employees, shifts, baselineShifts] = await Promise.all([
          db.employee.findMany({
            where: { employeeId: { in: employeeIds } },
            orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { employeeCode: "asc" }],
            take: 50,
            select: { employeeId: true, employeeCode: true, firstName: true, lastName: true, departmentId: true, department: { select: { name: true } } },
          }),
          db.shift.findMany({
            where: { isActive: true },
            orderBy: [{ startMinutes: "asc" }, { code: "asc" }],
            take: 40,
            select: { id: true, code: true, name: true, isDayOff: true, startMinutes: true, endMinutes: true, spansMidnight: true },
          }),
          baselineShiftIds.length
            ? db.shift.findMany({ where: { id: { in: baselineShiftIds } }, select: { id: true, isDayOff: true } })
            : Promise.resolve([]),
        ]);
        const employeeById = new Map(employees.map((employee) => [employee.employeeId, employee]));
        const baselineDayOffByShiftId = new Map(baselineShifts.map((shift) => [shift.id, shift.isDayOff]));
        const changed = draft.assignments.filter((assignment) => {
          const preservedOverride = assignment.source === "CURRENT_SCHEDULE" &&
            assignment.hasBaselineOverride &&
            assignment.shiftId === assignment.baselineOverrideShiftId;
          return !preservedOverride && (
            assignment.shiftId !== assignment.baselineShiftId ||
            assignment.assignmentKind !== (assignment.isProtected
              ? "PROTECTED_LEAVE"
              : assignment.baselineShiftId == null
                ? "UNASSIGNED"
                : baselineDayOffByShiftId.get(assignment.baselineShiftId)
                  ? "DAY_OFF"
                  : "WORK")
          );
        });
        return {
          draftId: draft.id,
          version: draft.version,
          status: draft.status,
          weekStart: draft.weekStart,
          weekDates: getWeekDates(parseWeekStartInput(draft.weekStart) ?? new Date()).map(({ date }) => toPlannerDateKey(date)),
          sourceMode: draft.sourceMode,
          referenceWeekStart: draft.sourceWeekStart,
          scope: { employeeCount: employeeIds.length },
          staleSource: draft.isSourceStale,
          assignmentCount: draft.assignmentCount,
          changedCellCount: changed.length,
          changedCells: changed.slice(0, 30).map((assignment) => ({
            employeeCode: employeeById.get(assignment.employeeId)?.employeeCode ?? null,
            employeeName: employeeById.get(assignment.employeeId)
              ? `${employeeById.get(assignment.employeeId)!.firstName} ${employeeById.get(assignment.employeeId)!.lastName}`
              : null,
            workDate: assignment.workDate,
            assignmentKind: assignment.assignmentKind,
          })),
          employees: employees.map((employee) => ({
            employeeCode: employee.employeeCode,
            displayName: `${employee.firstName} ${employee.lastName}`,
            department: employee.department?.name ?? null,
          })),
          employeeListTruncated: employees.length < employeeIds.length,
          shiftOptions: shifts.map((shift) => ({
            code: shift.code,
            name: shift.name,
            dayOff: shift.isDayOff,
            startMinutes: shift.startMinutes,
            endMinutes: shift.endMinutes,
            spansMidnight: shift.spansMidnight,
          })),
        };
      }
      case "search_employees": {
        const args = parseToolArgs(toolSchemas.search_employees, input.arguments);
        let scopedIds: string[] | null = null;
        if (args.draftId) {
          const draft = await assertDraftForOwner(args.draftId, input.ownerUserId);
          scopedIds = draft.scope.employeeIds;
        }
        const terms = args.query.split(/\s+/).filter(Boolean).slice(0, 4);
        const [employees, departments] = await Promise.all([
          db.employee.findMany({
            where: {
              isArchived: false,
              currentStatus: { notIn: [CURRENT_STATUS.INACTIVE, CURRENT_STATUS.ENDED] },
              ...(scopedIds ? { employeeId: { in: scopedIds } } : {}),
              ...(args.departmentId ? { departmentId: args.departmentId } : {}),
              AND: terms.map((term) => ({
                OR: [
                  { firstName: { contains: term, mode: "insensitive" as const } },
                  { lastName: { contains: term, mode: "insensitive" as const } },
                  { employeeCode: { contains: term, mode: "insensitive" as const } },
                ],
              })),
            },
            orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { employeeCode: "asc" }],
            take: 10,
            select: { employeeId: true, employeeCode: true, firstName: true, lastName: true, departmentId: true, department: { select: { name: true } } },
          }),
          db.department.findMany({
            where: { isActive: true, name: { contains: args.query, mode: "insensitive" } },
            orderBy: { name: "asc" },
            take: 5,
            select: { departmentId: true, name: true },
          }),
        ]);
        const candidates = employees.map((employee) => ({
          employeeId: employee.employeeId,
          employeeCode: employee.employeeCode,
          displayName: `${employee.firstName} ${employee.lastName}`,
        }));
        const multiple = candidates.length > 1;
        const explicitlySelectedId = resolveExplicitEmployeeSelection(input.userMessage, candidates);
        if (explicitlySelectedId) input.confirmedEmployeeIds.add(explicitlySelectedId);
        const candidateSelection = multiple
          ? { candidates, draftId: args.draftId ?? null, createdAt: new Date().toISOString() }
          : null;
        await savePendingSelection(input.conversationId, input.ownerUserId, multiple && !explicitlySelectedId ? candidateSelection : null);
        input.selectionState.current = candidateSelection;
        return {
          matches: employees
            .filter((employee) => !explicitlySelectedId || employee.employeeId === explicitlySelectedId)
            .map((employee, index) => ({
            option: index + 1,
            employeeCode: employee.employeeCode,
            displayName: `${employee.firstName} ${employee.lastName}`,
            department: employee.department?.name ?? null,
          })),
          departmentMatches: departments,
          requiresManagerSelection: multiple && !explicitlySelectedId,
          selectionInstruction: multiple && !explicitlySelectedId ? "Ask manager to choose by option number or employee code before editing." : null,
        };
      }
      case "list_staffing_rules": {
        const args = parseToolArgs(toolSchemas.list_staffing_rules, input.arguments);
        const draft = await assertDraftForOwner(args.draftId, input.ownerUserId);
        const [result, employees] = await Promise.all([
          listScheduleCoverageRules(),
          db.employee.findMany({
            where: { employeeId: { in: draft.scope.employeeIds } },
            select: { departmentId: true, positionId: true },
          }),
        ]);
        const departmentIds = new Set(employees.map((employee) => employee.departmentId).filter((id): id is string => Boolean(id)));
        const positionIds = new Set(employees.map((employee) => employee.positionId).filter((id): id is string => Boolean(id)));
        const weekEnd = toPlannerDateKey(new Date((parseWeekStartInput(draft.weekStart)?.getTime() ?? 0) + 6 * 86_400_000));
        const rules = result.rules.filter((rule) =>
          rule.isActive &&
          (!rule.effectiveFrom || rule.effectiveFrom <= weekEnd) &&
          (!rule.effectiveTo || rule.effectiveTo >= draft.weekStart) &&
          (!rule.departmentId || departmentIds.has(rule.departmentId)) &&
          (!rule.positionId || positionIds.has(rule.positionId)),
        );
        return {
          weekStart: draft.weekStart,
          configured: rules.length > 0,
          message: rules.length > 0 ? null : "Not configured: no active staffing rules apply to this draft scope and week.",
          rules: rules.map((rule) => ({
            id: rule.id,
            name: rule.name,
            department: rule.departmentName,
            position: rule.positionName,
            shift: rule.shiftLabel,
            weekday: rule.weekday,
            minimumStaff: rule.minimumStaff,
            maximumStaff: rule.maximumStaff,
            priority: rule.priority,
          })),
        };
      }
      case "create_schedule_draft": {
        const args = parseToolArgs(toolSchemas.create_schedule_draft, input.arguments);
        ensureMondayInput(args.weekStart, "Draft week");
        if (args.sourceMode === "REFERENCE_WEEK") {
          if (!args.referenceWeekStart) throw new ScheduleChatError("Choose a reference week.");
          ensureMondayInput(args.referenceWeekStart, "Reference week");
        }
        const draft = await createScheduleDraft({
          requestKey: idempotencyKey,
          weekStart: args.weekStart,
          referenceWeekStart: args.referenceWeekStart ?? null,
          departmentId: args.departmentId ?? input.departmentId,
          selectedEmployeeIds: args.departmentId ? [] : input.selectedEmployeeIds,
          sourceMode: args.sourceMode,
          ownerUserId: input.ownerUserId,
        });
        await setActiveDraft(input.conversationId, input.ownerUserId, draft.id);
        await savePendingSelection(input.conversationId, input.ownerUserId, null);
        input.selectionState.current = null;
        return {
          draftId: draft.id,
          version: draft.version,
          weekStart: draft.weekStart,
          sourceMode: draft.sourceMode,
          employeeCount: draft.scope.employeeIds.length,
          assignmentCount: draft.assignmentCount,
          status: draft.status,
          liveScheduleChanged: false,
        };
      }
      case "revise_schedule_draft": {
        const args = parseToolArgs(toolSchemas.revise_schedule_draft, input.arguments);
        const { draft, employee } = await resolveEmployeeFromDraft({
          draftId: args.draftId,
          ownerUserId: input.ownerUserId,
          employeeId: args.employeeId,
          userMessage: input.userMessage,
          confirmedEmployeeIds: input.confirmedEmployeeIds,
          pendingCandidates: input.selectionState.current?.candidates ?? [],
        });
        const original = draft.assignments.find((assignment) =>
          assignment.employeeId === args.employeeId && assignment.workDate === args.workDate,
        );
        if (!original) throw new ScheduleChatError("Date is outside the selected draft week.");
        const activeShifts = args.shiftRef
          ? await db.shift.findMany({
              where: { isActive: true },
              select: { id: true, code: true, name: true, isDayOff: true },
            })
          : [];
        const shiftMatch = args.shiftRef ? resolveShiftReference(args.shiftRef, activeShifts) : null;
        if (shiftMatch?.status === "ambiguous") {
          throw new ScheduleChatError(`Shift reference "${args.shiftRef}" matches more than one active shift. Use the exact shift code.`);
        }
        if (args.shiftRef && shiftMatch?.status !== "resolved") {
          const options = activeShifts.map((shift) => `${shift.code} (${shift.name})`).join(", ");
          throw new ScheduleChatError(`No active shift matches "${args.shiftRef}". Available shift codes: ${options || "none"}.`);
        }
        const shift = shiftMatch?.status === "resolved" ? shiftMatch.shift : null;
        if (shift?.isDayOff) {
          throw new ScheduleChatError(`Shift ${shift.code} is a day-off shift. Choose a working shift for this assignment.`);
        }
        const shiftId = shift?.id ?? null;
        const assignments = draft.assignments.map((assignment) => assignment.employeeId === args.employeeId && assignment.workDate === args.workDate
          ? {
              ...assignment,
              shiftId,
              assignmentKind: args.assignmentKind,
          reason: "Revised by scheduling assistant at manager request.",
            }
          : assignment);
        const revised = await saveScheduleDraftVersion({
          requestKey: idempotencyKey,
          draftId: draft.id,
          ownerUserId: input.ownerUserId,
          changeSource: "AI",
          assignments,
        });
        await setActiveDraft(input.conversationId, input.ownerUserId, revised.id);
        const validation = await validateScheduleDraft({
          draftId: revised.id,
          ownerUserId: input.ownerUserId,
          actorUserId: input.ownerUserId,
        });
        const previousShift = original.shiftId == null
          ? null
          : await db.shift.findUnique({ where: { id: original.shiftId }, select: { code: true, name: true } });
        return {
          draftId: revised.id,
          version: revised.version,
          employeeCode: employee.employeeCode,
          employeeName: `${employee.firstName} ${employee.lastName}`,
          workDate: args.workDate,
          previousShiftCode: previousShift?.code ?? null,
          shiftCode: shift?.code ?? null,
          shiftName: shift?.name ?? null,
          assignmentKind: args.assignmentKind,
          validation: {
            blockerCount: validation.blockerCount,
            warningCount: validation.warningCount,
            infoCount: validation.infoCount,
            issues: validation.issues.slice(0, 30),
          },
          liveScheduleChanged: false,
        };
      }
      case "assign_shift_to_draft_scope": {
        const args = parseToolArgs(toolSchemas.assign_shift_to_draft_scope, input.arguments);
        if (!isExplicitBulkScheduleRequest(input.userMessage)) {
          throw new ScheduleChatError("Bulk assignment requires an explicit request to change all employees or the whole team. No draft cells changed.");
        }
        const draft = await assertDraftForOwner(args.draftId, input.ownerUserId);
        const requestedDates = resolveExplicitBulkScheduleDates(
          input.userMessage,
          draft.weekStart,
          toPlannerDateKey(new Date()),
        );
        if (!requestedDates) {
          throw new ScheduleChatError("Specify exact dates, weekdays, or the whole selected week for this bulk edit. No draft cells changed.");
        }
        const requestedDateSet = new Set(requestedDates);
        const toolDateSet = new Set(args.workDates);
        if (requestedDateSet.size !== toolDateSet.size || Array.from(requestedDateSet).some((date) => !toolDateSet.has(date))) {
          throw new ScheduleChatError(`Bulk edit dates must match your request: ${requestedDates.join(", ")}. No draft cells changed.`);
        }
        const activeShifts = await db.shift.findMany({
          where: { isActive: true },
          select: { id: true, code: true, name: true, isDayOff: true },
        });
        const shiftMatch = resolveShiftReference(args.shiftRef, activeShifts);
        if (shiftMatch.status === "ambiguous") {
          throw new ScheduleChatError(`Shift reference "${args.shiftRef}" matches more than one active shift. Use the exact shift code.`);
        }
        if (shiftMatch.status !== "resolved") {
          const options = activeShifts.map((shift) => `${shift.code} (${shift.name})`).join(", ");
          throw new ScheduleChatError(`No active shift matches "${args.shiftRef}". Available shift codes: ${options || "none"}.`);
        }
        const shift = shiftMatch.shift;
        if (shift.isDayOff) {
          throw new ScheduleChatError(`Shift ${shift.code} is a day-off shift. Bulk assignment supports working shifts only; no draft cells changed.`);
        }
        const workDates = Array.from(new Set(args.workDates));
        const draftDates = new Set(draft.assignments.map((assignment) => assignment.workDate));
        const outsideDates = workDates.filter((date) => !draftDates.has(date));
        if (outsideDates.length) {
          throw new ScheduleChatError(`Date ${outsideDates.join(", ")} is outside the selected draft week.`);
        }
        const targets = draft.assignments.filter((assignment) => workDates.includes(assignment.workDate));
        const expectedTargetCount = draft.scope.employeeIds.length * workDates.length;
        if (targets.length !== expectedTargetCount) {
          throw new ScheduleChatError("Draft is missing one or more requested employee/day cells. No draft cells changed.");
        }
        if (targets.some((assignment) => assignment.isProtected || assignment.hasBaselineOverride)) {
          throw new ScheduleChatError("Bulk assignment stopped because at least one requested cell has protected leave or a schedule override. No draft cells changed.");
        }
        const changedKeys = new Set(targets
          .filter((assignment) => assignment.shiftId !== shift.id || assignment.assignmentKind !== "WORK")
          .map((assignment) => `${assignment.employeeId}:${assignment.workDate}`));
        if (changedKeys.size === 0) {
          return {
            draftId: draft.id,
            version: draft.version,
            shiftCode: shift.code,
            shiftName: shift.name,
            employeeCount: draft.scope.employeeIds.length,
            workDates,
            changedCellCount: 0,
            unchanged: true,
            liveScheduleChanged: false,
          };
        }
        const assignments = draft.assignments.map((assignment) => changedKeys.has(`${assignment.employeeId}:${assignment.workDate}`)
          ? {
              ...assignment,
              shiftId: shift.id,
              assignmentKind: "WORK",
              reason: "Bulk shift assignment requested by manager.",
            }
          : assignment);
        const revised = await saveScheduleDraftVersion({
          requestKey: idempotencyKey,
          draftId: draft.id,
          ownerUserId: input.ownerUserId,
          changeSource: "AI",
          assignments,
        });
        await setActiveDraft(input.conversationId, input.ownerUserId, revised.id);
        const validation = await validateScheduleDraft({
          draftId: revised.id,
          ownerUserId: input.ownerUserId,
          actorUserId: input.ownerUserId,
        });
        return {
          draftId: revised.id,
          version: revised.version,
          shiftCode: shift.code,
          shiftName: shift.name,
          employeeCount: draft.scope.employeeIds.length,
          workDates,
          changedCellCount: changedKeys.size,
          validation: {
            blockerCount: validation.blockerCount,
            warningCount: validation.warningCount,
            infoCount: validation.infoCount,
            issues: validation.issues.slice(0, 30),
          },
          liveScheduleChanged: false,
        };
      }
      case "explain_assignment": {
        const args = parseToolArgs(toolSchemas.explain_assignment, input.arguments);
        const { draft, employee } = await resolveEmployeeFromDraft({
          draftId: args.draftId,
          ownerUserId: input.ownerUserId,
          employeeId: args.employeeId,
          userMessage: input.userMessage,
          confirmedEmployeeIds: input.confirmedEmployeeIds,
          pendingCandidates: input.selectionState.current?.candidates ?? [],
        });
        const assignment = draft.assignments.find((row) => row.employeeId === args.employeeId && row.workDate === args.workDate);
        if (!assignment) throw new ScheduleChatError("Date is outside the selected draft week.");
        const [shift, baselineShift, overrideShift, audits] = await Promise.all([
          assignment.shiftId == null ? null : db.shift.findUnique({ where: { id: assignment.shiftId }, select: { code: true, name: true } }),
          assignment.baselineShiftId == null ? null : db.shift.findUnique({ where: { id: assignment.baselineShiftId }, select: { code: true, name: true } }),
          assignment.baselineOverrideShiftId == null ? null : db.shift.findUnique({ where: { id: assignment.baselineOverrideShiftId }, select: { code: true, name: true } }),
          db.aiActionAudit.findMany({
            where: { draftId: draft.id },
            orderBy: { createdAt: "desc" },
            take: 10,
            select: { action: true, outcome: true, metadata: true, createdAt: true },
          }),
        ]);
        return {
          employeeCode: employee.employeeCode,
          employeeName: `${employee.firstName} ${employee.lastName}`,
          workDate: args.workDate,
          proposedAssignment: { kind: assignment.assignmentKind, shift: shift ? `${shift.code} · ${shift.name}` : null, reason: assignment.reason },
          baselineShift: baselineShift ? `${baselineShift.code} · ${baselineShift.name}` : null,
          override: assignment.hasBaselineOverride ? (overrideShift ? `${overrideShift.code} · ${overrideShift.name}` : "No shift") : null,
          protectedLeave: assignment.assignmentKind === "PROTECTED_LEAVE",
          source: assignment.source,
          recentAudit: audits.map((row) => ({
            action: row.action,
            outcome: row.outcome,
            metadata: row.metadata,
            createdAt: row.createdAt.toISOString(),
          })),
          explanationFacts: [
            `Draft assignment source: ${assignment.source}.`,
            assignment.hasBaselineOverride ? "A day-specific override is protected and remains effective." : "No day-specific override is recorded for this draft cell.",
            assignment.assignmentKind === "PROTECTED_LEAVE" ? "Approved leave protects this date." : "No protected leave marker is set on this draft assignment.",
          ],
        };
      }
      case "compare_draft": {
        const args = parseToolArgs(toolSchemas.compare_draft, input.arguments);
        const draft = await assertDraftForOwner(args.draftId, input.ownerUserId);
        const employeeIds = Array.from(new Set(draft.assignments.map((assignment) => assignment.employeeId)));
        const [employees, shifts] = await Promise.all([
          db.employee.findMany({
            where: { employeeId: { in: employeeIds } },
            select: { employeeId: true, employeeCode: true, firstName: true, lastName: true },
          }),
          db.shift.findMany({
            where: { id: { in: Array.from(new Set(draft.assignments.map((assignment) => assignment.baselineShiftId).filter((id): id is number => id != null))) } },
            select: { id: true, isDayOff: true },
          }),
        ]);
        const employeeById = new Map(employees.map((employee) => [employee.employeeId, employee]));
        const shiftById = new Map(shifts.map((shift) => [shift.id, shift]));
        const changes = draft.assignments.flatMap((assignment) => {
          const preservedOverride = assignment.source === "CURRENT_SCHEDULE" &&
            assignment.hasBaselineOverride &&
            assignment.shiftId === assignment.baselineOverrideShiftId;
          const baseKind = assignment.isProtected
            ? "PROTECTED_LEAVE"
            : assignment.baselineShiftId == null
              ? "UNASSIGNED"
              : shiftById.get(assignment.baselineShiftId)?.isDayOff
                ? "DAY_OFF"
                : "WORK";
          if (preservedOverride || (assignment.shiftId === assignment.baselineShiftId && assignment.assignmentKind === baseKind)) return [];
          const employee = employeeById.get(assignment.employeeId);
          return [{
            employeeId: assignment.employeeId,
            employeeCode: employee?.employeeCode ?? null,
            employeeName: employee ? `${employee.firstName} ${employee.lastName}` : null,
            workDate: assignment.workDate,
            assignmentKind: assignment.assignmentKind,
            source: assignment.source,
          }];
        });
        return { draftId: draft.id, version: draft.version, weekStart: draft.weekStart, changedCellCount: changes.length, changes: changes.slice(0, 120), truncated: changes.length > 120 };
      }
      case "validate_schedule_draft": {
        const args = parseToolArgs(toolSchemas.validate_schedule_draft, input.arguments);
        const draft = await assertDraftForOwner(args.draftId, input.ownerUserId);
        const result = await validateScheduleDraft({
          draftId: draft.id,
          ownerUserId: input.ownerUserId,
          actorUserId: input.ownerUserId,
        });
        return {
          draftId: draft.id,
          version: draft.version,
          isValid: result.isValid,
          coverageConfigured: result.coverageConfigured,
          blockerCount: result.blockerCount,
          warningCount: result.warningCount,
          infoCount: result.infoCount,
          issues: result.issues.slice(0, 40).map((issue) => {
            const publicIssue = { ...issue };
            delete publicIssue.shiftId;
            return publicIssue;
          }),
          issuesTruncated: result.issues.length > 40,
        };
      }
      case "propose_schedule_operation": {
        const args = parseToolArgs(toolSchemas.propose_schedule_operation, input.arguments);
        const conversation = await db.aiConversation.findFirst({
          where: { id: input.conversationId, userId: input.ownerUserId },
          select: { activeDraftId: true, pendingInteraction: true },
        });
        if (!conversation) throw new ScheduleChatError("Conversation not found.", 404);
        const priorOperation = readPendingScheduleOperation(conversation.pendingInteraction);
        let intent = priorOperation && ["CLARIFICATION", "PROPOSAL"].includes(priorOperation.status)
          ? mergePendingScheduleIntent(priorOperation.intent, args)
          : args;
        if (
          args.operation === "DISTRIBUTE_DAY_OFF" && priorOperation?.status === "CLARIFICATION" &&
          priorOperation.intent.operation === "NO_DAY_OFF" &&
          priorOperation.intent.targetType === args.targetType &&
          (args.targetType === "ALL" || matchesNaturalGroupName(priorOperation.intent.targetQuery ?? "", args.targetQuery ?? ""))
        ) {
          const restrictedWeekdays = priorOperation.intent.noDayOffWeekdays.length
            ? priorOperation.intent.noDayOffWeekdays
            : priorOperation.intent.workDates.map((date) => new Date(`${date}T00:00:00.000Z`).getUTCDay() || 7);
          intent = { ...intent, noDayOffWeekdays: Array.from(new Set([...intent.noDayOffWeekdays, ...restrictedWeekdays])) };
        }
        return prepareScheduleOperation({
          conversationId: input.conversationId,
          ownerUserId: input.ownerUserId,
          requestKey: input.requestKey,
          draftId: conversation.activeDraftId,
          sourceMessage: input.userMessage,
          intent,
          ...(priorOperation && (priorOperation.status === "CLARIFICATION" || priorOperation.status === "PROPOSAL")
            ? { previousOperation: priorOperation }
            : {}),
        });
      }
      default:
        return { ok: false, error: "Tool is not allowed." };
    }
  } catch (error) {
    const safe = safeToolError(error);
    return { ok: false, error: safe, ...(isKnownSchedulingError(error) ? {} : { retryable: true }) };
  }
};

const providerHistoryMessage = (message: {
  role: AiMessageRole;
  content: string;
  toolName: string | null;
  toolCallId: string | null;
}): ProviderMessage => {
  if (message.role === AiMessageRole.USER) return { role: "user", content: message.content };
  if (message.role === AiMessageRole.TOOL) return {
    role: "tool",
    tool_call_id: message.toolCallId ?? "missing-tool-call-id",
    content: message.content,
  };
  if (message.toolCallId && message.toolName) return {
    role: "assistant",
    content: null,
    tool_calls: [{ id: message.toolCallId, type: "function", function: { name: message.toolName, arguments: message.content } }],
  };
  return { role: "assistant", content: message.content };
};

const providerHistory = (rows: Array<{
  role: AiMessageRole;
  content: string;
  toolName: string | null;
  toolCallId: string | null;
}>) => {
  const chronological = [...rows].reverse();
  const messages: ProviderMessage[] = [];
  let index = 0;
  while (index < chronological.length) {
    const row = chronological[index];
    if (row.role === AiMessageRole.TOOL && !messages.some((message) => message.role === "assistant" && message.tool_calls?.some((call) => call.id === row.toolCallId))) {
      index += 1;
      continue;
    }
    if (row.role === AiMessageRole.ASSISTANT && row.toolCallId && row.toolName) {
      const calls: NonNullable<ProviderMessage["tool_calls"]> = [];
      while (index < chronological.length) {
        const candidate = chronological[index];
        if (candidate.role !== AiMessageRole.ASSISTANT || !candidate.toolCallId || !candidate.toolName) break;
        calls.push({
          id: candidate.toolCallId,
          type: "function",
          function: { name: candidate.toolName, arguments: candidate.content },
        });
        index += 1;
      }
      messages.push({ role: "assistant", content: null, tool_calls: calls });
      continue;
    }
    messages.push(providerHistoryMessage(row));
    index += 1;
  }

  let remainingChars = 24_000;
  const bounded: ProviderMessage[] = [];
  for (let cursor = messages.length - 1; cursor >= 0 && remainingChars > 0; cursor -= 1) {
    const message = messages[cursor];
    const length = JSON.stringify(message).length;
    if (length > remainingChars) {
      if (message.content && remainingChars > 300) {
        bounded.unshift({ ...message, content: message.content.slice(-(remainingChars - 200)) });
      }
      break;
    }
    bounded.unshift(message);
    remainingChars -= length;
  }
  while (bounded[0]?.role === "tool") bounded.shift();
  return bounded;
};

const readUsage = (value: unknown) => {
  if (!value || typeof value !== "object") return { promptTokens: 0, completionTokens: 0 };
  const usage = value as Record<string, unknown>;
  return {
    promptTokens: typeof usage.prompt_tokens === "number" && Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : 0,
    completionTokens: typeof usage.completion_tokens === "number" && Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : 0,
  };
};

const callOpenRouter = async (input: {
  model: string;
  apiKey: string;
  messages: ProviderMessage[];
  maxTokens: number;
  allowToolCalls?: boolean;
}) => {
  const allowToolCalls = input.allowToolCalls !== false;
  const providerRequestId = randomUUID();
  const response = await fetch(OPENROUTER_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "http://localhost:3000",
      "X-Title": "JumboCrab EMIS Scheduling Assistant",
    },
    body: JSON.stringify({
      model: input.model,
      messages: input.messages,
      ...(allowToolCalls ? {
        tools: providerTools,
        tool_choice: "auto",
        parallel_tool_calls: false,
      } : {}),
      max_tokens: input.maxTokens,
      temperature: 0.1,
    }),
    signal: AbortSignal.timeout(MAX_PROVIDER_TIMEOUT_MS),
  });
  if (!response.ok) {
    console.warn("[AI scheduling provider] OpenRouter request failed", {
      providerRequestId,
      model: input.model,
      httpStatus: response.status,
      responseContentType: response.headers.get("content-type") ?? "unknown",
    });
    throw new Error(`OpenRouter request failed (${response.status}).`);
  }
  const data: unknown = await response.json();
  if (!data || typeof data !== "object") {
    console.warn("[AI scheduling provider] Invalid JSON response", { providerRequestId, model: input.model });
    return {
      content: "",
      calls: [] as ProviderToolCall[],
      usage: { promptTokens: 0, completionTokens: 0 },
      estimatedCompletionTokens: 0,
      finishReason: null as string | null,
      incomplete: true,
      diagnostics: { providerRequestId, responseMode: "invalid_json", rawToolCallCount: 0, rejectedToolCallCount: 0 },
    };
  }
  const body = data as Record<string, unknown>;
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const first = choices[0] && typeof choices[0] === "object" ? choices[0] as Record<string, unknown> : null;
  const message = first?.message && typeof first.message === "object" ? first.message as Record<string, unknown> : null;
  const finishReason = typeof first?.finish_reason === "string" ? first.finish_reason : null;
  let content = typeof message?.content === "string" ? message.content.slice(0, MAX_CHAT_TOOL_RESULT_CHARS) : "";
  const nativeCalls = validateProviderToolCalls({
    value: message?.tool_calls,
    allowedToolNames: Array.from(PROVIDER_TOOL_NAMES),
    maxCalls: MAX_CHAT_TOOL_CALLS_PER_TURN,
  });
  let calls = nativeCalls.calls;
  let rejectedToolCallCount = nativeCalls.rejectedCount;
  let responseMode = calls.length ? "native_tool_calls" : content.trim() ? "text" : "empty";
  let textualToolCallDetected = false;
  if (allowToolCalls && calls.length === 0 && content) {
    const textual = parseTextualProviderToolCalls({
      content,
      allowedToolNames: Array.from(PROVIDER_TOOL_NAMES),
      maxCalls: MAX_CHAT_TOOL_CALLS_PER_TURN,
    });
    if (textual.detected) {
      textualToolCallDetected = true;
      const textualCalls = validateProviderToolCalls({
        value: textual.calls.map((call) => ({ id: randomUUID(), function: call })),
        allowedToolNames: Array.from(PROVIDER_TOOL_NAMES),
        maxCalls: MAX_CHAT_TOOL_CALLS_PER_TURN,
      });
      calls = textualCalls.calls;
      rejectedToolCallCount += textualCalls.rejectedCount || (textual.detected && textual.calls.length === 0 ? 1 : 0);
      responseMode = calls.length ? "textual_tool_calls" : "invalid_tool_call_format";
      if (calls.length) content = "";
    }
  } else if (!allowToolCalls && parseTextualProviderToolCalls({
    content,
    allowedToolNames: Array.from(PROVIDER_TOOL_NAMES),
    maxCalls: MAX_CHAT_TOOL_CALLS_PER_TURN,
  }).detected) {
    content = "";
    rejectedToolCallCount += 1;
    responseMode = "unexpected_tool_call_in_final_response";
  }
  const proposalCalls = calls.filter((call) => call.name === "propose_schedule_operation").length;
  const multipleProposals = proposalCalls > 1;
  if (multipleProposals) {
    rejectedToolCallCount += proposalCalls;
    calls = [];
    content = "";
    responseMode = "multiple_proposal_calls_rejected";
  }
  const usage = readUsage(body.usage);
  const estimatedCompletionTokens = Math.ceil((content.length + calls.reduce((total, call) => total + call.arguments.length, 0)) / 4);
  const incomplete = !message || multipleProposals || shouldRetryIncompleteCompletion({
    finishReason,
    content,
    validToolCallCount: calls.length,
    rejectedToolCallCount,
  });
  const diagnostics = {
    providerRequestId,
    model: typeof body.model === "string" ? body.model : input.model,
    provider: typeof body.provider === "string" ? body.provider : null,
    finishReason,
    choiceCount: choices.length,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens || estimatedCompletionTokens,
    requestedMaxTokens: input.maxTokens,
    requestedResponseFormat: allowToolCalls ? "native_function_tools" : "text_only",
    responseMode,
    contentLength: content.length,
    rawToolCallCount: nativeCalls.rawCallCount,
    rejectedToolCallCount,
    textualToolCallDetected,
  };
  if (incomplete || finishReason === "length" || rejectedToolCallCount > 0) {
    console.warn("[AI scheduling provider] Empty, incomplete, or invalid completion", diagnostics);
  }
  return { content, calls, usage, estimatedCompletionTokens, finishReason, incomplete, diagnostics };
};

const writeChatAudit = async (input: {
  userId: string;
  conversationId: string;
  action: string;
  outcome: string;
  metadata: Record<string, string | number | boolean | null>;
}) => db.aiActionAudit.create({
  data: {
    actorUserId: input.userId,
    conversationId: input.conversationId,
    action: input.action,
    outcome: input.outcome,
    metadata: input.metadata as Prisma.InputJsonObject,
  },
});

const getProviderConfig = () => {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  const model = process.env.OPENROUTER_MODEL?.trim();
  if (!apiKey || !model) throw new ScheduleChatError("Scheduling chat provider is not configured.", 503);
  return { apiKey, model };
};

const newOperationChoice = (label: string, description: string | undefined, value: Record<string, string | number | boolean | null>) => ({
  id: randomUUID(),
  label,
  ...(description ? { description } : {}),
  value,
});

const weekDatesFor = (weekStart: string) => {
  const parsed = parseWeekStartInput(weekStart);
  return parsed ? getWeekDates(parsed).map(({ date }) => toPlannerDateKey(date)) : [];
};

const isIsoWeekday = (date: string, weekday: number) => {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay() || 7;
  return day === weekday;
};

const makePendingOperation = async (input: {
  conversationId: string;
  userId: string;
  draft: Awaited<ReturnType<typeof getScheduleDraftVersion>>;
  sourceMessage: string;
  intent: ScheduleOperationIntent;
  targetEmployeeIds: string[];
  status: PendingScheduleOperation["status"];
  title: string;
  summary: string;
  choices?: PendingScheduleOperation["choices"];
  selectionMode?: PendingScheduleOperation["selectionMode"];
  assignments?: PendingScheduleOperation["assignments"];
  beforeAssignments?: PendingScheduleOperation["beforeAssignments"];
  changes?: PendingScheduleOperation["changes"];
  warnings?: string[];
  blockers?: string[];
  changeCount?: number;
  canApply?: boolean;
  canUndo?: boolean;
  appliedDraftId?: string;
  appliedDraftVersion?: number;
  appliedDraftFingerprint?: string;
  previousOperation?: PendingScheduleOperation;
}) => {
  const id = randomUUID();
  const createdAt = new Date();
  const previewChanges = input.changes ? selectRepresentativeScheduleChanges(input.changes, 100) : undefined;
  const interaction: ScheduleInteraction = {
    id,
    kind: input.status,
    title: input.title,
    summary: input.summary,
    ...(input.selectionMode ? { selectionMode: input.selectionMode } : {}),
    ...(input.choices ? { options: input.choices.map(({ id: optionId, label, description }) => ({ id: optionId, label, ...(description ? { description } : {}) })) } : {}),
    ...(input.changes ? { changes: previewChanges, changeCount: input.changeCount ?? input.changes.length, changesTruncated: (input.changeCount ?? input.changes.length) > 100 } : {}),
    ...(input.warnings?.length ? { warnings: input.warnings.slice(0, 20) } : {}),
    ...(input.blockers?.length ? { blockers: input.blockers.slice(0, 30) } : {}),
    ...(input.canApply != null ? { canApply: input.canApply } : {}),
    ...(input.canUndo != null ? { canUndo: input.canUndo } : {}),
    ...(input.previousOperation ? { canGoBack: true } : {}),
  };
  const pending: PendingScheduleOperation = {
    kind: "SCHEDULE_OPERATION",
    id,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + 30 * 60 * 1000).toISOString(),
    draftId: input.draft.id,
    draftVersion: input.draft.version,
    draftFingerprint: input.draft.draftFingerprint,
    sourceFingerprint: input.draft.sourceFingerprint,
    weekStart: input.draft.weekStart,
    sourceMessage: input.sourceMessage,
    status: input.status,
    intent: input.intent,
    targetEmployeeIds: input.targetEmployeeIds,
    ...(input.choices ? { choices: input.choices } : {}),
    ...(input.selectionMode ? { selectionMode: input.selectionMode } : {}),
    ...(input.assignments ? { assignments: input.assignments } : {}),
    ...(input.beforeAssignments ? { beforeAssignments: input.beforeAssignments } : {}),
    ...(previewChanges ? { changes: previewChanges } : {}),
    ...(input.warnings ? { warnings: input.warnings } : {}),
    ...(input.blockers ? { blockers: input.blockers } : {}),
    ...(input.appliedDraftId ? { appliedDraftId: input.appliedDraftId } : {}),
    ...(input.appliedDraftVersion ? { appliedDraftVersion: input.appliedDraftVersion } : {}),
    ...(input.appliedDraftFingerprint ? { appliedDraftFingerprint: input.appliedDraftFingerprint } : {}),
    ...(input.previousOperation ? { previous: { ...input.previousOperation, previous: undefined } } : {}),
    interaction,
  };
  await savePendingScheduleOperation(input.conversationId, input.userId, pending);
  await writeChatAudit({
    userId: input.userId,
    conversationId: input.conversationId,
    action: "AI_SCHEDULE_OPERATION_PREPARED",
    outcome: input.status,
    metadata: {
      draftId: input.draft.id,
      draftVersion: input.draft.version,
      operation: input.intent.operation,
      targetCount: input.targetEmployeeIds.length,
      changeCount: input.changeCount ?? input.changes?.length ?? 0,
      interactionId: id,
    },
  });
  return { pending, interaction };
};

const formatShiftAssignment = (assignment: { shiftId: number | null; assignmentKind: string }, shifts: Array<{ id: number; code: string; name: string; isDayOff: boolean }>) => {
  if (assignment.assignmentKind === "PROTECTED_LEAVE") return "Approved leave";
  if (assignment.assignmentKind === "UNASSIGNED" || assignment.shiftId == null) return "Unassigned";
  const shift = shifts.find((candidate) => candidate.id === assignment.shiftId);
  if (!shift) return "Unavailable shift";
  return shift.isDayOff ? `OFF · ${shift.code}` : `${shift.code} · ${shift.name}`;
};

const findEmployeeTargets = (query: string, employees: Array<{
  employeeId: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  position: { positionId: string; name: string; isActive: boolean; departmentId: string } | null;
  department: { departmentId: string; name: string; isActive: boolean } | null;
}>) => {
  return employees.filter((employee) => matchesScheduleEmployeeQuery(query, employee));
};

const prepareScheduleOperation = async (input: {
  conversationId: string;
  ownerUserId: string;
  requestKey: string;
  draftId: string | null;
  sourceMessage: string;
  intent: ScheduleOperationIntent;
  fixedTargetEmployeeIds?: string[];
  previousOperation?: PendingScheduleOperation;
}) => {
  if (!input.draftId) {
    return { message: "Select or create a draft for the displayed planner week first. No schedule changes were made.", interaction: null as ScheduleInteraction | null };
  }
  const draft = await assertDraftForOwner(input.draftId, input.ownerUserId);
  if (!draft.isLatestVersion || (draft.status !== "DRAFT" && draft.status !== "VALIDATED")) {
    return { message: "This draft is not the latest editable version. Reload the current draft, then retry.", interaction: null as ScheduleInteraction | null };
  }
  const intent = scheduleOperationIntentSchema.parse(input.intent);
  const actionsHaveOwnScopes = intent.actions.some((action) => action.targetType !== null || action.targetQuery !== null ||
    action.targetEmployeeQueries.length > 0 || action.excludeTargetQueries.length > 0);
  const datesInWeek = weekDatesFor(draft.weekStart);
  const assignmentInputs = draft.assignments.map((assignment) => ({
    employeeId: assignment.employeeId,
    workDate: assignment.workDate,
    shiftId: assignment.shiftId,
    assignmentKind: assignment.assignmentKind,
    reason: assignment.reason ?? null,
    isProtected: assignment.isProtected,
    hasBaselineOverride: assignment.hasBaselineOverride,
  }));
  const makeClarification = async (inputClarification: {
    title: string;
    summary: string;
    choices?: PendingScheduleOperation["choices"];
    selectionMode?: PendingScheduleOperation["selectionMode"];
    targetEmployeeIds?: string[];
    blockers?: string[];
  }) => {
    const { interaction } = await makePendingOperation({
      conversationId: input.conversationId,
      userId: input.ownerUserId,
      draft,
      sourceMessage: input.sourceMessage,
      intent,
      targetEmployeeIds: inputClarification.targetEmployeeIds ?? input.fixedTargetEmployeeIds ?? [],
      status: "CLARIFICATION",
      title: inputClarification.title,
      summary: inputClarification.summary,
      choices: inputClarification.choices,
      selectionMode: inputClarification.selectionMode,
      blockers: inputClarification.blockers,
      previousOperation: input.previousOperation,
    });
    return { message: interaction.summary, interaction };
  };

  if (intent.operation === "NO_DAY_OFF") {
    const weekdays = intent.noDayOffWeekdays.length
      ? intent.noDayOffWeekdays
      : intent.workDates.map((date) => new Date(`${date}T00:00:00.000Z`).getUTCDay() || 7);
    const weekDayNames = weekdays.map((weekday) => ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][weekday]);
    return makeClarification({
      title: "Restriction understood",
      summary: `I’ll treat the requested no-day-off restriction on ${weekDayNames.join(", ")} as a constraint for this planning conversation. Tell me who should receive a day off, and I’ll prepare a preview. No standing company policy or schedule was changed.`,
    });
  }

  if (intent.operation === "BALANCE_COVERAGE") {
    const generated = await previewScheduleDraftGeneration({ draftId: draft.id, ownerUserId: input.ownerUserId });
    const shiftRows = await db.shift.findMany({ select: { id: true, code: true, name: true, isDayOff: true } });
    const currentByKey = new Map(draft.assignments.map((assignment) => [`${assignment.employeeId}:${assignment.workDate}`, assignment]));
    const employeeById = new Map(draft.assignments.map((assignment) => [assignment.employeeId, assignment]));
    const changes = generated.assignments.flatMap((assignment) => {
      const previous = currentByKey.get(`${assignment.employeeId}:${assignment.workDate}`);
      if (!previous || (previous.shiftId === assignment.shiftId && previous.assignmentKind === assignment.assignmentKind)) return [];
      const target = employeeById.get(assignment.employeeId);
      return [{
        employeeCode: target?.employeeCode ?? "",
        employeeName: target?.employeeName ?? "Employee",
        workDate: assignment.workDate,
        before: formatShiftAssignment(previous, shiftRows),
        after: formatShiftAssignment(assignment, shiftRows),
      }];
    });
    const candidateValidation = await validateScheduleDraftCandidate({
      draftId: draft.id,
      ownerUserId: input.ownerUserId,
      assignments: generated.assignments,
    });
    const blockers = candidateValidation.introducedBlockers.map((issue) => issue.message);
    const warnings = generated.issues.filter((issue) => issue.severity !== "BLOCKER").map((issue) => issue.message).slice(0, 20);
    if (generated.sourceStale) blockers.unshift("Live schedule, overrides, or approved leave changed since this draft was created.");
    const changeAssignments = generated.assignments.map((assignment) => ({
      employeeId: assignment.employeeId,
      workDate: assignment.workDate,
      shiftId: assignment.shiftId,
      assignmentKind: assignment.assignmentKind,
      reason: "Balanced by existing configured staffing coverage generator.",
    }));
    const { interaction } = await makePendingOperation({
      conversationId: input.conversationId,
      userId: input.ownerUserId,
      draft,
      sourceMessage: input.sourceMessage,
      intent,
      targetEmployeeIds: draft.scope.employeeIds,
      status: "PROPOSAL",
      title: "Review coverage proposal",
      summary: generated.changedCells
        ? `Existing coverage generator proposes ${generated.changedCells} draft changes for week ${draft.weekStart}. It uses configured coverage rules and existing generator objective; no extra staffing target was assumed.`
        : "No change needed under configured coverage rules. If rules are not configured, add reviewed coverage policies before asking to balance staffing.",
      assignments: changeAssignments,
      beforeAssignments: assignmentInputs,
      changes,
      changeCount: generated.changedCells,
      warnings,
      blockers,
      canApply: generated.changedCells > 0 && blockers.length === 0,
      previousOperation: input.previousOperation,
    });
    return { message: interaction.summary, interaction };
  }

  const employeeRows = await db.employee.findMany({
    where: {
      employeeId: { in: draft.scope.employeeIds },
      isArchived: false,
      currentStatus: { notIn: [CURRENT_STATUS.INACTIVE, CURRENT_STATUS.ENDED] },
    },
    select: {
      employeeId: true,
      employeeCode: true,
      firstName: true,
      lastName: true,
      position: { select: { positionId: true, name: true, isActive: true, departmentId: true } },
      department: { select: { departmentId: true, name: true, isActive: true } },
    },
  });
  const activeEmployees = employeeRows.filter((employee) => employee.department?.isActive !== false && employee.position?.isActive !== false);
  const positionRows = new Map<string, { positionId: string; name: string; departmentName: string }>();
  const departmentRows = new Map<string, { departmentId: string; name: string }>();
  for (const employee of activeEmployees) {
    if (employee.position) {
      positionRows.set(employee.position.positionId, {
        positionId: employee.position.positionId,
        name: employee.position.name,
        departmentName: employee.department?.name ?? "No department",
      });
    }
    if (employee.department) departmentRows.set(employee.department.departmentId, employee.department);
  }
  const roleChoices = (query: string, type: "POSITION" | "DEPARTMENT") => {
    const rows = type === "POSITION" ? Array.from(positionRows.values()) : Array.from(departmentRows.values());
    const matches = rows.filter((row) => matchesNaturalGroupName(query, row.name));
    return { rows, matches };
  };
  const choicesForEmployeeRows = (rows: typeof activeEmployees, kind = "EMPLOYEE") => rows.map((employee) => newOperationChoice(
    `${employee.firstName} ${employee.lastName}`.trim(),
    [employee.position?.name, employee.department?.name, `Code ${employee.employeeCode}`].filter(Boolean).join(" · "),
    { kind, employeeId: employee.employeeId, employeeCode: employee.employeeCode },
  ));

  let targetEmployeeIds = input.fixedTargetEmployeeIds
    ? input.fixedTargetEmployeeIds.filter((employeeId) => activeEmployees.some((employee) => employee.employeeId === employeeId))
    : [];
  if (!input.fixedTargetEmployeeIds && actionsHaveOwnScopes) {
    targetEmployeeIds = activeEmployees.map((employee) => employee.employeeId);
  } else if (!input.fixedTargetEmployeeIds) {
    if (intent.targetType === "ALL") {
      targetEmployeeIds = activeEmployees.map((employee) => employee.employeeId);
    } else if (intent.targetType === "EMPLOYEE") {
      const employeeQueries = intent.targetEmployeeQueries.length
        ? intent.targetEmployeeQueries
        : intent.targetQuery ? [intent.targetQuery] : [];
      const resolvedEmployeeIds: string[] = [];
      for (let queryIndex = 0; queryIndex < employeeQueries.length; queryIndex += 1) {
        const query = employeeQueries[queryIndex];
        const matches = findEmployeeTargets(query, activeEmployees);
        if (matches.length === 0) {
          return makeClarification({
            title: "Employee not found",
            summary: "I couldn't match that person to an active employee in the selected draft. Try the employee's full name or employee code, or select a draft that includes them. No changes made.",
            targetEmployeeIds: resolvedEmployeeIds,
          });
        }
        if (matches.length > 1) {
          return makeClarification({
            title: "Which employee?",
            summary: "More than one active employee matches this request. Choose the correct person.",
            choices: matches.map((employee) => newOperationChoice(
              `${employee.firstName} ${employee.lastName}`.trim(),
              [employee.position?.name, employee.department?.name, `Code ${employee.employeeCode}`].filter(Boolean).join(" · "),
              { kind: "EMPLOYEE", employeeId: employee.employeeId, employeeCode: employee.employeeCode, queryIndex },
            )),
            selectionMode: "single",
            targetEmployeeIds: resolvedEmployeeIds,
          });
        }
        resolvedEmployeeIds.push(matches[0].employeeId);
      }
      targetEmployeeIds = Array.from(new Set(resolvedEmployeeIds));
    } else if ((intent.targetType === "POSITION" || intent.targetType === "DEPARTMENT") && intent.targetQuery) {
      const { rows, matches } = roleChoices(intent.targetQuery, intent.targetType);
      if (matches.length === 0) {
        const options = rows.slice(0, 50).map((row) => newOperationChoice(
          row.name,
          "departmentName" in row ? row.departmentName : "Active department",
          "positionId" in row
            ? { kind: "POSITION", positionId: row.positionId, groupName: row.name }
            : { kind: "DEPARTMENT", departmentId: row.departmentId, groupName: row.name },
        ));
        return makeClarification({
          title: `Choose ${intent.targetType === "POSITION" ? "position" : "department"}`,
          summary: `I couldn't match the requested group to an active ${intent.targetType.toLocaleLowerCase()} in this draft. Choose an available group or edit request.`,
          choices: options,
          selectionMode: "single",
        });
      }
      if (matches.length > 1) {
        const options = matches.map((row) => newOperationChoice(
          row.name,
          "departmentName" in row ? row.departmentName : "Active department",
          "positionId" in row
            ? { kind: "POSITION", positionId: row.positionId, groupName: row.name }
            : { kind: "DEPARTMENT", departmentId: row.departmentId, groupName: row.name },
        ));
        return makeClarification({
          title: "Choose target group",
          summary: "The requested name matches more than one active group. Choose the intended group.",
          choices: options,
          selectionMode: "single",
        });
      }
      const group = matches[0];
      targetEmployeeIds = activeEmployees.filter((employee) => intent.targetType === "POSITION"
        ? employee.position?.positionId === ("positionId" in group ? group.positionId : null)
        : employee.department?.departmentId === ("departmentId" in group ? group.departmentId : null)).map((employee) => employee.employeeId);
    }
  }
  if (input.fixedTargetEmployeeIds && targetEmployeeIds.length !== input.fixedTargetEmployeeIds.length) {
    return { message: "One or more selected employees are no longer active or inside this draft. Review target scope and try again.", interaction: null as ScheduleInteraction | null };
  }

  for (const exclusion of actionsHaveOwnScopes ? [] : intent.excludeTargetQueries) {
    const positionMatches = roleChoices(exclusion, "POSITION").matches;
    const departmentMatches = roleChoices(exclusion, "DEPARTMENT").matches;
    const employeeMatches = findEmployeeTargets(exclusion, activeEmployees);
    if (employeeMatches.length > 1) {
      return makeClarification({
        title: "Choose employee to exclude",
        summary: "More than one active employee matches the exclusion. Choose who to leave unchanged.",
        choices: employeeMatches.map((employee) => newOperationChoice(
          `${employee.firstName} ${employee.lastName}`.trim(),
          [employee.position?.name, employee.department?.name, `Code ${employee.employeeCode}`].filter(Boolean).join(" · "),
          { kind: "EXCLUDED_EMPLOYEE", employeeId: employee.employeeId, employeeCode: employee.employeeCode, exclusionQuery: exclusion },
        )),
        selectionMode: "single",
        targetEmployeeIds,
      });
    }
    const excludedIds = new Set([
      ...activeEmployees.filter((employee) =>
      (employee.position && positionMatches.some((position) => "positionId" in position && position.positionId === employee.position?.positionId)) ||
      (employee.department && departmentMatches.some((department) => "departmentId" in department && department.departmentId === employee.department?.departmentId)),
      ).map((employee) => employee.employeeId),
      ...employeeMatches.map((employee) => employee.employeeId),
    ]);
    if (excludedIds.size === 0) {
      return makeClarification({ title: "Check exclusion", summary: "I couldn't resolve the excluded employee, position, or department in this draft. Confirm its name; no changes made." });
    }
    targetEmployeeIds = targetEmployeeIds.filter((employeeId) => !excludedIds.has(employeeId));
  }
  targetEmployeeIds = Array.from(new Set(targetEmployeeIds));
  if (targetEmployeeIds.length === 0) {
    return makeClarification({ title: "No eligible employees", summary: "No active eligible employees match this request inside the selected draft. No changes made." });
  }

  if (intent.actions.length > 0) {
    const actions = intent.actions;
    const shiftRows = await db.shift.findMany({
      where: { isActive: true },
      orderBy: [{ startMinutes: "asc" }, { code: "asc" }],
      select: { id: true, code: true, name: true, isDayOff: true },
    });
    const resolvedActions: Array<{
      dates: string[];
      shiftId: number | null;
      assignmentKind: "WORK" | "DAY_OFF" | "UNASSIGNED";
      preserveExistingDayOff: boolean;
      onlyUnassigned: boolean;
      employeeIds: string[];
      targetType: "ALL" | "POSITION" | "DEPARTMENT" | "EMPLOYEE";
      targetLabel: string;
      allocationGroup: string | null;
      allocationIndex: number | null;
      allocationSize: number | null;
      inferredGroupKey: string | null;
      inferredSplitRequested: boolean;
    }> = [];
    for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
      const action = actions[actionIndex];
      const hasActionScope = action.targetType !== null || action.targetQuery !== null ||
        action.targetEmployeeQueries.length > 0 || action.excludeTargetQueries.length > 0;
      const targetType = action.targetType ?? intent.targetType;
      const targetQuery = action.targetQuery ?? intent.targetQuery;
      const employeeQueries = action.targetEmployeeQueries.length
        ? action.targetEmployeeQueries
        : targetType === "EMPLOYEE"
          ? intent.targetEmployeeQueries.length ? intent.targetEmployeeQueries : targetQuery ? [targetQuery] : []
          : [];
      const exclusionQueries = action.excludeTargetQueries.length
        ? action.excludeTargetQueries
        : action.targetType === null ? intent.excludeTargetQueries : [];
      const resolvesActionTarget = hasActionScope || actionsHaveOwnScopes;
      let actionEmployeeIds = resolvesActionTarget ? [] : [...targetEmployeeIds];
      let targetLabel = targetType === "ALL" ? "All employees" : targetQuery ?? "Selected employees";

      if (resolvesActionTarget) {
        if (targetType === "ALL") {
          actionEmployeeIds = activeEmployees.map((employee) => employee.employeeId);
        } else if (targetType === "EMPLOYEE") {
          const resolvedIds: string[] = [];
          for (let queryIndex = 0; queryIndex < employeeQueries.length; queryIndex += 1) {
            const query = employeeQueries[queryIndex];
            const matches = findEmployeeTargets(query, activeEmployees);
            if (matches.length === 0) {
              return makeClarification({
                title: "Employee not found",
                summary: `I couldn't match an employee for action ${actionIndex + 1}. Try the employee's full name or code. No changes made.`,
                targetEmployeeIds: resolvedIds,
              });
            }
            if (matches.length > 1) {
              return makeClarification({
                title: "Choose employee for action",
                summary: `Choose the employee for action ${actionIndex + 1}.`,
                choices: matches.map((employee) => newOperationChoice(
                  `${employee.firstName} ${employee.lastName}`.trim(),
                  [employee.position?.name, employee.department?.name, `Code ${employee.employeeCode}`].filter(Boolean).join(" · "),
                  { kind: "ACTION_EMPLOYEE", actionIndex, queryIndex, employeeId: employee.employeeId, employeeCode: employee.employeeCode },
                )),
                selectionMode: "single",
                targetEmployeeIds: resolvedIds,
              });
            }
            resolvedIds.push(matches[0].employeeId);
          }
          actionEmployeeIds = Array.from(new Set(resolvedIds));
          targetLabel = actionEmployeeIds.map((employeeId) => {
            const employee = activeEmployees.find((candidate) => candidate.employeeId === employeeId)!;
            return `${employee.firstName} ${employee.lastName} (${employee.employeeCode})`;
          }).join(", ") || "Selected employees";
        } else if ((targetType === "POSITION" || targetType === "DEPARTMENT") && targetQuery) {
          const { rows, matches } = roleChoices(targetQuery, targetType);
          if (matches.length !== 1) {
            const options = (matches.length ? matches : rows).slice(0, 50).map((row) => newOperationChoice(
              row.name,
              "departmentName" in row ? row.departmentName : "Active department",
              {
                kind: "ACTION_GROUP",
                actionIndex,
                targetType,
                groupName: row.name,
              },
            ));
            return makeClarification({
              title: matches.length ? "Choose action group" : "Group not found",
              summary: matches.length
                ? `Choose the position or department for action ${actionIndex + 1}.`
                : `I couldn't match an active ${targetType.toLocaleLowerCase()} for action ${actionIndex + 1}. Choose an available group or edit the request.`,
              choices: options,
              selectionMode: "single",
            });
          }
          const group = matches[0];
          targetLabel = group.name;
          actionEmployeeIds = activeEmployees.filter((employee) => targetType === "POSITION"
            ? employee.position?.positionId === ("positionId" in group ? group.positionId : null)
            : employee.department?.departmentId === ("departmentId" in group ? group.departmentId : null)).map((employee) => employee.employeeId);
        }
      }

      const appliedExclusions: string[] = [];
      for (const exclusion of exclusionQueries) {
        const positionMatches = roleChoices(exclusion, "POSITION").matches;
        const departmentMatches = roleChoices(exclusion, "DEPARTMENT").matches;
        const employeeMatches = findEmployeeTargets(exclusion, activeEmployees);
        if (employeeMatches.length > 1) {
          return makeClarification({
            title: "Choose employee to exclude",
            summary: `Choose who to exclude from action ${actionIndex + 1}.`,
            choices: employeeMatches.map((employee) => newOperationChoice(
              `${employee.firstName} ${employee.lastName}`.trim(),
              [employee.position?.name, employee.department?.name, `Code ${employee.employeeCode}`].filter(Boolean).join(" · "),
              { kind: "ACTION_EXCLUDED_EMPLOYEE", actionIndex, employeeId: employee.employeeId, employeeCode: employee.employeeCode, exclusionQuery: exclusion },
            )),
            selectionMode: "single",
            targetEmployeeIds: actionEmployeeIds,
          });
        }
        const excludedGroups = activeEmployees.filter((employee) =>
          (employee.position && positionMatches.some((position) => "positionId" in position && position.positionId === employee.position?.positionId)) ||
          (employee.department && departmentMatches.some((department) => "departmentId" in department && department.departmentId === employee.department?.departmentId)),
        );
        const excludedIds = new Set([...excludedGroups.map((employee) => employee.employeeId), ...employeeMatches.map((employee) => employee.employeeId)]);
        if (excludedIds.size === 0) {
          return makeClarification({
            title: "Check action exclusion",
            summary: `I couldn't resolve an exclusion for action ${actionIndex + 1}. Confirm the employee, position, or department name. No changes made.`,
            targetEmployeeIds: actionEmployeeIds,
          });
        }
        actionEmployeeIds = actionEmployeeIds.filter((employeeId) => !excludedIds.has(employeeId));
        appliedExclusions.push(...excludedGroups.map((employee) => employee.position?.name ?? employee.department?.name ?? "group"));
        appliedExclusions.push(...employeeMatches.map((employee) => `${employee.firstName} ${employee.lastName}`));
      }
      if (appliedExclusions.length) targetLabel += ` except ${Array.from(new Set(appliedExclusions)).join(", ")}`;
      if (actionEmployeeIds.length === 0) {
        return makeClarification({
          title: "No eligible employees",
          summary: `No active employees match action ${actionIndex + 1} after its exclusions. No changes made.`,
        });
      }

      const requestedDates = action.workDates.length
        ? action.workDates
        : action.usePlannerWeek
          ? datesInWeek
          : actions.length === 1
            ? resolveExplicitBulkScheduleDates(input.sourceMessage, draft.weekStart, toPlannerDateKey(new Date())) ?? []
            : [];
      const uniqueDates = Array.from(new Set(requestedDates)).sort();
      const outsideDates = uniqueDates.filter((date) => !datesInWeek.includes(date));
      if (outsideDates.length) {
        return makeClarification({
          title: "Choose dates in this week",
          summary: `${outsideDates.join(", ")} is outside displayed draft week ${draft.weekStart}. Choose valid dates for action ${actionIndex + 1}.`,
          choices: datesInWeek.map((date) => newOperationChoice(
            `${new Intl.DateTimeFormat("en", { weekday: "long", timeZone: "Asia/Manila" }).format(new Date(`${date}T12:00:00.000Z`))} · ${date}`,
            undefined,
            { kind: "ACTION_DATE", actionIndex, date },
          )),
          selectionMode: "multiple",
          targetEmployeeIds: actionEmployeeIds,
        });
      }
      if (uniqueDates.length === 0) {
        if (action.dateSelectionMode === "PICK_DAYS") {
          return makeClarification({
            title: "Choose dates",
            summary: `Select date(s) for action ${actionIndex + 1} in planner week ${draft.weekStart}.`,
            choices: datesInWeek.map((date) => newOperationChoice(
              `${new Intl.DateTimeFormat("en", { weekday: "long", timeZone: "Asia/Manila" }).format(new Date(`${date}T12:00:00.000Z`))} · ${date}`,
              undefined,
              { kind: "ACTION_DATE", actionIndex, date },
            )),
            selectionMode: "multiple",
            targetEmployeeIds: actionEmployeeIds,
          });
        }
        return makeClarification({
          title: "Choose schedule range",
          summary: `Choose the date range for action ${actionIndex + 1}.`,
          choices: [
            newOperationChoice("Whole week", `All seven days · ${draft.weekStart}`, { kind: "ACTION_DATE_SCOPE", actionIndex, scope: "WEEK" }),
            newOperationChoice("Weekdays only", "Monday through Friday", { kind: "ACTION_DATE_SCOPE", actionIndex, scope: "WEEKDAYS" }),
            newOperationChoice("Choose dates", "Pick one or more days", { kind: "ACTION_DATE_SCOPE", actionIndex, scope: "PICK_DAYS" }),
          ],
          selectionMode: "single",
          targetEmployeeIds: actionEmployeeIds,
        });
      }

      let shiftId: number | null = null;
      if (action.assignmentKind === "WORK") {
        const workingShifts = shiftRows.filter((shift) => !shift.isDayOff);
        const shiftResult = action.shiftRef
          ? resolveShiftReference(action.shiftRef, workingShifts)
          : extractShiftReferenceFromMessage(input.sourceMessage, workingShifts);
        if (shiftResult.status !== "resolved") {
          const choices = workingShifts.map((shift) => newOperationChoice(
            `${shift.code} · ${shift.name}`,
            undefined,
            { kind: "ACTION_SHIFT", actionIndex, shiftCode: shift.code },
          ));
          return makeClarification({
            title: "Choose working shift",
            summary: shiftResult.status === "ambiguous"
              ? `Action ${actionIndex + 1} matches multiple active shifts. Choose one.`
              : `I couldn't identify a working shift for action ${actionIndex + 1}. Choose an active shift.`,
            choices,
            selectionMode: "single",
            targetEmployeeIds: actionEmployeeIds,
          });
        }
        shiftId = shiftResult.shift.id;
      } else if (action.assignmentKind === "DAY_OFF") {
        const offShifts = shiftRows.filter((shift) => shift.isDayOff);
        if (offShifts.length === 0) {
          return makeClarification({
            title: "Day-off shift not configured",
            summary: "No active shift is marked as a day off. Configure a day-off shift, then retry. No draft changes were proposed.",
            targetEmployeeIds: actionEmployeeIds,
          });
        }
        const offMatch = action.shiftRef ? resolveShiftReference(action.shiftRef, offShifts) : null;
        if (offMatch?.status === "resolved") shiftId = offMatch.shift.id;
        else if (offShifts.length === 1 && !action.shiftRef) shiftId = offShifts[0].id;
        else {
          return makeClarification({
            title: "Choose day-off shift",
            summary: `Choose the active day-off shift for action ${actionIndex + 1}.`,
            choices: offShifts.map((shift) => newOperationChoice(
              `${shift.code} · ${shift.name}`,
              undefined,
              { kind: "ACTION_SHIFT", actionIndex, shiftCode: shift.code },
            )),
            selectionMode: "single",
            targetEmployeeIds: actionEmployeeIds,
          });
        }
      }
      resolvedActions.push({
        dates: uniqueDates,
        shiftId,
        assignmentKind: action.assignmentKind,
        preserveExistingDayOff: action.preserveExistingDayOff,
        onlyUnassigned: action.onlyUnassigned && explicitlyRequestsUnassignedScheduleCells(input.sourceMessage),
        employeeIds: actionEmployeeIds,
        targetType,
        targetLabel,
        allocationGroup: action.allocationGroup,
        allocationIndex: null,
        allocationSize: null,
        inferredGroupKey: null,
        inferredSplitRequested: false,
      });
    }

    // Reconcile model scopes against the entities and shift mentions the user
    // actually wrote. This prevents a repeated model target (e.g. Cashier for
    // every action) from silently dropping a later group such as Cook.
    const scopeCandidates = [
      ...Array.from(positionRows.values()).map((position) => ({
        id: position.positionId,
        type: "POSITION" as const,
        name: position.name,
        employeeIds: activeEmployees
          .filter((employee) => employee.position?.positionId === position.positionId)
          .map((employee) => employee.employeeId),
      })),
      ...Array.from(departmentRows.values()).map((department) => ({
        id: department.departmentId,
        type: "DEPARTMENT" as const,
        name: department.name,
        employeeIds: activeEmployees
          .filter((employee) => employee.department?.departmentId === department.departmentId)
          .map((employee) => employee.employeeId),
      })),
    ];
    const inferredScopes = inferScheduleActionScopesFromText({
      message: input.sourceMessage,
      groups: scopeCandidates,
      shifts: shiftRows,
      actionShiftIds: resolvedActions.map((action) => action.shiftId),
      allEmployeeIds: activeEmployees.map((employee) => employee.employeeId),
    });
    inferredScopes.forEach((scope, index) => {
      if (!scope || scope.employeeIds.length === 0) return;
      resolvedActions[index].employeeIds = scope.employeeIds;
      resolvedActions[index].targetType = scope.targetType;
      resolvedActions[index].targetLabel = scope.targetLabel;
      resolvedActions[index].inferredGroupKey = scope.groupKey;
      resolvedActions[index].inferredSplitRequested = scope.splitRequested;
    });

    // When the user says a group should be split between named shifts, make
    // those action scopes disjoint and deterministic before validating them.
    const inferredSplitGroups = new Map<string, number[]>();
    resolvedActions.forEach((action, index) => {
      if (!action.inferredSplitRequested || !action.inferredGroupKey) return;
      inferredSplitGroups.set(action.inferredGroupKey, [
        ...(inferredSplitGroups.get(action.inferredGroupKey) ?? []),
        index,
      ]);
    });
    for (const [groupKey, indexes] of inferredSplitGroups) {
      const distinctShifts = new Set(indexes.map((index) => resolvedActions[index].shiftId));
      if (indexes.length > 1 && distinctShifts.size > 1) {
        indexes.forEach((index) => {
          if (!resolvedActions[index].allocationGroup) {
            resolvedActions[index].allocationGroup = `inferred:${groupKey}`;
          }
        });
      }
    }

    const allocationGroups = new Map<string, number[]>();
    resolvedActions.forEach((action, index) => {
      if (!action.allocationGroup) return;
      allocationGroups.set(action.allocationGroup, [...(allocationGroups.get(action.allocationGroup) ?? []), index]);
    });
    for (const [groupName, indexes] of allocationGroups) {
      if (indexes.length < 2) {
        return makeClarification({ title: "Incomplete employee split", summary: "An even split needs at least two shift actions. No changes made." });
      }
      const firstAction = resolvedActions[indexes[0]];
      const sameTarget = indexes.every((index) => {
        const employeeIds = resolvedActions[index].employeeIds;
        return employeeIds.length === firstAction.employeeIds.length && firstAction.employeeIds.every((employeeId) => employeeIds.includes(employeeId));
      });
      const sameDates = indexes.every((index) => {
        const dates = resolvedActions[index].dates;
        return dates.length === firstAction.dates.length && firstAction.dates.every((date) => dates.includes(date));
      });
      if (!sameTarget || !sameDates) {
        return makeClarification({
          title: "Review employee split",
          summary: "Actions in an even split must use the same employee group and dates. No changes made; edit the request and preview again.",
          targetEmployeeIds: firstAction.employeeIds,
        });
      }
      const partitions = splitEmployeesEvenly(firstAction.employeeIds, indexes.length, `${draft.weekStart}:${groupName}`);
      indexes.forEach((index, partitionIndex) => {
        resolvedActions[index].employeeIds = partitions[partitionIndex];
        resolvedActions[index].allocationIndex = partitionIndex + 1;
        resolvedActions[index].allocationSize = partitions[partitionIndex].length;
      });
    }

    const mentionedGroupNames = Array.from(new Set([
      ...positionRows.values(),
      ...departmentRows.values(),
    ].map((group) => group.name).filter((name) => containsNaturalGroupName(input.sourceMessage, name))));
    const incompleteGroups = mentionedGroupNames.filter((name) => {
      const hasTargetAction = resolvedActions.some((action) =>
        (action.targetType === "POSITION" || action.targetType === "DEPARTMENT") &&
        matchesNaturalGroupName(action.targetLabel, name),
      );
      if (hasTargetAction) return false;
      const isExplicitlyExcluded = /\b(?:except|excluding|without|but\s+not)\b/i.test(input.sourceMessage) &&
        resolvedActions.some((action) => action.targetType === "ALL" && action.targetLabel.includes(" except ") && matchesNaturalGroupName(action.targetLabel, name));
      return !isExplicitlyExcluded;
    });
    if (incompleteGroups.length) {
      return makeClarification({
        title: "Incomplete group plan",
        summary: `The proposal doesn't assign every group named in your request: ${incompleteGroups.join(", ")}. No changes were proposed; edit the request or use the planner controls.`,
      });
    }

    const sourceTokens = new Set(input.sourceMessage.toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter(Boolean));
    const genericShiftWords = new Set(["shift", "day", "off", "work", "the", "and", "set", "to", "on", "rest", "half"]);
    const mentionedWorkShifts = shiftRows.filter((shift) => !shift.isDayOff && [shift.code, shift.name].some((label) =>
      label.toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).some((token) =>
        token.length > 1 && !genericShiftWords.has(token) && sourceTokens.has(token),
      ),
    ));
    const missingWorkShifts = mentionedWorkShifts.filter((shift) => !resolvedActions.some((action) => action.shiftId === shift.id));
    if (missingWorkShifts.length) {
      return makeClarification({
        title: "Incomplete shift plan",
        summary: `The proposal left out shift(s) named in your request: ${missingWorkShifts.map((shift) => `${shift.code} · ${shift.name}`).join(", ")}. No changes were proposed; edit the request and try again.`,
      });
    }

    targetEmployeeIds = Array.from(new Set(resolvedActions.flatMap((action) => action.employeeIds)));
    const actionDescriptions = resolvedActions.map((action) => {
      const shift = shiftRows.find((candidate) => candidate.id === action.shiftId);
      const assignmentLabel = action.assignmentKind === "DAY_OFF"
        ? `OFF${shift ? ` · ${shift.code}` : ""}`
        : action.assignmentKind === "UNASSIGNED"
          ? "Unassigned"
          : shift ? `${shift.code} · ${shift.name}` : "Working shift";
      const datesLabel = action.dates.length === datesInWeek.length && datesInWeek.every((date) => action.dates.includes(date))
        ? "whole week"
        : action.dates.join(", ");
      const targetCount = action.allocationIndex !== null
        ? `${action.allocationSize} of ${resolvedActions.filter((candidate) => candidate.allocationGroup === action.allocationGroup).reduce((count, candidate) => count + candidate.allocationSize!, 0)} evenly split employees`
        : `${action.employeeIds.length} employees`;
      const allocationLabel = action.allocationIndex !== null
        ? ` · split ${action.allocationIndex}/${allocationGroups.get(action.allocationGroup!)!.length}`
        : "";
      return `${action.targetLabel} (${targetCount}${allocationLabel}) → ${assignmentLabel} · ${datesLabel}`;
    });

    const sequence = applyScheduleAssignmentSequence({
      assignments: assignmentInputs,
      employeeIds: targetEmployeeIds,
      actions: resolvedActions,
    });
    const nextAssignments = sequence.assignments;
    const findChangedAssignments = nextAssignments.filter((assignment) => {
      const before = assignmentInputs.find((candidate) => candidate.employeeId === assignment.employeeId && candidate.workDate === assignment.workDate);
      return before && (before.shiftId !== assignment.shiftId || before.assignmentKind !== assignment.assignmentKind);
    });
    const employeeById = new Map(draft.assignments.map((assignment) => [assignment.employeeId, assignment]));
    const changes = findChangedAssignments.map((assignment) => {
      const before = assignmentInputs.find((candidate) => candidate.employeeId === assignment.employeeId && candidate.workDate === assignment.workDate)!;
      const employee = employeeById.get(assignment.employeeId);
      const finalAction = [...resolvedActions].reverse().find((action) =>
        action.employeeIds.includes(assignment.employeeId) &&
        action.dates.includes(assignment.workDate) &&
        action.shiftId === assignment.shiftId &&
        action.assignmentKind === assignment.assignmentKind,
      );
      const after = formatShiftAssignment(assignment, shiftRows);
      return {
        employeeCode: employee?.employeeCode ?? "",
        employeeName: employee?.employeeName ?? "Employee",
        workDate: assignment.workDate,
        before: formatShiftAssignment(before, shiftRows),
        after,
        ...(finalAction ? { planLabel: `${finalAction.targetLabel} → ${after}` } : {}),
      };
    });
    const candidateAssignments = nextAssignments.map((assignment) => ({
      employeeId: assignment.employeeId,
      workDate: assignment.workDate,
      shiftId: assignment.shiftId,
      assignmentKind: assignment.assignmentKind,
      reason: assignment.reason ?? null,
      isProtected: assignment.isProtected,
      hasBaselineOverride: assignment.hasBaselineOverride,
      baselineOverrideShiftId: assignment.hasBaselineOverride
        ? draft.assignments.find((candidate) => candidate.employeeId === assignment.employeeId && candidate.workDate === assignment.workDate)?.baselineOverrideShiftId ?? null
        : null,
    }));
    const candidateValidation = await validateScheduleDraftCandidate({
      draftId: draft.id,
      ownerUserId: input.ownerUserId,
      assignments: candidateAssignments,
    });
    const blockers = candidateValidation.introducedBlockers.map((issue) => issue.message);
    if (draft.isSourceStale) blockers.unshift("Live schedules, overrides, or approved leave changed since this draft was created.");
    const employeeByIdForWarnings = new Map(activeEmployees.map((employee) => [employee.employeeId, employee]));
    const preservedWarnings = sequence.preservedCells.map(({ employeeId, workDate, reason }) => {
      const employee = employeeByIdForWarnings.get(employeeId);
      return `${employee ? `${employee.firstName} ${employee.lastName} (${employee.employeeCode})` : employeeId} · ${workDate}: ${reason} preserved.`;
    });
    const warnings = [
      ...preservedWarnings,
      ...candidateValidation.issues.filter((issue) => issue.severity === "WARNING").map((issue) => issue.message),
      ...(candidateValidation.issues.some((issue) => issue.code === "COVERAGE_RULES_NOT_CONFIGURED")
        ? ["Staffing coverage rules are not configured; no coverage assumptions were applied."]
        : []),
    ].slice(0, 40);
    return createScheduleProposal({
      draft,
      nextAssignments,
      targetEmployeeIds,
      sourceMessage: input.sourceMessage,
      intent,
      previousOperation: input.previousOperation,
      conversationId: input.conversationId,
      ownerUserId: input.ownerUserId,
      shiftRows,
      initialWarnings: warnings,
      blockers,
      changes,
      summary: changes.length
        ? `Review ${changes.length} combined draft change${changes.length === 1 ? "" : "s"} for week ${draft.weekStart}. Plan: ${actionDescriptions.join("; ")}. Changes are validated together; later actions override earlier assignments only for overlapping employees and dates. Applying changes affects this draft only.`
        : "No draft cells need changing. Existing assignments already match the requested plan.",
    });
  }

  if (intent.operation === "SWAP_SHIFTS") {
    const sourceMatches = findEmployeeTargets(intent.sourceEmployeeQuery ?? "", activeEmployees);
    if (sourceMatches.length !== 1) {
      return makeClarification({
        title: "Choose first employee",
        summary: sourceMatches.length > 1 ? "Several active employees match the first person in this swap. Choose the correct person." : "I couldn't match the first person to an active employee in this draft. Check the name or employee code.",
        choices: sourceMatches.length > 1 ? choicesForEmployeeRows(sourceMatches, "SWAP_SOURCE") : undefined,
        selectionMode: sourceMatches.length > 1 ? "single" : undefined,
      });
    }
    const targetMatches = findEmployeeTargets(intent.targetEmployeeQuery ?? "", activeEmployees);
    if (targetMatches.length !== 1) {
      return makeClarification({
        title: "Choose second employee",
        summary: targetMatches.length > 1 ? "Several active employees match the second person in this swap. Choose the correct person." : "I couldn't match the second person to an active employee in this draft. Check the name or employee code.",
        choices: targetMatches.length > 1 ? choicesForEmployeeRows(targetMatches, "SWAP_TARGET") : undefined,
        selectionMode: targetMatches.length > 1 ? "single" : undefined,
      });
    }
    const dates = intent.workDates.length ? intent.workDates : resolveExplicitBulkScheduleDates(input.sourceMessage, draft.weekStart, toPlannerDateKey(new Date())) ?? [];
    const sourceDate = intent.sourceDate ?? dates[0];
    const targetDate = intent.targetDate ?? dates[1] ?? dates[0];
    if (!sourceDate || !targetDate) {
      return makeClarification({
        title: "Choose swap date(s)",
        summary: "Select one date to swap both employees on that day, or two dates to exchange assignments across days.",
        choices: datesInWeek.map((date) => newOperationChoice(
          `${new Intl.DateTimeFormat("en", { weekday: "long", timeZone: "Asia/Manila" }).format(new Date(`${date}T12:00:00.000Z`))} · ${date}`,
          undefined,
          { kind: "DATE", date },
        )),
        selectionMode: "multiple",
      });
    }
    const first = draft.assignments.find((assignment) => assignment.employeeId === sourceMatches[0].employeeId && assignment.workDate === sourceDate);
    const second = draft.assignments.find((assignment) => assignment.employeeId === targetMatches[0].employeeId && assignment.workDate === targetDate);
    if (!first || !second) {
      return makeClarification({
        title: "Choose swap date(s)",
        summary: "Requested date is outside this draft or unavailable. Select one date for a same-day swap, or two dates for different days.",
        choices: datesInWeek.map((date) => newOperationChoice(
          `${new Intl.DateTimeFormat("en", { weekday: "long", timeZone: "Asia/Manila" }).format(new Date(`${date}T12:00:00.000Z`))} · ${date}`,
          undefined,
          { kind: "DATE", date },
        )),
        selectionMode: "multiple",
      });
    }
    if (first.employeeId === second.employeeId || first.isProtected || second.isProtected || first.hasBaselineOverride || second.hasBaselineOverride) {
      return makeClarification({
        title: "Swap cannot be proposed",
        summary: "Swap needs two different employees, and neither cell can have approved leave or a schedule override. No changes made.",
        blockers: ["One or both swap cells are protected, overridden, or refer to the same employee."],
      });
    }
    const next = assignmentInputs.map((assignment) => assignment.employeeId === first.employeeId && assignment.workDate === first.workDate
      ? { ...assignment, shiftId: second.shiftId, assignmentKind: second.assignmentKind, reason: "Shift swap proposed by manager." }
      : assignment.employeeId === second.employeeId && assignment.workDate === second.workDate
        ? { ...assignment, shiftId: first.shiftId, assignmentKind: first.assignmentKind, reason: "Shift swap proposed by manager." }
        : assignment);
    return createScheduleProposal({
      draft,
      nextAssignments: next,
      targetEmployeeIds: [first.employeeId, second.employeeId],
      sourceMessage: input.sourceMessage,
      intent,
      previousOperation: input.previousOperation,
      conversationId: input.conversationId,
      ownerUserId: input.ownerUserId,
      shiftRows: await db.shift.findMany({ select: { id: true, code: true, name: true, isDayOff: true } }),
      initialWarnings: [],
    });
  }

  const fullWeekOffPlan = intent.operation === "DISTRIBUTE_DAY_OFF" && intent.workDates.length === 0 && !intent.usePlannerWeek && !resolveExplicitBulkScheduleDates(input.sourceMessage, draft.weekStart, toPlannerDateKey(new Date()));
  const requestedDates = intent.workDates.length
    ? intent.workDates
    : intent.usePlannerWeek || fullWeekOffPlan
      ? datesInWeek
      : resolveExplicitBulkScheduleDates(input.sourceMessage, draft.weekStart, toPlannerDateKey(new Date())) ?? [];
  const uniqueDates = Array.from(new Set(requestedDates)).sort();
  const outsideDates = uniqueDates.filter((date) => !datesInWeek.includes(date));
  if (outsideDates.length) {
    const options = datesInWeek.map((date) => newOperationChoice(
      `${new Intl.DateTimeFormat("en", { weekday: "long", timeZone: "Asia/Manila" }).format(new Date(`${date}T12:00:00.000Z`))} · ${date}`,
      undefined,
      { kind: "DATE", date },
    ));
    return makeClarification({ title: "Choose dates in this week", summary: `${outsideDates.join(", ")} is outside displayed draft week ${draft.weekStart}. Choose dates from active planner week or switch planner week.`, choices: options, selectionMode: "multiple", targetEmployeeIds });
  }
  if (uniqueDates.length === 0 && intent.operation === "ASSIGN_SHIFT") {
    if (intent.dateSelectionMode === "PICK_DAYS") {
      const options = datesInWeek.map((date) => newOperationChoice(
        `${new Intl.DateTimeFormat("en", { weekday: "long", timeZone: "Asia/Manila" }).format(new Date(`${date}T12:00:00.000Z`))} · ${date}`,
        undefined,
        { kind: "DATE", date },
      ));
      return makeClarification({ title: "Choose dates", summary: `Select date(s) in planner week ${draft.weekStart}.`, choices: options, selectionMode: "multiple", targetEmployeeIds });
    }
    return makeClarification({
      title: "Choose schedule range",
      summary: `Choose the date range in planner week ${draft.weekStart}.`,
      choices: [
        newOperationChoice("Whole week", "All seven days", { kind: "DATE_SCOPE", scope: "WEEK" }),
        newOperationChoice("Weekdays only", "Monday through Friday", { kind: "DATE_SCOPE", scope: "WEEKDAYS" }),
        newOperationChoice("Choose dates", "Pick one or more days", { kind: "DATE_SCOPE", scope: "PICK_DAYS" }),
      ],
      selectionMode: "single",
      targetEmployeeIds,
    });
  }
  if (uniqueDates.length === 0) {
    return makeClarification({ title: "Choose planner dates", summary: "I couldn't safely resolve requested dates in the displayed planner week. Select dates or edit request.", targetEmployeeIds });
  }

  const shiftRows = await db.shift.findMany({
    where: { isActive: true },
    orderBy: [{ startMinutes: "asc" }, { code: "asc" }],
    select: { id: true, code: true, name: true, isDayOff: true },
  });
  let selectedShift: { id: number; code: string; name: string; isDayOff: boolean } | null = null;
  if (intent.operation === "ASSIGN_SHIFT") {
    const workingShifts = shiftRows.filter((shift) => !shift.isDayOff);
    const shiftResult = intent.shiftRef
      ? resolveShiftReference(intent.shiftRef, workingShifts)
      : extractShiftReferenceFromMessage(input.sourceMessage, workingShifts);
    if (shiftResult.status === "resolved") selectedShift = { ...shiftResult.shift, isDayOff: shiftResult.shift.isDayOff ?? false };
    else {
      const choices = workingShifts.map((shift) => newOperationChoice(`${shift.code} · ${shift.name}`, undefined, { kind: "SHIFT", shiftCode: shift.code }));
      return makeClarification({
        title: "Choose shift",
        summary: shiftResult.status === "ambiguous" ? "This request matches multiple shifts. Choose one active shift code." : "I couldn't identify an active shift. Choose one by its code or name.",
        choices,
        selectionMode: "single",
        targetEmployeeIds,
      });
    }
  } else {
    const offShifts = shiftRows.filter((shift) => shift.isDayOff);
    if (offShifts.length === 0) {
      return makeClarification({ title: "Day-off shift not configured", summary: "No active shift has Shift.isDayOff=true. Configure an active day-off shift, then retry. I won't assume a code or turn approved leave into a day off.", targetEmployeeIds });
    }
    if (offShifts.length > 1 && !intent.shiftRef) {
      return makeClarification({
        title: "Choose day-off shift",
        summary: "More than one active shift is marked as a day off. Choose the intended shift.",
        choices: offShifts.map((shift) => newOperationChoice(`${shift.code} · ${shift.name}`, undefined, { kind: "SHIFT", shiftCode: shift.code })),
        selectionMode: "single",
        targetEmployeeIds,
      });
    }
    const match = intent.shiftRef ? resolveShiftReference(intent.shiftRef, offShifts) : { status: "resolved" as const, shift: offShifts[0] };
    if (match.status !== "resolved" || !match.shift.isDayOff) {
      return makeClarification({
        title: "Choose day-off shift",
        summary: "Choose an active shift marked as a day off.",
        choices: offShifts.map((shift) => newOperationChoice(`${shift.code} · ${shift.name}`, undefined, { kind: "SHIFT", shiftCode: shift.code })),
        selectionMode: "single",
        targetEmployeeIds,
      });
    }
    selectedShift = { ...match.shift, isDayOff: true };
  }
  if (!selectedShift) return { message: "Could not resolve active shift. No changes made.", interaction: null as ScheduleInteraction | null };

  let nextAssignments = assignmentInputs;
  const initialWarnings: string[] = [];
  const distributionBlockers: string[] = [];
  let mayExploreCoverageAlternatives = false;
  if (intent.operation === "DISTRIBUTE_DAY_OFF") {
    const offDates = new Set(intent.noDayOffWeekdays.flatMap((weekday) => datesInWeek.filter((date) => isIsoWeekday(date, weekday))));
    const result = distributeDayOffAssignments({
      assignments: assignmentInputs,
      employeeIds: targetEmployeeIds,
      dates: uniqueDates,
      dayOffShiftId: selectedShift.id,
      dayOffShiftIds: shiftRows.filter((shift) => shift.isDayOff).map((shift) => shift.id),
      noDayOffDates: Array.from(offDates),
      weekStart: draft.weekStart,
      seed: input.requestKey,
      minimumOnly: intent.minimumOnly,
      dayOffCount: intent.dayOffCount ?? undefined,
    });
    nextAssignments = result.assignments.map((assignment) => ({ ...assignment, reason: assignment.reason ?? null }));
    mayExploreCoverageAlternatives = result.blocked.length === 0 && !draft.isSourceStale;
    const employeeById = new Map(activeEmployees.map((employee) => [employee.employeeId, employee]));
    for (const blocked of result.blocked) {
      const employee = employeeById.get(blocked.employeeId);
      const message = `${employee ? `${employee.firstName} ${employee.lastName} (${employee.employeeCode})` : blocked.employeeId}: ${blocked.reason}`;
      initialWarnings.push(message);
      distributionBlockers.push(message);
    }
    for (const retained of result.retained) {
      const employee = employeeById.get(retained.employeeId);
      if (employee) initialWarnings.push(`${employee.firstName} ${employee.lastName} (${employee.employeeCode}): retained existing day off on ${retained.workDate}.`);
    }
  } else {
    const nextKind = selectedShift.isDayOff ? "DAY_OFF" : "WORK";
    const proposal = applyShiftAssignmentProposal({
      assignments: assignmentInputs,
      employeeIds: targetEmployeeIds,
      dates: uniqueDates,
      shiftId: selectedShift.id,
      assignmentKind: nextKind,
      preserveExistingDayOff: intent.operation === "ASSIGN_SHIFT" && intent.preserveExistingDayOff,
      onlyUnassigned: intent.operation === "ASSIGN_SHIFT" && intent.onlyUnassigned && explicitlyRequestsUnassignedScheduleCells(input.sourceMessage),
    });
    nextAssignments = proposal.assignments;
    const employeeById = new Map(activeEmployees.map((employee) => [employee.employeeId, employee]));
    initialWarnings.push(...proposal.preservedCells.map(({ employeeId, workDate, reason }) => {
      const employee = employeeById.get(employeeId);
      return `${employee ? `${employee.firstName} ${employee.lastName} (${employee.employeeCode})` : employeeId} · ${workDate}: ${reason} preserved.`;
    }));
  }

  const findChangedAssignments = (assignments: typeof nextAssignments) => assignments.filter((assignment) => {
    const before = assignmentInputs.find((candidate) => candidate.employeeId === assignment.employeeId && candidate.workDate === assignment.workDate);
    return before && (before.shiftId !== assignment.shiftId || before.assignmentKind !== assignment.assignmentKind);
  });
  const employeeById = new Map(draft.assignments.map((assignment) => [assignment.employeeId, assignment]));
  const toChangeRows = (assignments: typeof nextAssignments) => findChangedAssignments(assignments).map((assignment) => {
    const previous = assignmentInputs.find((candidate) => candidate.employeeId === assignment.employeeId && candidate.workDate === assignment.workDate)!;
    const employee = employeeById.get(assignment.employeeId);
    return {
      employeeCode: employee?.employeeCode ?? "",
      employeeName: employee?.employeeName ?? "Employee",
      workDate: assignment.workDate,
      before: formatShiftAssignment(previous, shiftRows),
      after: formatShiftAssignment(assignment, shiftRows),
    };
  });
  const toCandidateAssignments = (assignments: typeof nextAssignments) => assignments.map((assignment) => ({
      employeeId: assignment.employeeId,
      workDate: assignment.workDate,
      shiftId: assignment.shiftId,
      assignmentKind: assignment.assignmentKind,
      reason: assignment.reason ?? null,
      isProtected: assignment.isProtected,
      hasBaselineOverride: assignment.hasBaselineOverride,
      baselineOverrideShiftId: assignment.hasBaselineOverride
        ? draft.assignments.find((candidate) => candidate.employeeId === assignment.employeeId && candidate.workDate === assignment.workDate)?.baselineOverrideShiftId ?? null
        : null,
    }));
  let changes = toChangeRows(nextAssignments);
  let candidateValidation = await validateScheduleDraftCandidate({
    draftId: draft.id,
    ownerUserId: input.ownerUserId,
    assignments: toCandidateAssignments(nextAssignments),
  });
  if (mayExploreCoverageAlternatives && candidateValidation.introducedBlockers.length > 0) {
    const alternatives: typeof nextAssignments[] = [];
    const seen = new Set([JSON.stringify(toCandidateAssignments(nextAssignments).map(({ employeeId, workDate, shiftId, assignmentKind }) => [employeeId, workDate, shiftId, assignmentKind]))]);
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      const alternative = distributeDayOffAssignments({
        assignments: assignmentInputs,
        employeeIds: targetEmployeeIds,
        dates: uniqueDates,
        dayOffShiftId: selectedShift.id,
        dayOffShiftIds: shiftRows.filter((shift) => shift.isDayOff).map((shift) => shift.id),
        noDayOffDates: Array.from(new Set(intent.noDayOffWeekdays.flatMap((weekday) => datesInWeek.filter((date) => isIsoWeekday(date, weekday))))),
        weekStart: draft.weekStart,
        seed: `${input.requestKey}:coverage:${attempt}`,
        minimumOnly: intent.minimumOnly,
        dayOffCount: intent.dayOffCount ?? undefined,
      });
      if (alternative.blocked.length > 0) continue;
      const proposed = alternative.assignments.map((assignment) => ({ ...assignment, reason: assignment.reason ?? null }));
      const fingerprint = JSON.stringify(toCandidateAssignments(proposed).map(({ employeeId, workDate, shiftId, assignmentKind }) => [employeeId, workDate, shiftId, assignmentKind]));
      if (!seen.has(fingerprint)) {
        seen.add(fingerprint);
        alternatives.push(proposed);
      }
    }
    if (alternatives.length > 0) {
      const alternativeValidations = await validateScheduleDraftCandidates({
        draftId: draft.id,
        ownerUserId: input.ownerUserId,
        candidates: alternatives.map(toCandidateAssignments),
      });
      const passingIndex = alternativeValidations.findIndex((validation) => validation.introducedBlockers.length === 0);
      if (passingIndex >= 0) {
        nextAssignments = alternatives[passingIndex];
        candidateValidation = alternativeValidations[passingIndex];
        changes = toChangeRows(nextAssignments);
      }
    }
  }
  const blockers = [...distributionBlockers, ...candidateValidation.introducedBlockers.map((issue) => issue.message)];
  if (draft.isSourceStale) blockers.unshift("Live schedules, overrides, or approved leave changed since this draft was created.");
  const introducedIssueSet = new Set(candidateValidation.introducedBlockers);
  const existingBlockerMessages = candidateValidation.issues
    .filter((issue) => issue.severity === "BLOCKER" && !introducedIssueSet.has(issue))
    .map((issue) => `Existing draft blocker: ${issue.message}`);
  const warnings = [
    ...initialWarnings,
    ...existingBlockerMessages,
    ...candidateValidation.issues.filter((issue) => issue.severity === "WARNING").map((issue) => issue.message),
    ...(candidateValidation.issues.some((issue) => issue.code === "COVERAGE_RULES_NOT_CONFIGURED")
      ? ["Staffing coverage rules are not configured; no coverage assumptions were applied."]
      : []),
  ].slice(0, 40);
  const proposalSummary = changes.length === 0
    ? "No draft cells need changing. Existing compliant assignments were retained."
    : `Review ${changes.length} proposed draft change${changes.length === 1 ? "" : "s"} for week ${draft.weekStart}. ${initialWarnings.length ? `${initialWarnings.length} employee/date item(s) were preserved or skipped; see details.` : ""} Applying updates this draft only. Schedule approval and publication remain separate.`;
  return createScheduleProposal({
    draft,
    nextAssignments,
    targetEmployeeIds,
    sourceMessage: input.sourceMessage,
    intent,
    previousOperation: input.previousOperation,
    conversationId: input.conversationId,
    ownerUserId: input.ownerUserId,
    shiftRows,
    initialWarnings: warnings,
    blockers,
    changes,
    summary: proposalSummary,
  });
};

const createScheduleProposal = async (input: {
  draft: Awaited<ReturnType<typeof getScheduleDraftVersion>>;
  nextAssignments: Array<{
    employeeId: string;
    workDate: string;
    shiftId: number | null;
    assignmentKind: string;
    reason?: string | null;
    isProtected?: boolean;
    hasBaselineOverride?: boolean;
  }>;
  targetEmployeeIds: string[];
  sourceMessage: string;
  intent: ScheduleOperationIntent;
  previousOperation?: PendingScheduleOperation;
  conversationId: string;
  ownerUserId: string;
  shiftRows: Array<{ id: number; code: string; name: string; isDayOff: boolean }>;
  initialWarnings: string[];
  blockers?: string[];
  changes?: NonNullable<ScheduleInteraction["changes"]>;
  summary?: string;
}) => {
  const changes = input.changes ?? input.nextAssignments.flatMap((assignment) => {
    const previous = input.draft.assignments.find((candidate) => candidate.employeeId === assignment.employeeId && candidate.workDate === assignment.workDate);
    if (!previous || (previous.shiftId === assignment.shiftId && previous.assignmentKind === assignment.assignmentKind)) return [];
    return [{
      employeeCode: previous.employeeCode,
      employeeName: previous.employeeName,
      workDate: assignment.workDate,
      before: formatShiftAssignment(previous, input.shiftRows),
      after: formatShiftAssignment(assignment, input.shiftRows),
    }];
  });
  const validation = await validateScheduleDraftCandidate({
    draftId: input.draft.id,
    ownerUserId: input.ownerUserId,
    assignments: input.nextAssignments.map((assignment) => ({
      employeeId: assignment.employeeId,
      workDate: assignment.workDate,
      shiftId: assignment.shiftId,
      assignmentKind: assignment.assignmentKind as "WORK" | "DAY_OFF" | "UNASSIGNED" | "PROTECTED_LEAVE",
      isProtected: assignment.isProtected ?? false,
      hasBaselineOverride: assignment.hasBaselineOverride ?? false,
      baselineOverrideShiftId: assignment.hasBaselineOverride
        ? input.draft.assignments.find((candidate) => candidate.employeeId === assignment.employeeId && candidate.workDate === assignment.workDate)?.baselineOverrideShiftId ?? null
        : null,
    })),
  });
  const blockers = Array.from(new Set([...(input.blockers ?? []), ...validation.introducedBlockers.map((issue) => issue.message)]));
  if (input.draft.isSourceStale) blockers.unshift("Live schedules, overrides, or approved leave changed since this draft was created.");
  const warnings = Array.from(new Set([
    ...input.initialWarnings,
    ...validation.issues.filter((issue) => issue.severity === "WARNING").map((issue) => issue.message),
    ...validation.issues.filter((issue) => issue.severity === "BLOCKER" && !validation.introducedBlockers.includes(issue)).map((issue) => `Existing draft blocker: ${issue.message}`),
    ...(validation.issues.some((issue) => issue.code === "COVERAGE_RULES_NOT_CONFIGURED") ? ["Staffing coverage rules are not configured; no coverage assumptions were applied."] : []),
  ])).slice(0, 40);
  const changedCount = changes.length;
  const summary = input.summary ?? (changedCount
    ? `Review ${changedCount} proposed draft change${changedCount === 1 ? "" : "s"} for week ${input.draft.weekStart}. Applying updates this draft only; approval and publication remain separate.`
    : "No draft cells need changing. Existing schedule assignments already match this request.");
  const beforeAssignments = input.draft.assignments.map((assignment) => ({
    employeeId: assignment.employeeId,
    workDate: assignment.workDate,
    shiftId: assignment.shiftId,
    assignmentKind: assignment.assignmentKind as "WORK" | "DAY_OFF" | "UNASSIGNED" | "PROTECTED_LEAVE",
    reason: assignment.reason,
  }));
  const proposalAssignments = input.nextAssignments.map((assignment) => ({
    employeeId: assignment.employeeId,
    workDate: assignment.workDate,
    shiftId: assignment.shiftId,
    assignmentKind: assignment.assignmentKind as "WORK" | "DAY_OFF" | "UNASSIGNED" | "PROTECTED_LEAVE",
    reason: assignment.reason,
  }));
  const { interaction } = await makePendingOperation({
    conversationId: input.conversationId,
    userId: input.ownerUserId,
    draft: input.draft,
    sourceMessage: input.sourceMessage,
    intent: input.intent,
    targetEmployeeIds: input.targetEmployeeIds,
    status: "PROPOSAL",
    title: "Review proposed schedule changes",
    summary,
    assignments: proposalAssignments,
    beforeAssignments,
    changes,
    changeCount: changedCount,
    warnings,
    blockers,
    canApply: changedCount > 0 && blockers.length === 0,
    previousOperation: input.previousOperation,
  });
  return { message: interaction.summary, interaction };
};

type ScheduleInteractionActionResult = {
  message: string;
  interaction?: ScheduleInteraction;
  prefill?: string;
  activeDraftId: string | null;
};

const interactionWithStatus = (
  pending: PendingScheduleOperation,
  kind: ScheduleInteraction["kind"],
  summary: string,
  flags: { canApply?: boolean; canUndo?: boolean; canGoBack?: boolean } = {},
): ScheduleInteraction => ({
  ...(pending.interaction ?? { id: pending.id, kind, title: "Schedule operation", summary }),
  id: pending.id,
  kind,
  summary,
  ...flags,
});

const assertPendingOperationCurrent = async (
  pending: PendingScheduleOperation,
  userId: string,
  activeDraftId: string | null,
) => {
  if (isScheduleOperationExpired(pending.expiresAt)) {
    throw new ScheduleChatError("This schedule choice expired. Send request again to create a fresh preview.", 409);
  }
  if (activeDraftId !== pending.draftId) {
    throw new ScheduleChatError("Planner draft changed since this preview. Reopen current draft and review a fresh proposal.", 409);
  }
  const draft = await assertDraftForOwner(pending.draftId, userId);
  if (!matchesScheduleOperationDraftVersion({
    draftId: pending.draftId,
    version: pending.draftVersion,
    draftFingerprint: pending.draftFingerprint,
    sourceFingerprint: pending.sourceFingerprint,
  }, {
    draftId: draft.id,
    version: draft.version,
    draftFingerprint: draft.draftFingerprint,
    sourceFingerprint: draft.sourceFingerprint,
    isLatestVersion: draft.isLatestVersion,
    isSourceStale: draft.isSourceStale,
  })) {
    throw new ScheduleChatError("Schedule or live source changed since this preview. Review a fresh proposal before applying.", 409);
  }
  return draft;
};

const handleScheduleInteractionAction = async (input: {
  conversationId: string;
  userId: string;
  requestKey: string;
  activeDraftId: string | null;
  action: NonNullable<ChatRequest["interactionAction"]>;
  interactionId: string;
  optionIds: string[];
}): Promise<ScheduleInteractionActionResult> => {
  const conversation = await db.aiConversation.findFirst({
    where: { id: input.conversationId, userId: input.userId },
    select: { activeDraftId: true, pendingInteraction: true },
  });
  if (!conversation) throw new ScheduleChatError("Conversation not found.", 404);
  const pending = readPendingScheduleOperation(conversation.pendingInteraction);
  if (!pending || pending.id !== input.interactionId) {
    throw new ScheduleChatError("This schedule choice is no longer active. Refresh chat and review current draft.", 409);
  }
  const activeDraftId = conversation.activeDraftId ?? input.activeDraftId;
  const expired = isScheduleOperationExpired(pending.expiresAt);
  if (expired && input.action !== "cancel" && input.action !== "edit") {
    const interaction = interactionWithStatus(pending, "EXPIRED", "This preview expired. Send request again to prepare a fresh one.", { canApply: false, canUndo: false });
    await savePendingScheduleOperation(input.conversationId, input.userId, {
      ...pending,
      status: pending.status === "APPLIED" ? "APPLIED" : "CANCELLED",
      interaction,
    });
    return { message: interaction.summary, interaction, activeDraftId };
  }
  const markStale = async (message: string): Promise<ScheduleInteractionActionResult> => {
    const proposal = pending.status === "PROPOSAL";
    const kind: ScheduleInteraction["kind"] = proposal ? "PROPOSAL" : "EXPIRED";
    const interaction = {
      ...interactionWithStatus(pending, kind, message, { canApply: false, canUndo: false, canGoBack: false }),
      ...(proposal ? { blockers: Array.from(new Set([...(pending.blockers ?? []), message])) } : {}),
    };
    await savePendingScheduleOperation(input.conversationId, input.userId, {
      ...pending,
      status: proposal ? "PROPOSAL" : pending.status === "APPLIED" ? "APPLIED" : "CANCELLED",
      blockers: proposal ? interaction.blockers : pending.blockers,
      interaction,
    });
    return { message, interaction, activeDraftId };
  };
  const getCurrentDraftOrMarkStale = async (operation: PendingScheduleOperation) => {
    try {
      return { draft: await assertPendingOperationCurrent(operation, input.userId, activeDraftId) };
    } catch (error) {
      if ((error instanceof ScheduleChatError && error.status === 409) || error instanceof ScheduleDraftServiceError) {
        return { stale: await markStale(error.message) };
      }
      throw error;
    }
  };

  if (input.action === "edit") {
    await savePendingScheduleOperation(input.conversationId, input.userId, null);
    return {
      message: "Edit the request below, then send it for a new preview. No schedule cells changed.",
      prefill: pending.sourceMessage,
      activeDraftId,
    };
  }
  if (input.action === "back") {
    if (!pending.previous) throw new ScheduleChatError("There is no earlier scheduling question to return to.", 409);
    const current = await getCurrentDraftOrMarkStale(pending);
    if (current.stale) return current.stale;
    const previousCurrent = await getCurrentDraftOrMarkStale(pending.previous);
    if (previousCurrent.stale) return previousCurrent.stale;
    const previous = { ...pending.previous, previous: undefined };
    await savePendingScheduleOperation(input.conversationId, input.userId, previous);
    return {
      message: previous.interaction?.summary ?? "Returned to previous scheduling question.",
      interaction: previous.interaction,
      activeDraftId,
    };
  }
  if (input.action === "cancel") {
    const interaction = interactionWithStatus(pending, "CANCELLED", "Cancelled. No draft changes were applied.", { canApply: false, canUndo: false });
    await savePendingScheduleOperation(input.conversationId, input.userId, { ...pending, status: "CANCELLED", interaction });
    await writeChatAudit({
      userId: input.userId,
      conversationId: input.conversationId,
      action: "AI_SCHEDULE_OPERATION_CANCELLED",
      outcome: "CANCELLED",
      metadata: { draftId: pending.draftId, draftVersion: pending.draftVersion, operationId: pending.id },
    });
    return { message: interaction.summary, interaction, activeDraftId };
  }

  if (input.action === "select") {
    if (pending.status !== "CLARIFICATION" || !pending.choices?.length) {
      throw new ScheduleChatError("This clarification is no longer waiting for a choice.", 409);
    }
    const current = await getCurrentDraftOrMarkStale(pending);
    if (current.stale) return current.stale;
    const draft = current.draft!;
    const selected = input.optionIds.map((id) => pending.choices!.find((choice) => choice.id === id));
    if (!isValidScheduleOperationSelection({
      availableOptionIds: pending.choices.map((choice) => choice.id),
      selectedOptionIds: input.optionIds,
      selectionMode: pending.selectionMode ?? "single",
    }) || selected.some((choice) => !choice)) {
      throw new ScheduleChatError("Choose from the options shown in this clarification.");
    }
    const values = selected.map((choice) => choice!.value);
    const kinds = new Set(values.map((value) => value.kind));
    if (kinds.size !== 1) throw new ScheduleChatError("Selected options must belong to one choice group.");
    const kind = values[0].kind;
    let intent = scheduleOperationIntentSchema.parse(pending.intent);
    let fixedTargetEmployeeIds: string[] | undefined = pending.targetEmployeeIds.length ? pending.targetEmployeeIds : undefined;
    const updateAction = (actionIndex: number, update: Partial<ScheduleOperationIntent["actions"][number]>) => {
      if (!Number.isInteger(actionIndex) || actionIndex < 0 || actionIndex >= intent.actions.length) {
        throw new ScheduleChatError("Scheduling action choice is invalid.");
      }
      const actions = [...intent.actions];
      actions[actionIndex] = { ...actions[actionIndex], ...update };
      intent = { ...intent, actions };
    };
    if (kind === "DATE") {
      if (values.some((value) => typeof value.date !== "string")) throw new ScheduleChatError("Date choice is invalid.");
      const dates = values.map((value) => value.date as string);
      if (intent.operation === "SWAP_SHIFTS") {
        if (dates.length > 2) throw new ScheduleChatError("Choose one date for same-day swap, or two dates for different days.");
        intent = { ...intent, workDates: dates, sourceDate: dates[0] ?? null, targetDate: dates[1] ?? dates[0] ?? null, usePlannerWeek: false, dateSelectionMode: "UNRESOLVED" };
      } else {
        intent = { ...intent, workDates: dates, usePlannerWeek: false, dateSelectionMode: "UNRESOLVED" };
      }
    } else if (kind === "DATE_SCOPE") {
      if (values.length !== 1 || typeof values[0].scope !== "string") throw new ScheduleChatError("Date-range choice is invalid.");
      const scope = values[0].scope as string;
      if (scope === "WEEK") intent = { ...intent, workDates: [], usePlannerWeek: true, dateSelectionMode: "UNRESOLVED" };
      else if (scope === "WEEKDAYS") intent = { ...intent, workDates: weekDatesFor(draft.weekStart).slice(0, 5), usePlannerWeek: false, dateSelectionMode: "UNRESOLVED" };
      else if (scope === "PICK_DAYS") intent = { ...intent, workDates: [], usePlannerWeek: false, dateSelectionMode: "PICK_DAYS" };
      else throw new ScheduleChatError("Date-range choice is invalid.");
    } else if (kind === "ACTION_DATE") {
      if (values.some((value) => typeof value.date !== "string" || typeof value.actionIndex !== "number") ||
        new Set(values.map((value) => value.actionIndex)).size !== 1) {
        throw new ScheduleChatError("Date choices must belong to one scheduling action.");
      }
      const actionIndex = values[0].actionIndex as number;
      const dates = values.map((value) => value.date as string);
      updateAction(actionIndex, { workDates: dates, usePlannerWeek: false, dateSelectionMode: "UNRESOLVED" });
    } else if (kind === "ACTION_DATE_SCOPE") {
      if (values.length !== 1 || typeof values[0].actionIndex !== "number" || typeof values[0].scope !== "string") {
        throw new ScheduleChatError("Date-range choice is invalid.");
      }
      const actionIndex = values[0].actionIndex as number;
      const scope = values[0].scope as string;
      if (scope === "WEEK") updateAction(actionIndex, { usePlannerWeek: true, workDates: [], dateSelectionMode: "UNRESOLVED" });
      else if (scope === "WEEKDAYS") updateAction(actionIndex, { usePlannerWeek: false, workDates: weekDatesFor(draft.weekStart).slice(0, 5), dateSelectionMode: "UNRESOLVED" });
      else if (scope === "PICK_DAYS") updateAction(actionIndex, { usePlannerWeek: false, workDates: [], dateSelectionMode: "PICK_DAYS" });
      else throw new ScheduleChatError("Date-range choice is invalid.");
    } else if (kind === "ACTION_SHIFT") {
      if (values.length !== 1 || typeof values[0].shiftCode !== "string" || typeof values[0].actionIndex !== "number") {
        throw new ScheduleChatError("Shift choice is invalid.");
      }
      updateAction(values[0].actionIndex as number, { shiftRef: values[0].shiftCode });
    } else if (kind === "ACTION_EMPLOYEE") {
      if (values.length !== 1 || typeof values[0].actionIndex !== "number" ||
        typeof values[0].queryIndex !== "number" || typeof values[0].employeeCode !== "string") {
        throw new ScheduleChatError("Employee choice is invalid.");
      }
      const actionIndex = values[0].actionIndex as number;
      const queryIndex = values[0].queryIndex as number;
      const action = intent.actions[actionIndex];
      if (!action || queryIndex < 0 || (action.targetEmployeeQueries.length > 0 && queryIndex >= action.targetEmployeeQueries.length)) {
        throw new ScheduleChatError("Employee choice no longer matches this action.", 409);
      }
      if (action.targetEmployeeQueries.length > 0) {
        const queries = [...action.targetEmployeeQueries];
        queries[queryIndex] = values[0].employeeCode as string;
        updateAction(actionIndex, { targetType: "EMPLOYEE", targetEmployeeQueries: queries });
      } else if (queryIndex === 0) {
        updateAction(actionIndex, { targetType: "EMPLOYEE", targetQuery: values[0].employeeCode as string });
      } else {
        throw new ScheduleChatError("Employee choice no longer matches this action.", 409);
      }
    } else if (kind === "ACTION_GROUP") {
      if (values.length !== 1 || typeof values[0].actionIndex !== "number" ||
        !["POSITION", "DEPARTMENT"].includes(String(values[0].targetType)) || typeof values[0].groupName !== "string") {
        throw new ScheduleChatError("Group choice is invalid.");
      }
      updateAction(values[0].actionIndex as number, {
        targetType: values[0].targetType as "POSITION" | "DEPARTMENT",
        targetQuery: values[0].groupName as string,
      });
    } else if (kind === "ACTION_EXCLUDED_EMPLOYEE") {
      if (values.length !== 1 || typeof values[0].actionIndex !== "number" ||
        typeof values[0].employeeCode !== "string" || typeof values[0].exclusionQuery !== "string") {
        throw new ScheduleChatError("Employee exclusion choice is invalid.");
      }
      const actionIndex = values[0].actionIndex as number;
      const action = intent.actions[actionIndex];
      if (!action) throw new ScheduleChatError("Employee exclusion choice no longer matches this action.", 409);
      updateAction(actionIndex, {
        excludeTargetQueries: action.excludeTargetQueries.map((query) => query === values[0].exclusionQuery ? values[0].employeeCode as string : query),
      });
    } else if (kind === "SHIFT") {
      if (values.length !== 1 || typeof values[0].shiftCode !== "string") throw new ScheduleChatError("Shift choice is invalid.");
      intent = { ...intent, shiftRef: values[0].shiftCode };
    } else if (kind === "EMPLOYEE") {
      if (values.length !== 1 || typeof values[0].employeeId !== "string" || typeof values[0].employeeCode !== "string") {
        throw new ScheduleChatError("Employee choice is invalid.");
      }
      if (typeof values[0].queryIndex === "number" && intent.targetEmployeeQueries.length) {
        const queries = [...intent.targetEmployeeQueries];
        queries[values[0].queryIndex] = values[0].employeeCode;
        intent = { ...intent, targetType: "EMPLOYEE", targetEmployeeQueries: queries };
        fixedTargetEmployeeIds = undefined;
      } else {
        intent = { ...intent, targetType: "EMPLOYEE", targetQuery: values[0].employeeCode };
        fixedTargetEmployeeIds = [values[0].employeeId];
      }
    } else if (kind === "POSITION" || kind === "DEPARTMENT") {
      if (values.length !== 1) throw new ScheduleChatError("Choose one target group.");
      const groupId = kind === "POSITION" ? values[0].positionId : values[0].departmentId;
      if (typeof groupId !== "string") throw new ScheduleChatError("Target group choice is invalid.");
      const employees = await db.employee.findMany({
        where: {
          employeeId: { in: draft.scope.employeeIds },
          isArchived: false,
          currentStatus: { notIn: [CURRENT_STATUS.INACTIVE, CURRENT_STATUS.ENDED] },
          ...(kind === "POSITION" ? { positionId: groupId } : { departmentId: groupId }),
        },
        select: { employeeId: true, position: { select: { isActive: true } }, department: { select: { isActive: true } } },
      });
      fixedTargetEmployeeIds = employees
        .filter((employee) => employee.position?.isActive !== false && employee.department?.isActive !== false)
        .map((employee) => employee.employeeId);
      intent = {
        ...intent,
        targetType: kind,
        targetQuery: typeof values[0].groupName === "string" ? values[0].groupName : intent.targetQuery,
      };
    } else if (kind === "EXCLUDED_EMPLOYEE") {
      if (values.length !== 1 || typeof values[0].employeeCode !== "string" || typeof values[0].exclusionQuery !== "string") {
        throw new ScheduleChatError("Employee exclusion choice is invalid.");
      }
      intent = {
        ...intent,
        excludeTargetQueries: intent.excludeTargetQueries.map((query) => query === values[0].exclusionQuery ? values[0].employeeCode as string : query),
      };
    } else if (kind === "SWAP_SOURCE" || kind === "SWAP_TARGET") {
      if (values.length !== 1 || typeof values[0].employeeCode !== "string") throw new ScheduleChatError("Swap employee choice is invalid.");
      intent = kind === "SWAP_SOURCE"
        ? { ...intent, sourceEmployeeQuery: values[0].employeeCode }
        : { ...intent, targetEmployeeQuery: values[0].employeeCode };
      fixedTargetEmployeeIds = undefined;
    } else {
      throw new ScheduleChatError("This clarification type is not supported.");
    }
    const result = await prepareScheduleOperation({
      conversationId: input.conversationId,
      ownerUserId: input.userId,
      requestKey: input.requestKey,
      draftId: draft.id,
      sourceMessage: pending.sourceMessage,
      intent,
      ...(fixedTargetEmployeeIds ? { fixedTargetEmployeeIds } : {}),
      previousOperation: pending,
    });
    return { message: result.message, interaction: result.interaction ?? undefined, activeDraftId: draft.id };
  }

  if (input.action === "apply") {
    if (!canApplyScheduleOperation({
      status: pending.status,
      canApply: pending.interaction?.canApply === true,
      hasAssignments: Boolean(pending.assignments),
      expiresAt: pending.expiresAt,
    })) {
      throw new ScheduleChatError("This proposal is not ready to apply. Review blockers and prepare a new proposal.", 409);
    }
    const proposalAssignments = pending.assignments;
    if (!proposalAssignments) throw new ScheduleChatError("This proposal has no saved assignments.", 409);
    const current = await getCurrentDraftOrMarkStale(pending);
    if (current.stale) return current.stale;
    const draft = current.draft!;
    const validation = await validateScheduleDraftCandidate({
      draftId: draft.id,
      ownerUserId: input.userId,
      assignments: proposalAssignments.map((assignment) => ({
        ...assignment,
        isProtected: draft.assignments.find((current) => current.employeeId === assignment.employeeId && current.workDate === assignment.workDate)?.isProtected ?? false,
        hasBaselineOverride: draft.assignments.find((current) => current.employeeId === assignment.employeeId && current.workDate === assignment.workDate)?.hasBaselineOverride ?? false,
        baselineOverrideShiftId: draft.assignments.find((current) => current.employeeId === assignment.employeeId && current.workDate === assignment.workDate)?.baselineOverrideShiftId ?? null,
      })),
    });
    if (validation.introducedBlockers.length > 0 || validation.sourceStale) {
      const blockers = [
        ...validation.introducedBlockers.map((issue) => issue.message),
        ...(validation.sourceStale ? ["Live schedule, overrides, or approved leave changed since preview."] : []),
      ];
      const interaction = { ...interactionWithStatus(pending, "PROPOSAL", "Proposal now has blockers. Refresh draft and review a new preview.", { canApply: false }), blockers };
      await savePendingScheduleOperation(input.conversationId, input.userId, { ...pending, blockers, interaction });
      return { message: interaction.summary, interaction, activeDraftId: draft.id };
    }
    let saved: Awaited<ReturnType<typeof saveScheduleDraftVersion>>;
    try {
      saved = await saveScheduleDraftVersion({
        requestKey: requestIdempotencyKey(input.requestKey, `operation:${pending.id}:apply`),
        draftId: draft.id,
        ownerUserId: input.userId,
        changeSource: "AI",
        expectedVersion: pending.draftVersion,
        expectedDraftFingerprint: pending.draftFingerprint,
        expectedSourceFingerprint: pending.sourceFingerprint,
        assignments: proposalAssignments,
      });
    } catch (error) {
      if (error instanceof ScheduleDraftServiceError) return markStale(error.message);
      throw error;
    }
    const interaction = {
      ...interactionWithStatus(pending, "APPLIED", `Applied ${pending.changes?.length ?? 0} reviewed change(s) to draft version ${saved.version}. Live schedule unchanged; approval and publication remain separate.`, { canApply: false, canUndo: true }),
    };
    const applied: PendingScheduleOperation = {
      ...pending,
      draftId: saved.id,
      draftVersion: saved.version,
      draftFingerprint: saved.draftFingerprint,
      sourceFingerprint: saved.sourceFingerprint,
      status: "APPLIED",
      appliedDraftId: saved.id,
      appliedDraftVersion: saved.version,
      appliedDraftFingerprint: saved.draftFingerprint,
      interaction,
    };
    await savePendingScheduleOperation(input.conversationId, input.userId, applied, saved.id);
    await writeChatAudit({
      userId: input.userId,
      conversationId: input.conversationId,
      action: "AI_SCHEDULE_OPERATION_APPLIED",
      outcome: "SUCCEEDED",
      metadata: {
        draftId: saved.id,
        draftVersion: saved.version,
        changeCount: pending.changes?.length ?? 0,
        operationId: pending.id,
        reason: pending.sourceMessage,
      },
    });
    return { message: interaction.summary, interaction, activeDraftId: saved.id };
  }

  if (input.action === "undo") {
    if (pending.status !== "APPLIED" || pending.interaction?.canUndo !== true || !pending.beforeAssignments) {
      throw new ScheduleChatError("No recent AI draft change can be undone from this chat.", 409);
    }
    const current = await getCurrentDraftOrMarkStale(pending);
    if (current.stale) return current.stale;
    const draft = current.draft!;
    if (draft.id !== pending.appliedDraftId || draft.version !== pending.appliedDraftVersion || draft.draftFingerprint !== pending.appliedDraftFingerprint) {
      throw new ScheduleChatError("Draft changed after this AI change. Undo is no longer safe; review current draft manually.", 409);
    }
    let reverted: Awaited<ReturnType<typeof saveScheduleDraftVersion>>;
    try {
      reverted = await saveScheduleDraftVersion({
        requestKey: requestIdempotencyKey(input.requestKey, `operation:${pending.id}:undo`),
        draftId: draft.id,
        ownerUserId: input.userId,
        changeSource: "AI",
        expectedVersion: draft.version,
        expectedDraftFingerprint: draft.draftFingerprint,
        expectedSourceFingerprint: draft.sourceFingerprint,
        assignments: pending.beforeAssignments,
      });
    } catch (error) {
      if (error instanceof ScheduleDraftServiceError) return markStale(error.message);
      throw error;
    }
    const interaction = interactionWithStatus(pending, "UNDONE", `Undid AI changes by creating draft version ${reverted.version}. Live schedule unchanged.`, { canApply: false, canUndo: false });
    await savePendingScheduleOperation(input.conversationId, input.userId, {
      ...pending,
      draftId: reverted.id,
      draftVersion: reverted.version,
      draftFingerprint: reverted.draftFingerprint,
      sourceFingerprint: reverted.sourceFingerprint,
      status: "UNDONE",
      interaction,
    }, reverted.id);
    await writeChatAudit({
      userId: input.userId,
      conversationId: input.conversationId,
      action: "AI_SCHEDULE_OPERATION_UNDONE",
      outcome: "SUCCEEDED",
      metadata: { draftId: reverted.id, draftVersion: reverted.version, operationId: pending.id },
    });
    return { message: interaction.summary, interaction, activeDraftId: reverted.id };
  }

  throw new ScheduleChatError("Unsupported schedule interaction action.");
};

const runBulkShiftChatAction = async (input: {
  userId: string;
  conversationId: string;
  requestKey: string;
  draftId: string | null;
  message: string;
  action?: ChatRequest["bulkAction"];
  expectedDraftVersion?: number;
}) => {
  if (input.action === "cancel") {
    return { message: "Cancelled. No draft cells changed; live schedule remains unchanged.", activeDraftId: input.draftId, quickActions: [] as BulkQuickAction[] };
  }
  if (!input.draftId) {
    return { message: "Select or create a schedule draft first. Then I can prepare a shift assignment for its employees.", activeDraftId: null, quickActions: [] as BulkQuickAction[] };
  }
  if (!isExplicitBulkScheduleRequest(input.message)) {
    return { message: "I could not verify an all-employee shift request. No draft cells changed.", activeDraftId: input.draftId, quickActions: [] as BulkQuickAction[] };
  }

  const draft = await assertDraftForOwner(input.draftId, input.userId);
  if (input.action === "confirm" && input.expectedDraftVersion !== draft.version) {
    return {
      message: "Draft changed after this review. No cells were changed. Send the request again to review the latest draft.",
      activeDraftId: draft.id,
      quickActions: [] as BulkQuickAction[],
    };
  }
  const shifts = await db.shift.findMany({
    where: { isActive: true },
    orderBy: [{ startMinutes: "asc" }, { code: "asc" }],
    select: { id: true, code: true, name: true, isDayOff: true },
  });
  const shiftMatch = extractShiftReferenceFromMessage(input.message, shifts);
  if (shiftMatch.status === "ambiguous") {
    return { message: "That shift reference matches more than one active shift. Use one of the shift buttons below to choose exactly.", activeDraftId: draft.id, quickActions: [] as BulkQuickAction[] };
  }
  if (shiftMatch.status !== "resolved") {
    const codes = shifts.map((shift) => `${shift.code} · ${shift.name}`).join(", ");
    return { message: `I could not match that shift to an active shift code/name. Choose a shift below. Available: ${codes || "none"}.`, activeDraftId: draft.id, quickActions: [] as BulkQuickAction[] };
  }
  const shift = shiftMatch.shift;
  if (shift.isDayOff) {
    return { message: `Shift ${shift.code} is a day-off shift. Bulk assignment supports working shifts; no draft cells changed.`, activeDraftId: draft.id, quickActions: [] as BulkQuickAction[] };
  }

  const weekDates = getWeekDates(parseWeekStartInput(draft.weekStart) ?? new Date()).map(({ date }) => toPlannerDateKey(date));
  const requestedDates = input.action === "all_week"
    ? weekDates
    : resolveExplicitBulkScheduleDates(input.message, draft.weekStart, toPlannerDateKey(new Date()));
  if (!requestedDates) {
    if (needsBulkScheduleDateClarification(input.message)) {
      const allWeekMessage = `${input.message} for the whole week`;
      return {
        message: `I found shift ${shift.code} · ${shift.name} and ${draft.scope.employeeIds.length} employees in this draft. Choose date scope before I prepare the change.`,
        activeDraftId: draft.id,
        quickActions: [
          { id: "all_week", label: "Use all 7 days", bulkAction: "all_week", sourceMessage: allWeekMessage },
          { id: "choose_dates", label: "Choose days", prefill: `Set all employees to shift ${shift.code} on ` },
        ],
      };
    }
    return {
      message: "Use weekday names in the selected week or an exact date like 2026-10-23. I could not safely map that date request; no draft cells changed.",
      activeDraftId: draft.id,
      quickActions: [] as BulkQuickAction[],
    };
  }
  const uniqueDates = Array.from(new Set(requestedDates)).sort();
  const draftDates = new Set(draft.assignments.map((assignment) => assignment.workDate));
  const outsideDates = uniqueDates.filter((date) => !draftDates.has(date));
  if (outsideDates.length) {
    return {
      message: `${outsideDates.join(", ")} falls outside the active draft week (${draft.weekStart}). No draft cells changed.`,
      activeDraftId: draft.id,
      quickActions: [] as BulkQuickAction[],
    };
  }
  const targets = draft.assignments.filter((assignment) => uniqueDates.includes(assignment.workDate));
  const expectedTargetCount = draft.scope.employeeIds.length * uniqueDates.length;
  if (targets.length !== expectedTargetCount) {
    return { message: "Draft is missing requested employee/day cells. No draft cells changed.", activeDraftId: draft.id, quickActions: [] as BulkQuickAction[] };
  }
  if (targets.some((assignment) => assignment.isProtected || assignment.hasBaselineOverride)) {
    return { message: "At least one requested cell has protected leave or a schedule override. I stopped the entire change; no draft cells changed.", activeDraftId: draft.id, quickActions: [] as BulkQuickAction[] };
  }
  const changedCellCount = targets.filter((assignment) => assignment.shiftId !== shift.id || assignment.assignmentKind !== "WORK").length;
  if (changedCellCount === 0) {
    return { message: `All ${targets.length} requested cells already use shift ${shift.code}. No new draft version was created.`, activeDraftId: draft.id, quickActions: [] as BulkQuickAction[] };
  }

  if (input.action !== "confirm") {
    const actionSourceMessage = input.action === "all_week" && !/\b(?:whole|entire|all)\s+week\b/i.test(input.message)
      ? `${input.message} for the whole week`
      : input.message;
    return {
      message: `Review: shift ${shift.code} · ${shift.name} for ${draft.scope.employeeIds.length} employees on ${uniqueDates.join(", ")}. This will change ${changedCellCount} cells in draft version ${draft.version}. Apply to draft? Live schedule will not change.`,
      activeDraftId: draft.id,
      quickActions: [
        { id: "confirm", label: `Apply ${changedCellCount} draft changes`, bulkAction: "confirm", sourceMessage: actionSourceMessage, expectedDraftVersion: draft.version },
        { id: "cancel", label: "Cancel", bulkAction: "cancel", sourceMessage: actionSourceMessage },
      ],
    };
  }

  const result = await executeTool({
    name: "assign_shift_to_draft_scope",
    arguments: JSON.stringify({ draftId: draft.id, shiftRef: shift.code, workDates: uniqueDates }),
    ownerUserId: input.userId,
    conversationId: input.conversationId,
    requestKey: input.requestKey,
    round: 0,
    toolIndex: 0,
    departmentId: null,
    selectedEmployeeIds: [],
    userMessage: input.message,
    confirmedEmployeeIds: new Set(),
    selectionState: { current: null },
  });
  if (result && typeof result === "object" && "ok" in result && result.ok === false) {
    const reason = "error" in result && typeof result.error === "string" ? result.error : "Action rejected.";
    return { message: `${reason} No bulk draft change was saved.`, activeDraftId: draft.id, quickActions: [] as BulkQuickAction[] };
  }
  const changed = result && typeof result === "object" && "changedCellCount" in result && typeof result.changedCellCount === "number"
    ? result.changedCellCount
    : changedCellCount;
  const version = result && typeof result === "object" && "version" in result && typeof result.version === "number"
    ? result.version
    : draft.version;
  const nextDraftId = result && typeof result === "object" && "draftId" in result && typeof result.draftId === "string"
    ? result.draftId
    : draft.id;
  return {
    message: `Applied shift ${shift.code} · ${shift.name} to ${draft.scope.employeeIds.length} employees on ${uniqueDates.join(", ")}: ${changed} cells saved to draft version ${version}. Live schedule unchanged.`,
    activeDraftId: nextDraftId,
    quickActions: [] as BulkQuickAction[],
  };
};

export async function submitScheduleChat(input: ChatRequest & { userId: string }) {
  ensureChatEnabled();
  const userMessage = redactSensitiveText(input.message);
  const bulkSourceMessage = input.bulkSourceMessage ? redactSensitiveText(input.bulkSourceMessage) : userMessage;
  const isBulkAction = Boolean(input.bulkAction);
  const provider = isBulkAction || input.interactionAction ? null : getProviderConfig();
  const existingConversation = input.conversationId
    ? await db.aiConversation.findFirst({
        where: { id: input.conversationId, userId: input.userId },
        select: { activeDraftId: true },
      })
    : null;
  if (input.conversationId && !existingConversation) throw new ScheduleChatError("Conversation not found.", 404);
  const selectedDraftId = input.draftId ?? existingConversation?.activeDraftId ?? null;
  if (selectedDraftId) await assertDraftForOwner(selectedDraftId, input.userId);
  const reserved = await reserveUserMessage({ ...input, message: userMessage });
  if (reserved.replay) return {
    conversationId: reserved.conversation.id,
    activeDraftId: reserved.conversation.activeDraftId,
    message: reserved.reply.content,
    status: "complete" as const,
    replayed: true,
  };

  const { conversation } = reserved;
  if (input.interactionAction) {
    await ensureToolActor(input.userId);
    try {
      const result = await handleScheduleInteractionAction({
        conversationId: conversation.id,
        userId: input.userId,
        requestKey: input.requestKey,
        activeDraftId: conversation.activeDraftId,
        action: input.interactionAction,
        interactionId: input.interactionId!,
        optionIds: input.optionIds ?? [],
      });
      await appendMessages(conversation.id, input.userId, [{
        role: AiMessageRole.ASSISTANT,
        content: result.message,
        replyToRequestKey: input.requestKey,
      }]);
      return {
        conversationId: conversation.id,
        activeDraftId: result.activeDraftId,
        message: result.message,
        interaction: result.interaction,
        prefill: result.prefill,
        status: "complete" as const,
        replayed: false,
      };
    } catch (error) {
      if (error instanceof ScheduleChatError) {
        await appendMessages(conversation.id, input.userId, [{
          role: AiMessageRole.ASSISTANT,
          content: error.message,
          replyToRequestKey: input.requestKey,
        }]);
      }
      throw error;
    }
  }
  const activeDraft = conversation.activeDraftId
    ? await assertDraftForOwner(conversation.activeDraftId, input.userId)
    : null;
  if (isBulkAction) {
    const actionStartedAt = Date.now();
    const bulkResult = await runBulkShiftChatAction({
      userId: input.userId,
      conversationId: conversation.id,
      requestKey: input.requestKey,
      draftId: conversation.activeDraftId,
      message: bulkSourceMessage,
      action: input.bulkAction,
      expectedDraftVersion: input.bulkExpectedDraftVersion,
    });
    await appendMessages(conversation.id, input.userId, [{
      role: AiMessageRole.ASSISTANT,
      content: bulkResult.message,
      replyToRequestKey: input.requestKey,
    }]);
    await writeChatAudit({
      userId: input.userId,
      conversationId: conversation.id,
      action: "AI_CHAT_COMPLETED",
      outcome: input.bulkAction === "confirm" ? "SUCCEEDED" : input.bulkAction === "cancel" ? "CANCELLED" : "NEEDS_CONFIRMATION",
      metadata: {
        model: "policy",
        elapsedMs: Date.now() - actionStartedAt,
        promptTokens: 0,
        completionTokens: 0,
        toolCalls: input.bulkAction === "confirm" ? 1 : 0,
        requestKeyHash: createHash("sha256").update(input.requestKey).digest("hex").slice(0, 16),
      },
    });
    const latestConversation = await db.aiConversation.findFirst({
      where: { id: conversation.id, userId: input.userId },
      select: { activeDraftId: true },
    });
    return {
      conversationId: conversation.id,
      activeDraftId: latestConversation?.activeDraftId ?? bulkResult.activeDraftId,
      message: bulkResult.message,
      quickActions: bulkResult.quickActions,
      status: "complete" as const,
      replayed: false,
    };
  }

  const activeProvider = provider ?? getProviderConfig();
  const previousPending = readPendingSelection(conversation.pendingInteraction);
  const confirmedEmployeeIds = new Set<string>();
  const selectionState = { current: previousPending };
  if (previousPending) {
    const selectedId = resolveExplicitEmployeeSelection(userMessage, previousPending.candidates);
    if (selectedId) {
      confirmedEmployeeIds.add(selectedId);
      await savePendingSelection(conversation.id, input.userId, null);
    }
  }

  const history = await db.aiMessage.findMany({
    where: { conversationId: conversation.id },
    orderBy: { sequence: "desc" },
    take: MAX_CHAT_HISTORY_MESSAGES,
    select: { role: true, content: true, toolName: true, toolCallId: true },
  });
  const messages: ProviderMessage[] = [
    {
      role: "system",
      content: buildSchedulingChatSystemPrompt(toPlannerDateKey(new Date()), {
        weekStart: input.weekStart ?? activeDraft?.weekStart ?? null,
        referenceWeekStart: input.referenceWeekStart ?? null,
        scope: {
          departmentId: input.departmentId,
          selectedEmployeeCount: input.selectedEmployeeIds?.length ?? 0,
        },
        activeDraft: activeDraft ? {
          id: activeDraft.id,
          version: activeDraft.version,
          status: activeDraft.status,
          isSourceStale: activeDraft.isSourceStale,
        } : null,
        pendingOperationSummary: (() => {
          const pending = readPendingScheduleOperation(conversation.pendingInteraction);
          return pending && !["CANCELLED", "UNDONE"].includes(pending.status)
            ? `${pending.intent.operation} for ${pending.intent.targetQuery ?? pending.intent.targetType}; ${pending.interaction?.summary ?? pending.status}`
            : null;
        })(),
        pendingOperationDetails: (() => {
          const pending = readPendingScheduleOperation(conversation.pendingInteraction);
          return pending && ["CLARIFICATION", "PROPOSAL"].includes(pending.status)
            ? JSON.stringify({ status: pending.status, intent: pending.intent }).slice(0, 4_000)
            : null;
        })(),
      }),
    },
    ...providerHistory(history),
  ];
  let promptTokens = 0;
  let completionTokens = 0;
  let totalToolCalls = 0;
  let completedToolRound = false;
  let executedTool = false;
  let lastToolFeedback = "";
  const startedAt = Date.now();
  let finalMessage = "";
  let finalInteraction: ScheduleInteraction | null = null;
  let responseStatus: "complete" | "provider_unavailable" = "complete";

  try {
    for (let round = 0; round < MAX_CHAT_TOOL_ROUNDS; round += 1) {
      await ensureToolActor(input.userId);
      const availableBudget = getCompletionBudget(MAX_CHAT_COMPLETION_TOKENS, completionTokens, MAX_CHAT_FINAL_RESPONSE_TOKENS);
      if (availableBudget.toolTokens <= 0) break;
      let completion: Awaited<ReturnType<typeof callOpenRouter>> | null = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const attemptBudget = getCompletionBudget(MAX_CHAT_COMPLETION_TOKENS, completionTokens, MAX_CHAT_FINAL_RESPONSE_TOKENS).toolTokens;
        if (attemptBudget <= 0) break;
        let requestMessages = messages;
        if (attempt === 1) {
          requestMessages = [...messages];
          const systemMessage = requestMessages[0];
          if (systemMessage?.role === "system" && typeof systemMessage.content === "string") {
            requestMessages[0] = {
              ...systemMessage,
              content: `${systemMessage.content}\n\nThe previous provider response was empty, truncated, or invalid. Retry once with one complete native function call that matches its schema, or return a concise actionable clarification. Do not invent database entities.`,
            };
          }
        }
        completion = await callOpenRouter({
          ...activeProvider,
          messages: requestMessages,
          maxTokens: attempt === 0 ? Math.min(attemptBudget, MAX_CHAT_INITIAL_TOOL_TOKENS) : attemptBudget,
        });
        promptTokens += completion.usage.promptTokens;
        completionTokens += completion.usage.completionTokens || completion.estimatedCompletionTokens;
        if (!completion.incomplete || executedTool || attempt === 1) break;
      }
      if (!completion) {
        responseStatus = "provider_unavailable";
        finalMessage = "I ran out of response budget before receiving a complete scheduling answer. No schedule operation ran. Use the planner choices or try a shorter request.";
        break;
      }
      if (completion.incomplete) {
        responseStatus = "provider_unavailable";
        finalMessage = completion.diagnostics.responseMode.includes("invalid") || completion.diagnostics.responseMode.includes("rejected")
          ? "OpenRouter returned an invalid scheduling-action format twice. No schedule operation ran. Try a shorter request or use the clickable planner choices."
          : completion.finishReason === "length"
            ? "OpenRouter stopped at its output limit before returning a complete scheduling action. No schedule operation ran; shorten the request or use the clickable planner choices."
            : "OpenRouter returned an empty or incomplete answer twice. No schedule operation ran; use the clickable planner choices or retry once the provider is available.";
        break;
      }
      if (completion.calls.length === 0) {
        finalMessage = completion.content.trim();
        if (!finalMessage) {
          responseStatus = "provider_unavailable";
          finalMessage = "OpenRouter returned no answer. No scheduling operation ran. Use the clickable planner choices or retry once the provider is available.";
        }
        break;
      }

      completedToolRound = true;
      const assistantAndToolMessages: StoredMessageInput[] = [];
      const toolResultMessages: StoredMessageInput[] = [];
      const providerToolResults: ProviderMessage[] = [];
      for (let toolIndex = 0; toolIndex < completion.calls.length; toolIndex += 1) {
        const call = completion.calls[toolIndex];
        totalToolCalls += 1;
        executedTool = true;
        const output = await executeTool({
          ...call,
          ownerUserId: input.userId,
          conversationId: conversation.id,
          requestKey: input.requestKey,
          round,
          toolIndex,
          departmentId: input.departmentId ?? null,
          selectedEmployeeIds: input.selectedEmployeeIds ?? [],
          userMessage,
          confirmedEmployeeIds,
          selectionState,
        });
        assistantAndToolMessages.push({ role: AiMessageRole.ASSISTANT, content: call.arguments, toolName: call.name, toolCallId: call.id });
        toolResultMessages.push({ role: AiMessageRole.TOOL, content: compact(output), toolName: call.name, toolCallId: call.id });
        providerToolResults.push({ role: "tool", tool_call_id: call.id, content: compact(output) });
        if (output && typeof output === "object") {
          const record = output as Record<string, unknown>;
          if (typeof record.message === "string") lastToolFeedback = record.message;
          else if (typeof record.error === "string") lastToolFeedback = record.error;
        }
        if (call.name === "propose_schedule_operation" && output && typeof output === "object") {
          const operationOutput = output as { message?: unknown; interaction?: unknown };
          if (typeof operationOutput.message === "string") finalMessage = operationOutput.message;
          if (operationOutput.interaction && typeof operationOutput.interaction === "object") {
            finalInteraction = operationOutput.interaction as ScheduleInteraction;
          }
        }
      }
      await appendMessages(conversation.id, input.userId, [...assistantAndToolMessages, ...toolResultMessages]);
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: completion.calls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.name, arguments: call.arguments },
        })),
      }, ...providerToolResults);
      if (finalInteraction) break;
    }

    if (!finalMessage && completedToolRound) {
      await ensureToolActor(input.userId);
      const summaryBudget = getCompletionBudget(MAX_CHAT_COMPLETION_TOKENS, completionTokens, MAX_CHAT_FINAL_RESPONSE_TOKENS).finalTokens;
      if (summaryBudget <= 0) {
        responseStatus = "provider_unavailable";
        finalMessage = lastToolFeedback
          ? `Scheduling step completed: ${lastToolFeedback} I ran out of response budget before summarizing; review the draft before retrying. Live schedule unchanged.`
          : "The scheduling steps completed, but the response budget ran out before I could summarize them. Review the draft before retrying; live schedule unchanged.";
      } else {
        const finalMessages = [...messages];
        const systemMessage = finalMessages[0];
        if (systemMessage?.role === "system" && typeof systemMessage.content === "string") {
          finalMessages[0] = {
            ...systemMessage,
            content: `${systemMessage.content}\n\nThe tool-call budget is complete. Do not request or execute more tools. Summarize only confirmed tool results. If a tool result asks the manager to choose or provide missing information, ask that one question. Never say a draft change succeeded unless a tool result confirms it.`,
          };
        }
        const completion = await callOpenRouter({
          ...activeProvider,
          messages: finalMessages,
          maxTokens: summaryBudget,
          allowToolCalls: false,
        });
        promptTokens += completion.usage.promptTokens;
        completionTokens += completion.usage.completionTokens || completion.estimatedCompletionTokens;
        if (completion.calls.length > 0 || completion.incomplete || !completion.content.trim()) {
          responseStatus = "provider_unavailable";
          finalMessage = lastToolFeedback
            ? `Scheduling step completed: ${lastToolFeedback} I couldn't generate the final summary. Review the draft before retrying; live schedule unchanged.`
            : "I couldn't generate the final summary. Check the draft for confirmed results before retrying; live schedule unchanged.";
        } else {
          finalMessage = completion.content.trim();
        }
      }
    }
  } catch (error) {
    if (error instanceof ScheduleChatError && error.status !== 503) throw error;
    if (error instanceof Error && ["Unauthorized", "Forbidden", "AI scheduling is disabled"].includes(error.message)) throw error;
    console.warn("[AI scheduling chat] Provider orchestration failed", {
      model: activeProvider.model,
      requestKeyHash: createHash("sha256").update(input.requestKey).digest("hex").slice(0, 16),
      errorName: error instanceof Error ? error.name : "UnknownError",
      ...(error && typeof error === "object" && "code" in error && typeof error.code === "string" ? { errorCode: error.code } : {}),
    });
    responseStatus = "provider_unavailable";
    finalMessage = "Scheduling assistant is temporarily unavailable. No live schedule changes were made. Check for a saved draft proposal before retrying; manual planner controls remain available.";
  }

  await appendMessages(conversation.id, input.userId, [{
    role: AiMessageRole.ASSISTANT,
    content: finalMessage,
    replyToRequestKey: input.requestKey,
  }]);
  const elapsedMs = Date.now() - startedAt;
  await writeChatAudit({
    userId: input.userId,
    conversationId: conversation.id,
    action: "AI_CHAT_COMPLETED",
    outcome: responseStatus === "complete" ? "SUCCEEDED" : "PROVIDER_UNAVAILABLE",
    metadata: {
      model: activeProvider.model,
      elapsedMs,
      promptTokens,
      completionTokens,
      toolCalls: totalToolCalls,
      requestKeyHash: createHash("sha256").update(input.requestKey).digest("hex").slice(0, 16),
    },
  });
  const latestConversation = await db.aiConversation.findFirst({
    where: { id: conversation.id, userId: input.userId },
    select: { activeDraftId: true },
  });
  return {
    conversationId: conversation.id,
    activeDraftId: latestConversation?.activeDraftId ?? null,
    message: finalMessage,
    interaction: finalInteraction ?? undefined,
    status: responseStatus,
    replayed: false,
  };
}

export async function getScheduleChatHistory(input: { conversationId: string; userId: string }) {
  const conversation = await db.aiConversation.findFirst({
    where: { id: input.conversationId, userId: input.userId },
    select: { id: true, activeDraftId: true, pendingInteraction: true },
  });
  if (!conversation) throw new ScheduleChatError("Conversation not found.", 404);
  const messages = await db.aiMessage.findMany({
    where: {
      conversationId: conversation.id,
      role: { in: [AiMessageRole.USER, AiMessageRole.ASSISTANT] },
      toolCallId: null,
    },
    orderBy: { sequence: "desc" },
    take: MAX_CHAT_MESSAGES_PER_CONVERSATION * 2,
    select: { id: true, role: true, content: true, createdAt: true },
  });
  const pending = readPendingScheduleOperation(conversation.pendingInteraction);
  const pendingExpired = pending && isScheduleOperationExpired(pending.expiresAt);
  const interaction = pending && ["CANCELLED", "UNDONE"].includes(pending.status)
    ? null
    : pending?.interaction
    ? pendingExpired
      ? { ...pending.interaction, kind: "EXPIRED" as const, summary: "This schedule preview expired. Send request again to prepare a fresh one.", canApply: false, canUndo: false }
      : pending.interaction
    : null;
  return {
    conversationId: conversation.id,
    activeDraftId: conversation.activeDraftId,
    interaction,
    messages: messages.reverse().map((message) => ({
      id: message.id,
      role: message.role,
      content: message.role === AiMessageRole.ASSISTANT
        ? sanitizeSchedulingAssistantMessage(message.content)
        : message.content,
      createdAt: message.createdAt.toISOString(),
    })),
  };
}
