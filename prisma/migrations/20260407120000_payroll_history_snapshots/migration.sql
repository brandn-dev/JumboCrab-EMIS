DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PayrollFrequency') THEN
    CREATE TYPE "PayrollFrequency" AS ENUM ('WEEKLY', 'BIMONTHLY', 'MONTHLY');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ContributionType') THEN
    CREATE TYPE "ContributionType" AS ENUM ('SSS', 'PHILHEALTH', 'PAGIBIG', 'WITHHOLDING');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'ContributionCalculationMethod'
  ) THEN
    CREATE TYPE "ContributionCalculationMethod" AS ENUM (
      'FIXED_AMOUNTS',
      'PERCENT_OF_BASE',
      'BASE_PLUS_PERCENT_OF_EXCESS'
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ContributionBaseKind') THEN
    CREATE TYPE "ContributionBaseKind" AS ENUM ('MONTHLY_BASIC', 'PAYROLL_TAXABLE');
  END IF;
END $$;

ALTER TABLE "Employee"
  DROP COLUMN IF EXISTS "dailyRate";

DROP TABLE IF EXISTS "EmployeeContribution" CASCADE;
DROP TABLE IF EXISTS "EmployeeRateHistory" CASCADE;

ALTER TABLE "Position"
  ADD COLUMN IF NOT EXISTS "dailyRate" DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS "hourlyRate" DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS "monthlyRate" DECIMAL(12,2),
  ADD COLUMN IF NOT EXISTS "currencyCode" TEXT NOT NULL DEFAULT 'PHP';

CREATE TABLE IF NOT EXISTS "ContributionBracket" (
  "id" TEXT NOT NULL,
  "contributionType" "ContributionType" NOT NULL,
  "calculationMethod" "ContributionCalculationMethod" NOT NULL,
  "baseKind" "ContributionBaseKind" NOT NULL,
  "payrollFrequency" "PayrollFrequency",
  "lowerBound" DECIMAL(12,2) NOT NULL,
  "upperBound" DECIMAL(12,2),
  "employeeFixedAmount" DECIMAL(12,2),
  "employerFixedAmount" DECIMAL(12,2),
  "employeeRate" DECIMAL(8,6),
  "employerRate" DECIMAL(8,6),
  "baseTax" DECIMAL(12,2),
  "marginalRate" DECIMAL(8,6),
  "effectiveFrom" TIMESTAMP(3) NOT NULL,
  "effectiveTo" TIMESTAMP(3),
  "referenceCode" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContributionBracket_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ContributionBracket_contributionType_payrollFrequency_effectiveFrom_idx"
  ON "ContributionBracket"("contributionType", "payrollFrequency", "effectiveFrom");
CREATE INDEX IF NOT EXISTS "ContributionBracket_contributionType_effectiveFrom_lowerBound_idx"
  ON "ContributionBracket"("contributionType", "effectiveFrom", "lowerBound");
CREATE INDEX IF NOT EXISTS "ContributionBracket_effectiveFrom_effectiveTo_idx"
  ON "ContributionBracket"("effectiveFrom", "effectiveTo");

CREATE TABLE IF NOT EXISTS "PositionRateHistory" (
  "id" TEXT NOT NULL,
  "positionId" TEXT NOT NULL,
  "dailyRate" DECIMAL(10,2),
  "hourlyRate" DECIMAL(10,2),
  "monthlyRate" DECIMAL(12,2),
  "currencyCode" TEXT NOT NULL DEFAULT 'PHP',
  "effectiveFrom" TIMESTAMP(3) NOT NULL,
  "effectiveTo" TIMESTAMP(3),
  "reason" TEXT,
  "metadata" JSONB,
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PositionRateHistory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PositionRateHistory_positionId_effectiveFrom_key"
  ON "PositionRateHistory"("positionId", "effectiveFrom");
CREATE INDEX IF NOT EXISTS "PositionRateHistory_positionId_effectiveFrom_idx"
  ON "PositionRateHistory"("positionId", "effectiveFrom");
CREATE INDEX IF NOT EXISTS "PositionRateHistory_createdByUserId_idx"
  ON "PositionRateHistory"("createdByUserId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'PositionRateHistory_positionId_fkey'
      AND table_name = 'PositionRateHistory'
  ) THEN
    ALTER TABLE "PositionRateHistory"
      ADD CONSTRAINT "PositionRateHistory_positionId_fkey"
      FOREIGN KEY ("positionId") REFERENCES "Position"("positionId")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'PositionRateHistory_createdByUserId_fkey'
      AND table_name = 'PositionRateHistory'
  ) THEN
    ALTER TABLE "PositionRateHistory"
      ADD CONSTRAINT "PositionRateHistory_createdByUserId_fkey"
      FOREIGN KEY ("createdByUserId") REFERENCES "User"("userId")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "EmployeePositionHistory" (
  "id" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "departmentId" TEXT,
  "positionId" TEXT,
  "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "effectiveTo" TIMESTAMP(3),
  "reason" TEXT,
  "metadata" JSONB,
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmployeePositionHistory_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'EmployeePositionHistory_employeeId_fkey'
      AND table_name = 'EmployeePositionHistory'
  ) THEN
    ALTER TABLE "EmployeePositionHistory"
      ADD CONSTRAINT "EmployeePositionHistory_employeeId_fkey"
      FOREIGN KEY ("employeeId") REFERENCES "Employee"("employeeId")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'EmployeePositionHistory_departmentId_fkey'
      AND table_name = 'EmployeePositionHistory'
  ) THEN
    ALTER TABLE "EmployeePositionHistory"
      ADD CONSTRAINT "EmployeePositionHistory_departmentId_fkey"
      FOREIGN KEY ("departmentId") REFERENCES "Department"("departmentId")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'EmployeePositionHistory_positionId_fkey'
      AND table_name = 'EmployeePositionHistory'
  ) THEN
    ALTER TABLE "EmployeePositionHistory"
      ADD CONSTRAINT "EmployeePositionHistory_positionId_fkey"
      FOREIGN KEY ("positionId") REFERENCES "Position"("positionId")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'EmployeePositionHistory_createdByUserId_fkey'
      AND table_name = 'EmployeePositionHistory'
  ) THEN
    ALTER TABLE "EmployeePositionHistory"
      ADD CONSTRAINT "EmployeePositionHistory_createdByUserId_fkey"
      FOREIGN KEY ("createdByUserId") REFERENCES "User"("userId")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "EmployeePositionHistory_employeeId_effectiveFrom_idx"
  ON "EmployeePositionHistory"("employeeId", "effectiveFrom");
