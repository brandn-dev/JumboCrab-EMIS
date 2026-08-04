import {
  ATTENDANCE_STATUS,
  ContributionType,
  DeductionAmountMode,
  DeductionFrequency,
  PayrollDeductionType,
  PayrollEarningType,
  PayrollLineSource,
  PayrollReferenceType,
  type PayrollFrequency,
  type Prisma,
} from "@prisma/client";
import {
  computePayableAmountFromNetMinutes,
  computeRatePerMinute,
  computeScheduledPaidMinutes,
} from "@/lib/attendance";
import {
  calculateContributionFromBracket,
  findApplicableContributionBracket,
  type ContributionBracketRecord,
} from "@/lib/payroll/contribution-brackets";
import {
  buildCompensationLookupKey,
  listMonthDateKeys,
  type CompensationSnapshot,
} from "@/lib/payroll/compensation";
import {
  roundCurrency,
  roundSixDecimals,
  toDateKeyInTz,
  toNumber,
  toPercent,
} from "@/lib/payroll/helpers";
import {
  OVERTIME_RATE_MULTIPLIER,
  payrollTypeToFrequency,
  UNDERTIME_DEDUCTION_MULTIPLIER,
} from "./payroll-shared";

export type PayrollGenerationEmployee = Prisma.EmployeeGetPayload<{
  include: {
    governmentId: true;
  };
}>;

export type PayrollGenerationAssignment =
  Prisma.EmployeeDeductionAssignmentGetPayload<{
    include: {
      deductionType: true;
    };
  }>;

export type PayrollGenerationAttendanceRow = {
  id: string;
  employeeId: string;
  workDate: Date;
  status: string;
  isPaidLeave: boolean | null;
  paidHoursPerDay: Prisma.Decimal | number | null;
  scheduledStartMinutes: number | null;
  scheduledEndMinutes: number | null;
  workedMinutes: number | null;
  netWorkedMinutes: number | null;
  lateMinutes: number | null;
  undertimeMinutes: number | null;
  overtimeMinutesRaw: number | null;
  overtimeMinutesApproved: number | null;
};

export type PayrollEarningDraft = {
  earningType: PayrollEarningType;
  amount: number;
  minutes?: number;
  rateSnapshot?: number;
  source: PayrollLineSource;
  referenceType?: PayrollReferenceType;
  referenceId?: string;
  remarks?: string;
};

export type PayrollDeductionDraft = {
  deductionType: PayrollDeductionType;
  deductionTypeId?: string;
  assignmentId?: string;
  deductionCodeSnapshot?: string;
  deductionNameSnapshot?: string;
  contributionType?: ContributionType;
  bracketIdSnapshot?: string;
  bracketReferenceSnapshot?: string;
  payrollFrequency?: PayrollFrequency;
  periodStartSnapshot?: Date;
  periodEndSnapshot?: Date;
  compensationBasisSnapshot?: number;
  employeeShareSnapshot?: number;
  employerShareSnapshot?: number;
  baseTaxSnapshot?: number;
  marginalRateSnapshot?: number;
  quantitySnapshot?: number;
  unitLabelSnapshot?: string;
  metadata?: Prisma.InputJsonValue;
  amount: number;
  minutes?: number;
  rateSnapshot?: number;
  source: PayrollLineSource;
  referenceType?: PayrollReferenceType;
  referenceId?: string;
  remarks?: string;
};

export type EmployeePayrollDraft = {
  daysPresent: number;
  daysAbsent: number;
  daysLate: number;
  minutesWorked: number;
  minutesNetWorked: number;
  minutesOvertime: number;
  minutesUndertime: number;
  positionIdSnapshot: string | null;
  positionNameSnapshot: string | null;
  dailyRateSnapshot: number | null;
  hourlyRateSnapshot: number | null;
  monthlyRateSnapshot: number | null;
  currencyCodeSnapshot: string | null;
  ratePerMinuteSnapshot: number | null;
  grossPay: number;
  totalEarnings: number;
  totalDeductions: number;
  netPay: number;
  earnings: PayrollEarningDraft[];
  deductions: PayrollDeductionDraft[];
};

