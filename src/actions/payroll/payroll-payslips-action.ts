"use server";

import { PayrollStatus, Roles } from "@prisma/client";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { toIsoString, toNumber, toNumberOrNull } from "@/lib/payroll/helpers";
import {
  canViewPayslips,
  formatEmployeeName,
  serializeDeductionLine,
  serializeEarningLine,
} from "./payroll-shared";
import type {
  PayrollEmployeeAttendanceRow,
  PayrollPayslipDetail,
  PayrollPayslipSummary,
} from "@/types/payroll";

export async function listPayrollPayslips(input?: {
  employeeId?: string;
}): Promise<{
  success: boolean;
  data?: PayrollPayslipSummary[];
  error?: string;
}> {
  try {
    const session = await getSession();
    if (!canViewPayslips(session.role)) {
      return { success: false, error: "Unauthorized" };
    }

    const employee =
      session.role === Roles.Employee && session.userId
        ? await db.employee.findUnique({
            where: { userId: session.userId },
            select: { employeeId: true },
          })
        : null;

    if (session.role === Roles.Employee && !employee?.employeeId) {
      return { success: false, error: "Employee profile not found" };
    }

    const targetEmployeeId =
      session.role === Roles.Employee
        ? employee?.employeeId
        : input?.employeeId?.trim() || undefined;

    const rows = await db.payrollEmployee.findMany({
      where: {
        employeeId: targetEmployeeId,
        payroll: {
          status:
            session.role === Roles.Employee
              ? PayrollStatus.RELEASED
              : undefined,
        },
      },
      include: {
        payroll: {
          select: {
            payrollId: true,
            payrollPeriodStart: true,
            payrollPeriodEnd: true,
            payrollType: true,
            status: true,
            generatedAt: true,
            releasedAt: true,
          },
        },
        employee: {
          select: {
            employeeId: true,
            employeeCode: true,
            firstName: true,
            lastName: true,
          },
        },
      },
      orderBy: [
        { payroll: { payrollPeriodStart: "desc" } },
        { employee: { lastName: "asc" } },
      ],
    });

    const data: PayrollPayslipSummary[] = rows.map((row) => ({
      payrollEmployeeId: row.id,
      payrollId: row.payrollId,
      payrollPeriodStart: row.payroll.payrollPeriodStart.toISOString(),
      payrollPeriodEnd: row.payroll.payrollPeriodEnd.toISOString(),
      payrollType: row.payroll.payrollType,
      payrollStatus: row.payroll.status,
      generatedAt: row.payroll.generatedAt.toISOString(),
      releasedAt: toIsoString(row.payroll.releasedAt),
      employeeId: row.employeeId,
      employeeCode: row.employee.employeeCode,
      employeeName: formatEmployeeName(row.employee),
      grossPay: toNumber(row.grossPay, 0),
      totalEarnings: toNumber(row.totalEarnings, 0),
      totalDeductions: toNumber(row.totalDeductions, 0),
      netPay: toNumber(row.netPay, 0),
      status: row.status,
    }));

    return { success: true, data };
  } catch (error) {
    console.error("Error listing payroll payslips:", error);
    return { success: false, error: "Failed to load payslips" };
  }
}

export async function getPayrollEmployeeAttendance(
  payrollEmployeeId: string,
): Promise<{
  success: boolean;
  data?: PayrollEmployeeAttendanceRow[];
  error?: string;
}> {
  try {
    const session = await getSession();
    if (!canViewPayslips(session.role)) {
      return { success: false, error: "Unauthorized" };
    }
    if (!payrollEmployeeId) {
      return { success: false, error: "Payroll employee ID is required" };
    }

    const owner = await db.payrollEmployee.findUnique({
      where: { id: payrollEmployeeId },
      select: {
        id: true,
        employee: {
          select: {
            employeeId: true,
            userId: true,
          },
        },
        payroll: {
          select: {
            status: true,
          },
        },
      },
    });

    if (!owner) {
      return { success: false, error: "Payroll employee row not found" };
    }

    if (session.role === Roles.Employee) {
      if (!session.userId || owner.employee.userId !== session.userId) {
        return { success: false, error: "Unauthorized" };
      }
      if (owner.payroll.status !== PayrollStatus.RELEASED) {
        return {
          success: false,
          error:
            "Attendance breakdown is available after payroll release only.",
        };
      }
    }

    const rows = await db.attendance.findMany({
      where: { payrollEmployeeId },
      include: {
        expectedShift: {
          select: {
            name: true,
          },
        },
      },
      orderBy: [{ workDate: "asc" }],
    });

    const data: PayrollEmployeeAttendanceRow[] = rows.map((row) => ({
      id: row.id,
      workDate: row.workDate.toISOString(),
      status: row.status,
      expectedShiftName: row.expectedShift?.name ?? null,
      scheduledStartMinutes: row.scheduledStartMinutes ?? null,
      scheduledEndMinutes: row.scheduledEndMinutes ?? null,
      actualInAt: toIsoString(row.actualInAt),
      actualOutAt: toIsoString(row.actualOutAt),
      workedMinutes: row.workedMinutes ?? null,
      netWorkedMinutes: row.netWorkedMinutes ?? null,
      lateMinutes: row.lateMinutes ?? 0,
      undertimeMinutes: row.undertimeMinutes ?? 0,
      overtimeMinutes:
        row.overtimeMinutesApproved > 0
          ? row.overtimeMinutesApproved
          : (row.overtimeMinutesRaw ?? 0),
    }));

    return { success: true, data };
  } catch (error) {
    console.error("Error loading payroll employee attendance:", error);
    return {
      success: false,
      error: "Failed to load payroll employee attendance breakdown",
    };
  }
}

