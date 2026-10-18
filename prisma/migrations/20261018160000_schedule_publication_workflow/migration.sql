CREATE TYPE "SchedulePublicationNotificationStatus" AS ENUM (
  'PENDING',
  'PROCESSING',
  'DELIVERED',
  'FAILED',
  'SKIPPED'
);

ALTER TABLE "AiScheduleDraft"
  ADD COLUMN "validatedSourceFingerprint" TEXT,
  ADD COLUMN "validationReport" JSONB,
  ADD COLUMN "warningsAcknowledgedAt" TIMESTAMP(3),
  ADD COLUMN "warningsAcknowledgedByUserId" TEXT;

ALTER TABLE "Notification"
  ADD COLUMN "dedupeKey" TEXT;

CREATE UNIQUE INDEX "Notification_dedupeKey_key" ON "Notification"("dedupeKey");

-- Keep Prisma's managed index name below PostgreSQL's identifier limit.
ALTER INDEX "ScheduleCoverageRule_isActive_weekday_departmentId_positionId_s"
  RENAME TO "ScheduleCoverageRule_isActive_weekday_departmentId_position_idx";

CREATE TABLE "SchedulePublicationOutbox" (
  "id" TEXT NOT NULL,
  "draftId" TEXT NOT NULL,
  "recipientUserIds" JSONB NOT NULL,
  "notificationId" TEXT,
  "status" "SchedulePublicationNotificationStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "deliveredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SchedulePublicationOutbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SchedulePublicationOutbox_draftId_key"
  ON "SchedulePublicationOutbox"("draftId");
CREATE UNIQUE INDEX "SchedulePublicationOutbox_notificationId_key"
  ON "SchedulePublicationOutbox"("notificationId");
CREATE INDEX "SchedulePublicationOutbox_status_updatedAt_idx"
  ON "SchedulePublicationOutbox"("status", "updatedAt");

ALTER TABLE "AiScheduleDraft"
  ADD CONSTRAINT "AiScheduleDraft_warningsAcknowledgedByUserId_fkey"
  FOREIGN KEY ("warningsAcknowledgedByUserId") REFERENCES "User"("userId")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SchedulePublicationOutbox"
  ADD CONSTRAINT "SchedulePublicationOutbox_draftId_fkey"
  FOREIGN KEY ("draftId") REFERENCES "AiScheduleDraft"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "SchedulePublicationOutbox_notificationId_fkey"
  FOREIGN KEY ("notificationId") REFERENCES "Notification"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
