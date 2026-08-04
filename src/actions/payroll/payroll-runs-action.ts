"use server";

import { PayrollStatus, PayrollType } from "@prisma/client";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { toIsoString, toNumber, toNumberOrNull } from "@/lib/payroll/helpers";
import {
  canViewPayrollRuns,
  formatEmployeeName,
  serializeDeductionLine,
  serializeEarningLine,
  serializePayrollRunSummary,
} from "./payroll-shared";
import type { PayrollRunDetail, PayrollRunSummary } from "@/types/payroll";

export async function listPayrollRuns(input?: {
  status?: Array<PayrollStatus>;
  payrollType?: PayrollType;
  limit?: number;
}): Promise<{
  success: boolean;
  data?: PayrollRunSummary[];
  error?: string;
}> {
  try {
    const session = await getSession();
    if (!canViewPayrollRuns(session.role)) {
      return { success: false, error: "Unauthorized" };
    }

    const rows = await db.payroll.findMany({
      where: {
        status: input?.status?.length ? { in: input.status } : undefined,
        payrollType: input?.payrollType ?? undefined,
      },
      select: {
        payrollId: true,
        payrollPeriodStart: true,
        payrollPeriodEnd: true,
        payrollType: true,
        status: true,
        managerDecision: true,
        gmDecision: true,
        generatedAt: true,
        managerReviewedAt: true,
        gmReviewedAt: true,
        releasedAt: true,
        managerReviewRemarks: true,
        gmReviewRemarks: true,
        notes: true,
        createdBy: { select: { username: true } },
        managerReviewedBy: { select: { username: true } },
        gmReviewedBy: { select: { username: true } },
        releasedBy: { select: { username: true } },
      },
      orderBy: [{ payrollPeriodStart: "desc" }, { createdAt: "desc" }],
      take: input?.limit && input.limit > 0 ? input.limit : undefined,
    });

    if (rows.length === 0) {
      return { success: true, data: [] };
    }

    const aggregates = await db.payrollEmployee.groupBy({
      by: ["payrollId"],
      where: {
        payrollId: {
          in: rows.map((row) => row.payrollId),
        },
      },
      _count: {
        _all: true,
      },
      _sum: {
        grossPay: true,
        totalDeductions: true,
        netPay: true,
      },
    });

    const aggregateByPayrollId = new Map(
      aggregates.map((row) => [row.payrollId, row]),
    );

    return {
      success: true,
      data: rows.map((row): PayrollRunSummary => {
        const aggregate = aggregateByPayrollId.get(row.payrollId);

        return {
          payrollId: row.payrollId,
          payrollPeriodStart: row.payrollPeriodStart.toISOString(),
          payrollPeriodEnd: row.payrollPeriodEnd.toISOString(),
          payrollType: row.payrollType,
          status: row.status,
          managerDecision: row.managerDecision,
          gmDecision: row.gmDecision,
          generatedAt: row.generatedAt.toISOString(),
          managerReviewedAt: toIsoString(row.managerReviewedAt),
          gmReviewedAt: toIsoString(row.gmReviewedAt),
          releasedAt: toIsoString(row.releasedAt),
          managerReviewRemarks: row.managerReviewRemarks ?? null,
          gmReviewRemarks: row.gmReviewRemarks ?? null,
          notes: row.notes ?? null,
          createdByName: row.createdBy?.username ?? null,
          managerReviewedByName: row.managerReviewedBy?.username ?? null,
          gmReviewedByName: row.gmReviewedBy?.username ?? null,
          releasedByName: row.releasedBy?.username ?? null,
          employeeCount: aggregate?._count._all ?? 0,
          grossTotal: toNumber(aggregate?._sum.grossPay, 0),
          deductionsTotal: toNumber(aggregate?._sum.totalDeductions, 0),
          netTotal: toNumber(aggregate?._sum.netPay, 0),
        };
      }),
    };
  } catch (error) {
    console.error("Error listing payroll runs:", error);
    return { success: false, error: "Failed to load payroll runs" };
  }
}

