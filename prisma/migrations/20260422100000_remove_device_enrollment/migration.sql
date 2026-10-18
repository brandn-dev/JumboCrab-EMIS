-- Remove browser device enrollment and token/fingerprint tracking.

DROP TABLE IF EXISTS "DeviceRegistration";

ALTER TABLE "AttendanceSecuritySetting"
  DROP COLUMN IF EXISTS "deviceTokenTrackingEnabled",
  DROP COLUMN IF EXISTS "fingerprintTrackingEnabled";

ALTER TABLE "Punch"
  DROP COLUMN IF EXISTS "deviceId";

DROP INDEX IF EXISTS "AttendanceDeviceLog_deviceToken_createdAt_idx";
DROP INDEX IF EXISTS "AttendanceDeviceLog_fingerprint_createdAt_idx";

ALTER TABLE "AttendanceDeviceLog"
  DROP COLUMN IF EXISTS "deviceToken",
  DROP COLUMN IF EXISTS "fingerprint";

ALTER TABLE "AttendanceDeviceLog"
  RENAME TO "AttendanceContextLog";

ALTER INDEX IF EXISTS "AttendanceDeviceLog_pkey"
  RENAME TO "AttendanceContextLog_pkey";
ALTER INDEX IF EXISTS "AttendanceDeviceLog_attendanceId_idx"
  RENAME TO "AttendanceContextLog_attendanceId_idx";
ALTER INDEX IF EXISTS "AttendanceDeviceLog_employeeId_createdAt_idx"
  RENAME TO "AttendanceContextLog_employeeId_createdAt_idx";

ALTER TABLE "AttendanceContextLog"
  RENAME CONSTRAINT "AttendanceDeviceLog_attendanceId_fkey"
  TO "AttendanceContextLog_attendanceId_fkey";
ALTER TABLE "AttendanceContextLog"
  RENAME CONSTRAINT "AttendanceDeviceLog_employeeId_fkey"
  TO "AttendanceContextLog_employeeId_fkey";