CREATE INDEX IF NOT EXISTS "EmployeePositionHistory_departmentId_idx"
  ON "EmployeePositionHistory"("departmentId");
CREATE INDEX IF NOT EXISTS "EmployeePositionHistory_positionId_idx"
  ON "EmployeePositionHistory"("positionId");

ALTER TABLE "PayrollEmployee"
  ADD COLUMN IF NOT EXISTS "positionIdSnapshot" TEXT,
  ADD COLUMN IF NOT EXISTS "positionNameSnapshot" TEXT,
  ADD COLUMN IF NOT EXISTS "dailyRateSnapshot" DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS "hourlyRateSnapshot" DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS "monthlyRateSnapshot" DECIMAL(12,2),
  ADD COLUMN IF NOT EXISTS "currencyCodeSnapshot" TEXT,
  ADD COLUMN IF NOT EXISTS "ratePerMinuteSnapshot" DECIMAL(12,6);

ALTER TABLE "PayrollDeduction"
  ADD COLUMN IF NOT EXISTS "deductionCodeSnapshot" TEXT,
  ADD COLUMN IF NOT EXISTS "deductionNameSnapshot" TEXT,
  ADD COLUMN IF NOT EXISTS "contributionType" "ContributionType",
  ADD COLUMN IF NOT EXISTS "bracketIdSnapshot" TEXT,
  ADD COLUMN IF NOT EXISTS "bracketReferenceSnapshot" TEXT,
  ADD COLUMN IF NOT EXISTS "payrollFrequency" "PayrollFrequency",
  ADD COLUMN IF NOT EXISTS "periodStartSnapshot" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "periodEndSnapshot" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "compensationBasisSnapshot" DECIMAL(12,2),
  ADD COLUMN IF NOT EXISTS "employeeShareSnapshot" DECIMAL(12,2),
  ADD COLUMN IF NOT EXISTS "employerShareSnapshot" DECIMAL(12,2),
  ADD COLUMN IF NOT EXISTS "baseTaxSnapshot" DECIMAL(12,2),
  ADD COLUMN IF NOT EXISTS "marginalRateSnapshot" DECIMAL(8,6),
  ADD COLUMN IF NOT EXISTS "quantitySnapshot" DECIMAL(12,4),
  ADD COLUMN IF NOT EXISTS "unitLabelSnapshot" TEXT,
  ADD COLUMN IF NOT EXISTS "metadata" JSONB;

DROP TYPE IF EXISTS "ContributionSchedule";
