import { revalidatePath } from "next/cache";
import {
  PayrollFrequency,
  PayrollDeductionType,
  PayrollEarningType,
  PayrollLineSource,
  PayrollReferenceType,
  PayrollReviewDecision,
  PayrollStatus,
  PayrollType,
  Roles,
} from "@prisma/client";
import {
  parseIsoDateAtNoonUtc,
  roundCurrency,
  toDateKeyInTz,
  toIsoString,
  toNumber,
  toNumberOrNull,
} from "@/lib/payroll/helpers";
import type {
  PayrollDeductionLine,
  PayrollEarningLine,
  PayrollRunSummary,
} from "@/types/payroll";

export const OVERTIME_RATE_MULTIPLIER = 1.25;
export const UNDERTIME_DEDUCTION_MULTIPLIER = 1;

const PAYROLL_ROUTE_PREFIXES = [
  "/admin/payroll",
  "/manager/payroll",
  "/generalManager/payroll",
  "/employee/payroll",
] as const;

export const parseDateKey = (value: string) => {
  const parsed = parseIsoDateAtNoonUtc(value);
  if (!parsed) return null;
  return value;
};

const parseDateKeyParts = (value: string) => {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  return { year, month, day };
};

export const isStandardFirstHalfBimonthlyRun = (input: {
  payrollType: PayrollType;
  payrollPeriodStart: string;
  payrollPeriodEnd: string;
  isScopedRun: boolean;
}) => {
  if (input.payrollType !== PayrollType.BIMONTHLY || input.isScopedRun) {
    return false;
  }

  const start = parseDateKeyParts(input.payrollPeriodStart);
  const end = parseDateKeyParts(input.payrollPeriodEnd);
  if (!start || !end) return false;

  return (
    start.year === end.year &&
    start.month === end.month &&
    start.day === 1 &&
    end.day === 15
  );
};

export const payrollTypeToFrequency = (
  payrollType: PayrollType,
): PayrollFrequency | null => {
  if (payrollType === PayrollType.WEEKLY) return PayrollFrequency.WEEKLY;
  if (payrollType === PayrollType.BIMONTHLY) return PayrollFrequency.BIMONTHLY;
  if (payrollType === PayrollType.MONTHLY) return PayrollFrequency.MONTHLY;
  return null;
};

const monthStartKey = (year: number, month: number) =>
  `${year}-${String(month).padStart(2, "0")}-01`;