export const groupAttendanceRowsByEmployee = (
  rows: PayrollGenerationAttendanceRow[],
  periodStartKey: string,
  periodEndKey: string,
) => {
  const attendanceByEmployee = new Map<
    string,
    PayrollGenerationAttendanceRow[]
  >();

  rows.forEach((row) => {
    const key = toDateKeyInTz(row.workDate);
    if (key < periodStartKey || key > periodEndKey) return;
    if (!attendanceByEmployee.has(row.employeeId)) {
      attendanceByEmployee.set(row.employeeId, []);
    }
    attendanceByEmployee.get(row.employeeId)!.push(row);
  });

  return attendanceByEmployee;
};

export const filterActiveAssignmentsForPeriod = (
  assignments: PayrollGenerationAssignment[],
  periodStartKey: string,
  periodEndKey: string,
) =>
  assignments.filter((assignment) => {
    const fromKey = toDateKeyInTz(assignment.effectiveFrom);
    const toKey = assignment.effectiveTo
      ? toDateKeyInTz(assignment.effectiveTo)
      : null;
    return fromKey <= periodEndKey && (!toKey || toKey >= periodStartKey);
  });

export const groupActiveAssignmentsByEmployee = (
  assignments: PayrollGenerationAssignment[],
) => {
  const assignmentByEmployee = new Map<string, PayrollGenerationAssignment[]>();

  assignments.forEach((assignment) => {
    if (!assignmentByEmployee.has(assignment.employeeId)) {
      assignmentByEmployee.set(assignment.employeeId, []);
    }
    assignmentByEmployee.get(assignment.employeeId)!.push(assignment);
  });

  return assignmentByEmployee;
};

export const buildMonthlyGovernmentDeductionKey = (
  employeeId: string,
  contributionType: ContributionType,
  monthStartKey: string,
) => `${employeeId}:${contributionType}:${monthStartKey}`;

const getEmployeeLabel = (employee: {
  employeeCode: string;
  firstName: string;
  lastName: string;
}) =>
  [employee.firstName, employee.lastName].filter(Boolean).join(" ").trim() ||
  employee.employeeCode;

const getRequiredCompensationSnapshot = (input: {
  employee: PayrollGenerationEmployee;
  compensationSnapshots: Map<string, CompensationSnapshot | null>;
  dateKey: string;
}) => {
  const snapshot = input.compensationSnapshots.get(
    buildCompensationLookupKey(input.employee.employeeId, input.dateKey),
  );

  if (!snapshot) {
    throw new Error(
      `Cannot generate payroll. ${getEmployeeLabel(input.employee)} has no active position assignment on ${input.dateKey}.`,
    );
  }

  if (snapshot.dailyRate == null || snapshot.monthlyRate == null) {
    throw new Error(
      `Cannot generate payroll. ${getEmployeeLabel(input.employee)} has no active position rate on ${input.dateKey}.`,
    );
  }

  return snapshot;
};

const calculateMonthlyContributionBase = (input: {
  employee: PayrollGenerationEmployee;
  monthStartKey: string;
  compensationSnapshots: Map<string, CompensationSnapshot | null>;
}) => {
  const monthDateKeys = listMonthDateKeys(input.monthStartKey);
  if (monthDateKeys.length === 0) {
    throw new Error(`Invalid contribution month ${input.monthStartKey}`);
  }

  const monthlyRates = monthDateKeys.map((dateKey) => {
    const snapshot = getRequiredCompensationSnapshot({
      employee: input.employee,
      compensationSnapshots: input.compensationSnapshots,
      dateKey,
    });
    return snapshot.monthlyRate ?? 0;
  });

  return roundCurrency(
    monthlyRates.reduce((sum, value) => sum + value, 0) / monthDateKeys.length,
  );
};

const resolveGovernmentNumber = (
  employee: PayrollGenerationEmployee,
  contributionType: ContributionType,
) => {
  if (contributionType === ContributionType.SSS) {
    return employee.governmentId?.sssNumber?.trim() || null;
  }
  if (contributionType === ContributionType.PHILHEALTH) {
    return employee.governmentId?.philHealthNumber?.trim() || null;
  }
  if (contributionType === ContributionType.PAGIBIG) {
    return employee.governmentId?.pagIbigNumber?.trim() || null;
  }
  return employee.governmentId?.tinNumber?.trim() || null;
};

