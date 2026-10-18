ALTER TABLE "Shift"
ADD COLUMN "colorHex" TEXT,
ADD COLUMN "isDayOff" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "WeeklySchedule" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "monShiftId" INTEGER,
    "tueShiftId" INTEGER,
    "wedShiftId" INTEGER,
    "thuShiftId" INTEGER,
    "friShiftId" INTEGER,
    "satShiftId" INTEGER,
    "sunShiftId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WeeklySchedule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WeeklySchedule_employeeId_weekStart_key"
ON "WeeklySchedule"("employeeId", "weekStart");

CREATE INDEX "WeeklySchedule_weekStart_idx"
ON "WeeklySchedule"("weekStart");

CREATE UNIQUE INDEX "Shift_single_day_off_idx"
ON "Shift" ("isDayOff")
WHERE "isDayOff" = true;

ALTER TABLE "WeeklySchedule"
ADD CONSTRAINT "WeeklySchedule_employeeId_fkey"
FOREIGN KEY ("employeeId") REFERENCES "Employee"("employeeId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WeeklySchedule"
ADD CONSTRAINT "WeeklySchedule_monShiftId_fkey"
FOREIGN KEY ("monShiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WeeklySchedule"
ADD CONSTRAINT "WeeklySchedule_tueShiftId_fkey"
FOREIGN KEY ("tueShiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WeeklySchedule"
ADD CONSTRAINT "WeeklySchedule_wedShiftId_fkey"
FOREIGN KEY ("wedShiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WeeklySchedule"
ADD CONSTRAINT "WeeklySchedule_thuShiftId_fkey"
FOREIGN KEY ("thuShiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WeeklySchedule"
ADD CONSTRAINT "WeeklySchedule_friShiftId_fkey"
FOREIGN KEY ("friShiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WeeklySchedule"
ADD CONSTRAINT "WeeklySchedule_satShiftId_fkey"
FOREIGN KEY ("satShiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WeeklySchedule"
ADD CONSTRAINT "WeeklySchedule_sunShiftId_fkey"
FOREIGN KEY ("sunShiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;

DROP TABLE "EmployeePatternAssignment";
DROP TABLE "WeeklyPattern";
