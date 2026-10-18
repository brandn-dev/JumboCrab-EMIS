-- Add new enum values/types for the simplified request module.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum
    WHERE enumlabel = 'SIL'
      AND enumtypid = '"LeaveRequestType"'::regtype
  ) THEN
    ALTER TYPE "LeaveRequestType" ADD VALUE 'SIL';
  END IF;
END $$;

CREATE TYPE "LeaveCreditType" AS ENUM ('SICK', 'SIL');
CREATE TYPE "LeaveCreditLedgerEntryType" AS ENUM ('GRANT', 'RESET', 'USAGE', 'ADJUSTMENT');
CREATE TYPE "LeaveCreditResetRunType" AS ENUM ('MANUAL', 'SCHEDULED');
CREATE TYPE "CashAdvanceDeductionMode" AS ENUM ('FULL_NEXT_PAYROLL', 'INSTALLMENTS');

ALTER TABLE "CashAdvanceRequest"
  ADD COLUMN "approvedAmount" DECIMAL(12, 2),
  ADD COLUMN "approvedDeductionMode" "CashAdvanceDeductionMode",
  ADD COLUMN "approvedRepaymentPerPayroll" DECIMAL(12, 2),
  ADD COLUMN "approvedEffectiveFrom" TIMESTAMP(3);

ALTER TABLE "DayOffRequest"
  ADD COLUMN "sourceOffDate" TIMESTAMP(3),
  ADD COLUMN "targetWorkDate" TIMESTAMP(3),
  ADD COLUMN "sourceShiftIdSnapshot" INTEGER,
  ADD COLUMN "sourceShiftCodeSnapshot" TEXT,
  ADD COLUMN "sourceShiftNameSnapshot" TEXT,
  ADD COLUMN "sourceStartMinutesSnapshot" INTEGER,
  ADD COLUMN "sourceEndMinutesSnapshot" INTEGER,
  ADD COLUMN "sourceSpansMidnightSnapshot" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "ScheduleChangeRequest"
  ADD COLUMN "startDate" TIMESTAMP(3),
  ADD COLUMN "endDate" TIMESTAMP(3);

UPDATE "DayOffRequest"
SET "targetWorkDate" = "workDate"
WHERE "targetWorkDate" IS NULL;

UPDATE "ScheduleChangeRequest"
SET "startDate" = "workDate",
    "endDate" = "workDate"
WHERE "startDate" IS NULL
   OR "endDate" IS NULL;

CREATE TABLE "LeaveCreditPolicy" (
  "id" TEXT NOT NULL,
  "leaveType" "LeaveCreditType" NOT NULL,
  "resetMonth" INTEGER NOT NULL DEFAULT 1,
  "resetDay" INTEGER NOT NULL DEFAULT 1,
  "annualCredits" INTEGER NOT NULL DEFAULT 5,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LeaveCreditPolicy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LeaveCreditPolicy_leaveType_key" ON "LeaveCreditPolicy"("leaveType");
CREATE INDEX "LeaveCreditPolicy_resetMonth_resetDay_idx" ON "LeaveCreditPolicy"("resetMonth", "resetDay");

CREATE TABLE "LeaveCreditResetRun" (
  "id" TEXT NOT NULL,
  "policyId" TEXT NOT NULL,
  "leaveType" "LeaveCreditType" NOT NULL,
  "cycleStartDate" TIMESTAMP(3) NOT NULL,
  "cycleEndDate" TIMESTAMP(3) NOT NULL,
  "effectiveDate" TIMESTAMP(3) NOT NULL,
  "annualCredits" INTEGER NOT NULL,
  "employeeCount" INTEGER NOT NULL DEFAULT 0,
  "runType" "LeaveCreditResetRunType" NOT NULL DEFAULT 'MANUAL',
  "notes" TEXT,
  "initiatedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LeaveCreditResetRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LeaveCreditResetRun_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "LeaveCreditPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "LeaveCreditResetRun_leaveType_effectiveDate_idx" ON "LeaveCreditResetRun"("leaveType", "effectiveDate");
CREATE INDEX "LeaveCreditResetRun_policyId_cycleStartDate_idx" ON "LeaveCreditResetRun"("policyId", "cycleStartDate");

CREATE TABLE "EmployeeLeaveCreditLedger" (
  "id" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "leaveType" "LeaveCreditType" NOT NULL,
  "entryType" "LeaveCreditLedgerEntryType" NOT NULL,
  "amount" INTEGER NOT NULL,
  "balanceBefore" INTEGER NOT NULL,
  "balanceAfter" INTEGER NOT NULL,
  "effectiveDate" TIMESTAMP(3) NOT NULL,
  "cycleStartDate" TIMESTAMP(3) NOT NULL,
  "leaveRequestId" TEXT,
  "resetRunId" TEXT,
  "notes" TEXT,
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmployeeLeaveCreditLedger_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EmployeeLeaveCreditLedger_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("employeeId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "EmployeeLeaveCreditLedger_resetRunId_fkey" FOREIGN KEY ("resetRunId") REFERENCES "LeaveCreditResetRun"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "EmployeeLeaveCreditLedger_employeeId_leaveType_cycleStartDate_createdAt_idx" ON "EmployeeLeaveCreditLedger"("employeeId", "leaveType", "cycleStartDate", "createdAt");
CREATE INDEX "EmployeeLeaveCreditLedger_leaveRequestId_idx" ON "EmployeeLeaveCreditLedger"("leaveRequestId");
CREATE INDEX "EmployeeLeaveCreditLedger_resetRunId_idx" ON "EmployeeLeaveCreditLedger"("resetRunId");
CREATE INDEX "EmployeeLeaveCreditLedger_leaveType_effectiveDate_idx" ON "EmployeeLeaveCreditLedger"("leaveType", "effectiveDate");
