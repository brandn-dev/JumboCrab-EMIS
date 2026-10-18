-- Add face recognition enrollment, verification audit, and attendance settings.

ALTER TABLE "AttendanceSecuritySetting"
  ADD COLUMN "faceRecognitionEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "faceRequiredForQrPunch" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "faceLivenessRequired" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "faceMatchMaxDistance" DECIMAL(4,2) NOT NULL DEFAULT 0.50,
  ADD COLUMN "faceFailureMode" TEXT NOT NULL DEFAULT 'BLOCK';

CREATE TABLE "EmployeeFaceEnrollment" (
  "id" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "embedding" BYTEA NOT NULL,
  "sampleCount" INTEGER NOT NULL DEFAULT 0,
  "modelVersion" TEXT NOT NULL,
  "consentText" TEXT,
  "consentedAt" TIMESTAMP(3),
  "enrolledByUserId" TEXT,
  "revokedByUserId" TEXT,
  "revokedAt" TIMESTAMP(3),
  "revokeReason" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "EmployeeFaceEnrollment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FaceVerificationAttempt" (
  "id" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "attendanceId" TEXT,
  "punchId" TEXT,
  "kioskId" TEXT,
  "kioskNonce" TEXT,
  "punchType" "PUNCH_TYPE",
  "status" TEXT NOT NULL,
  "reason" TEXT,
  "distance" DECIMAL(8,6),
  "threshold" DECIMAL(4,2),
  "livenessPassed" BOOLEAN,
  "livenessPrompt" TEXT,
  "faceCount" INTEGER,
  "modelVersion" TEXT,
  "serviceLatencyMs" INTEGER,
  "details" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "FaceVerificationAttempt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EmployeeFaceEnrollment_employeeId_isActive_createdAt_idx" ON "EmployeeFaceEnrollment"("employeeId", "isActive", "createdAt");
CREATE INDEX "EmployeeFaceEnrollment_enrolledByUserId_createdAt_idx" ON "EmployeeFaceEnrollment"("enrolledByUserId", "createdAt");
CREATE INDEX "EmployeeFaceEnrollment_revokedByUserId_revokedAt_idx" ON "EmployeeFaceEnrollment"("revokedByUserId", "revokedAt");

CREATE INDEX "FaceVerificationAttempt_employeeId_createdAt_idx" ON "FaceVerificationAttempt"("employeeId", "createdAt");
CREATE INDEX "FaceVerificationAttempt_attendanceId_idx" ON "FaceVerificationAttempt"("attendanceId");
CREATE INDEX "FaceVerificationAttempt_punchId_idx" ON "FaceVerificationAttempt"("punchId");
CREATE INDEX "FaceVerificationAttempt_status_createdAt_idx" ON "FaceVerificationAttempt"("status", "createdAt");
CREATE INDEX "FaceVerificationAttempt_kioskId_createdAt_idx" ON "FaceVerificationAttempt"("kioskId", "createdAt");

ALTER TABLE "EmployeeFaceEnrollment"
  ADD CONSTRAINT "EmployeeFaceEnrollment_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "Employee"("employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EmployeeFaceEnrollment"
  ADD CONSTRAINT "EmployeeFaceEnrollment_enrolledByUserId_fkey"
  FOREIGN KEY ("enrolledByUserId") REFERENCES "User"("userId") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "EmployeeFaceEnrollment"
  ADD CONSTRAINT "EmployeeFaceEnrollment_revokedByUserId_fkey"
  FOREIGN KEY ("revokedByUserId") REFERENCES "User"("userId") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "FaceVerificationAttempt"
  ADD CONSTRAINT "FaceVerificationAttempt_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "Employee"("employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FaceVerificationAttempt"
  ADD CONSTRAINT "FaceVerificationAttempt_attendanceId_fkey"
  FOREIGN KEY ("attendanceId") REFERENCES "Attendance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "FaceVerificationAttempt"
  ADD CONSTRAINT "FaceVerificationAttempt_punchId_fkey"
  FOREIGN KEY ("punchId") REFERENCES "Punch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
