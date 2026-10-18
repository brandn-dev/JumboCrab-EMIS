ALTER TYPE "AiScheduleAssignmentSource" ADD VALUE IF NOT EXISTS 'GENERATOR';

CREATE TYPE "ScheduleCoverageRulePriority" AS ENUM ('HARD', 'SOFT');

CREATE TABLE "ScheduleCoverageRule" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "departmentId" TEXT,
  "positionId" TEXT,
  "shiftId" INTEGER,
  "weekday" INTEGER NOT NULL,
  "minimumStaff" INTEGER NOT NULL,
  "maximumStaff" INTEGER,
  "priority" "ScheduleCoverageRulePriority" NOT NULL DEFAULT 'HARD',
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "effectiveFrom" TIMESTAMP(3),
  "effectiveTo" TIMESTAMP(3),
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ScheduleCoverageRule_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ScheduleCoverageRule_weekday_check" CHECK ("weekday" BETWEEN 1 AND 7),
  CONSTRAINT "ScheduleCoverageRule_minimumStaff_check" CHECK ("minimumStaff" >= 0),
  CONSTRAINT "ScheduleCoverageRule_maximumStaff_check" CHECK ("maximumStaff" IS NULL OR "maximumStaff" >= "minimumStaff"),
  CONSTRAINT "ScheduleCoverageRule_effectiveDates_check" CHECK ("effectiveFrom" IS NULL OR "effectiveTo" IS NULL OR "effectiveFrom" <= "effectiveTo")
);

CREATE INDEX "ScheduleCoverageRule_isActive_weekday_departmentId_positionId_shiftId_idx"
  ON "ScheduleCoverageRule"("isActive", "weekday", "departmentId", "positionId", "shiftId");
CREATE INDEX "ScheduleCoverageRule_effectiveFrom_effectiveTo_idx"
  ON "ScheduleCoverageRule"("effectiveFrom", "effectiveTo");

ALTER TABLE "ScheduleCoverageRule"
  ADD CONSTRAINT "ScheduleCoverageRule_departmentId_fkey"
    FOREIGN KEY ("departmentId") REFERENCES "Department"("departmentId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ScheduleCoverageRule_positionId_fkey"
    FOREIGN KEY ("positionId") REFERENCES "Position"("positionId") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ScheduleCoverageRule_shiftId_fkey"
    FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ScheduleCoverageRule_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;
