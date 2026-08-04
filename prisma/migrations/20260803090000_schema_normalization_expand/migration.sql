-- Stability-first expand migration.
-- Destructive contract work is intentionally deferred until production verification.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "LeaveCreditResetRun" AS run
    LEFT JOIN "User" AS actor ON actor."userId" = run."initiatedByUserId"
    WHERE run."initiatedByUserId" IS NOT NULL AND actor."userId" IS NULL
  ) THEN
    RAISE EXCEPTION 'Normalization aborted: orphan LeaveCreditResetRun.initiatedByUserId found';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "EmployeeLeaveCreditLedger" AS ledger
    LEFT JOIN "User" AS actor ON actor."userId" = ledger."createdByUserId"
    WHERE ledger."createdByUserId" IS NOT NULL AND actor."userId" IS NULL
  ) THEN
    RAISE EXCEPTION 'Normalization aborted: orphan EmployeeLeaveCreditLedger.createdByUserId found';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "EmployeeLeaveCreditLedger" AS ledger
    LEFT JOIN "LeaveRequest" AS request ON request."id" = ledger."leaveRequestId"
    WHERE ledger."leaveRequestId" IS NOT NULL AND request."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'Normalization aborted: orphan EmployeeLeaveCreditLedger.leaveRequestId found';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "SilEncashmentRequest" AS request
    LEFT JOIN "EmployeeLeaveCreditLedger" AS ledger ON ledger."id" = request."ledgerEntryId"
    WHERE request."ledgerEntryId" IS NOT NULL AND ledger."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'Normalization aborted: orphan SilEncashmentRequest.ledgerEntryId found';
  END IF;

  IF EXISTS (
    SELECT "ledgerEntryId"
    FROM "SilEncashmentRequest"
    WHERE "ledgerEntryId" IS NOT NULL
    GROUP BY "ledgerEntryId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Normalization aborted: duplicate SilEncashmentRequest.ledgerEntryId found';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Employee"
    WHERE COALESCE("isEnded", false) IS DISTINCT FROM
      ("currentStatus" IN ('INACTIVE', 'ENDED'))
  ) THEN
    RAISE EXCEPTION 'Normalization aborted: Employee.isEnded conflicts with currentStatus';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "PayrollEarning"
    WHERE "isManual" IS DISTINCT FROM ("source" = 'MANUAL')
  ) OR EXISTS (
    SELECT 1
    FROM "PayrollDeduction"
    WHERE "isManual" IS DISTINCT FROM ("source" = 'MANUAL')
  ) THEN
    RAISE EXCEPTION 'Normalization aborted: payroll isManual conflicts with source';
  END IF;
END $$;

ALTER TABLE "Punch"
  ADD COLUMN "ipAddress" TEXT,
  ADD COLUMN "userAgent" TEXT,
  ADD COLUMN "latitude" DECIMAL(9, 6),
  ADD COLUMN "longitude" DECIMAL(9, 6);

ALTER TABLE "AttendanceContextLog"
  ADD COLUMN "punchId" TEXT;

-- Backfill only provable one-to-one context/punch mappings. Unmapped rows remain
-- in the legacy table and will block the guarded contract migration.
WITH raw_mappings AS (
  SELECT DISTINCT
    attempt."details" ->> 'contextLogId' AS "contextLogId",
    attempt."punchId"
  FROM "FaceVerificationAttempt" AS attempt
  WHERE attempt."punchId" IS NOT NULL
    AND attempt."details" ->> 'contextLogId' IS NOT NULL
),
one_punch_per_context AS (
  SELECT "contextLogId", MIN("punchId") AS "punchId"
  FROM raw_mappings
  GROUP BY "contextLogId"
  HAVING COUNT(DISTINCT "punchId") = 1
),
one_context_per_punch AS (
  SELECT MIN("contextLogId") AS "contextLogId", "punchId"
  FROM one_punch_per_context
  GROUP BY "punchId"
  HAVING COUNT(DISTINCT "contextLogId") = 1
)
UPDATE "AttendanceContextLog" AS context
SET "punchId" = mapping."punchId"
FROM one_context_per_punch AS mapping
WHERE context."id" = mapping."contextLogId";

UPDATE "Punch" AS punch
SET
  "ipAddress" = context."ipAddress",
  "userAgent" = context."userAgent",
  "latitude" = context."latitude",
  "longitude" = context."longitude"
FROM "AttendanceContextLog" AS context
WHERE context."punchId" = punch."id";

CREATE UNIQUE INDEX "AttendanceContextLog_punchId_key"
  ON "AttendanceContextLog"("punchId");

DROP INDEX IF EXISTS "SilEncashmentRequest_ledgerEntryId_idx";
CREATE UNIQUE INDEX "SilEncashmentRequest_ledgerEntryId_key"
  ON "SilEncashmentRequest"("ledgerEntryId");

ALTER TABLE "AttendanceContextLog"
  ADD CONSTRAINT "AttendanceContextLog_punchId_fkey"
  FOREIGN KEY ("punchId") REFERENCES "Punch"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LeaveCreditResetRun"
  ADD CONSTRAINT "LeaveCreditResetRun_initiatedByUserId_fkey"
  FOREIGN KEY ("initiatedByUserId") REFERENCES "User"("userId")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "EmployeeLeaveCreditLedger"
  ADD CONSTRAINT "EmployeeLeaveCreditLedger_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("userId")
  ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "EmployeeLeaveCreditLedger_leaveRequestId_fkey"
  FOREIGN KEY ("leaveRequestId") REFERENCES "LeaveRequest"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SilEncashmentRequest"
  ADD CONSTRAINT "SilEncashmentRequest_ledgerEntryId_fkey"
  FOREIGN KEY ("ledgerEntryId") REFERENCES "EmployeeLeaveCreditLedger"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
