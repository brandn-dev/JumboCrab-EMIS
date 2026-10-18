CREATE TYPE "EmployeeDeductionWorkflowStatus" AS ENUM ('DRAFT', 'APPROVED', 'REJECTED');

ALTER TABLE "EmployeeDeductionAssignment"
ADD COLUMN "workflowStatus" "EmployeeDeductionWorkflowStatus" NOT NULL DEFAULT 'APPROVED',
ADD COLUMN "submittedAt" TIMESTAMP(3),
ADD COLUMN "reviewedByUserId" TEXT,
ADD COLUMN "reviewedAt" TIMESTAMP(3),
ADD COLUMN "reviewRemarks" TEXT;

CREATE INDEX "EmployeeDeductionAssignment_workflowStatus_employeeId_effec_idx"
ON "EmployeeDeductionAssignment"("workflowStatus", "employeeId", "effectiveFrom");

CREATE INDEX "EmployeeDeductionAssignment_assignedByUserId_workflowSta_idx"
ON "EmployeeDeductionAssignment"("assignedByUserId", "workflowStatus", "updatedAt");

ALTER TABLE "EmployeeDeductionAssignment"
ADD CONSTRAINT "EmployeeDeductionAssignment_reviewedByUserId_fkey"
FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("userId")
ON DELETE SET NULL
ON UPDATE CASCADE;
