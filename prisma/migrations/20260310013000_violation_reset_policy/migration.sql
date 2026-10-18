CREATE TYPE "ViolationResetFrequency" AS ENUM ('MONTHLY', 'YEARLY');

CREATE TABLE "EmployeeViolationReset" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "violationId" TEXT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "autoPolicyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeViolationReset_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ViolationAutoResetPolicy" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "frequency" "ViolationResetFrequency" NOT NULL,
    "dayOfMonth" INTEGER NOT NULL DEFAULT 1,
    "monthOfYear" INTEGER,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "reasonTemplate" TEXT,
    "appliesToAllEmployees" BOOLEAN NOT NULL DEFAULT true,
    "employeeId" TEXT,
    "violationId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ViolationAutoResetPolicy_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EmployeeViolationReset_employeeId_effectiveFrom_idx" ON "EmployeeViolationReset"("employeeId", "effectiveFrom");
CREATE INDEX "EmployeeViolationReset_employeeId_violationId_effectiveFrom_idx" ON "EmployeeViolationReset"("employeeId", "violationId", "effectiveFrom");
CREATE INDEX "EmployeeViolationReset_createdAt_idx" ON "EmployeeViolationReset"("createdAt");

CREATE INDEX "ViolationAutoResetPolicy_isActive_nextRunAt_idx" ON "ViolationAutoResetPolicy"("isActive", "nextRunAt");
CREATE INDEX "ViolationAutoResetPolicy_employeeId_idx" ON "ViolationAutoResetPolicy"("employeeId");
CREATE INDEX "ViolationAutoResetPolicy_violationId_idx" ON "ViolationAutoResetPolicy"("violationId");
CREATE INDEX "ViolationAutoResetPolicy_frequency_dayOfMonth_monthOfYear_idx" ON "ViolationAutoResetPolicy"("frequency", "dayOfMonth", "monthOfYear");

ALTER TABLE "EmployeeViolationReset" ADD CONSTRAINT "EmployeeViolationReset_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("employeeId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmployeeViolationReset" ADD CONSTRAINT "EmployeeViolationReset_violationId_fkey" FOREIGN KEY ("violationId") REFERENCES "Violation"("violationId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmployeeViolationReset" ADD CONSTRAINT "EmployeeViolationReset_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("userId") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EmployeeViolationReset" ADD CONSTRAINT "EmployeeViolationReset_autoPolicyId_fkey" FOREIGN KEY ("autoPolicyId") REFERENCES "ViolationAutoResetPolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ViolationAutoResetPolicy" ADD CONSTRAINT "ViolationAutoResetPolicy_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("employeeId") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ViolationAutoResetPolicy" ADD CONSTRAINT "ViolationAutoResetPolicy_violationId_fkey" FOREIGN KEY ("violationId") REFERENCES "Violation"("violationId") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ViolationAutoResetPolicy" ADD CONSTRAINT "ViolationAutoResetPolicy_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("userId") ON DELETE SET NULL ON UPDATE CASCADE;
