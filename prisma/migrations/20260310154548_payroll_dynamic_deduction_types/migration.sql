-- CreateEnum
CREATE TYPE "DeductionAmountMode" AS ENUM ('FIXED', 'PERCENT');

-- CreateEnum
CREATE TYPE "DeductionFrequency" AS ENUM ('ONE_TIME', 'PER_PAYROLL', 'INSTALLMENT');

-- CreateEnum
CREATE TYPE "EmployeeDeductionAssignmentStatus" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED');

-- AlterTable
ALTER TABLE "PayrollDeduction" ADD COLUMN     "assignmentId" TEXT,
ADD COLUMN     "deductionCodeSnapshot" TEXT,
ADD COLUMN     "deductionNameSnapshot" TEXT,
ADD COLUMN     "deductionTypeId" TEXT,
ALTER COLUMN "deductionType" SET DEFAULT 'OTHER';

-- CreateTable
CREATE TABLE "DeductionType" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "amountMode" "DeductionAmountMode" NOT NULL,
    "frequency" "DeductionFrequency" NOT NULL DEFAULT 'PER_PAYROLL',
    "defaultAmount" DECIMAL(12,2),
    "defaultPercent" DECIMAL(5,2),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeductionType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeDeductionAssignment" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "deductionTypeId" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "amountOverride" DECIMAL(12,2),
    "percentOverride" DECIMAL(5,2),
    "installmentTotal" DECIMAL(12,2),
    "installmentPerPayroll" DECIMAL(12,2),
    "remainingBalance" DECIMAL(12,2),
    "status" "EmployeeDeductionAssignmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "reason" TEXT,
    "assignedByUserId" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeDeductionAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeductionType_code_key" ON "DeductionType"("code");

-- CreateIndex
CREATE INDEX "DeductionType_isActive_name_idx" ON "DeductionType"("isActive", "name");

-- CreateIndex
CREATE INDEX "EmployeeDeductionAssignment_employeeId_status_effectiveFrom_idx" ON "EmployeeDeductionAssignment"("employeeId", "status", "effectiveFrom");

-- CreateIndex
CREATE INDEX "EmployeeDeductionAssignment_deductionTypeId_status_idx" ON "EmployeeDeductionAssignment"("deductionTypeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeDeductionAssignment_employeeId_deductionTypeId_effe_key" ON "EmployeeDeductionAssignment"("employeeId", "deductionTypeId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "PayrollDeduction_deductionTypeId_idx" ON "PayrollDeduction"("deductionTypeId");

-- CreateIndex
CREATE INDEX "PayrollDeduction_assignmentId_idx" ON "PayrollDeduction"("assignmentId");

-- AddForeignKey
ALTER TABLE "DeductionType" ADD CONSTRAINT "DeductionType_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("userId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeductionType" ADD CONSTRAINT "DeductionType_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("userId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeDeductionAssignment" ADD CONSTRAINT "EmployeeDeductionAssignment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeDeductionAssignment" ADD CONSTRAINT "EmployeeDeductionAssignment_deductionTypeId_fkey" FOREIGN KEY ("deductionTypeId") REFERENCES "DeductionType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeDeductionAssignment" ADD CONSTRAINT "EmployeeDeductionAssignment_assignedByUserId_fkey" FOREIGN KEY ("assignedByUserId") REFERENCES "User"("userId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeDeductionAssignment" ADD CONSTRAINT "EmployeeDeductionAssignment_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("userId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollDeduction" ADD CONSTRAINT "PayrollDeduction_deductionTypeId_fkey" FOREIGN KEY ("deductionTypeId") REFERENCES "DeductionType"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollDeduction" ADD CONSTRAINT "PayrollDeduction_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "EmployeeDeductionAssignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