export const listMonthStartKeysInRange = (startKey: string, endKey: string) => {
  const start = parseDateKeyParts(startKey);
  const end = parseDateKeyParts(endKey);
  if (!start || !end) return [];

  const keys: string[] = [];
  let year = start.year;
  let month = start.month;

  while (year < end.year || (year === end.year && month <= end.month)) {
    const key = monthStartKey(year, month);
    if (key >= startKey && key <= endKey) {
      keys.push(key);
    }
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return keys;
};

export const normalizeEmployeeIds = (employeeIds?: string[]) =>
  Array.from(
    new Set(
      (employeeIds ?? [])
        .map((id) => (typeof id === "string" ? id.trim() : ""))
        .filter((id) => id.length > 0),
    ),
  );

export const toPeriodDateKey = (value: Date) => toDateKeyInTz(value);

export const resolvePayrollPeriod = (input: {
  payrollPeriodStart: string;
  payrollPeriodEnd: string;
}) => {
  const startKey = parseDateKey(input.payrollPeriodStart);
  const endKey = parseDateKey(input.payrollPeriodEnd);
  if (!startKey || !endKey) {
    return {
      success: false as const,
      error: "Invalid payroll period dates",
    };
  }

  if (startKey > endKey) {
    return {
      success: false as const,
      error: "Payroll period start must be before period end",
    };
  }

  const startAt = parseIsoDateAtNoonUtc(startKey);
  const endAt = parseIsoDateAtNoonUtc(endKey);
  if (!startAt || !endAt) {
    return {
      success: false as const,
      error: "Invalid payroll period dates",
    };
  }

  return {
    success: true as const,
    startKey,
    endKey,
    startAt,
    endAt,
  };
};

export const canGeneratePayroll = (role?: Roles) => role === Roles.Manager;

export const canReviewAsManager = (role?: Roles) => role === Roles.Manager;

export const canReviewAsGeneralManager = (role?: Roles) =>
  role === Roles.GeneralManager;

export const canViewPayrollRuns = (role?: Roles) =>
  role === Roles.Admin ||
  role === Roles.Manager ||
  role === Roles.GeneralManager;

export const canViewPayslips = (role?: Roles) =>
  role === Roles.Admin ||
  role === Roles.Manager ||
  role === Roles.GeneralManager ||
  role === Roles.Employee;

const formatUsername = (
  user?: {
    username: string;
  } | null,
) => user?.username ?? null;

export const formatEmployeeName = (employee: {
  firstName?: string | null;
  lastName?: string | null;
}) =>
  [employee.firstName, employee.lastName].filter(Boolean).join(" ").trim();

const sumCurrencyFromValues = (values: Array<unknown>) =>
  roundCurrency(
    values.reduce<number>((acc, value) => acc + toNumber(value, 0), 0),
  );

const serializeJsonObject = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

export const serializeEarningLine = (line: {
  id: string;
  earningType: PayrollEarningType;
  amount: unknown;
  minutes: number | null;
  rateSnapshot: unknown;
  source: PayrollLineSource;
  referenceType: PayrollReferenceType | null;
  referenceId: string | null;
  remarks: string | null;
  isVoided: boolean;
}): PayrollEarningLine => ({
  id: line.id,
  earningType: line.earningType,
  amount: toNumber(line.amount, 0),
  minutes: line.minutes ?? null,
  rateSnapshot: toNumberOrNull(line.rateSnapshot),
  source: line.source,
  isManual: line.source === PayrollLineSource.MANUAL,
  referenceType: line.referenceType,
  referenceId: line.referenceId,
  remarks: line.remarks,
  isVoided: line.isVoided,
});

export const serializeDeductionLine = (line: {
  id: string;
  deductionType: PayrollDeductionType;
  deductionTypeId: string | null;
  deductionCodeSnapshot: string | null;
  deductionNameSnapshot: string | null;
  assignmentId: string | null;
  contributionType: string | null;
  bracketIdSnapshot: string | null;
  bracketReferenceSnapshot: string | null;
  payrollFrequency: PayrollFrequency | null;
  periodStartSnapshot: Date | null;
  periodEndSnapshot: Date | null;
  compensationBasisSnapshot: unknown;
  employeeShareSnapshot: unknown;
  employerShareSnapshot: unknown;
  baseTaxSnapshot: unknown;
  marginalRateSnapshot: unknown;
  quantitySnapshot: unknown;
  unitLabelSnapshot: string | null;
  metadata: unknown;
  amount: unknown;
  minutes: number | null;
  rateSnapshot: unknown;
  source: PayrollLineSource;
  referenceType: PayrollReferenceType | null;
  referenceId: string | null;
  remarks: string | null;
  isVoided: boolean;
}): PayrollDeductionLine => ({
  id: line.id,
  deductionType: line.deductionType,
  deductionTypeId: line.deductionTypeId,
  deductionCodeSnapshot: line.deductionCodeSnapshot,
  deductionNameSnapshot: line.deductionNameSnapshot,
  assignmentId: line.assignmentId,
  contributionType: line.contributionType as PayrollDeductionLine["contributionType"],
  bracketIdSnapshot: line.bracketIdSnapshot,
  bracketReferenceSnapshot: line.bracketReferenceSnapshot,
  payrollFrequency: line.payrollFrequency,
  periodStartSnapshot: toIsoString(line.periodStartSnapshot),
  periodEndSnapshot: toIsoString(line.periodEndSnapshot),
  compensationBasisSnapshot: toNumberOrNull(line.compensationBasisSnapshot),
  employeeShareSnapshot: toNumberOrNull(line.employeeShareSnapshot),
  employerShareSnapshot: toNumberOrNull(line.employerShareSnapshot),
  baseTaxSnapshot: toNumberOrNull(line.baseTaxSnapshot),
  marginalRateSnapshot: toNumberOrNull(line.marginalRateSnapshot),
  quantitySnapshot: toNumberOrNull(line.quantitySnapshot),
  unitLabelSnapshot: line.unitLabelSnapshot,
  metadata: serializeJsonObject(line.metadata),
  amount: toNumber(line.amount, 0),
  minutes: line.minutes ?? null,
  rateSnapshot: toNumberOrNull(line.rateSnapshot),
  source: line.source,
  isManual: line.source === PayrollLineSource.MANUAL,
  referenceType: line.referenceType,
  referenceId: line.referenceId,
  remarks: line.remarks,
  isVoided: line.isVoided,
});

export const serializePayrollRunSummary = (run: {
  payrollId: string;
  payrollPeriodStart: Date;
  payrollPeriodEnd: Date;
  payrollType: PayrollType;
  status: PayrollStatus;
  managerDecision: PayrollReviewDecision;
  gmDecision: PayrollReviewDecision;
  generatedAt: Date;
  managerReviewedAt: Date | null;
  gmReviewedAt: Date | null;
  releasedAt: Date | null;
  managerReviewRemarks: string | null;
  gmReviewRemarks: string | null;
  notes: string | null;
  createdBy: { username: string } | null;
  managerReviewedBy: { username: string } | null;
  gmReviewedBy: { username: string } | null;
  releasedBy: { username: string } | null;
  payrollEmployees: Array<{
    grossPay: unknown;
    totalDeductions: unknown;
    netPay: unknown;
  }>;
}): PayrollRunSummary => {
  const grossTotal = sumCurrencyFromValues(
    run.payrollEmployees.map((row) => row.grossPay),
  );
  const deductionsTotal = sumCurrencyFromValues(
    run.payrollEmployees.map((row) => row.totalDeductions),
  );
  const netTotal = sumCurrencyFromValues(
    run.payrollEmployees.map((row) => row.netPay),
  );

  return {
    payrollId: run.payrollId,
    payrollPeriodStart: run.payrollPeriodStart.toISOString(),
    payrollPeriodEnd: run.payrollPeriodEnd.toISOString(),
    payrollType: run.payrollType,
    status: run.status,
    managerDecision: run.managerDecision,
    gmDecision: run.gmDecision,
    generatedAt: run.generatedAt.toISOString(),
    managerReviewedAt: toIsoString(run.managerReviewedAt),
    gmReviewedAt: toIsoString(run.gmReviewedAt),
    releasedAt: toIsoString(run.releasedAt),
    managerReviewRemarks: run.managerReviewRemarks ?? null,
    gmReviewRemarks: run.gmReviewRemarks ?? null,
    notes: run.notes ?? null,
    createdByName: formatUsername(run.createdBy),
    managerReviewedByName: formatUsername(run.managerReviewedBy),
    gmReviewedByName: formatUsername(run.gmReviewedBy),
    releasedByName: formatUsername(run.releasedBy),
    employeeCount: run.payrollEmployees.length,
    grossTotal,
    deductionsTotal,
    netTotal,
  };
};

export const revalidatePayrollPages = () => {
  PAYROLL_ROUTE_PREFIXES.forEach((prefix) => {
    revalidatePath(prefix);
    revalidatePath(`${prefix}/review-payroll`);
    revalidatePath(`${prefix}/generate-payroll`);
    revalidatePath(`${prefix}/payroll-history`);
    revalidatePath(`${prefix}/payslips`);
  });
};
