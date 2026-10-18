-- CreateEnum
CREATE TYPE "VIOLATION_STATUS" AS ENUM ('PENDING', 'DEDUCTED', 'WAIVED');

-- CreateEnum
CREATE TYPE "VIOLATION_TYPE" AS ENUM ('AWOL', 'LATE', 'ABSENT');

-- CreateEnum
CREATE TYPE "ATTENDANCE_STATUS" AS ENUM ('PRESENT', 'ABSENT', 'LATE', 'INCOMPLETE', 'OVERTIME', 'HOLIDAY', 'REST');

-- CreateEnum
CREATE TYPE "PUNCH_TYPE" AS ENUM ('TIME_IN', 'TIME_OUT', 'BREAK_OUT', 'BREAK_IN');

-- CreateEnum
CREATE TYPE "GENDER" AS ENUM ('MALE', 'FEMALE');

-- CreateEnum
CREATE TYPE "CIVIL_STATUS" AS ENUM ('SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED');

-- CreateEnum
CREATE TYPE "EMPLOYMENT_STATUS" AS ENUM ('REGULAR', 'PROBATIONARY', 'TRAINING');

-- CreateEnum
CREATE TYPE "CURRENT_STATUS" AS ENUM ('ACTIVE', 'ON_LEAVE', 'VACATION', 'SICK_LEAVE', 'INACTIVE', 'ENDED');

-- CreateEnum
CREATE TYPE "SUFFIX" AS ENUM ('JR', 'SR', 'II', 'III', 'IV');

-- CreateEnum
CREATE TYPE "Roles" AS ENUM ('Admin', 'GeneralManager', 'Manager', 'Supervisor', 'Clerk', 'Employee');