export async function getPayrollRunDetails(payrollId: string): Promise<{
  success: boolean;
  data?: PayrollRunDetail;
  error?: string;
}> {
  try {
    const session = await getSession();
    if (!canViewPayrollRuns(session.role)) {
      return { success: false, error: "Unauthorized" };
    }
    if (!payrollId) return { success: false, error: "Payroll ID is required" };

    const row = await db.payroll.findUnique({
      where: { payrollId },
      include: {
        createdBy: { select: { username: true } },
        managerReviewedBy: { select: { username: true } },
        gmReviewedBy: { select: { username: true } },
        releasedBy: { select: { username: true } },
        payrollEmployees: {
          include: {
            employee: {
              select: {
                employeeId: true,
                employeeCode: true,
                firstName: true,
                lastName: true,
              },
            },
            earnings: {
              orderBy: [{ createdAt: "asc" }],
              select: {
                id: true,
                earningType: true,
                amount: true,
                minutes: true,
                rateSnapshot: true,
                source: true,
                referenceType: true,
                referenceId: true,
                remarks: true,
                isVoided: true,
              },
            },
            deductions: {
              orderBy: [{ createdAt: "asc" }],
              select: {
                id: true,
                deductionType: true,
                deductionTypeId: true,
                deductionCodeSnapshot: true,
                deductionNameSnapshot: true,
                assignmentId: true,
                contributionType: true,
                bracketIdSnapshot: true,
                bracketReferenceSnapshot: true,
                payrollFrequency: true,
                periodStartSnapshot: true,
                periodEndSnapshot: true,
                compensationBasisSnapshot: true,
                employeeShareSnapshot: true,
                employerShareSnapshot: true,
                baseTaxSnapshot: true,
                marginalRateSnapshot: true,
                quantitySnapshot: true,
                unitLabelSnapshot: true,
                metadata: true,
                amount: true,
                minutes: true,
                rateSnapshot: true,
                source: true,
                referenceType: true,
                referenceId: true,
                remarks: true,
                isVoided: true,
              },
            },
          },
          orderBy: [
            { employee: { lastName: "asc" } },
            { employee: { firstName: "asc" } },
          ],
        },
      },
    });

    if (!row) return { success: false, error: "Payroll run not found" };

    const summary = serializePayrollRunSummary(row);
    const employees = row.payrollEmployees.map((employeeRow) => ({
      id: employeeRow.id,
      employeeId: employeeRow.employeeId,
      employeeCode: employeeRow.employee.employeeCode,
      employeeName:
        formatEmployeeName(employeeRow.employee) || "Unknown employee",
      status: employeeRow.status,
      attendanceStart: employeeRow.attendanceStart.toISOString(),
      attendanceEnd: employeeRow.attendanceEnd.toISOString(),
      daysPresent: employeeRow.daysPresent,
      daysAbsent: employeeRow.daysAbsent,
      daysLate: employeeRow.daysLate,
      minutesWorked: employeeRow.minutesWorked,
      minutesNetWorked: employeeRow.minutesNetWorked,
      minutesOvertime: employeeRow.minutesOvertime,
      minutesUndertime: employeeRow.minutesUndertime,
      positionIdSnapshot: employeeRow.positionIdSnapshot ?? null,
      positionNameSnapshot: employeeRow.positionNameSnapshot ?? null,
      dailyRateSnapshot: toNumberOrNull(employeeRow.dailyRateSnapshot),
      hourlyRateSnapshot: toNumberOrNull(employeeRow.hourlyRateSnapshot),
      monthlyRateSnapshot: toNumberOrNull(employeeRow.monthlyRateSnapshot),
      currencyCodeSnapshot: employeeRow.currencyCodeSnapshot ?? null,
      ratePerMinuteSnapshot: toNumberOrNull(employeeRow.ratePerMinuteSnapshot),
      grossPay: toNumber(employeeRow.grossPay, 0),
      totalEarnings: toNumber(employeeRow.totalEarnings, 0),
      totalDeductions: toNumber(employeeRow.totalDeductions, 0),
      netPay: toNumber(employeeRow.netPay, 0),
      notes: employeeRow.notes ?? null,
      earnings: employeeRow.earnings.map(serializeEarningLine),
      deductions: employeeRow.deductions.map(serializeDeductionLine),
    }));

    return {
      success: true,
      data: {
        ...summary,
        employees,
      },
    };
  } catch (error) {
    console.error("Error fetching payroll run details:", error);
    return { success: false, error: "Failed to load payroll run details" };
  }
}
