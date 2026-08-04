ALTER TABLE "AttendanceSecuritySetting"
ALTER COLUMN "faceMatchMaxDistance" SET DEFAULT 0.35;

UPDATE "AttendanceSecuritySetting"
SET "faceMatchMaxDistance" = 0.35
WHERE "faceMatchMaxDistance" = 0.42;
