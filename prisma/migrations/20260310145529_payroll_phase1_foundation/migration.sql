-- CreateEnum
CREATE TYPE "PayrollType" AS ENUM ('BIMONTHLY', 'MONTHLY', 'WEEKLY');

-- CreateEnum
CREATE TYPE "PayrollStatus" AS ENUM ('DRAFT', 'REVIEWED', 'FINALIZED', 'VOIDED');

-- CreateEnum
CREATE TYPE "PayrollEmployeeStatus" AS ENUM ('DRAFT', 'REVIEWED', 'FINALIZED', 'VOIDED');

-- CreateEnum
CREATE TYPE "PayrollEarningType" AS ENUM ('BASE_PAY', 'OVERTIME_PAY', 'ADJUSTMENT', 'BONUS', 'ALLOWANCE');

-- CreateEnum
CREATE TYPE "PayrollDeductionType" AS ENUM ('UNDERTIME_DEDUCTION', 'CONTRIBUTION_SSS', 'CONTRIBUTION_PHILHEALTH', 'CONTRIBUTION_PAGIBIG', 'WITHHOLDING_TAX', 'LOAN', 'CASH_ADVANCE', 'PENALTY', 'OTHER');

-- CreateEnum
CREATE TYPE "PayrollLineSource" AS ENUM ('SYSTEM', 'MANUAL', 'IMPORT', 'CONTRIBUTION_ENGINE');

-- CreateEnum
CREATE TYPE "PayrollReferenceType" AS ENUM ('ATTENDANCE', 'CONTRIBUTION', 'VIOLATION', 'LOAN', 'MANUAL');

-- AlterTable
ALTER TABLE "Attendance" ADD COLUMN     "payrollEmployeeId" TEXT;

-- AlterTable
ALTER TABLE "EmployeeType" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateTable
CREATE TABLE "Payroll" (
    "payrollId" TEXT NOT NULL,
    "payrollPeriodStart" TIMESTAMP(3) NOT NULL,
    "payrollPeriodEnd" TIMESTAMP(3) NOT NULL,
    "payrollType" "PayrollType" NOT NULL,
    "status" "PayrollStatus" NOT NULL DEFAULT 'DRAFT',
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalizedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdByUserId" TEXT,
    "finalizedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payroll_pkey" PRIMARY KEY ("payrollId")
);

