ALTER TABLE "EmployeeViolation"
ADD COLUMN IF NOT EXISTS "appealPaperSecuredAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "appealPaperFilledAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "appealPaperSubmittedToManagerAt" TIMESTAMP(3);
