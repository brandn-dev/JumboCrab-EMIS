"use server";

import {
  ContributionType,
  DeductionFrequency,
  EmployeeDeductionAssignmentStatus,
  EmployeeDeductionWorkflowStatus,
  PayrollEmployeeStatus,
  PayrollReviewDecision,
  PayrollStatus,
  type Prisma,
} from "@prisma/client";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { loadActiveContributionBrackets } from "@/lib/payroll/contribution-brackets";
import {
  listMonthDateKeys,
  resolveEmployeeCompensationSnapshots,
} from "@/lib/payroll/compensation";
import { shiftDateByDays, toDateKeyInTz } from "@/lib/payroll/helpers";
import { getPayrollRunDetails } from "./payroll-runs-action";
import {
  buildMonthlyGovernmentDeductionKey,
  buildEmployeePayrollDraft,
  filterActiveAssignmentsForPeriod,
  groupActiveAssignmentsByEmployee,
  groupAttendanceRowsByEmployee,
} from "./payroll-generation-shared";
import {
  canGeneratePayroll,
  formatEmployeeName,
  listMonthStartKeysInRange,
  normalizeEmployeeIds,
  payrollTypeToFrequency,
  resolvePayrollPeriod,
  toPeriodDateKey,
  revalidatePayrollPages,
} from "./payroll-shared";
import { notifyPayrollReviewers } from "./payroll-notifications";
import type { GeneratePayrollInput, PayrollRunDetail } from "@/types/payroll";

