-- CreateTable
CREATE TABLE "EmployeeRateHistory" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "dailyRate" DECIMAL(10,2),
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeRateHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmployeeRateHistory_employeeId_effectiveFrom_idx" ON "EmployeeRateHistory"("employeeId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "EmployeeRateHistory_effectiveFrom_idx" ON "EmployeeRateHistory"("effectiveFrom");

-- AddForeignKey
ALTER TABLE "EmployeeRateHistory" ADD CONSTRAINT "EmployeeRateHistory_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill current employee rates so history starts with today's data model.
INSERT INTO "EmployeeRateHistory" (
    "id",
    "employeeId",
    "dailyRate",
    "effectiveFrom",
    "reason",
    "createdAt"
)
SELECT
    CONCAT('backfill-', e."employeeId"),
    e."employeeId",
    e."dailyRate",
    e."startDate",
    'Initial backfill from Employee.dailyRate',
    CURRENT_TIMESTAMP
FROM "Employee" e
WHERE e."dailyRate" IS NOT NULL;
