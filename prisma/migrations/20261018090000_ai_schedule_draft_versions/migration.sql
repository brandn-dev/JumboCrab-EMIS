CREATE TYPE "AiScheduleDraftStatus" AS ENUM (
  'DRAFT',
  'VALIDATED',
  'APPROVED',
  'PUBLISHED',
  'DISCARDED'
);

CREATE TYPE "AiScheduleDraftSource" AS ENUM (
  'CURRENT_SCHEDULE',
  'REFERENCE_WEEK',
  'EMPTY'
);

CREATE TYPE "AiScheduleAssignmentKind" AS ENUM (
  'WORK',
  'DAY_OFF',
  'UNASSIGNED',
  'PROTECTED_LEAVE'
);

CREATE TYPE "AiScheduleAssignmentSource" AS ENUM (
  'CURRENT_SCHEDULE',
  'REFERENCE_WEEK',
  'EMPTY',
  'MANUAL'
);

CREATE TABLE "AiScheduleDraft" (
  "id" TEXT NOT NULL,
  "lineageId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "requestKey" TEXT,
  "weekStart" TIMESTAMP(3) NOT NULL,
  "scope" JSONB NOT NULL,
  "scopeKey" TEXT NOT NULL,
  "sourceMode" "AiScheduleDraftSource" NOT NULL,
  "sourceWeekStart" TIMESTAMP(3),
  "status" "AiScheduleDraftStatus" NOT NULL DEFAULT 'DRAFT',
  "createdByUserId" TEXT NOT NULL,
  "sourceFingerprint" TEXT NOT NULL,
  "draftFingerprint" TEXT NOT NULL,
  "validatedFingerprint" TEXT,
  "approvedByUserId" TEXT,
  "approvedAt" TIMESTAMP(3),
  "publishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AiScheduleDraft_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AiScheduleDraftAssignment" (
  "id" TEXT NOT NULL,
  "draftId" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "workDate" TIMESTAMP(3) NOT NULL,
  "shiftId" INTEGER,
  "baselineShiftId" INTEGER,
  "baselineOverrideShiftId" INTEGER,
  "hasBaselineOverride" BOOLEAN NOT NULL DEFAULT false,
  "assignmentKind" "AiScheduleAssignmentKind" NOT NULL,
  "isProtected" BOOLEAN NOT NULL DEFAULT false,
  "source" "AiScheduleAssignmentSource" NOT NULL,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiScheduleDraftAssignment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AiActionAudit" (
  "id" TEXT NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "draftId" TEXT,
  "conversationId" TEXT,
  "outcome" TEXT NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiActionAudit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiScheduleDraft_lineageId_version_key"
  ON "AiScheduleDraft"("lineageId", "version");
CREATE UNIQUE INDEX "AiScheduleDraft_requestKey_key"
  ON "AiScheduleDraft"("requestKey");
CREATE INDEX "AiScheduleDraft_createdByUserId_weekStart_scopeKey_updatedAt_idx"
  ON "AiScheduleDraft"("createdByUserId", "weekStart", "scopeKey", "updatedAt");
CREATE INDEX "AiScheduleDraft_weekStart_status_idx"
  ON "AiScheduleDraft"("weekStart", "status");
CREATE UNIQUE INDEX "AiScheduleDraftAssignment_draftId_employeeId_workDate_key"
  ON "AiScheduleDraftAssignment"("draftId", "employeeId", "workDate");
CREATE INDEX "AiScheduleDraftAssignment_employeeId_workDate_idx"
  ON "AiScheduleDraftAssignment"("employeeId", "workDate");
CREATE INDEX "AiActionAudit_draftId_createdAt_idx"
  ON "AiActionAudit"("draftId", "createdAt");
CREATE INDEX "AiActionAudit_actorUserId_createdAt_idx"
  ON "AiActionAudit"("actorUserId", "createdAt");

ALTER TABLE "AiScheduleDraft"
  ADD CONSTRAINT "AiScheduleDraft_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("userId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "AiScheduleDraft_approvedByUserId_fkey"
    FOREIGN KEY ("approvedByUserId") REFERENCES "User"("userId") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AiScheduleDraftAssignment"
  ADD CONSTRAINT "AiScheduleDraftAssignment_draftId_fkey"
    FOREIGN KEY ("draftId") REFERENCES "AiScheduleDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "AiScheduleDraftAssignment_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("employeeId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "AiScheduleDraftAssignment_shiftId_fkey"
    FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "AiScheduleDraftAssignment_baselineShiftId_fkey"
    FOREIGN KEY ("baselineShiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "AiScheduleDraftAssignment_baselineOverrideShiftId_fkey"
    FOREIGN KEY ("baselineOverrideShiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AiActionAudit"
  ADD CONSTRAINT "AiActionAudit_actorUserId_fkey"
    FOREIGN KEY ("actorUserId") REFERENCES "User"("userId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "AiActionAudit_draftId_fkey"
    FOREIGN KEY ("draftId") REFERENCES "AiScheduleDraft"("id") ON DELETE SET NULL ON UPDATE CASCADE;