export async function generatePayrollRun(input: GeneratePayrollInput): Promise<{
  success: boolean;
  data?: PayrollRunDetail;
  error?: string;
}> {
  try {
    const session = await getSession();
    if (!canGeneratePayroll(session.role)) {
      return { success: false, error: "Unauthorized" };
    }

    const period = resolvePayrollPeriod({
      payrollPeriodStart: input.payrollPeriodStart,
      payrollPeriodEnd: input.payrollPeriodEnd,
    });
    if (!period.success) {
      return { success: false, error: period.error };
    }

    const scopedEmployeeIds = normalizeEmployeeIds(input.employeeIds);
    if (
      input.employeeIds &&
      input.employeeIds.length > 0 &&
      scopedEmployeeIds.length === 0
    ) {
      return { success: false, error: "No valid employee IDs were provided." };
    }

    const applyGovernmentContributions =
      payrollTypeToFrequency(input.payrollType) !== null;

    const created = await db.$transaction(
      async (tx) => {
        const preparedAt = new Date();
        const payroll = await tx.payroll.create({
          data: {
            payrollPeriodStart: period.startAt,
            payrollPeriodEnd: period.endAt,
            payrollType: input.payrollType,
            status: PayrollStatus.DRAFT,
            managerDecision: PayrollReviewDecision.APPROVED,
            managerReviewedAt: preparedAt,
            managerReviewedByUserId: session.userId ?? null,
            gmDecision: PayrollReviewDecision.PENDING,
            notes: input.notes?.trim() || null,
            createdByUserId: session.userId ?? null,
            generatedAt: preparedAt,
          },
        });

        const employees = await tx.employee.findMany({
          where: {
            isArchived: false,
            currentStatus: {
              notIn: ["INACTIVE", "ENDED"],
            },
            ...(scopedEmployeeIds.length > 0
              ? { employeeId: { in: scopedEmployeeIds } }
              : {}),
          },
          include: {
            governmentId: true,
          },
          orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
        });

        if (scopedEmployeeIds.length > 0) {
          const foundEmployeeIds = new Set(
            employees.map((employee) => employee.employeeId),
          );
          const missing = scopedEmployeeIds.filter(
            (id) => !foundEmployeeIds.has(id),
          );
          if (missing.length > 0) {
            throw new Error(
              `Some selected employees are unavailable or inactive (${missing.length}). Refresh selection and retry.`,
            );
          }
        }

        const employeeIds = employees.map((employee) => employee.employeeId);
        if (employeeIds.length === 0) {
          return payroll.payrollId;
        }

        const periodWhere: Prisma.AttendanceWhereInput = {
          employeeId: { in: employeeIds },
          workDate: { gte: period.startAt, lte: period.endAt },
          payrollPeriodId: null,
        };

        const unlockedUnpaidCount = await tx.attendance.count({
          where: {
            ...periodWhere,
            isLocked: false,
          },
        });
        if (unlockedUnpaidCount > 0) {
          const unlockedSample = await tx.attendance.findMany({
            where: {
              ...periodWhere,
              isLocked: false,
            },
            orderBy: [{ workDate: "asc" }],
            take: 10,
            select: {
              employeeId: true,
              workDate: true,
            },
          });

          const nameByEmployeeId = new Map(
            employees.map((employee) => [
              employee.employeeId,
              formatEmployeeName(employee) || employee.employeeCode,
            ]),
          );

          const preview = unlockedSample
            .map((row) => {
              const employeeName =
                nameByEmployeeId.get(row.employeeId) ?? row.employeeId;
              return `${employeeName} (${toDateKeyInTz(row.workDate)})`;
            })
            .join(", ");

          throw new Error(
            `Cannot generate payroll. Found ${unlockedUnpaidCount} unlocked unpaid attendance row(s) in this period. Lock attendance first.${preview ? ` Sample: ${preview}` : ""}`,
          );
        }

        const broadStart = shiftDateByDays(period.startAt, -2);
        const broadEnd = shiftDateByDays(period.endAt, 2);

        const attendanceRows = await tx.attendance.findMany({
          where: {
            employeeId: { in: employeeIds },
            workDate: { gte: broadStart, lte: broadEnd },
            payrollPeriodId: null,
            isLocked: true,
          },
          orderBy: [{ workDate: "asc" }],
          select: {
            id: true,
            employeeId: true,
            workDate: true,
            status: true,
            isPaidLeave: true,
            paidHoursPerDay: true,
            scheduledStartMinutes: true,
            scheduledEndMinutes: true,
            workedMinutes: true,
            netWorkedMinutes: true,
            lateMinutes: true,
            undertimeMinutes: true,
            overtimeMinutesRaw: true,
            overtimeMinutesApproved: true,
          },
        });

        const attendanceByEmployee = groupAttendanceRowsByEmployee(
          attendanceRows,
          period.startKey,
          period.endKey,
        );

        const assignments = await tx.employeeDeductionAssignment.findMany({
          where: {
            employeeId: { in: employeeIds },
            workflowStatus: EmployeeDeductionWorkflowStatus.APPROVED,
            status: EmployeeDeductionAssignmentStatus.ACTIVE,
            deductionType: { isActive: true },
          },
          include: {
            deductionType: true,
          },
        });

        const activeAssignments = filterActiveAssignmentsForPeriod(
          assignments,
          period.startKey,
          period.endKey,
        );
        const assignmentByEmployee =
          groupActiveAssignmentsByEmployee(activeAssignments);

        const deductionMonthStartKeys = applyGovernmentContributions
          ? listMonthStartKeysInRange(period.startKey, period.endKey)
          : [];

        const compensationDatesByEmployee = new Map<string, Date[]>();
        employees.forEach((employee) => {
          const dates: Date[] = [period.endAt];
          const employeeRows = attendanceByEmployee.get(employee.employeeId) ?? [];
          employeeRows.forEach((row) => {
            dates.push(row.workDate);
          });
          deductionMonthStartKeys.forEach((monthStartKey) => {
            listMonthDateKeys(monthStartKey).forEach((dateKey) => {
              const date = new Date(`${dateKey}T12:00:00.000Z`);
              if (!Number.isNaN(date.getTime())) {
                dates.push(date);
              }
            });
          });
          compensationDatesByEmployee.set(employee.employeeId, dates);
        });

        const [compensationSnapshots, contributionBrackets] =
          await Promise.all([
            resolveEmployeeCompensationSnapshots({
              employeeDates: compensationDatesByEmployee,
              client: tx,
            }),
            applyGovernmentContributions
              ? loadActiveContributionBrackets(period.endAt, tx)
              : Promise.resolve([]),
          ]);

        const oneTimeAssignmentIds = activeAssignments
          .filter(
            (assignment) =>
              assignment.deductionType.frequency === DeductionFrequency.ONE_TIME,
          )
          .map((assignment) => assignment.id);

        const existingOneTimeAssignments = oneTimeAssignmentIds.length
          ? await tx.payrollDeduction.findMany({
              where: {
                assignmentId: { in: oneTimeAssignmentIds },
                isVoided: false,
              },
              select: { assignmentId: true },
            })
          : [];

        const oneTimeAlreadyApplied = new Set(
          existingOneTimeAssignments
            .map((row) => row.assignmentId)
            .filter((value): value is string => Boolean(value)),
        );

        const existingMonthlyGovernmentDeductions = new Set<string>();
        if (applyGovernmentContributions && deductionMonthStartKeys.length > 0) {
          const existingGovernmentDeductions = await tx.payrollDeduction.findMany({
            where: {
              isVoided: false,
              contributionType: {
                in: [
                  ContributionType.SSS,
                  ContributionType.PHILHEALTH,
                  ContributionType.PAGIBIG,
                ],
              },
              payrollEmployee: {
                employeeId: { in: employeeIds },
                payroll: {
                  status: { not: PayrollStatus.VOIDED },
                },
              },
            },
            select: {
              contributionType: true,
              periodStartSnapshot: true,
              periodEndSnapshot: true,
              payrollEmployee: {
                select: {
                  employeeId: true,
                },
              },
            },
          });

          existingGovernmentDeductions.forEach((row) => {
            if (
              !row.contributionType ||
              !row.periodStartSnapshot ||
              !row.periodEndSnapshot
            ) {
              return;
            }
            const contributionType = row.contributionType;
            const rowStartKey = toDateKeyInTz(row.periodStartSnapshot);
            const rowEndKey = toDateKeyInTz(row.periodEndSnapshot);
            listMonthStartKeysInRange(rowStartKey, rowEndKey).forEach(
              (monthStartKey) => {
                existingMonthlyGovernmentDeductions.add(
                  buildMonthlyGovernmentDeductionKey(
                    row.payrollEmployee.employeeId,
                    contributionType,
                    monthStartKey,
                  ),
                );
              },
            );
          });
        }

        for (const employee of employees) {
          const employeeRows = attendanceByEmployee.get(employee.employeeId) ?? [];
          const employeeAssignments =
            assignmentByEmployee.get(employee.employeeId) ?? [];

          const payrollDraft = buildEmployeePayrollDraft({
            employee,
            employeeRows,
            payrollId: payroll.payrollId,
            payrollType: input.payrollType,
            payrollPeriodStart: period.startAt,
            payrollPeriodEnd: period.endAt,
            payrollPeriodStartKey: period.startKey,
            payrollPeriodEndKey: period.endKey,
            applyGovernmentContributions,
            employeeAssignments,
            oneTimeAlreadyApplied,
            compensationSnapshots,
            contributionBrackets,
            deductionMonthStartKeys,
            existingMonthlyGovernmentDeductions,
          });

          const payrollEmployee = await tx.payrollEmployee.create({
            data: {
              payrollId: payroll.payrollId,
              employeeId: employee.employeeId,
              attendanceStart: period.startAt,
              attendanceEnd: period.endAt,
              daysPresent: payrollDraft.daysPresent,
              daysAbsent: payrollDraft.daysAbsent,
              daysLate: payrollDraft.daysLate,
              minutesWorked: payrollDraft.minutesWorked,
              minutesNetWorked: payrollDraft.minutesNetWorked,
              minutesOvertime: payrollDraft.minutesOvertime,
              minutesUndertime: payrollDraft.minutesUndertime,
              positionIdSnapshot: payrollDraft.positionIdSnapshot,
              positionNameSnapshot: payrollDraft.positionNameSnapshot,
              dailyRateSnapshot: payrollDraft.dailyRateSnapshot,
              hourlyRateSnapshot: payrollDraft.hourlyRateSnapshot,
              monthlyRateSnapshot: payrollDraft.monthlyRateSnapshot,
              currencyCodeSnapshot: payrollDraft.currencyCodeSnapshot,
              ratePerMinuteSnapshot: payrollDraft.ratePerMinuteSnapshot,
              grossPay: payrollDraft.grossPay,
              totalEarnings: payrollDraft.totalEarnings,
              totalDeductions: payrollDraft.totalDeductions,
              netPay: payrollDraft.netPay,
              status: PayrollEmployeeStatus.DRAFT,
              createdByUserId: session.userId ?? null,
              updatedByUserId: session.userId ?? null,
            },
          });

          if (employeeRows.length > 0) {
            await tx.attendance.updateMany({
              where: {
                id: { in: employeeRows.map((row) => row.id) },
                payrollPeriodId: null,
                isLocked: true,
              },
              data: {
                payrollPeriodId: payroll.payrollId,
                payrollEmployeeId: payrollEmployee.id,
              },
            });
          }

          if (payrollDraft.earnings.length > 0) {
            await tx.payrollEarning.createMany({
              data: payrollDraft.earnings.map((line) => ({
                payrollEmployeeId: payrollEmployee.id,
                earningType: line.earningType,
                amount: line.amount,
                minutes: line.minutes ?? null,
                rateSnapshot: line.rateSnapshot ?? null,
                source: line.source,
                referenceType: line.referenceType ?? null,
                referenceId: line.referenceId ?? null,
                remarks: line.remarks ?? null,
                createdByUserId: session.userId ?? null,
              })),
            });
          }

          if (payrollDraft.deductions.length > 0) {
            await tx.payrollDeduction.createMany({
              data: payrollDraft.deductions.map((line) => ({
                payrollEmployeeId: payrollEmployee.id,
                deductionType: line.deductionType,
                deductionTypeId: line.deductionTypeId ?? null,
                assignmentId: line.assignmentId ?? null,
                deductionCodeSnapshot: line.deductionCodeSnapshot ?? null,
                deductionNameSnapshot: line.deductionNameSnapshot ?? null,
                contributionType: line.contributionType ?? null,
                bracketIdSnapshot: line.bracketIdSnapshot ?? null,
                bracketReferenceSnapshot: line.bracketReferenceSnapshot ?? null,
                payrollFrequency: line.payrollFrequency ?? null,
                periodStartSnapshot: line.periodStartSnapshot ?? null,
                periodEndSnapshot: line.periodEndSnapshot ?? null,
                compensationBasisSnapshot:
                  line.compensationBasisSnapshot ?? null,
                employeeShareSnapshot: line.employeeShareSnapshot ?? null,
                employerShareSnapshot: line.employerShareSnapshot ?? null,
                baseTaxSnapshot: line.baseTaxSnapshot ?? null,
                marginalRateSnapshot: line.marginalRateSnapshot ?? null,
                quantitySnapshot: line.quantitySnapshot ?? null,
                unitLabelSnapshot: line.unitLabelSnapshot ?? null,
                metadata: line.metadata ?? undefined,
                amount: line.amount,
                minutes: line.minutes ?? null,
                rateSnapshot: line.rateSnapshot ?? null,
                source: line.source,
                referenceType: line.referenceType ?? null,
                referenceId: line.referenceId ?? null,
                remarks: line.remarks ?? null,
                createdByUserId: session.userId ?? null,
              })),
            });
          }
        }

        return payroll.payrollId;
      },
      {
        maxWait: 10_000,
        timeout: 60_000,
      },
    );

    revalidatePayrollPages();
    const detail = await getPayrollRunDetails(created);
    if (detail.success && detail.data) {
      await notifyPayrollReviewers({
        eventType: "PAYROLL_READY_FOR_REVIEW",
        title: "Payroll ready for review",
        message: "A payroll run is ready for General Manager review.",
        actorUserId: session.userId ?? null,
        payrollId: detail.data.payrollId,
      });
    }
    return detail;
  } catch (error) {
    console.error("Error generating payroll run:", error);
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "P2002"
    ) {
      return {
        success: false,
        error:
          "Payroll already exists for this period and payroll type. Open the existing run instead.",
      };
    }
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to generate payroll run",
    };
  }
}

