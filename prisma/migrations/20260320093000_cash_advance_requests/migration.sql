-- CreateEnum
CREATE TYPE "public"."CashAdvanceRequestStatus" AS ENUM (
  'PENDING_MANAGER',
  'APPROVED',
  'REJECTED',
  'CANCELLED'
);

-- CreateTable
CREATE TABLE "public"."CashAdvanceRequest" (
  "id" TEXT NOT NULL,
  "employeeId" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL,
  "repaymentPerPayroll" DECIMAL(12,2) NOT NULL,
  "preferredStartDate" TIMESTAMP(3) NOT NULL,
  "reason" TEXT,
  "status" "public"."CashAdvanceRequestStatus" NOT NULL DEFAULT 'PENDING_MANAGER',
  "managerRemarks" TEXT,
  "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedByUserId" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "deductionAssignmentId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CashAdvanceRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CashAdvanceRequest_deductionAssignmentId_key"
ON "public"."CashAdvanceRequest"("deductionAssignmentId");

-- CreateIndex
CREATE INDEX "CashAdvanceRequest_employeeId_status_submittedAt_idx"
ON "public"."CashAdvanceRequest"("employeeId", "status", "submittedAt");

-- CreateIndex
CREATE INDEX "CashAdvanceRequest_status_submittedAt_idx"
ON "public"."CashAdvanceRequest"("status", "submittedAt");

-- CreateIndex
CREATE INDEX "CashAdvanceRequest_reviewedByUserId_reviewedAt_idx"
ON "public"."CashAdvanceRequest"("reviewedByUserId", "reviewedAt");

-- AddForeignKey
ALTER TABLE "public"."CashAdvanceRequest"
ADD CONSTRAINT "CashAdvanceRequest_employeeId_fkey"
FOREIGN KEY ("employeeId") REFERENCES "public"."Employee"("employeeId")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CashAdvanceRequest"
ADD CONSTRAINT "CashAdvanceRequest_reviewedByUserId_fkey"
FOREIGN KEY ("reviewedByUserId") REFERENCES "public"."User"("userId")
ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CashAdvanceRequest"
ADD CONSTRAINT "CashAdvanceRequest_deductionAssignmentId_fkey"
FOREIGN KEY ("deductionAssignmentId") REFERENCES "public"."EmployeeDeductionAssignment"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