export async function getPayrollPayslip(payrollEmployeeId: string): Promise<{
  success: boolean;
  data?: PayrollPayslipDetail;
  error?: string;
}> {
  try {
    const session = await getSession();
    if (!canViewPayslips(session.role)) {
      return { success: false, error: "Unauthorized" };
    }
    if (!payrollEmployeeId) {
      return { success: false, error: "Payslip ID is required" };
    }

    const row = await db.payrollEmployee.findUnique({
      where: { id: payrollEmployeeId },
      include: {
        payroll: {
          select: {
            payrollId: true,
            payrollPeriodStart: true,
            payrollPeriodEnd: true,
            payrollType: true,
            status: true,
            generatedAt: true,
            releasedAt: true,
          },
        },
        employee: {
          select: {
            employeeId: true,
            employeeCode: true,
            firstName: true,
            lastName: true,
            userId: true,
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
    });

    if (!row) return { success: false, error: "Payslip not found" };

    if (session.role === Roles.Employee) {
      if (row.employee.userId !== session.userId) {
        return { success: false, error: "Unauthorized" };
      }
      if (row.payroll.status !== PayrollStatus.RELEASED) {
        return {
          success: false,
          error: "Payslip is not yet available. Payroll is not released.",
        };
      }
    }

    return {
      success: true,
      data: {
        payrollEmployeeId: row.id,
        payrollId: row.payrollId,
        payrollPeriodStart: row.payroll.payrollPeriodStart.toISOString(),
        payrollPeriodEnd: row.payroll.payrollPeriodEnd.toISOString(),
        payrollType: row.payroll.payrollType,
        payrollStatus: row.payroll.status,
        generatedAt: row.payroll.generatedAt.toISOString(),
        releasedAt: toIsoString(row.payroll.releasedAt),
        employeeId: row.employeeId,
        employeeCode: row.employee.employeeCode,
        employeeName: formatEmployeeName(row.employee),
        grossPay: toNumber(row.grossPay, 0),
        totalEarnings: toNumber(row.totalEarnings, 0),
        totalDeductions: toNumber(row.totalDeductions, 0),
        netPay: toNumber(row.netPay, 0),
        status: row.status,
        attendanceStart: row.attendanceStart.toISOString(),
        attendanceEnd: row.attendanceEnd.toISOString(),
        daysPresent: row.daysPresent,
        daysAbsent: row.daysAbsent,
        daysLate: row.daysLate,
        minutesWorked: row.minutesWorked,
        minutesNetWorked: row.minutesNetWorked,
        minutesOvertime: row.minutesOvertime,
        minutesUndertime: row.minutesUndertime,
        positionIdSnapshot: row.positionIdSnapshot ?? null,
        positionNameSnapshot: row.positionNameSnapshot ?? null,
        dailyRateSnapshot: toNumberOrNull(row.dailyRateSnapshot),
        hourlyRateSnapshot: toNumberOrNull(row.hourlyRateSnapshot),
        monthlyRateSnapshot: toNumberOrNull(row.monthlyRateSnapshot),
        currencyCodeSnapshot: row.currencyCodeSnapshot ?? null,
        ratePerMinuteSnapshot: toNumberOrNull(row.ratePerMinuteSnapshot),
        notes: row.notes ?? null,
        earnings: row.earnings.map(serializeEarningLine),
        deductions: row.deductions.map(serializeDeductionLine),
      },
    };
  } catch (error) {
    console.error("Error loading payroll payslip:", error);
    return { success: false, error: "Failed to load payslip" };
  }
}
