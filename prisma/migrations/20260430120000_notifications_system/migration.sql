-- Create enums
CREATE TYPE "NotificationModule" AS ENUM (
  'USERS',
  'REQUESTS',
  'PAYROLL',
  'VIOLATIONS',
  'DEDUCTIONS',
  'ATTENDANCE',
  'SCHEDULE',
  'CONTRIBUTIONS',
  'ORGANIZATION',
  'SECURITY',
  'SYSTEM'
);

CREATE TYPE "NotificationSeverity" AS ENUM (
  'INFO',
  'SUCCESS',
  'WARNING',
  'ERROR'
);

CREATE TYPE "NotificationEmailStatus" AS ENUM (
  'PENDING',
  'SENT',
  'FAILED',
  'SKIPPED'
);

CREATE TYPE "NotificationEventType" AS ENUM (
  'ACCOUNT_CREATED',
  'ACCOUNT_DISABLED',
  'ACCOUNT_ENABLED',
  'ACCOUNT_CREDENTIAL_EMAIL_FAILED',
  'PASSWORD_CHANGE_REQUIRED',
  'LEAVE_REQUEST_SUBMITTED',
  'LEAVE_REQUEST_APPROVED',
  'LEAVE_REQUEST_REJECTED',
  'DAY_OFF_REQUEST_SUBMITTED',
  'DAY_OFF_REQUEST_APPROVED',
  'DAY_OFF_REQUEST_REJECTED',
  'SCHEDULE_CHANGE_REQUEST_SUBMITTED',
  'SCHEDULE_CHANGE_REQUEST_APPROVED',
  'SCHEDULE_CHANGE_REQUEST_REJECTED',
  'SCHEDULE_SWAP_REQUEST_SUBMITTED',
  'SCHEDULE_SWAP_REQUEST_COWORKER_APPROVED',
  'SCHEDULE_SWAP_REQUEST_COWORKER_REJECTED',
  'SCHEDULE_SWAP_REQUEST_APPROVED',
  'SCHEDULE_SWAP_REQUEST_REJECTED',
  'CASH_ADVANCE_REQUEST_SUBMITTED',
  'CASH_ADVANCE_REQUEST_APPROVED',
  'CASH_ADVANCE_REQUEST_REJECTED',
  'DEDUCTION_ASSIGNMENT_SUBMITTED',
  'DEDUCTION_ASSIGNMENT_APPROVED',
  'DEDUCTION_ASSIGNMENT_REJECTED',
  'DEDUCTION_ASSIGNMENT_COMPLETED',
  'VIOLATION_SUBMITTED',
  'VIOLATION_APPROVED',
  'VIOLATION_REJECTED',
  'VIOLATION_ACKNOWLEDGEMENT_REQUIRED',
  'VIOLATION_ACKNOWLEDGED',
  'PAYROLL_GENERATED',
  'PAYROLL_READY_FOR_REVIEW',
  'PAYROLL_MANAGER_APPROVED',
  'PAYROLL_MANAGER_REJECTED',
  'PAYROLL_GM_APPROVED',
  'PAYROLL_GM_REJECTED',
  'PAYROLL_RELEASED',
  'PAYSLIP_AVAILABLE',
  'ATTENDANCE_ACTION_REQUIRED',
  'SCHEDULE_UPDATED'
);

-- Alter User
ALTER TABLE "User"
ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "passwordChangedAt" TIMESTAMP(3);

-- Create Notification
CREATE TABLE "Notification" (
  "id" TEXT NOT NULL,
  "eventType" "NotificationEventType" NOT NULL,
  "module" "NotificationModule" NOT NULL,
  "title" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "severity" "NotificationSeverity" NOT NULL DEFAULT 'INFO',
  "actorUserId" TEXT,
  "entityType" TEXT,
  "entityId" TEXT,
  "linkHref" TEXT NOT NULL,
  "metadata" JSONB,
  "emailEligible" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- Create UserNotification
CREATE TABLE "UserNotification" (
  "id" TEXT NOT NULL,
  "notificationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "readAt" TIMESTAMP(3),
  "archivedAt" TIMESTAMP(3),
  "emailedAt" TIMESTAMP(3),
  "emailStatus" "NotificationEmailStatus" NOT NULL DEFAULT 'PENDING',
  "emailError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "UserNotification_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "User_mustChangePassword_username_idx" ON "User"("mustChangePassword", "username");
CREATE INDEX "User_passwordChangedAt_idx" ON "User"("passwordChangedAt");
CREATE INDEX "Notification_module_createdAt_idx" ON "Notification"("module", "createdAt");
CREATE INDEX "Notification_eventType_createdAt_idx" ON "Notification"("eventType", "createdAt");
CREATE INDEX "Notification_actorUserId_createdAt_idx" ON "Notification"("actorUserId", "createdAt");
CREATE INDEX "Notification_entityType_entityId_idx" ON "Notification"("entityType", "entityId");
CREATE UNIQUE INDEX "UserNotification_notificationId_userId_key" ON "UserNotification"("notificationId", "userId");
CREATE INDEX "UserNotification_userId_readAt_archivedAt_createdAt_idx" ON "UserNotification"("userId", "readAt", "archivedAt", "createdAt");
CREATE INDEX "UserNotification_notificationId_createdAt_idx" ON "UserNotification"("notificationId", "createdAt");
CREATE INDEX "UserNotification_emailStatus_emailedAt_idx" ON "UserNotification"("emailStatus", "emailedAt");

-- Foreign keys
ALTER TABLE "Notification"
ADD CONSTRAINT "Notification_actorUserId_fkey"
FOREIGN KEY ("actorUserId") REFERENCES "User"("userId") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "UserNotification"
ADD CONSTRAINT "UserNotification_notificationId_fkey"
FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserNotification"
ADD CONSTRAINT "UserNotification_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("userId") ON DELETE CASCADE ON UPDATE CASCADE;
