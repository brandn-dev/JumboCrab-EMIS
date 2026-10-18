-- AlterTable
ALTER TABLE "GovernmentId"
ADD COLUMN "isSssIncludedInPayroll" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "isPhilHealthIncludedInPayroll" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "isWithholdingIncludedInPayroll" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "isPagIbigIncludedInPayroll" BOOLEAN NOT NULL DEFAULT true;