const isContributionIncludedInPayroll = (
  employee: PayrollGenerationEmployee,
  contributionType: ContributionType,
) => {
  if (contributionType === ContributionType.SSS) {
    return employee.governmentId?.isSssIncludedInPayroll ?? true;
  }
  if (contributionType === ContributionType.PHILHEALTH) {
    return employee.governmentId?.isPhilHealthIncludedInPayroll ?? true;
  }
  if (contributionType === ContributionType.PAGIBIG) {
    return employee.governmentId?.isPagIbigIncludedInPayroll ?? true;
  }
  return employee.governmentId?.isWithholdingIncludedInPayroll ?? true;
};

const deductionTypeForContribution = (contributionType: ContributionType) => {
  if (contributionType === ContributionType.SSS) {
    return PayrollDeductionType.CONTRIBUTION_SSS;
  }
  if (contributionType === ContributionType.PHILHEALTH) {
    return PayrollDeductionType.CONTRIBUTION_PHILHEALTH;
  }
  if (contributionType === ContributionType.PAGIBIG) {
    return PayrollDeductionType.CONTRIBUTION_PAGIBIG;
  }
  return PayrollDeductionType.WITHHOLDING_TAX;
};

export const buildEmployeePayrollDraft = (input: {
  employee: PayrollGenerationEmployee;
  employeeRows: PayrollGenerationAttendanceRow[];
  payrollId: string;
  payrollType: "BIMONTHLY" | "MONTHLY" | "WEEKLY" | "OFF_CYCLE";
  payrollPeriodStart: Date;
  payrollPeriodEnd: Date;
  payrollPeriodStartKey: string;
  payrollPeriodEndKey: string;
  applyGovernmentContributions: boolean;
  employeeAssignments: PayrollGenerationAssignment[];
  oneTimeAlreadyApplied: Set<string>;
  compensationSnapshots: Map<string, CompensationSnapshot | null>;
  contributionBrackets: ContributionBracketRecord[];
  deductionMonthStartKeys: string[];
  existingMonthlyGovernmentDeductions: Set<string>;
}): EmployeePayrollDraft => {
  const { employee, employeeRows, payrollId } = input;
  const runFrequency = payrollTypeToFrequency(input.payrollType);
  const periodEndSnapshot = getRequiredCompensationSnapshot({
    employee,
    compensationSnapshots: input.compensationSnapshots,
    dateKey: input.payrollPeriodEndKey,
  });

  let daysPresent = 0;
  let daysAbsent = 0;
  let daysLate = 0;
  for (const row of employeeRows) {
    const isPaidLeaveRow =
      row.status === ATTENDANCE_STATUS.LEAVE && row.isPaidLeave === true;

    if (
      row.status === ATTENDANCE_STATUS.ABSENT ||
      (row.status === ATTENDANCE_STATUS.LEAVE && !isPaidLeaveRow)
    ) {
      daysAbsent += 1;
    } else if (
      row.status === ATTENDANCE_STATUS.PRESENT ||
      row.status === ATTENDANCE_STATUS.LATE ||
      isPaidLeaveRow
    ) {
      daysPresent += 1;
    }
    if (row.status === ATTENDANCE_STATUS.LATE || (row.lateMinutes ?? 0) > 0) {
      daysLate += 1;
    }
  }

  const baselinePaidMinutes =
    employeeRows
      .map((row) =>
        computeScheduledPaidMinutes({
          paidHoursPerDay: row.paidHoursPerDay,
          scheduledStartMinutes: row.scheduledStartMinutes,
          scheduledEndMinutes: row.scheduledEndMinutes,
          scheduledBreakMinutes: null,
        }),
      )
      .find(
        (minutes): minutes is number =>
          typeof minutes === "number" && minutes > 0,
      ) ?? 8 * 60;

  const rowPayrollMetrics = employeeRows.map((row) => {
    const rowDateKey = toDateKeyInTz(row.workDate);
    const compensationSnapshot = getRequiredCompensationSnapshot({
      employee,
      compensationSnapshots: input.compensationSnapshots,
      dateKey: rowDateKey,
    });
    const dailyRate = compensationSnapshot.dailyRate;

    const scheduledPaidMinutesRaw = computeScheduledPaidMinutes({
      paidHoursPerDay: row.paidHoursPerDay,
      scheduledStartMinutes: row.scheduledStartMinutes,
      scheduledEndMinutes: row.scheduledEndMinutes,
      scheduledBreakMinutes: null,
    });
    const scheduledPaidMinutes =
      typeof scheduledPaidMinutesRaw === "number" &&
      Number.isFinite(scheduledPaidMinutesRaw)
        ? Math.max(0, Math.round(scheduledPaidMinutesRaw))
        : null;

    const netWorkedMinutes =
      typeof row.netWorkedMinutes === "number" &&
      Number.isFinite(row.netWorkedMinutes)
        ? Math.max(0, Math.round(row.netWorkedMinutes))
        : 0;

    let undertimeMinutes =
      typeof row.undertimeMinutes === "number" &&
      Number.isFinite(row.undertimeMinutes)
        ? Math.max(0, Math.round(row.undertimeMinutes))
        : 0;

    if (scheduledPaidMinutes != null) {
      if (row.netWorkedMinutes == null) {
        undertimeMinutes = scheduledPaidMinutes;
      }
      undertimeMinutes = Math.min(undertimeMinutes, scheduledPaidMinutes);
    }

    const payableWorkedMinutes =
      scheduledPaidMinutes != null
        ? Math.max(0, scheduledPaidMinutes - undertimeMinutes)
        : netWorkedMinutes;

    const isPaidLeaveRow =
      row.status === ATTENDANCE_STATUS.LEAVE && row.isPaidLeave === true;

    const isZeroWorkRow =
      (row.status === ATTENDANCE_STATUS.ABSENT ||
        (row.status === ATTENDANCE_STATUS.LEAVE && !isPaidLeaveRow) ||
        row.status === ATTENDANCE_STATUS.INCOMPLETE) &&
      Math.max(0, row.workedMinutes ?? 0) === 0 &&
      Math.max(0, row.netWorkedMinutes ?? 0) === 0;

    const baseEarningMinutes = isPaidLeaveRow
      ? (scheduledPaidMinutes ?? 0)
      : isZeroWorkRow
        ? 0
        : scheduledPaidMinutes != null
          ? scheduledPaidMinutes
          : payableWorkedMinutes;

    const ratePerMinute = computeRatePerMinute({
      dailyRate,
      scheduledPaidMinutes: scheduledPaidMinutes ?? baselinePaidMinutes,
    });

    const basePayAmount = isZeroWorkRow
      ? 0
      : (computePayableAmountFromNetMinutes({
          netWorkedMinutes: baseEarningMinutes,
          ratePerMinute,
        }) ?? 0);

    const undertimeDeductionAmount =
      isPaidLeaveRow || isZeroWorkRow || scheduledPaidMinutes == null
        ? 0
        : (computePayableAmountFromNetMinutes({
            netWorkedMinutes: undertimeMinutes,
            ratePerMinute,
          }) ?? 0) * UNDERTIME_DEDUCTION_MULTIPLIER;

    const approvedOvertime = Math.max(0, row.overtimeMinutesApproved ?? 0);
    const rawOvertime = Math.max(0, row.overtimeMinutesRaw ?? 0);
    const overtimeMinutes =
      approvedOvertime > 0 ? approvedOvertime : rawOvertime;
    const overtimePayAmount =
      ratePerMinute == null
        ? 0
        : overtimeMinutes * ratePerMinute * OVERTIME_RATE_MULTIPLIER;

    return {
      compensationSnapshot,
      baseEarningMinutes,
      basePayAmount,
      netWorkedMinutes,
      overtimeMinutes,
      overtimePayAmount,
      undertimeMinutes,
      undertimeDeductionAmount,
      ratePerMinute,
    };
  });

  const minutesWorked = employeeRows.reduce(
    (sum, row) => sum + Math.max(0, row.workedMinutes ?? 0),
    0,
  );
  const minutesNetWorked = rowPayrollMetrics.reduce(
    (sum, row) => sum + row.netWorkedMinutes,
    0,
  );
  const minutesBasePay = rowPayrollMetrics.reduce(
    (sum, row) => sum + row.baseEarningMinutes,
    0,
  );
  const minutesOvertime = rowPayrollMetrics.reduce(
    (sum, row) => sum + row.overtimeMinutes,
    0,
  );
  const minutesUndertime = rowPayrollMetrics.reduce(
    (sum, row) => sum + row.undertimeMinutes,
    0,
  );

  const basePay = roundCurrency(
    rowPayrollMetrics.reduce((sum, row) => sum + row.basePayAmount, 0),
  );
  const overtimePay = roundCurrency(
    rowPayrollMetrics.reduce((sum, row) => sum + row.overtimePayAmount, 0),
  );
  const undertimeDeduction = roundCurrency(
    rowPayrollMetrics.reduce(
      (sum, row) => sum + row.undertimeDeductionAmount,
      0,
    ),
  );

  const distinctRateSnapshots = [
    ...new Set(
      rowPayrollMetrics
        .map((row) => row.ratePerMinute)
        .filter((value): value is number => value != null)
        .map((value) => roundSixDecimals(value)),
    ),
  ];
  const distinctPositionIds = [
    ...new Set(
      rowPayrollMetrics.map((row) => row.compensationSnapshot.positionId),
    ),
  ];

  const earnings: PayrollEarningDraft[] = [];

  if (basePay > 0) {
    earnings.push({
      earningType: PayrollEarningType.BASE_PAY,
      amount: basePay,
      minutes: minutesBasePay,
      rateSnapshot:
        distinctRateSnapshots.length === 1
          ? distinctRateSnapshots[0]
          : undefined,
      source: PayrollLineSource.SYSTEM,
      referenceType: PayrollReferenceType.ATTENDANCE,
      referenceId: payrollId,
      remarks:
        distinctPositionIds.length > 1 || distinctRateSnapshots.length > 1
          ? "Computed from payable base minutes across multiple position/rate segments"
          : "Computed from payable base minutes (grace-aware, capped by schedule)",
    });
  }

  if (overtimePay > 0) {
    earnings.push({
      earningType: PayrollEarningType.OVERTIME_PAY,
      amount: overtimePay,
      minutes: minutesOvertime,
      rateSnapshot:
        distinctRateSnapshots.length === 1
          ? distinctRateSnapshots[0]
          : undefined,
      source: PayrollLineSource.SYSTEM,
      referenceType: PayrollReferenceType.ATTENDANCE,
      referenceId: payrollId,
      remarks:
        distinctPositionIds.length > 1 || distinctRateSnapshots.length > 1
          ? `Overtime multiplier applied (${OVERTIME_RATE_MULTIPLIER}x) across multiple rate segments`
          : `Overtime multiplier applied (${OVERTIME_RATE_MULTIPLIER}x)`,
    });
  }

  const deductions: PayrollDeductionDraft[] = [];

  if (undertimeDeduction > 0) {
    deductions.push({
      deductionType: PayrollDeductionType.UNDERTIME_DEDUCTION,
      payrollFrequency: runFrequency ?? undefined,
      periodStartSnapshot: input.payrollPeriodStart,
      periodEndSnapshot: input.payrollPeriodEnd,
      quantitySnapshot: minutesUndertime,
      unitLabelSnapshot: "minutes",
      metadata: {
        deductionCategory: "attendance",
        multiplier: UNDERTIME_DEDUCTION_MULTIPLIER,
      },
      amount: undertimeDeduction,
      minutes: minutesUndertime,
      rateSnapshot:
        distinctRateSnapshots.length === 1
          ? distinctRateSnapshots[0]
          : undefined,
      source: PayrollLineSource.SYSTEM,
      referenceType: PayrollReferenceType.ATTENDANCE,
      referenceId: payrollId,
      remarks: `Computed from attendance undertime minutes (${UNDERTIME_DEDUCTION_MULTIPLIER}x, grace-aware)`,
    });
  }

  const earningsSubtotal = roundCurrency(
    earnings.reduce((sum, line) => sum + line.amount, 0),
  );

  if (input.applyGovernmentContributions && runFrequency) {
    for (const monthStartKey of input.deductionMonthStartKeys) {
      const monthlyBase = calculateMonthlyContributionBase({
        employee,
        monthStartKey,
        compensationSnapshots: input.compensationSnapshots,
      });

      for (const contributionType of [
        ContributionType.SSS,
        ContributionType.PHILHEALTH,
        ContributionType.PAGIBIG,
      ] as const) {
        if (!isContributionIncludedInPayroll(employee, contributionType)) {
          continue;
        }

        const deductionKey = buildMonthlyGovernmentDeductionKey(
          employee.employeeId,
          contributionType,
          monthStartKey,
        );
        if (input.existingMonthlyGovernmentDeductions.has(deductionKey)) {
          continue;
        }

        const governmentNumber = resolveGovernmentNumber(
          employee,
          contributionType,
        );
        if (!governmentNumber) {
          continue;
        }

        const bracket = findApplicableContributionBracket({
          brackets: input.contributionBrackets,
          contributionType,
          basisAmount: monthlyBase,
        });

        if (!bracket) {
          throw new Error(
            `Cannot generate payroll. No active ${contributionType} bracket matched ${monthlyBase.toFixed(2)} for ${getEmployeeLabel(employee)}.`,
          );
        }

        const calculation = calculateContributionFromBracket({
          bracket,
          basisAmount: monthlyBase,
        });

        if (calculation.employeeShare <= 0 && calculation.employerShare <= 0) {
          continue;
        }

        deductions.push({
          deductionType: deductionTypeForContribution(contributionType),
          contributionType,
          bracketIdSnapshot: calculation.bracket.id,
          bracketReferenceSnapshot:
            calculation.bracket.referenceCode ?? undefined,
          payrollFrequency: runFrequency,
          periodStartSnapshot: input.payrollPeriodStart,
          periodEndSnapshot: input.payrollPeriodEnd,
          compensationBasisSnapshot: calculation.basisAmount,
          employeeShareSnapshot: calculation.employeeShare,
          employerShareSnapshot: calculation.employerShare,
          baseTaxSnapshot: calculation.baseTax ?? undefined,
          marginalRateSnapshot: calculation.marginalRate ?? undefined,
          quantitySnapshot: 1,
          unitLabelSnapshot: "monthly bracket",
          metadata: {
            deductionMonthKey: monthStartKey,
            currencyCode: periodEndSnapshot.currencyCode,
            rawMonthlyBase: monthlyBase,
            governmentNumber,
            ...(calculation.bracket.metadata ?? {}),
          },
          amount: roundCurrency(calculation.employeeShare),
          source: PayrollLineSource.CONTRIBUTION_ENGINE,
          referenceType: PayrollReferenceType.CONTRIBUTION,
          referenceId: calculation.bracket.id,
          remarks: `${contributionType} statutory contribution`,
        });
      }
    }

    if (
      isContributionIncludedInPayroll(employee, ContributionType.WITHHOLDING)
    ) {
      const withholdingBracket = findApplicableContributionBracket({
        brackets: input.contributionBrackets,
        contributionType: ContributionType.WITHHOLDING,
        payrollFrequency: runFrequency,
        basisAmount: earningsSubtotal,
      });

      if (!withholdingBracket) {
        throw new Error(
          `Cannot generate payroll. No active withholding bracket matched ${earningsSubtotal.toFixed(2)} for ${getEmployeeLabel(employee)} (${runFrequency}).`,
        );
      }

      const withholding = calculateContributionFromBracket({
        bracket: withholdingBracket,
        basisAmount: earningsSubtotal,
      });

      if (withholding.employeeShare > 0) {
        deductions.push({
          deductionType: PayrollDeductionType.WITHHOLDING_TAX,
          contributionType: ContributionType.WITHHOLDING,
          bracketIdSnapshot: withholding.bracket.id,
          bracketReferenceSnapshot:
            withholding.bracket.referenceCode ?? undefined,
          payrollFrequency: runFrequency,
          periodStartSnapshot: input.payrollPeriodStart,
          periodEndSnapshot: input.payrollPeriodEnd,
          compensationBasisSnapshot: withholding.basisAmount,
          employeeShareSnapshot: withholding.employeeShare,
          employerShareSnapshot: withholding.employerShare,
          baseTaxSnapshot: withholding.baseTax ?? undefined,
          marginalRateSnapshot: withholding.marginalRate ?? undefined,
          quantitySnapshot: 1,
          unitLabelSnapshot: "tax bracket",
          metadata: {
            currencyCode: periodEndSnapshot.currencyCode,
            taxableCompensation: earningsSubtotal,
            tinNumber: resolveGovernmentNumber(
              employee,
              ContributionType.WITHHOLDING,
            ),
            ...(withholding.bracket.metadata ?? {}),
          },
          amount: roundCurrency(withholding.employeeShare),
          source: PayrollLineSource.CONTRIBUTION_ENGINE,
          referenceType: PayrollReferenceType.CONTRIBUTION,
          referenceId: withholding.bracket.id,
          remarks: "Withholding tax",
        });
      }
    }
  }

  for (const assignment of input.employeeAssignments) {
    if (assignment.deductionType.frequency === DeductionFrequency.ONE_TIME) {
      if (input.oneTimeAlreadyApplied.has(assignment.id)) {
        continue;
      }
    }

    const configuredAmount = toNumber(
      assignment.amountOverride ?? assignment.deductionType.defaultAmount,
      0,
    );
    const configuredPercent = toNumber(
      assignment.percentOverride ?? assignment.deductionType.defaultPercent,
      0,
    );

    let amount = 0;
    if (assignment.deductionType.amountMode === DeductionAmountMode.FIXED) {
      amount = configuredAmount;
    } else {
      amount = roundCurrency(earningsSubtotal * toPercent(configuredPercent));
    }

    if (assignment.deductionType.frequency === DeductionFrequency.INSTALLMENT) {
      const balanceSeed = toNumber(
        assignment.remainingBalance ?? assignment.installmentTotal,
        0,
      );
      const installmentValue = toNumber(
        assignment.installmentPerPayroll,
        amount,
      );
      const effectiveInstallment = Math.max(
        0,
        installmentValue > 0 ? installmentValue : amount,
      );
      const safeBalance = Math.max(0, balanceSeed);
      if (safeBalance <= 0 || effectiveInstallment <= 0) {
        continue;
      }
      amount = roundCurrency(Math.min(safeBalance, effectiveInstallment));
    }

    amount = roundCurrency(Math.max(0, amount));
    if (amount <= 0) continue;

    deductions.push({
      deductionType: PayrollDeductionType.OTHER,
      deductionTypeId: assignment.deductionTypeId,
      assignmentId: assignment.id,
      deductionCodeSnapshot: assignment.deductionType.code,
      deductionNameSnapshot: assignment.deductionType.name,
      payrollFrequency: runFrequency ?? undefined,
      periodStartSnapshot: input.payrollPeriodStart,
      periodEndSnapshot: input.payrollPeriodEnd,
      quantitySnapshot: 1,
      unitLabelSnapshot: "assignment",
      metadata: {
        deductionFrequency: assignment.deductionType.frequency,
        amountMode: assignment.deductionType.amountMode,
      },
      amount,
      source: PayrollLineSource.SYSTEM,
      referenceType: PayrollReferenceType.MANUAL,
      referenceId: assignment.id,
      remarks:
        assignment.reason ??
        `Applied from deduction assignment (${assignment.deductionType.name})`,
    });

    if (assignment.deductionType.frequency === DeductionFrequency.ONE_TIME) {
      input.oneTimeAlreadyApplied.add(assignment.id);
    }
  }

  const totalEarnings = roundCurrency(
    earnings.reduce((sum, line) => sum + line.amount, 0),
  );
  const totalDeductions = roundCurrency(
    deductions.reduce((sum, line) => sum + line.amount, 0),
  );

  return {
    daysPresent,
    daysAbsent,
    daysLate,
    minutesWorked,
    minutesNetWorked,
    minutesOvertime,
    minutesUndertime,
    positionIdSnapshot: periodEndSnapshot.positionId,
    positionNameSnapshot: periodEndSnapshot.positionName,
    dailyRateSnapshot: periodEndSnapshot.dailyRate,
    hourlyRateSnapshot: periodEndSnapshot.hourlyRate,
    monthlyRateSnapshot: periodEndSnapshot.monthlyRate,
    currencyCodeSnapshot: periodEndSnapshot.currencyCode,
    ratePerMinuteSnapshot:
      periodEndSnapshot.dailyRate == null
        ? null
        : roundSixDecimals(
            periodEndSnapshot.dailyRate / Math.max(1, baselinePaidMinutes),
          ),
    grossPay: totalEarnings,
    totalEarnings,
    totalDeductions,
    netPay: roundCurrency(totalEarnings - totalDeductions),
    earnings,
    deductions,
  };
};