-- CreateTable
CREATE TABLE "PayrollEmployee" (
    "id" TEXT NOT NULL,
    "payrollId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "attendanceStart" TIMESTAMP(3) NOT NULL,
    "attendanceEnd" TIMESTAMP(3) NOT NULL,
    "daysPresent" INTEGER NOT NULL DEFAULT 0,
    "daysAbsent" INTEGER NOT NULL DEFAULT 0,
    "daysLate" INTEGER NOT NULL DEFAULT 0,
    "minutesWorked" INTEGER NOT NULL DEFAULT 0,
    "minutesNetWorked" INTEGER NOT NULL DEFAULT 0,
    "minutesOvertime" INTEGER NOT NULL DEFAULT 0,
    "minutesUndertime" INTEGER NOT NULL DEFAULT 0,
    "dailyRateSnapshot" DECIMAL(10,2),
    "ratePerMinuteSnapshot" DECIMAL(12,6),
    "grossPay" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalEarnings" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalDeductions" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "netPay" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" "PayrollEmployeeStatus" NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "createdByUserId" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollEmployee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollEarning" (
    "id" TEXT NOT NULL,
    "payrollEmployeeId" TEXT NOT NULL,
    "earningType" "PayrollEarningType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "minutes" INTEGER,
    "rateSnapshot" DECIMAL(12,6),
    "source" "PayrollLineSource" NOT NULL DEFAULT 'SYSTEM',
    "isManual" BOOLEAN NOT NULL DEFAULT false,
    "referenceType" "PayrollReferenceType",
    "referenceId" TEXT,
    "remarks" TEXT,
    "isVoided" BOOLEAN NOT NULL DEFAULT false,
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollEarning_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollDeduction" (
    "id" TEXT NOT NULL,
    "payrollEmployeeId" TEXT NOT NULL,
    "deductionType" "PayrollDeductionType" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "minutes" INTEGER,
    "rateSnapshot" DECIMAL(12,6),
    "source" "PayrollLineSource" NOT NULL DEFAULT 'SYSTEM',
    "isManual" BOOLEAN NOT NULL DEFAULT false,
    "referenceType" "PayrollReferenceType",
    "referenceId" TEXT,
    "remarks" TEXT,
    "isVoided" BOOLEAN NOT NULL DEFAULT false,
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollDeduction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Payroll_status_payrollPeriodStart_payrollPeriodEnd_idx" ON "Payroll"("status", "payrollPeriodStart", "payrollPeriodEnd");

-- CreateIndex
CREATE INDEX "Payroll_payrollType_payrollPeriodStart_idx" ON "Payroll"("payrollType", "payrollPeriodStart");

-- CreateIndex
CREATE UNIQUE INDEX "Payroll_payrollPeriodStart_payrollPeriodEnd_payrollType_key" ON "Payroll"("payrollPeriodStart", "payrollPeriodEnd", "payrollType");

-- CreateIndex
CREATE INDEX "PayrollEmployee_employeeId_payrollId_idx" ON "PayrollEmployee"("employeeId", "payrollId");

-- CreateIndex
CREATE INDEX "PayrollEmployee_status_payrollId_idx" ON "PayrollEmployee"("status", "payrollId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollEmployee_payrollId_employeeId_key" ON "PayrollEmployee"("payrollId", "employeeId");

-- CreateIndex
CREATE INDEX "PayrollEarning_payrollEmployeeId_earningType_idx" ON "PayrollEarning"("payrollEmployeeId", "earningType");

-- CreateIndex
CREATE INDEX "PayrollEarning_source_idx" ON "PayrollEarning"("source");

-- CreateIndex
CREATE INDEX "PayrollEarning_referenceType_referenceId_idx" ON "PayrollEarning"("referenceType", "referenceId");

-- CreateIndex
CREATE INDEX "PayrollDeduction_payrollEmployeeId_deductionType_idx" ON "PayrollDeduction"("payrollEmployeeId", "deductionType");

-- CreateIndex
CREATE INDEX "PayrollDeduction_source_idx" ON "PayrollDeduction"("source");

-- CreateIndex
CREATE INDEX "PayrollDeduction_referenceType_referenceId_idx" ON "PayrollDeduction"("referenceType", "referenceId");

-- CreateIndex
CREATE INDEX "Attendance_payrollPeriodId_idx" ON "Attendance"("payrollPeriodId");

-- CreateIndex
CREATE INDEX "Attendance_payrollEmployeeId_idx" ON "Attendance"("payrollEmployeeId");

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_payrollPeriodId_fkey" FOREIGN KEY ("payrollPeriodId") REFERENCES "Payroll"("payrollId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_payrollEmployeeId_fkey" FOREIGN KEY ("payrollEmployeeId") REFERENCES "PayrollEmployee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payroll" ADD CONSTRAINT "Payroll_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("userId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payroll" ADD CONSTRAINT "Payroll_finalizedByUserId_fkey" FOREIGN KEY ("finalizedByUserId") REFERENCES "User"("userId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollEmployee" ADD CONSTRAINT "PayrollEmployee_payrollId_fkey" FOREIGN KEY ("payrollId") REFERENCES "Payroll"("payrollId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollEmployee" ADD CONSTRAINT "PayrollEmployee_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollEmployee" ADD CONSTRAINT "PayrollEmployee_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("userId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollEmployee" ADD CONSTRAINT "PayrollEmployee_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("userId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollEarning" ADD CONSTRAINT "PayrollEarning_payrollEmployeeId_fkey" FOREIGN KEY ("payrollEmployeeId") REFERENCES "PayrollEmployee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollEarning" ADD CONSTRAINT "PayrollEarning_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("userId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollDeduction" ADD CONSTRAINT "PayrollDeduction_payrollEmployeeId_fkey" FOREIGN KEY ("payrollEmployeeId") REFERENCES "PayrollEmployee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollDeduction" ADD CONSTRAINT "PayrollDeduction_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("userId") ON DELETE SET NULL ON UPDATE CASCADE;
