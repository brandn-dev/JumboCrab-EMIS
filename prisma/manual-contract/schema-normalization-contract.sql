-- MANUAL CONTRACT MIGRATION. DO NOT add this file to prisma/migrations yet.
-- Preconditions:
--   1. Expand migration has been deployed.
--   2. ATTENDANCE_CONTEXT_LOG_DUAL_WRITE remained enabled for one complete
--      attendance/payroll cycle.
--   3. A release with ATTENDANCE_CONTEXT_LOG_DUAL_WRITE=false is active.
--   4. AttendanceContextLog has been exported/backed up.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "AttendanceContextLog" WHERE "punchId" IS NULL
  ) THEN
    RAISE EXCEPTION 'Contract aborted: unmapped AttendanceContextLog rows remain';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "AttendanceContextLog" AS context
    JOIN "Punch" AS punch ON punch."id" = context."punchId"
    WHERE punch."ipAddress" IS DISTINCT FROM context."ipAddress"
       OR punch."userAgent" IS DISTINCT FROM context."userAgent"
       OR punch."latitude" IS DISTINCT FROM context."latitude"
       OR punch."longitude" IS DISTINCT FROM context."longitude"
  ) THEN
    RAISE EXCEPTION 'Contract aborted: Punch security context differs from legacy log';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "Employee"
    WHERE COALESCE("isEnded", false) IS DISTINCT FROM
      ("currentStatus" IN ('INACTIVE', 'ENDED'))
  ) THEN
    RAISE EXCEPTION 'Contract aborted: Employee.isEnded conflicts with currentStatus';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "PayrollEarning"
    WHERE "isManual" IS DISTINCT FROM ("source" = 'MANUAL')
  ) OR EXISTS (
    SELECT 1 FROM "PayrollDeduction"
    WHERE "isManual" IS DISTINCT FROM ("source" = 'MANUAL')
  ) THEN
    RAISE EXCEPTION 'Contract aborted: payroll isManual conflicts with source';
  END IF;
END $$;

DROP TABLE "AttendanceContextLog";

ALTER TABLE "Employee" DROP COLUMN "isEnded";
ALTER TABLE "PayrollEarning" DROP COLUMN "isManual";
ALTER TABLE "PayrollDeduction" DROP COLUMN "isManual";