export async function regenerateRejectedPayrollRun(payrollId: string): Promise<{
  success: boolean;
  data?: PayrollRunDetail;
  error?: string;
}> {
  try {
    const session = await getSession();
    if (!canGeneratePayroll(session.role)) {
      return { success: false, error: "Unauthorized" };
    }
    if (!payrollId) return { success: false, error: "Payroll ID is required" };

    const existing = await db.payroll.findUnique({
      where: { payrollId },
      select: {
        payrollId: true,
        payrollPeriodStart: true,
        payrollPeriodEnd: true,
        payrollType: true,
        status: true,
        managerDecision: true,
        gmDecision: true,
        notes: true,
        payrollEmployees: {
          select: {
            employeeId: true,
          },
        },
      },
    });

    if (!existing) {
      return { success: false, error: "Payroll run not found" };
    }

    if (
      existing.status === PayrollStatus.RELEASED ||
      existing.status === PayrollStatus.FINALIZED ||
      existing.status === PayrollStatus.VOIDED
    ) {
      return {
        success: false,
        error: "Released/finalized/voided payroll cannot be regenerated",
      };
    }

    if (
      existing.managerDecision !== PayrollReviewDecision.REJECTED &&
      existing.gmDecision !== PayrollReviewDecision.REJECTED
    ) {
      return {
        success: false,
        error:
          "Only rejected payroll runs can be regenerated from this action.",
      };
    }

    await db.payroll.delete({ where: { payrollId } });

    const regenerated = await generatePayrollRun({
      payrollPeriodStart: toPeriodDateKey(existing.payrollPeriodStart),
      payrollPeriodEnd: toPeriodDateKey(existing.payrollPeriodEnd),
      payrollType: existing.payrollType,
      notes: existing.notes ?? undefined,
      employeeIds: existing.payrollEmployees.map((row) => row.employeeId),
    });

    if (!regenerated.success) {
      throw new Error(regenerated.error || "Failed to regenerate payroll");
    }

    return regenerated;
  } catch (error) {
    console.error("Error regenerating rejected payroll run:", error);
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to regenerate rejected payroll run",
    };
  }
}
