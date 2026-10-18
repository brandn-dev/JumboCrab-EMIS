-- CreateEnum
CREATE TYPE "ScheduleSwapRequestStatus" AS ENUM ('PENDING_COWORKER', 'PENDING_MANAGER', 'APPROVED', 'REJECTED', 'DECLINED', 'CANCELLED');

-- CreateTable
CREATE TABLE "ScheduleSwapRequest" (
    "id" TEXT NOT NULL,
    "requesterEmployeeId" TEXT NOT NULL,
    "coworkerEmployeeId" TEXT NOT NULL,
    "workDate" TIMESTAMP(3) NOT NULL,
    "requesterShiftIdSnapshot" INTEGER,
    "requesterShiftCodeSnapshot" TEXT,
    "requesterShiftNameSnapshot" TEXT,
    "requesterStartMinutesSnapshot" INTEGER,
    "requesterEndMinutesSnapshot" INTEGER,
    "requesterSpansMidnightSnapshot" BOOLEAN NOT NULL DEFAULT false,
    "coworkerShiftIdSnapshot" INTEGER,
    "coworkerShiftCodeSnapshot" TEXT,
    "coworkerShiftNameSnapshot" TEXT,
    "coworkerStartMinutesSnapshot" INTEGER,
    "coworkerEndMinutesSnapshot" INTEGER,
    "coworkerSpansMidnightSnapshot" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "status" "ScheduleSwapRequestStatus" NOT NULL DEFAULT 'PENDING_COWORKER',
    "coworkerRemarks" TEXT,
    "coworkerRespondedAt" TIMESTAMP(3),
    "managerRemarks" TEXT,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduleSwapRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduleSwapRequest_requesterEmployeeId_status_submittedAt_idx" ON "ScheduleSwapRequest"("requesterEmployeeId", "status", "submittedAt");

-- CreateIndex
CREATE INDEX "ScheduleSwapRequest_coworkerEmployeeId_status_submittedAt_idx" ON "ScheduleSwapRequest"("coworkerEmployeeId", "status", "submittedAt");

-- CreateIndex
CREATE INDEX "ScheduleSwapRequest_status_submittedAt_idx" ON "ScheduleSwapRequest"("status", "submittedAt");

-- CreateIndex
CREATE INDEX "ScheduleSwapRequest_workDate_status_idx" ON "ScheduleSwapRequest"("workDate", "status");

-- AddForeignKey
ALTER TABLE "ScheduleSwapRequest" ADD CONSTRAINT "ScheduleSwapRequest_requesterEmployeeId_fkey" FOREIGN KEY ("requesterEmployeeId") REFERENCES "Employee"("employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleSwapRequest" ADD CONSTRAINT "ScheduleSwapRequest_coworkerEmployeeId_fkey" FOREIGN KEY ("coworkerEmployeeId") REFERENCES "Employee"("employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleSwapRequest" ADD CONSTRAINT "ScheduleSwapRequest_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("userId") ON DELETE SET NULL ON UPDATE CASCADE;
