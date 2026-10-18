-- Deduplicate overlapping entries by (employeeId, effectiveFrom).
-- Keep the most recently created row for each duplicate group.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY "employeeId", "effectiveFrom"
      ORDER BY "createdAt" DESC, id DESC
    ) AS rn
  FROM "EmployeeRateHistory"
)
DELETE FROM "EmployeeRateHistory" erh
USING ranked r
WHERE erh.id = r.id
  AND r.rn > 1;

-- Replace non-unique lookup index with unique key to prevent overlap.
DROP INDEX IF EXISTS "EmployeeRateHistory_employeeId_effectiveFrom_idx";

CREATE UNIQUE INDEX "EmployeeRateHistory_employeeId_effectiveFrom_key"
ON "EmployeeRateHistory"("employeeId", "effectiveFrom");
