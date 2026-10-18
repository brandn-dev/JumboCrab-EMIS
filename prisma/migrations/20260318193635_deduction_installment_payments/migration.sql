CREATE TABLE "EmployeeDeductionPayment" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "paymentDate" TIMESTAMP(3) NOT NULL,
    "remarks" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeeDeductionPayment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EmployeeDeductionPayment_assignmentId_paymentDate_idx"
ON "EmployeeDeductionPayment"("assignmentId", "paymentDate");

CREATE INDEX "EmployeeDeductionPayment_createdByUserId_createdAt_idx"
ON "EmployeeDeductionPayment"("createdByUserId", "createdAt");

ALTER TABLE "EmployeeDeductionPayment"
ADD CONSTRAINT "EmployeeDeductionPayment_assignmentId_fkey"
FOREIGN KEY ("assignmentId") REFERENCES "EmployeeDeductionAssignment"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EmployeeDeductionPayment"
ADD CONSTRAINT "EmployeeDeductionPayment_createdByUserId_fkey"
FOREIGN KEY ("createdByUserId") REFERENCES "User"("userId")
ON DELETE SET NULL ON UPDATE CASCADE;
