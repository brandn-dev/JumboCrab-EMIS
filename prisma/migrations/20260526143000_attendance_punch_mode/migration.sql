ALTER TABLE "AttendanceSecuritySetting"
ADD COLUMN IF NOT EXISTS "attendancePunchMode" TEXT NOT NULL DEFAULT 'QR_ONLY';

UPDATE "AttendanceSecuritySetting"
SET "attendancePunchMode" = CASE
  WHEN "faceRecognitionEnabled" = TRUE
   AND "faceRequiredForQrPunch" = TRUE
    THEN 'EMPLOYEE_QR_KIOSK_FACE'
  ELSE 'QR_ONLY'
END
WHERE "attendancePunchMode" IS NULL
   OR "attendancePunchMode" NOT IN (
     'QR_ONLY',
     'EMPLOYEE_QR_KIOSK_FACE',
     'SEARCH_EMPLOYEE_KIOSK_FACE'
   );
