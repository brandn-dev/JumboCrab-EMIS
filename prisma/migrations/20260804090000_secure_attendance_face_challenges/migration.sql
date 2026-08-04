CREATE TYPE "AttendanceFaceChallengeStatus" AS ENUM ('PENDING', 'PROCESSING', 'PASSED', 'FAILED', 'EXPIRED');

ALTER TABLE "AttendanceSecuritySetting"
  ADD COLUMN "activeFaceChallengeRequired" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "identityContinuityRequired" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "passiveAntiSpoofRequired" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "faceChallengeExpiresSeconds" INTEGER NOT NULL DEFAULT 20,
  ADD COLUMN "faceChallengeActionCount" INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN "faceChallengeMaxFrames" INTEGER NOT NULL DEFAULT 24,
  ADD COLUMN "faceChallengeMaxPayloadBytes" INTEGER NOT NULL DEFAULT 1250000,
  ADD COLUMN "faceChallengeMaxAttemptsPerMinute" INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN "faceChallengeMaxFailures" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN "faceChallengeCooldownSeconds" INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN "faceContinuityFrameCount" INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN "faceContinuityMaxDistance" DECIMAL(4,2) NOT NULL DEFAULT 0.35;

CREATE TABLE "AttendanceFaceChallenge" (
  "id" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "punchId" TEXT,
  "kioskId" TEXT NOT NULL,
  "kioskBindingHash" TEXT NOT NULL,
  "nonceHash" TEXT NOT NULL,
  "actions" JSONB NOT NULL,
  "expectedPunchType" "PUNCH_TYPE" NOT NULL,
  "status" "AttendanceFaceChallengeStatus" NOT NULL DEFAULT 'PENDING',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "processingStartedAt" TIMESTAMP(3),
  "usedAt" TIMESTAMP(3),
  "failureReason" TEXT,
  "frameSequenceHash" TEXT,
  "details" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AttendanceFaceChallenge_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AttendanceQrRedemption" (
  "tokenHash" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "challengeId" TEXT,
  "punchId" TEXT,
  "kioskBindingHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AttendanceQrRedemption_pkey" PRIMARY KEY ("tokenHash")
);

ALTER TABLE "FaceVerificationAttempt" ADD COLUMN "challengeId" TEXT;

CREATE UNIQUE INDEX "AttendanceFaceChallenge_punchId_key" ON "AttendanceFaceChallenge"("punchId");
CREATE UNIQUE INDEX "AttendanceFaceChallenge_frameSequenceHash_key" ON "AttendanceFaceChallenge"("frameSequenceHash");
CREATE INDEX "AttendanceFaceChallenge_employeeId_status_createdAt_idx" ON "AttendanceFaceChallenge"("employeeId", "status", "createdAt");
CREATE INDEX "AttendanceFaceChallenge_kioskBindingHash_createdAt_idx" ON "AttendanceFaceChallenge"("kioskBindingHash", "createdAt");
CREATE INDEX "AttendanceFaceChallenge_status_expiresAt_idx" ON "AttendanceFaceChallenge"("status", "expiresAt");
CREATE UNIQUE INDEX "AttendanceQrRedemption_challengeId_key" ON "AttendanceQrRedemption"("challengeId");
CREATE UNIQUE INDEX "AttendanceQrRedemption_punchId_key" ON "AttendanceQrRedemption"("punchId");
CREATE INDEX "AttendanceQrRedemption_employeeId_createdAt_idx" ON "AttendanceQrRedemption"("employeeId", "createdAt");
CREATE INDEX "AttendanceQrRedemption_kioskBindingHash_createdAt_idx" ON "AttendanceQrRedemption"("kioskBindingHash", "createdAt");
CREATE INDEX "AttendanceQrRedemption_expiresAt_idx" ON "AttendanceQrRedemption"("expiresAt");
CREATE INDEX "FaceVerificationAttempt_challengeId_idx" ON "FaceVerificationAttempt"("challengeId");

ALTER TABLE "AttendanceFaceChallenge" ADD CONSTRAINT "AttendanceFaceChallenge_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("employeeId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttendanceFaceChallenge" ADD CONSTRAINT "AttendanceFaceChallenge_punchId_fkey" FOREIGN KEY ("punchId") REFERENCES "Punch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AttendanceQrRedemption" ADD CONSTRAINT "AttendanceQrRedemption_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("employeeId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttendanceQrRedemption" ADD CONSTRAINT "AttendanceQrRedemption_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES "AttendanceFaceChallenge"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AttendanceQrRedemption" ADD CONSTRAINT "AttendanceQrRedemption_punchId_fkey" FOREIGN KEY ("punchId") REFERENCES "Punch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FaceVerificationAttempt" ADD CONSTRAINT "FaceVerificationAttempt_challengeId_fkey" FOREIGN KEY ("challengeId") REFERENCES "AttendanceFaceChallenge"("id") ON DELETE SET NULL ON UPDATE CASCADE;
