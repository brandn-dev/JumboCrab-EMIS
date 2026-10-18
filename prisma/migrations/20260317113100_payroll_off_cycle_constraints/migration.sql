-- Standard payroll should stay unique by period/type, but off-cycle runs must
-- be allowed to share the same dates as each other and as standard runs.
DROP INDEX IF EXISTS "Payroll_payrollPeriodStart_payrollPeriodEnd_payrollType_key";

CREATE INDEX IF NOT EXISTS "Payroll_payrollPeriodStart_payrollPeriodEnd_payrollType_idx"
ON "Payroll"("payrollPeriodStart", "payrollPeriodEnd", "payrollType");

-- Reclassify historical custom payroll runs created before OFF_CYCLE existed.
UPDATE "Payroll"
SET "payrollType" = 'OFF_CYCLE'
WHERE "payrollType" = 'BIMONTHLY'
  AND "notes" LIKE 'OFF-CYCLE:%';

CREATE UNIQUE INDEX IF NOT EXISTS "Payroll_standard_period_type_unique"
ON "Payroll"("payrollPeriodStart", "payrollPeriodEnd", "payrollType")
WHERE "payrollType" <> 'OFF_CYCLE';
