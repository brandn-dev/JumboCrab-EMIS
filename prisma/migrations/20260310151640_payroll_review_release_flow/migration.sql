/*
  Warnings:

  - You are about to drop the column `finalizedAt` on the `Payroll` table. All the data in the column will be lost.
  - You are about to drop the column `finalizedByUserId` on the `Payroll` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "PayrollReviewDecision" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterEnum
ALTER TYPE "PayrollEmployeeStatus" ADD VALUE 'RELEASED';

-- AlterEnum
ALTER TYPE "PayrollStatus" ADD VALUE 'RELEASED';

-- DropForeignKey
ALTER TABLE "Payroll" DROP CONSTRAINT "Payroll_finalizedByUserId_fkey";

-- AlterTable
ALTER TABLE "Payroll" DROP COLUMN "finalizedAt",
DROP COLUMN "finalizedByUserId",
ADD COLUMN     "gmDecision" "PayrollReviewDecision" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "gmReviewRemarks" TEXT,
ADD COLUMN     "gmReviewedAt" TIMESTAMP(3),
ADD COLUMN     "gmReviewedByUserId" TEXT,
ADD COLUMN     "managerDecision" "PayrollReviewDecision" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "managerReviewRemarks" TEXT,
ADD COLUMN     "managerReviewedAt" TIMESTAMP(3),
ADD COLUMN     "managerReviewedByUserId" TEXT,
ADD COLUMN     "releasedAt" TIMESTAMP(3),
ADD COLUMN     "releasedByUserId" TEXT;

-- CreateIndex
CREATE INDEX "Payroll_managerDecision_gmDecision_status_idx" ON "Payroll"("managerDecision", "gmDecision", "status");

-- AddForeignKey
ALTER TABLE "Payroll" ADD CONSTRAINT "Payroll_managerReviewedByUserId_fkey" FOREIGN KEY ("managerReviewedByUserId") REFERENCES "User"("userId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payroll" ADD CONSTRAINT "Payroll_gmReviewedByUserId_fkey" FOREIGN KEY ("gmReviewedByUserId") REFERENCES "User"("userId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payroll" ADD CONSTRAINT "Payroll_releasedByUserId_fkey" FOREIGN KEY ("releasedByUserId") REFERENCES "User"("userId") ON DELETE SET NULL ON UPDATE CASCADE;
