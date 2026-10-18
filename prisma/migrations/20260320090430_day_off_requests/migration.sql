-- CreateEnum
CREATE TYPE "DayOffRequestStatus" AS ENUM ('PENDING_MANAGER', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "DayOffRequest" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "workDate" TIMESTAMP(3) NOT NULL,
    "currentShiftIdSnapshot" INTEGER,
    "currentShiftCodeSnapshot" TEXT,
    "currentShiftNameSnapshot" TEXT,
    "currentStartMinutesSnapshot" INTEGER,
    "currentEndMinutesSnapshot" INTEGER,
    "currentSpansMidnightSnapshot" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "status" "DayOffRequestStatus" NOT NULL DEFAULT 'PENDING_MANAGER',
    "managerRemarks" TEXT,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DayOffRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DayOffRequest_employeeId_status_submittedAt_idx" ON "DayOffRequest"("employeeId", "status", "submittedAt");

-- CreateIndex
CREATE INDEX "DayOffRequest_status_submittedAt_idx" ON "DayOffRequest"("status", "submittedAt");

-- CreateIndex
CREATE INDEX "DayOffRequest_workDate_status_idx" ON "DayOffRequest"("workDate", "status");

-- CreateIndex
CREATE INDEX "DayOffRequest_reviewedByUserId_reviewedAt_idx" ON "DayOffRequest"("reviewedByUserId", "reviewedAt");

-- AddForeignKey
ALTER TABLE "DayOffRequest" ADD CONSTRAINT "DayOffRequest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DayOffRequest" ADD CONSTRAINT "DayOffRequest_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("userId") ON DELETE SET NULL ON UPDATE CASCADE;
