ALTER TYPE "AiScheduleAssignmentSource" ADD VALUE IF NOT EXISTS 'AI';

CREATE TYPE "AiConversationTopic" AS ENUM ('SCHEDULING');
CREATE TYPE "AiMessageRole" AS ENUM ('USER', 'ASSISTANT', 'TOOL');

CREATE TABLE "AiConversation" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "topic" "AiConversationTopic" NOT NULL DEFAULT 'SCHEDULING',
  "activeDraftId" TEXT,
  "pendingEmployeeSelection" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AiConversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AiMessage" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "role" "AiMessageRole" NOT NULL,
  "content" TEXT NOT NULL,
  "toolName" TEXT,
  "toolCallId" TEXT,
  "requestKey" TEXT,
  "replyToRequestKey" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiMessage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiMessage_requestKey_key" ON "AiMessage"("requestKey");
CREATE UNIQUE INDEX "AiMessage_replyToRequestKey_key" ON "AiMessage"("replyToRequestKey");
CREATE UNIQUE INDEX "AiMessage_conversationId_sequence_key" ON "AiMessage"("conversationId", "sequence");
CREATE INDEX "AiConversation_userId_updatedAt_idx" ON "AiConversation"("userId", "updatedAt");
CREATE INDEX "AiConversation_userId_createdAt_idx" ON "AiConversation"("userId", "createdAt");
CREATE INDEX "AiConversation_activeDraftId_idx" ON "AiConversation"("activeDraftId");
CREATE INDEX "AiMessage_conversationId_createdAt_idx" ON "AiMessage"("conversationId", "createdAt");
CREATE INDEX "AiMessage_conversationId_role_createdAt_idx" ON "AiMessage"("conversationId", "role", "createdAt");
CREATE INDEX "AiActionAudit_conversationId_createdAt_idx" ON "AiActionAudit"("conversationId", "createdAt");

ALTER TABLE "AiConversation"
  ADD CONSTRAINT "AiConversation_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("userId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "AiConversation_activeDraftId_fkey"
    FOREIGN KEY ("activeDraftId") REFERENCES "AiScheduleDraft"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AiMessage"
  ADD CONSTRAINT "AiMessage_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "AiConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AiActionAudit"
  ADD CONSTRAINT "AiActionAudit_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "AiConversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