-- CreateTable
CREATE TABLE "User" (
    "userId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "salt" TEXT NOT NULL,
    "role" "Roles" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isDisabled" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "User_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "Employee" (
    "employeeId" TEXT NOT NULL,
    "employeeCode" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "middleName" TEXT,
    "suffix" "SUFFIX",
    "sex" "GENDER" NOT NULL,
    "civilStatus" "CIVIL_STATUS" NOT NULL,
    "nationality" TEXT,
    "birthdate" TIMESTAMP(3) NOT NULL,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postalCode" TEXT,
    "country" TEXT,
    "img" TEXT,
    "startDate" TIMESTAMP(3) NOT NULL,
    "isEnded" BOOLEAN DEFAULT false,
    "endDate" TIMESTAMP(3),
    "employmentStatus" "EMPLOYMENT_STATUS" NOT NULL,
    "currentStatus" "CURRENT_STATUS" NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "emergencyContactName" TEXT,
    "emergencyContactRelationship" TEXT,
    "emergencyContactPhone" TEXT,
    "emergencyContactEmail" TEXT,
    "dailyRate" DECIMAL(10,2),
    "description" TEXT,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT,
    "departmentId" TEXT,
    "positionId" TEXT,
    "supervisorUserId" TEXT,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("employeeId")
);

-- CreateTable
CREATE TABLE "Department" (
    "departmentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("departmentId")
);

-- CreateTable
CREATE TABLE "Position" (
    "positionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "departmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("positionId")
);

-- CreateTable
CREATE TABLE "GovernmentId" (
    "governmentId" TEXT NOT NULL,
    "sssNumber" TEXT,
    "philHealthNumber" TEXT,
    "tinNumber" TEXT,
    "pagIbigNumber" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "employeeId" TEXT NOT NULL,

    CONSTRAINT "GovernmentId_pkey" PRIMARY KEY ("governmentId")
);

-- CreateTable
CREATE TABLE "EmployeeContribution" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "sssEe" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "sssEr" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "isSssActive" BOOLEAN NOT NULL DEFAULT true,
    "philHealthEe" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "philHealthEr" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "isPhilHealthActive" BOOLEAN NOT NULL DEFAULT true,
    "pagIbigEe" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "pagIbigEr" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "isPagIbigActive" BOOLEAN NOT NULL DEFAULT true,
    "withholdingEe" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "withholdingEr" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "isWithholdingActive" BOOLEAN NOT NULL DEFAULT true,
    "effectiveDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "updatedById" TEXT,

    CONSTRAINT "EmployeeContribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shift" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startMinutes" INTEGER NOT NULL,
    "endMinutes" INTEGER NOT NULL,
    "spansMidnight" BOOLEAN NOT NULL DEFAULT false,
    "breakStartMinutes" INTEGER,
    "breakEndMinutes" INTEGER,
    "breakMinutesUnpaid" INTEGER NOT NULL DEFAULT 0,
    "paidHoursPerDay" DECIMAL(5,2) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WeeklyPattern" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sunShiftId" INTEGER,
    "monShiftId" INTEGER,
    "tueShiftId" INTEGER,
    "wedShiftId" INTEGER,
    "thuShiftId" INTEGER,
    "friShiftId" INTEGER,
    "satShiftId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WeeklyPattern_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeePatternAssignment" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "effectiveDate" TIMESTAMP(3) NOT NULL,
    "patternId" TEXT NOT NULL,
    "sunShiftIdSnapshot" INTEGER,
    "monShiftIdSnapshot" INTEGER,
    "tueShiftIdSnapshot" INTEGER,
    "wedShiftIdSnapshot" INTEGER,
    "thuShiftIdSnapshot" INTEGER,
    "friShiftIdSnapshot" INTEGER,
    "satShiftIdSnapshot" INTEGER,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeePatternAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeShiftOverride" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "workDate" TIMESTAMP(3) NOT NULL,
    "shiftId" INTEGER,
    "source" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeShiftOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attendance" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "workDate" TIMESTAMP(3) NOT NULL,
    "status" "ATTENDANCE_STATUS" NOT NULL,
    "expectedShiftId" INTEGER,
    "scheduledStartMinutes" INTEGER,
    "scheduledEndMinutes" INTEGER,
    "paidHoursPerDay" DECIMAL(5,2),
    "actualInAt" TIMESTAMP(3),
    "actualOutAt" TIMESTAMP(3),
    "workedMinutes" INTEGER,
    "breakMinutes" INTEGER NOT NULL DEFAULT 0,
    "deductedBreakMinutes" INTEGER NOT NULL DEFAULT 0,
    "netWorkedMinutes" INTEGER,
    "breakCount" INTEGER NOT NULL DEFAULT 0,
    "lateMinutes" INTEGER NOT NULL DEFAULT 0,
    "undertimeMinutes" INTEGER NOT NULL DEFAULT 0,
    "overtimeMinutesRaw" INTEGER NOT NULL DEFAULT 0,
    "overtimeMinutesApproved" INTEGER NOT NULL DEFAULT 0,
    "nightMinutes" INTEGER NOT NULL DEFAULT 0,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "payrollPeriodId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Punch" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "attendanceId" TEXT,
    "punchTime" TIMESTAMP(3) NOT NULL,
    "punchType" "PUNCH_TYPE" NOT NULL,
    "source" TEXT,
    "deviceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Punch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Violation" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "violationType" "VIOLATION_TYPE" NOT NULL,
    "violationDate" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(65,30),
    "paidAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "remainingAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "installmentAmount" DECIMAL(65,30) NOT NULL,
    "status" "VIOLATION_STATUS" NOT NULL,
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "employeeEmployeeId" TEXT,

    CONSTRAINT "Violation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_createdAt_idx" ON "User"("createdAt");

-- CreateIndex
CREATE INDEX "User_role_username_idx" ON "User"("role", "username");

-- CreateIndex
CREATE INDEX "User_isDisabled_username_idx" ON "User"("isDisabled", "username");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_employeeCode_key" ON "Employee"("employeeCode");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_userId_key" ON "Employee"("userId");

-- CreateIndex
CREATE INDEX "Employee_isArchived_employeeCode_idx" ON "Employee"("isArchived", "employeeCode");

-- CreateIndex
CREATE INDEX "Employee_departmentId_idx" ON "Employee"("departmentId");

-- CreateIndex
CREATE INDEX "Employee_positionId_idx" ON "Employee"("positionId");

-- CreateIndex
CREATE UNIQUE INDEX "Department_name_key" ON "Department"("name");

-- CreateIndex
CREATE INDEX "Department_isActive_name_idx" ON "Department"("isActive", "name");

-- CreateIndex
CREATE INDEX "Position_isActive_departmentId_name_idx" ON "Position"("isActive", "departmentId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Position_name_departmentId_key" ON "Position"("name", "departmentId");

-- CreateIndex
CREATE UNIQUE INDEX "GovernmentId_employeeId_key" ON "GovernmentId"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeContribution_employeeId_key" ON "EmployeeContribution"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "Shift_code_key" ON "Shift"("code");

-- CreateIndex
CREATE INDEX "Shift_name_idx" ON "Shift"("name");

-- CreateIndex
CREATE UNIQUE INDEX "WeeklyPattern_code_key" ON "WeeklyPattern"("code");

-- CreateIndex
CREATE INDEX "WeeklyPattern_name_idx" ON "WeeklyPattern"("name");

-- CreateIndex
CREATE INDEX "EmployeePatternAssignment_employeeId_effectiveDate_idx" ON "EmployeePatternAssignment"("employeeId", "effectiveDate");

-- CreateIndex
CREATE INDEX "EmployeeShiftOverride_workDate_idx" ON "EmployeeShiftOverride"("workDate");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeShiftOverride_employeeId_workDate_key" ON "EmployeeShiftOverride"("employeeId", "workDate");

-- CreateIndex
CREATE INDEX "Attendance_employeeId_workDate_idx" ON "Attendance"("employeeId", "workDate");

-- CreateIndex
CREATE INDEX "Attendance_workDate_idx" ON "Attendance"("workDate");

-- CreateIndex
CREATE INDEX "Attendance_status_workDate_idx" ON "Attendance"("status", "workDate");

-- CreateIndex
CREATE INDEX "Attendance_isLocked_workDate_idx" ON "Attendance"("isLocked", "workDate");

-- CreateIndex
CREATE UNIQUE INDEX "Attendance_employeeId_workDate_key" ON "Attendance"("employeeId", "workDate");

-- CreateIndex
CREATE INDEX "Punch_employeeId_punchTime_idx" ON "Punch"("employeeId", "punchTime");

-- CreateIndex
CREATE INDEX "Punch_punchTime_idx" ON "Punch"("punchTime");

-- CreateIndex
CREATE INDEX "Punch_attendanceId_idx" ON "Punch"("attendanceId");

-- CreateIndex
CREATE INDEX "Violation_createdAt_idx" ON "Violation"("createdAt");

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("userId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("departmentId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position"("positionId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_supervisorUserId_fkey" FOREIGN KEY ("supervisorUserId") REFERENCES "User"("userId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("departmentId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GovernmentId" ADD CONSTRAINT "GovernmentId_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeContribution" ADD CONSTRAINT "EmployeeContribution_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeContribution" ADD CONSTRAINT "EmployeeContribution_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("userId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeContribution" ADD CONSTRAINT "EmployeeContribution_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("userId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeeklyPattern" ADD CONSTRAINT "WeeklyPattern_sunShiftId_fkey" FOREIGN KEY ("sunShiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeeklyPattern" ADD CONSTRAINT "WeeklyPattern_monShiftId_fkey" FOREIGN KEY ("monShiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeeklyPattern" ADD CONSTRAINT "WeeklyPattern_tueShiftId_fkey" FOREIGN KEY ("tueShiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeeklyPattern" ADD CONSTRAINT "WeeklyPattern_wedShiftId_fkey" FOREIGN KEY ("wedShiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeeklyPattern" ADD CONSTRAINT "WeeklyPattern_thuShiftId_fkey" FOREIGN KEY ("thuShiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeeklyPattern" ADD CONSTRAINT "WeeklyPattern_friShiftId_fkey" FOREIGN KEY ("friShiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeeklyPattern" ADD CONSTRAINT "WeeklyPattern_satShiftId_fkey" FOREIGN KEY ("satShiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeePatternAssignment" ADD CONSTRAINT "EmployeePatternAssignment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeePatternAssignment" ADD CONSTRAINT "EmployeePatternAssignment_patternId_fkey" FOREIGN KEY ("patternId") REFERENCES "WeeklyPattern"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeShiftOverride" ADD CONSTRAINT "EmployeeShiftOverride_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeShiftOverride" ADD CONSTRAINT "EmployeeShiftOverride_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_expectedShiftId_fkey" FOREIGN KEY ("expectedShiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Punch" ADD CONSTRAINT "Punch_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Punch" ADD CONSTRAINT "Punch_attendanceId_fkey" FOREIGN KEY ("attendanceId") REFERENCES "Attendance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Violation" ADD CONSTRAINT "Violation_employeeEmployeeId_fkey" FOREIGN KEY ("employeeEmployeeId") REFERENCES "Employee"("employeeId") ON DELETE SET NULL ON UPDATE CASCADE;

