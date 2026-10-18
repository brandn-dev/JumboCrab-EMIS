-- CreateEnum
CREATE TYPE "SuspiciousAttendanceSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "SuspiciousAttendanceStatus" AS ENUM ('PENDING', 'VALID', 'REVIEWED', 'REJECTED');

-- AlterTable
ALTER TABLE "Attendance" ADD COLUMN     "flaggedAt" TIMESTAMP(3),
ADD COLUMN     "isFlagged" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "AttendanceSecuritySetting" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "deviceTokenTrackingEnabled" BOOLEAN NOT NULL DEFAULT true,
    "fingerprintTrackingEnabled" BOOLEAN NOT NULL DEFAULT true,
    "gpsValidationEnabled" BOOLEAN NOT NULL DEFAULT false,
    "suspiciousTimeWindowMinutes" INTEGER NOT NULL DEFAULT 3,
    "allowOnlyOneRegisteredDevicePerEmployee" BOOLEAN NOT NULL DEFAULT false,
    "requireManagerReviewForFlaggedLogs" BOOLEAN NOT NULL DEFAULT true,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttendanceSecuritySetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceRegistration" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "deviceToken" TEXT,
    "fingerprint" TEXT,
    "deviceLabel" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceDeviceLog" (
    "id" TEXT NOT NULL,
    "attendanceId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "deviceToken" TEXT,
    "fingerprint" TEXT,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "isFlagged" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceDeviceLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SuspiciousAttendanceLog" (
    "id" TEXT NOT NULL,
    "attendanceId" TEXT,
    "deviceLogId" TEXT,
    "employeeId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "severity" "SuspiciousAttendanceSeverity" NOT NULL,
    "detectedByRule" TEXT NOT NULL,
    "status" "SuspiciousAttendanceStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "remarks" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SuspiciousAttendanceLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AttendanceSecuritySetting_updatedByUserId_updatedAt_idx" ON "AttendanceSecuritySetting"("updatedByUserId", "updatedAt");

-- CreateIndex
CREATE INDEX "DeviceRegistration_employeeId_isActive_lastSeenAt_idx" ON "DeviceRegistration"("employeeId", "isActive", "lastSeenAt");

-- CreateIndex
CREATE INDEX "DeviceRegistration_deviceToken_idx" ON "DeviceRegistration"("deviceToken");

-- CreateIndex
CREATE INDEX "DeviceRegistration_fingerprint_idx" ON "DeviceRegistration"("fingerprint");

-- CreateIndex
CREATE INDEX "DeviceRegistration_employeeId_fingerprint_idx" ON "DeviceRegistration"("employeeId", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceRegistration_employeeId_deviceToken_key" ON "DeviceRegistration"("employeeId", "deviceToken");

-- CreateIndex
CREATE INDEX "AttendanceDeviceLog_attendanceId_idx" ON "AttendanceDeviceLog"("attendanceId");

-- CreateIndex
CREATE INDEX "AttendanceDeviceLog_employeeId_createdAt_idx" ON "AttendanceDeviceLog"("employeeId", "createdAt");

-- CreateIndex
CREATE INDEX "AttendanceDeviceLog_deviceToken_createdAt_idx" ON "AttendanceDeviceLog"("deviceToken", "createdAt");

-- CreateIndex
CREATE INDEX "AttendanceDeviceLog_fingerprint_createdAt_idx" ON "AttendanceDeviceLog"("fingerprint", "createdAt");

-- CreateIndex
CREATE INDEX "AttendanceDeviceLog_isFlagged_createdAt_idx" ON "AttendanceDeviceLog"("isFlagged", "createdAt");

-- CreateIndex
CREATE INDEX "SuspiciousAttendanceLog_attendanceId_idx" ON "SuspiciousAttendanceLog"("attendanceId");

-- CreateIndex
CREATE INDEX "SuspiciousAttendanceLog_deviceLogId_idx" ON "SuspiciousAttendanceLog"("deviceLogId");

-- CreateIndex
CREATE INDEX "SuspiciousAttendanceLog_employeeId_createdAt_idx" ON "SuspiciousAttendanceLog"("employeeId", "createdAt");

-- CreateIndex
CREATE INDEX "SuspiciousAttendanceLog_status_createdAt_idx" ON "SuspiciousAttendanceLog"("status", "createdAt");

-- CreateIndex
CREATE INDEX "SuspiciousAttendanceLog_severity_createdAt_idx" ON "SuspiciousAttendanceLog"("severity", "createdAt");

-- CreateIndex
CREATE INDEX "SuspiciousAttendanceLog_reviewedByUserId_reviewedAt_idx" ON "SuspiciousAttendanceLog"("reviewedByUserId", "reviewedAt");

-- CreateIndex
CREATE INDEX "Attendance_isFlagged_workDate_idx" ON "Attendance"("isFlagged", "workDate");

-- AddForeignKey
ALTER TABLE "AttendanceSecuritySetting" ADD CONSTRAINT "AttendanceSecuritySetting_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("userId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceRegistration" ADD CONSTRAINT "DeviceRegistration_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceDeviceLog" ADD CONSTRAINT "AttendanceDeviceLog_attendanceId_fkey" FOREIGN KEY ("attendanceId") REFERENCES "Attendance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceDeviceLog" ADD CONSTRAINT "AttendanceDeviceLog_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuspiciousAttendanceLog" ADD CONSTRAINT "SuspiciousAttendanceLog_attendanceId_fkey" FOREIGN KEY ("attendanceId") REFERENCES "Attendance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuspiciousAttendanceLog" ADD CONSTRAINT "SuspiciousAttendanceLog_deviceLogId_fkey" FOREIGN KEY ("deviceLogId") REFERENCES "AttendanceDeviceLog"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuspiciousAttendanceLog" ADD CONSTRAINT "SuspiciousAttendanceLog_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuspiciousAttendanceLog" ADD CONSTRAINT "SuspiciousAttendanceLog_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("userId") ON DELETE SET NULL ON UPDATE CASCADE;
