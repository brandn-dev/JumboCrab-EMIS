-- Remove suspicious attendance log storage and review state.
DROP TABLE IF EXISTS "SuspiciousAttendanceLog";

ALTER TABLE "Attendance"
  DROP COLUMN IF EXISTS "isFlagged",
  DROP COLUMN IF EXISTS "flaggedAt";

ALTER TABLE "AttendanceDeviceLog"
  DROP COLUMN IF EXISTS "isFlagged";

ALTER TABLE "AttendanceSecuritySetting"
  DROP COLUMN IF EXISTS "suspiciousTimeWindowMinutes",
  DROP COLUMN IF EXISTS "requireManagerReviewForFlaggedLogs",
  DROP COLUMN IF EXISTS "allowOnlyOneRegisteredDevicePerEmployee";

DROP TYPE IF EXISTS "SuspiciousAttendanceSeverity";
DROP TYPE IF EXISTS "SuspiciousAttendanceStatus";
