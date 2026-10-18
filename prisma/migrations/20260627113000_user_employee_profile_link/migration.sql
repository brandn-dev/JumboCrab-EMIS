-- Link one Supervisor/Manager account to the employee profile used by that person's Employee account.
ALTER TABLE "User" ADD COLUMN "employeeProfileId" TEXT;

CREATE UNIQUE INDEX "User_employeeProfileId_key" ON "User"("employeeProfileId");

ALTER TABLE "User"
ADD CONSTRAINT "User_employeeProfileId_fkey"
FOREIGN KEY ("employeeProfileId") REFERENCES "Employee"("employeeId")
ON DELETE SET NULL ON UPDATE CASCADE;
