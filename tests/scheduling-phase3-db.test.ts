import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { AiMessageRole, Roles } from "@prisma/client";
import { getScheduleChatHistory, ScheduleChatError } from "../src/lib/ai-scheduling-chat-service";
import { getPrismaClient } from "../src/lib/prisma";

if (!process.env.DATABASE_URL_TEST || process.env.DATABASE_URL !== process.env.DATABASE_URL_TEST) {
  throw new Error("Test runner must explicitly set DATABASE_URL_TEST to its selected database URL");
}

const prisma = getPrismaClient();
const requestKey = randomUUID();
let ownerUserId = "";
let conversationId = "";

before(async () => {
  const owner = await prisma.user.findFirst({
    where: { isDisabled: false, role: { in: [Roles.Admin, Roles.Manager] } },
    select: { userId: true },
  });
  if (!owner) throw new Error("Scheduling chat DB test requires an enabled Admin or Manager fixture");
  ownerUserId = owner.userId;

  const conversation = await prisma.aiConversation.create({
    data: { userId: ownerUserId },
    select: { id: true },
  });
  conversationId = conversation.id;
  await prisma.aiMessage.createMany({
    data: [
      { conversationId, sequence: 1, role: AiMessageRole.USER, content: "Check this draft", requestKey },
      { conversationId, sequence: 2, role: AiMessageRole.ASSISTANT, content: "{}", toolName: "get_schedule_context", toolCallId: "tool-1" },
      { conversationId, sequence: 3, role: AiMessageRole.TOOL, content: "{\"ok\":true}", toolName: "get_schedule_context", toolCallId: "tool-1" },
      { conversationId, sequence: 4, role: AiMessageRole.ASSISTANT, content: "Draft is unchanged." },
      { conversationId, sequence: 5, role: AiMessageRole.ASSISTANT, content: "<tool_call><function=propose_schedule_operation></tool_call>" },
    ],
  });
});

after(async () => {
  if (conversationId) await prisma.aiConversation.deleteMany({ where: { id: conversationId } });
  await prisma.$disconnect();
});

test("chat transcript is ordered, hides tool internals, and stays owner-scoped", async () => {
  const history = await getScheduleChatHistory({ conversationId, userId: ownerUserId });
  assert.deepEqual(history.messages.map(({ role, content }) => ({ role, content })), [
    { role: "USER", content: "Check this draft" },
    { role: "ASSISTANT", content: "Draft is unchanged." },
    { role: "ASSISTANT", content: "Internal scheduling output was hidden. Check the draft preview before retrying." },
  ]);

  await assert.rejects(
    getScheduleChatHistory({ conversationId, userId: "another-manager" }),
    (error: unknown) => error instanceof ScheduleChatError && error.status === 404,
  );

  const interactionId = randomUUID();
  const optionId = randomUUID();
  await prisma.aiConversation.update({
    where: { id: conversationId },
    data: {
      pendingInteraction: {
        kind: "SCHEDULE_OPERATION",
        id: interactionId,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        draftId: "draft-fixture",
        draftVersion: 1,
        draftFingerprint: "draft-fingerprint",
        sourceFingerprint: "source-fingerprint",
        weekStart: "2026-10-19",
        sourceMessage: "Set Brandon on shift 2 Friday",
        status: "CLARIFICATION",
        intent: { operation: "ASSIGN_SHIFT", targetType: "ALL", shiftRef: "2" },
        targetEmployeeIds: [],
        choices: [{ id: optionId, label: "Brandon Lee", description: "Code JC-102", value: { employeeId: "private-db-id" } }],
        selectionMode: "single",
        interaction: {
          id: interactionId,
          kind: "CLARIFICATION",
          title: "Choose employee",
          summary: "Choose correct person.",
          selectionMode: "single",
          options: [{ id: optionId, label: "Brandon Lee", description: "Code JC-102" }],
        },
      },
    },
  });
  const restored = await getScheduleChatHistory({ conversationId, userId: ownerUserId });
  assert.equal(restored.interaction?.id, interactionId);
  assert.deepEqual(restored.interaction?.options, [{ id: optionId, label: "Brandon Lee", description: "Code JC-102" }]);
  assert.doesNotMatch(JSON.stringify(restored.interaction), /private-db-id/);
});
