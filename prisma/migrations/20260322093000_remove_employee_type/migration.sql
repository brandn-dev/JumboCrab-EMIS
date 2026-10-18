ALTER TABLE "Employee" DROP CONSTRAINT IF EXISTS "Employee_employeeTypeId_fkey";

DROP INDEX IF EXISTS "Employee_employeeTypeId_idx";

ALTER TABLE "Employee" DROP COLUMN IF EXISTS "employeeTypeId";

DROP TABLE IF EXISTS "EmployeeType";
