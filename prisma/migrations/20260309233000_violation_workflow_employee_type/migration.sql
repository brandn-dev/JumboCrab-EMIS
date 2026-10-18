-- Employee type model and assignment support.
ALTER TABLE "Employee"
ADD COLUMN IF NOT EXISTS "employeeTypeId" TEXT;

CREATE TABLE IF NOT EXISTS "EmployeeType" (
  "employeeTypeId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "EmployeeType_pkey" PRIMARY KEY ("employeeTypeId")
);

CREATE UNIQUE INDEX IF NOT EXISTS "EmployeeType_name_key" ON "EmployeeType"("name");
CREATE INDEX IF NOT EXISTS "EmployeeType_isActive_name_idx" ON "EmployeeType"("isActive", "name");
CREATE INDEX IF NOT EXISTS "Employee_employeeTypeId_idx" ON "Employee"("employeeTypeId");

ALTER TABLE "EmployeeType" DROP CONSTRAINT IF EXISTS "EmployeeType_createdByUserId_fkey";
ALTER TABLE "EmployeeType"
ADD CONSTRAINT "EmployeeType_createdByUserId_fkey"
FOREIGN KEY ("createdByUserId") REFERENCES "User"("userId") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Employee" DROP CONSTRAINT IF EXISTS "Employee_employeeTypeId_fkey";
ALTER TABLE "Employee"
ADD CONSTRAINT "Employee_employeeTypeId_fkey"
FOREIGN KEY ("employeeTypeId") REFERENCES "EmployeeType"("employeeTypeId") ON DELETE SET NULL ON UPDATE CASCADE;

-- Replace legacy violation schema with current violation definition + employee violation workflow.
DROP TABLE IF EXISTS "EmployeeViolation";
DROP TABLE IF EXISTS "Violation";
DROP TYPE IF EXISTS "VIOLATION_STATUS";
DROP TYPE IF EXISTS "VIOLATION_TYPE";

DO $$
BEGIN
  CREATE TYPE "EmployeeViolationStatus" AS ENUM ('DRAFT', 'APPROVED', 'REJECTED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE "Violation" (
  "violationId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "defaultStrikePoints" INTEGER NOT NULL DEFAULT 1,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Violation_pkey" PRIMARY KEY ("violationId")
);

CREATE INDEX "Violation_name_idx" ON "Violation"("name");

CREATE TABLE "EmployeeViolation" (
  "id" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "violationId" TEXT NOT NULL,
  "violationDate" TIMESTAMP(3) NOT NULL,
  "strikePointsSnapshot" INTEGER NOT NULL DEFAULT 1,
  "status" "EmployeeViolationStatus" NOT NULL DEFAULT 'DRAFT',
  "draftedById" TEXT,
  "submittedAt" TIMESTAMP(3),
  "reviewedById" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "reviewRemarks" TEXT,
  "isAcknowledged" BOOLEAN NOT NULL DEFAULT false,
  "acknowledgedAt" TIMESTAMP(3),
  "remarks" TEXT,
  "isCountedForStrike" BOOLEAN NOT NULL DEFAULT true,
  "voidedAt" TIMESTAMP(3),
  "voidReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "EmployeeViolation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EmployeeViolation_employeeId_violationDate_idx" ON "EmployeeViolation"("employeeId", "violationDate");
CREATE INDEX "EmployeeViolation_violationId_idx" ON "EmployeeViolation"("violationId");
CREATE INDEX "EmployeeViolation_status_violationDate_idx" ON "EmployeeViolation"("status", "violationDate");
CREATE INDEX "EmployeeViolation_draftedById_idx" ON "EmployeeViolation"("draftedById");
CREATE INDEX "EmployeeViolation_reviewedById_idx" ON "EmployeeViolation"("reviewedById");
CREATE INDEX "EmployeeViolation_isCountedForStrike_voidedAt_idx" ON "EmployeeViolation"("isCountedForStrike", "voidedAt");

ALTER TABLE "EmployeeViolation" DROP CONSTRAINT IF EXISTS "EmployeeViolation_violationId_fkey";
ALTER TABLE "EmployeeViolation"
ADD CONSTRAINT "EmployeeViolation_violationId_fkey"
FOREIGN KEY ("violationId") REFERENCES "Violation"("violationId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EmployeeViolation" DROP CONSTRAINT IF EXISTS "EmployeeViolation_employeeId_fkey";
ALTER TABLE "EmployeeViolation"
ADD CONSTRAINT "EmployeeViolation_employeeId_fkey"
FOREIGN KEY ("employeeId") REFERENCES "Employee"("employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EmployeeViolation" DROP CONSTRAINT IF EXISTS "EmployeeViolation_draftedById_fkey";
ALTER TABLE "EmployeeViolation"
ADD CONSTRAINT "EmployeeViolation_draftedById_fkey"
FOREIGN KEY ("draftedById") REFERENCES "User"("userId") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "EmployeeViolation" DROP CONSTRAINT IF EXISTS "EmployeeViolation_reviewedById_fkey";
ALTER TABLE "EmployeeViolation"
ADD CONSTRAINT "EmployeeViolation_reviewedById_fkey"
FOREIGN KEY ("reviewedById") REFERENCES "User"("userId") ON DELETE SET NULL ON UPDATE CASCADE;
