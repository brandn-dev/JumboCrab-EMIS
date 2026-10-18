-- CreateEnum
CREATE TYPE "ScheduleChangeRequestStatus" AS ENUM ('PENDING_MANAGER', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "ScheduleChangeRequest" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "workDate" TIMESTAMP(3) NOT NULL,
    "currentShiftIdSnapshot" INTEGER,
    "currentShiftCodeSnapshot" TEXT,
    "currentShiftNameSnapshot" TEXT,
    "currentStartMinutesSnapshot" INTEGER,
    "currentEndMinutesSnapshot" INTEGER,
    "currentSpansMidnightSnapshot" BOOLEAN NOT NULL DEFAULT false,
    "requestedShiftId" INTEGER NOT NULL,
    "requestedShiftCodeSnapshot" TEXT NOT NULL,
    "requestedShiftNameSnapshot" TEXT NOT NULL,
    "requestedStartMinutesSnapshot" INTEGER NOT NULL,
    "requestedEndMinutesSnapshot" INTEGER NOT NULL,
    "requestedSpansMidnightSnapshot" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "status" "ScheduleChangeRequestStatus" NOT NULL DEFAULT 'PENDING_MANAGER',
    "managerRemarks" TEXT,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduleChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduleChangeRequest_employeeId_status_submittedAt_idx" ON "ScheduleChangeRequest"("employeeId", "status", "submittedAt");

-- CreateIndex
CREATE INDEX "ScheduleChangeRequest_status_submittedAt_idx" ON "ScheduleChangeRequest"("status", "submittedAt");

-- CreateIndex
CREATE INDEX "ScheduleChangeRequest_workDate_status_idx" ON "ScheduleChangeRequest"("workDate", "status");

-- CreateIndex
CREATE INDEX "ScheduleChangeRequest_reviewedByUserId_reviewedAt_idx" ON "ScheduleChangeRequest"("reviewedByUserId", "reviewedAt");

-- AddForeignKey
ALTER TABLE "ScheduleChangeRequest" ADD CONSTRAINT "ScheduleChangeRequest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleChangeRequest" ADD CONSTRAINT "ScheduleChangeRequest_requestedShiftId_fkey" FOREIGN KEY ("requestedShiftId") REFERENCES "Shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleChangeRequest" ADD CONSTRAINT "ScheduleChangeRequest_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("userId") ON DELETE SET NULL ON UPDATE CASCADE;
