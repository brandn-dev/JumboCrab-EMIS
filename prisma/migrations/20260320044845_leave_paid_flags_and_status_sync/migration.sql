-- AlterTable
ALTER TABLE "Attendance" ADD COLUMN     "isPaidLeave" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "leaveRequestId" TEXT;

-- CreateIndex
CREATE INDEX "Attendance_leaveRequestId_idx" ON "Attendance"("leaveRequestId");

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_leaveRequestId_fkey" FOREIGN KEY ("leaveRequestId") REFERENCES "LeaveRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
