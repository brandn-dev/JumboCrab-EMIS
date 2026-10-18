ALTER TABLE "EmployeeViolation"
ADD COLUMN IF NOT EXISTS "appealSubmittedAt" TIMESTAMP(3);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    WHERE t.typname = 'NotificationEventType'
      AND e.enumlabel = 'VIOLATION_APPEAL_PAPER_SUBMITTED'
  ) THEN
    ALTER TYPE "NotificationEventType" ADD VALUE 'VIOLATION_APPEAL_PAPER_SUBMITTED';
  END IF;
END $$;
