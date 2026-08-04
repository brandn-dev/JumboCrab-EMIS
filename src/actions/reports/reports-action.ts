"use server";

import {
  ATTENDANCE_STATUS,
  CURRENT_STATUS,
  DeductionFrequency,
  EMPLOYMENT_STATUS,
  EmployeeDeductionAssignmentStatus,
  EmployeeDeductionWorkflowStatus,
  EmployeeViolationStatus,
  PayrollDeductionType,
  PayrollStatus,
  PayrollType,
  Roles,
  type Prisma,
} from "@prisma/client";
import { listContributionDirectory } from "@/actions/contributions/contributions-action";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { isEmployeeEndedStatus } from "@/lib/employees/status";
import { endOfZonedDay, startOfZonedDay } from "@/lib/timezone";

const REPORT_VIEW = {
  CONTRIBUTIONS: "contributions",
  DEDUCTIONS: "deductions",
  PAYROLL_IMPACT: "payroll-impact",
} as const;

const CONTRIBUTION_DEDUCTION_TYPES = new Set<PayrollDeductionType>([
  PayrollDeductionType.CONTRIBUTION_SSS,
  PayrollDeductionType.CONTRIBUTION_PHILHEALTH,
  PayrollDeductionType.CONTRIBUTION_PAGIBIG,
]);

const CONTRIBUTION_EXPORT_TYPES = new Set<PayrollDeductionType>([
  PayrollDeductionType.CONTRIBUTION_SSS,
  PayrollDeductionType.CONTRIBUTION_PHILHEALTH,
  PayrollDeductionType.CONTRIBUTION_PAGIBIG,
  PayrollDeductionType.WITHHOLDING_TAX,
]);

export type ContributionsDeductionsReportView =
  (typeof REPORT_VIEW)[keyof typeof REPORT_VIEW];

export type ReportFilterInput = {
  dateFrom?: string | null;
  dateTo?: string | null;
  departmentId?: string | null;
  employeeId?: string | null;
  payrollType?: PayrollType | string | null;
  attendanceStatus?: ATTENDANCE_STATUS | string | null;
  accountRole?: Roles | string | null;
  employmentStatus?: EMPLOYMENT_STATUS | string | null;
  currentStatus?: CURRENT_STATUS | string | null;
  deductionFrequency?: DeductionFrequency | string | null;
  deductionWorkflowStatus?: EmployeeDeductionWorkflowStatus | string | null;
  deductionRuntimeStatus?: EmployeeDeductionAssignmentStatus | string | null;
  violationStatus?: EmployeeViolationStatus | string | null;
  payrollHasDeductions?: string | null;
  search?: string | null;
};

export type ReportFilterOptions = {
  departments: {
    departmentId: string;
    name: string;
  }[];
  employees: {
    employeeId: string;
    employeeCode: string;
    employeeName: string;
  }[];
};

export type AttendanceReportRow = {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  department: string;
  workDate: string;
  status: ATTENDANCE_STATUS;
  expectedShift: string;
  actualInAt: string | null;
  actualOutAt: string | null;
  workedMinutes: number;
  netWorkedMinutes: number;
  overtimeMinutes: number;
  isLocked: boolean;
  isPayrollLinked: boolean;
};

export type AttendanceReportSummary = {
  totalRows: number;
  presentCount: number;
  absentCount: number;
  lateCount: number;
  leaveCount: number;
  overtimeMinutes: number;
  netWorkedMinutes: number;
};

export type AccountsReportRow = {
  userId: string;
  username: string;
  email: string;
  role: Roles;
  linkedEmployeeName: string | null;
  linkedEmployeeCode: string | null;
  department: string | null;
  isDisabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AccountsReportSummary = {
  totalAccounts: number;
  activeAccounts: number;
  disabledAccounts: number;
  linkedEmployeeAccounts: number;
  accountsByRole: {
    role: Roles;
    count: number;
  }[];
};

export type EmployeeInformationReportRow = {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  position: string | null;
  employmentStatus: EMPLOYMENT_STATUS;
  currentStatus: CURRENT_STATUS;
  email: string | null;
  phone: string | null;
  startDate: string;
  endDate: string | null;
  isEnded: boolean;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
};

export type EmployeeInformationReportSummary = {
  totalEmployees: number;
  activeEmployees: number;
  archivedEmployees: number;
  withDepartmentCount: number;
  withPositionCount: number;
};

export type ContributionSetupReportRow = {
  rowType: "CONTRIBUTION";
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  department: string;
  effectiveDate: string;
  sssEe: number;
  philHealthEe: number;
  pagIbigEe: number;
  withholdingEe: number;
  employeeShareTotal: number;
  isSssActive: boolean;
  isPhilHealthActive: boolean;
  isPagIbigActive: boolean;
  isWithholdingActive: boolean;
};

export type ContributionsReportRow = ContributionSetupReportRow;

export type ContributionsReportSummary = {
  totalContributionRecords: number;
  activeSssCount: number;
  activePhilHealthCount: number;
  activePagIbigCount: number;
  activeWithholdingCount: number;
};

export type DeductionSetupReportRow = {
  rowType: "DEDUCTION";
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  department: string;
  deductionTypeName: string;
  workflowStatus: EmployeeDeductionWorkflowStatus;
  runtimeStatus: EmployeeDeductionAssignmentStatus;
  frequency: DeductionFrequency;
  effectiveFrom: string;
  effectiveTo: string | null;
  amountValue: number | null;
  percentValue: number | null;
  installmentTotal: number | null;
  installmentPerPayroll: number | null;
  remainingBalance: number | null;
  reason: string | null;
};

export type DeductionsReportRow = DeductionSetupReportRow;

export type DeductionsReportSummary = {
  totalAssignments: number;
  employeesWithActiveDeductions: number;
  openInstallments: number;
  completedInstallmentsInRange: number;
};

export type PayrollImpactReportRow = {
  rowType: "PAYROLL_IMPACT";
  payrollEmployeeId: string;
  payrollId: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  department: string;
  payrollPeriodStart: string;
  payrollPeriodEnd: string;
  payrollType: PayrollType;
  contributionTotal: number;
  deductionTotal: number;
  totalWithheld: number;
  grossPay: number;
  netPay: number;
  releasedAt: string | null;
};

export type ContributionsDeductionsReportRow =
  | ContributionSetupReportRow
  | DeductionSetupReportRow
  | PayrollImpactReportRow;

export type ContributionsDeductionsReportSummary = {
  employeesWithContributionRecords: number;
  employeesWithActiveDeductions: number;
  openInstallments: number;
  completedInstallmentsInRange: number;
  payrollImpactEmployeeCount: number;
  payrollImpactContributionTotal: number;
  payrollImpactDeductionTotal: number;
  payrollImpactWithheldTotal: number;
  payrollImpactRowCount: number;
};

export type ViolationsReportRow = {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  department: string;
  violationType: string;
  incidentDate: string;
  status: EmployeeViolationStatus;
  strikeValue: number;
  countedStrikeValue: number;
  isAcknowledged: boolean;
  reviewedBy: string | null;
  reviewedAt: string | null;
};

export type ViolationsReportSummary = {
  totalViolations: number;
  pendingReviewCount: number;
  approvedCount: number;
  rejectedCount: number;
  activeStrikesTotal: number;
};

export type PayrollReportRow = {
  payrollEmployeeId: string;
  payrollId: string;
  payrollPeriodStart: string;
  payrollPeriodEnd: string;
  payrollType: PayrollType;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  department: string;
  grossPay: number;
  totalDeductions: number;
  netPay: number;
  releasedAt: string | null;
  releasedBy: string | null;
};

export type PayrollReportSummary = {
  releasedRunsCount: number;
  employeesPaidCount: number;
  grossTotal: number;
  deductionsTotal: number;
  netTotal: number;
};

type ReportSuccess<T> = {
  success: true;
  data: T;
  error?: never;
};

type ReportFailure = {
  success: false;
  data?: never;
  error: string;
};

type NormalizedReportFilters = {
  dateFrom: Date | null;
  dateToExclusive: Date | null;
  departmentId: string | null;
  employeeId: string | null;
  payrollType: PayrollType | null;
  attendanceStatus: ATTENDANCE_STATUS | null;
  accountRole: Roles | null;
  employmentStatus: EMPLOYMENT_STATUS | null;
  currentStatus: CURRENT_STATUS | null;
  deductionFrequency: DeductionFrequency | null;
  deductionWorkflowStatus: EmployeeDeductionWorkflowStatus | null;
  deductionRuntimeStatus: EmployeeDeductionAssignmentStatus | null;
  violationStatus: EmployeeViolationStatus | null;
  payrollHasDeductions: boolean | null;
  search: string | null;
};

type CsvExport = {
  filename: string;
  content: string;
};

const formatEmployeeName = (firstName?: string | null, lastName?: string | null) =>
  [firstName, lastName].filter(Boolean).join(" ").trim() || "Unnamed Employee";

const trimToNull = (value?: string | null) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const parseDateField = (value?: string | null) => {
  const normalized = trimToNull(value);
  if (!normalized) return null;
  const parsed = new Date(`${normalized}T00:00:00+08:00`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
};

const parseEnumFilter = <T extends string>(
  value: string | null,
  allowed: readonly T[],
): T | null => {
  if (!value) return null;
  return allowed.includes(value as T) ? (value as T) : null;
};

const normalizeFilters = (input?: ReportFilterInput): NormalizedReportFilters => {
  const dateFromInput = parseDateField(input?.dateFrom);
  const dateToInput = parseDateField(input?.dateTo);
  const payrollTypeInput = trimToNull(input?.payrollType);
  const payrollType = payrollTypeInput
    ? (Object.values(PayrollType).includes(payrollTypeInput as PayrollType)
        ? (payrollTypeInput as PayrollType)
        : null)
    : null;
  const attendanceStatus = parseEnumFilter(
    trimToNull(input?.attendanceStatus),
    Object.values(ATTENDANCE_STATUS),
  );
  const accountRole = parseEnumFilter(
    trimToNull(input?.accountRole),
    Object.values(Roles),
  );
  const employmentStatus = parseEnumFilter(
    trimToNull(input?.employmentStatus),
    Object.values(EMPLOYMENT_STATUS),
  );
  const currentStatus = parseEnumFilter(
    trimToNull(input?.currentStatus),
    Object.values(CURRENT_STATUS),
  );
  const deductionFrequency = parseEnumFilter(
    trimToNull(input?.deductionFrequency),
    Object.values(DeductionFrequency),
  );
  const deductionWorkflowStatus = parseEnumFilter(
    trimToNull(input?.deductionWorkflowStatus),
    Object.values(EmployeeDeductionWorkflowStatus),
  );
  const deductionRuntimeStatus = parseEnumFilter(
    trimToNull(input?.deductionRuntimeStatus),
    Object.values(EmployeeDeductionAssignmentStatus),
  );
  const violationStatus = parseEnumFilter(
    trimToNull(input?.violationStatus),
    Object.values(EmployeeViolationStatus),
  );
  const payrollHasDeductionsInput = trimToNull(input?.payrollHasDeductions);
  const payrollHasDeductions =
    payrollHasDeductionsInput === "yes"
      ? true
      : payrollHasDeductionsInput === "no"
        ? false
        : null;

  return {
    dateFrom: dateFromInput ? startOfZonedDay(dateFromInput) : null,
    dateToExclusive: dateToInput ? endOfZonedDay(dateToInput) : null,
    departmentId: trimToNull(input?.departmentId),
    employeeId: trimToNull(input?.employeeId),
    payrollType,
    attendanceStatus,
    accountRole,
    employmentStatus,
    currentStatus,
    deductionFrequency,
    deductionWorkflowStatus,
    deductionRuntimeStatus,
    violationStatus,
    payrollHasDeductions,
    search: trimToNull(input?.search),
  };
};

const toNumber = (value: unknown): number => {
  if (value === null || typeof value === "undefined") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const maybe = value as { toNumber?: () => number; toString?: () => string };
  if (typeof maybe.toNumber === "function") {
    return maybe.toNumber();
  }
  if (typeof maybe.toString === "function") {
    const parsed = Number(maybe.toString());
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const toIsoString = (value?: Date | string | null) => {
  if (!value) return null;
  if (typeof value === "string") return value;
  return value.toISOString();
};

const containsCI = (value: string) => ({ contains: value, mode: "insensitive" as const });

const minutesToTimeLabel = (totalMinutes?: number | null) => {
  if (totalMinutes === null || typeof totalMinutes === "undefined") return null;
  const normalized = ((totalMinutes % 1440) + 1440) % 1440;
  const hours24 = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  const meridiem = hours24 >= 12 ? "PM" : "AM";
  const hours12 = hours24 % 12 || 12;
  return `${hours12}:${minutes.toString().padStart(2, "0")} ${meridiem}`;
};

const formatShiftLabel = (input: {
  name?: string | null;
  startMinutes?: number | null;
  endMinutes?: number | null;
}) => {
  const startLabel = minutesToTimeLabel(input.startMinutes);
  const endLabel = minutesToTimeLabel(input.endMinutes);

  if (!input.name && !startLabel && !endLabel) return "Rest day";
  if (input.name && startLabel && endLabel) {
    return `${input.name} (${startLabel} - ${endLabel})`;
  }
  if (input.name) return input.name;
  if (startLabel && endLabel) return `${startLabel} - ${endLabel}`;
  return "Rest day";
};

const csvCell = (value: unknown) => {
  if (value === null || typeof value === "undefined") return "";
  const stringValue = String(value);
  if (
    stringValue.includes(",") ||
    stringValue.includes("\"") ||
    stringValue.includes("\n")
  ) {
    return `"${stringValue.replaceAll("\"", "\"\"")}"`;
  }
  return stringValue;
};

const buildCsv = (headers: string[], rows: unknown[][]) =>
  [headers, ...rows]
    .map((row) => row.map((cell) => csvCell(cell)).join(","))
    .join("\n");

const buildFileRangeSuffix = (filters: ReportFilterInput | undefined) => {
  const start = trimToNull(filters?.dateFrom);
  const end = trimToNull(filters?.dateTo);
  if (start && end) return `${start}_to_${end}`;
  if (start) return `from_${start}`;
  if (end) return `until_${end}`;
  return "all_dates";
};

const filterContributionPreviewRows = (
  rows: Awaited<ReturnType<typeof listContributionDirectory>> extends {
    data?: infer T;
  }
    ? NonNullable<T>
    : never,
  filters: NormalizedReportFilters,
) => {
  return rows.filter((row) => {
    if (filters.employeeId && row.employeeId !== filters.employeeId) {
      return false;
    }
    if (filters.departmentId && row.departmentId !== filters.departmentId) {
      return false;
    }
    if (filters.search) {
      const haystack = `${row.employeeCode} ${row.employeeName} ${row.department}`.toLowerCase();
      if (!haystack.includes(filters.search.toLowerCase())) {
        return false;
      }
    }
    if (filters.dateFrom) {
      const updatedAt = new Date(row.updatedAt);
      if (updatedAt < filters.dateFrom) {
        return false;
      }
    }
    if (filters.dateToExclusive) {
      const updatedAt = new Date(row.updatedAt);
      if (updatedAt >= filters.dateToExclusive) {
        return false;
      }
    }
    return true;
  });
};

const getDeductionRowsWhere = (
  filters: NormalizedReportFilters,
): Prisma.EmployeeDeductionAssignmentWhereInput => {
  const and: Prisma.EmployeeDeductionAssignmentWhereInput[] = [];

  if (filters.employeeId) {
    and.push({ employeeId: filters.employeeId });
  }
  if (filters.departmentId) {
    and.push({ employee: { departmentId: filters.departmentId } });
  }
  if (filters.dateFrom || filters.dateToExclusive) {
    and.push({
      effectiveFrom: {
        ...(filters.dateFrom ? { gte: filters.dateFrom } : {}),
        ...(filters.dateToExclusive ? { lt: filters.dateToExclusive } : {}),
      },
    });
  }
  if (filters.search) {
    and.push({
      OR: [
        { employee: { employeeCode: containsCI(filters.search) } },
        { employee: { firstName: containsCI(filters.search) } },
        { employee: { lastName: containsCI(filters.search) } },
        { deductionType: { name: containsCI(filters.search) } },
      ],
    });
  }
  if (filters.deductionFrequency) {
    and.push({ deductionType: { frequency: filters.deductionFrequency } });
  }
  if (filters.deductionWorkflowStatus) {
    and.push({ workflowStatus: filters.deductionWorkflowStatus });
  }
  if (filters.deductionRuntimeStatus) {
    and.push({ status: filters.deductionRuntimeStatus });
  }

  return and.length > 0 ? { AND: and } : {};
};

const getPayrollPeriodWhere = (filters: NormalizedReportFilters): Prisma.PayrollWhereInput => {
  const and: Prisma.PayrollWhereInput[] = [{ status: PayrollStatus.RELEASED }];

  if (filters.dateFrom) {
    and.push({ payrollPeriodEnd: { gte: filters.dateFrom } });
  }
  if (filters.dateToExclusive) {
    and.push({ payrollPeriodStart: { lt: filters.dateToExclusive } });
  }
  if (filters.payrollType) {
    and.push({ payrollType: filters.payrollType });
  }

  return and.length > 0 ? { AND: and } : {};
};

const getAttendanceWhere = (
  filters: NormalizedReportFilters,
): Prisma.AttendanceWhereInput => {
  const and: Prisma.AttendanceWhereInput[] = [];

  if (filters.employeeId) {
    and.push({ employeeId: filters.employeeId });
  }
  if (filters.departmentId) {
    and.push({ employee: { departmentId: filters.departmentId } });
  }
  if (filters.dateFrom || filters.dateToExclusive) {
    and.push({
      workDate: {
        ...(filters.dateFrom ? { gte: filters.dateFrom } : {}),
        ...(filters.dateToExclusive ? { lt: filters.dateToExclusive } : {}),
      },
    });
  }
  if (filters.search) {
    and.push({
      OR: [
        { employee: { employeeCode: containsCI(filters.search) } },
        { employee: { firstName: containsCI(filters.search) } },
        { employee: { lastName: containsCI(filters.search) } },
        { expectedShift: { name: containsCI(filters.search) } },
      ],
    });
  }
  if (filters.attendanceStatus) {
    and.push({ status: filters.attendanceStatus });
  }

  return and.length > 0 ? { AND: and } : {};
};

const getAccountsWhere = (filters: NormalizedReportFilters): Prisma.UserWhereInput => {
  const and: Prisma.UserWhereInput[] = [];

  if (filters.employeeId) {
    and.push({ employee: { employeeId: filters.employeeId } });
  }
  if (filters.departmentId) {
    and.push({ employee: { departmentId: filters.departmentId } });
  }
  if (filters.dateFrom || filters.dateToExclusive) {
    and.push({
      createdAt: {
        ...(filters.dateFrom ? { gte: filters.dateFrom } : {}),
        ...(filters.dateToExclusive ? { lt: filters.dateToExclusive } : {}),
      },
    });
  }
  if (filters.search) {
    and.push({
      OR: [
        { username: containsCI(filters.search) },
        { email: containsCI(filters.search) },
        { employee: { employeeCode: containsCI(filters.search) } },
        { employee: { firstName: containsCI(filters.search) } },
        { employee: { lastName: containsCI(filters.search) } },
      ],
    });
  }
  if (filters.accountRole) {
    and.push({ role: filters.accountRole });
  }

  return and.length > 0 ? { AND: and } : {};
};

const getEmployeeInformationWhere = (
  filters: NormalizedReportFilters,
): Prisma.EmployeeWhereInput => {
  const and: Prisma.EmployeeWhereInput[] = [];

  if (filters.employeeId) {
    and.push({ employeeId: filters.employeeId });
  }
  if (filters.departmentId) {
    and.push({ departmentId: filters.departmentId });
  }
  if (filters.dateFrom || filters.dateToExclusive) {
    and.push({
      startDate: {
        ...(filters.dateFrom ? { gte: filters.dateFrom } : {}),
        ...(filters.dateToExclusive ? { lt: filters.dateToExclusive } : {}),
      },
    });
  }
  if (filters.search) {
    and.push({
      OR: [
        { employeeCode: containsCI(filters.search) },
        { firstName: containsCI(filters.search) },
        { lastName: containsCI(filters.search) },
        { email: containsCI(filters.search) },
        { phone: containsCI(filters.search) },
        { department: { name: containsCI(filters.search) } },
        { position: { name: containsCI(filters.search) } },
      ],
    });
  }
  if (filters.employmentStatus) {
    and.push({ employmentStatus: filters.employmentStatus });
  }
  if (filters.currentStatus) {
    and.push({ currentStatus: filters.currentStatus });
  }

  return and.length > 0 ? { AND: and } : {};
};

const getViolationsWhere = (
  filters: NormalizedReportFilters,
): Prisma.EmployeeViolationWhereInput => {
  const and: Prisma.EmployeeViolationWhereInput[] = [];

  if (filters.employeeId) {
    and.push({ employeeId: filters.employeeId });
  }
  if (filters.departmentId) {
    and.push({ employee: { departmentId: filters.departmentId } });
  }
  if (filters.dateFrom || filters.dateToExclusive) {
    and.push({
      violationDate: {
        ...(filters.dateFrom ? { gte: filters.dateFrom } : {}),
        ...(filters.dateToExclusive ? { lt: filters.dateToExclusive } : {}),
      },
    });
  }
  if (filters.search) {
    and.push({
      OR: [
        { employee: { employeeCode: containsCI(filters.search) } },
        { employee: { firstName: containsCI(filters.search) } },
        { employee: { lastName: containsCI(filters.search) } },
        { violation: { name: containsCI(filters.search) } },
      ],
    });
  }
  if (filters.violationStatus) {
    and.push({ status: filters.violationStatus });
  }

  return and.length > 0 ? { AND: and } : {};
};

const getPayrollEmployeesWhere = (
  filters: NormalizedReportFilters,
  requireDeductions = false,
): Prisma.PayrollEmployeeWhereInput => {
  const and: Prisma.PayrollEmployeeWhereInput[] = [
    { payroll: getPayrollPeriodWhere(filters) },
  ];

  if (filters.employeeId) {
    and.push({ employeeId: filters.employeeId });
  }
  if (filters.departmentId) {
    and.push({ employee: { departmentId: filters.departmentId } });
  }
  if (filters.search) {
    and.push({
      OR: [
        { employee: { employeeCode: containsCI(filters.search) } },
        { employee: { firstName: containsCI(filters.search) } },
        { employee: { lastName: containsCI(filters.search) } },
      ],
    });
  }
  if (filters.payrollHasDeductions === true) {
    and.push({ deductions: { some: { isVoided: false } } });
  }
  if (filters.payrollHasDeductions === false) {
    and.push({ deductions: { none: { isVoided: false } } });
  }
  if (requireDeductions) {
    and.push({ deductions: { some: { isVoided: false } } });
  }

  return and.length > 0 ? { AND: and } : {};
};

const getPayrollEmployeesWithContributionWhere = (
  filters: NormalizedReportFilters,
): Prisma.PayrollEmployeeWhereInput => {
  const baseWhere = getPayrollEmployeesWhere(filters, false);
  const and = "AND" in baseWhere && Array.isArray(baseWhere.AND)
    ? [...baseWhere.AND]
    : baseWhere
      ? [baseWhere]
      : [];

  and.push({
    deductions: {
      some: {
        isVoided: false,
        deductionType: {
          in: Array.from(CONTRIBUTION_EXPORT_TYPES),
        },
      },
    },
  });

  return and.length > 0 ? { AND: and } : {};
};

async function requireReportsAccess() {
  const session = await getSession();
  if (
    !session.isLoggedIn ||
    !session.role ||
    (session.role !== Roles.Manager && session.role !== Roles.GeneralManager)
  ) {
    throw new Error("You do not have access to reports.");
  }
  return session;
}

async function fetchAttendanceReport(input?: ReportFilterInput) {
  await requireReportsAccess();
  const filters = normalizeFilters(input);
  const records = await db.attendance.findMany({
    where: getAttendanceWhere(filters),
    orderBy: [{ workDate: "desc" }, { employee: { employeeCode: "asc" } }],
    select: {
      id: true,
      workDate: true,
      status: true,
      actualInAt: true,
      actualOutAt: true,
      workedMinutes: true,
      netWorkedMinutes: true,
      overtimeMinutesApproved: true,
      isLocked: true,
      payrollPeriodId: true,
      payrollEmployeeId: true,
      scheduledStartMinutes: true,
      scheduledEndMinutes: true,
      expectedShift: { select: { name: true } },
      employee: {
        select: {
          employeeId: true,
          employeeCode: true,
          firstName: true,
          lastName: true,
          department: { select: { name: true } },
        },
      },
    },
  });

  const rows: AttendanceReportRow[] = records.map((record) => ({
    id: record.id,
    employeeId: record.employee.employeeId,
    employeeCode: record.employee.employeeCode,
    employeeName: formatEmployeeName(
      record.employee.firstName,
      record.employee.lastName,
    ),
    department: record.employee.department?.name ?? "Unassigned",
    workDate: record.workDate.toISOString(),
    status: record.status,
    expectedShift: formatShiftLabel({
      name: record.expectedShift?.name,
      startMinutes: record.scheduledStartMinutes,
      endMinutes: record.scheduledEndMinutes,
    }),
    actualInAt: toIsoString(record.actualInAt),
    actualOutAt: toIsoString(record.actualOutAt),
    workedMinutes: record.workedMinutes ?? 0,
    netWorkedMinutes: record.netWorkedMinutes ?? 0,
    overtimeMinutes: record.overtimeMinutesApproved ?? 0,
    isLocked: record.isLocked,
    isPayrollLinked: Boolean(record.payrollPeriodId || record.payrollEmployeeId),
  }));

  const summary: AttendanceReportSummary = rows.reduce(
    (acc, row) => {
      acc.totalRows += 1;
      if (row.status === ATTENDANCE_STATUS.PRESENT) acc.presentCount += 1;
      if (row.status === ATTENDANCE_STATUS.ABSENT) acc.absentCount += 1;
      if (row.status === ATTENDANCE_STATUS.LATE) acc.lateCount += 1;
      if (row.status === ATTENDANCE_STATUS.LEAVE) acc.leaveCount += 1;
      acc.overtimeMinutes += row.overtimeMinutes;
      acc.netWorkedMinutes += row.netWorkedMinutes;
      return acc;
    },
    {
      totalRows: 0,
      presentCount: 0,
      absentCount: 0,
      lateCount: 0,
      leaveCount: 0,
      overtimeMinutes: 0,
      netWorkedMinutes: 0,
    } satisfies AttendanceReportSummary,
  );

  return { summary, rows, total: rows.length };
}

async function fetchAccountsReport(input?: ReportFilterInput) {
  await requireReportsAccess();
  const filters = normalizeFilters(input);
  const records = await db.user.findMany({
    where: getAccountsWhere(filters),
    orderBy: [{ createdAt: "desc" }, { username: "asc" }],
    select: {
      userId: true,
      username: true,
      email: true,
      role: true,
      isDisabled: true,
      createdAt: true,
      updatedAt: true,
      employee: {
        select: {
          employeeCode: true,
          firstName: true,
          lastName: true,
          department: { select: { name: true } },
        },
      },
    },
  });

  const rows: AccountsReportRow[] = records.map((record) => ({
    userId: record.userId,
    username: record.username,
    email: record.email,
    role: record.role,
    linkedEmployeeName: record.employee
      ? formatEmployeeName(record.employee.firstName, record.employee.lastName)
      : null,
    linkedEmployeeCode: record.employee?.employeeCode ?? null,
    department: record.employee?.department?.name ?? null,
    isDisabled: record.isDisabled,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }));

  const countsByRole = new Map<Roles, number>();
  for (const row of rows) {
    countsByRole.set(row.role, (countsByRole.get(row.role) ?? 0) + 1);
  }

  const summary: AccountsReportSummary = {
    totalAccounts: rows.length,
    activeAccounts: rows.filter((row) => !row.isDisabled).length,
    disabledAccounts: rows.filter((row) => row.isDisabled).length,
    linkedEmployeeAccounts: rows.filter((row) => Boolean(row.linkedEmployeeCode))
      .length,
    accountsByRole: Array.from(countsByRole.entries())
      .map(([role, count]) => ({ role, count }))
      .sort((a, b) => a.role.localeCompare(b.role)),
  };

  return { summary, rows, total: rows.length };
}

async function fetchEmployeeInformationReport(input?: ReportFilterInput) {
  await requireReportsAccess();
  const filters = normalizeFilters(input);
  const records = await db.employee.findMany({
    where: getEmployeeInformationWhere(filters),
    orderBy: [{ employeeCode: "asc" }, { lastName: "asc" }],
    select: {
      employeeId: true,
      employeeCode: true,
      firstName: true,
      lastName: true,
      startDate: true,
      endDate: true,
      employmentStatus: true,
      currentStatus: true,
      email: true,
      phone: true,
      isArchived: true,
      createdAt: true,
      updatedAt: true,
      department: { select: { name: true } },
      position: { select: { name: true } },
    },
  });

  const rows: EmployeeInformationReportRow[] = records.map((record) => ({
    employeeId: record.employeeId,
    employeeCode: record.employeeCode,
    employeeName: formatEmployeeName(record.firstName, record.lastName),
    department: record.department?.name ?? null,
    position: record.position?.name ?? null,
    employmentStatus: record.employmentStatus,
    currentStatus: record.currentStatus,
    email: record.email ?? null,
    phone: record.phone ?? null,
    startDate: record.startDate.toISOString(),
    endDate: toIsoString(record.endDate),
    isEnded: isEmployeeEndedStatus(record.currentStatus),
    isArchived: record.isArchived,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }));

  const summary: EmployeeInformationReportSummary = {
    totalEmployees: rows.length,
    activeEmployees: rows.filter((row) => !row.isArchived).length,
    archivedEmployees: rows.filter((row) => row.isArchived).length,
    withDepartmentCount: rows.filter((row) => Boolean(row.department)).length,
    withPositionCount: rows.filter((row) => Boolean(row.position)).length,
  };

  return { summary, rows, total: rows.length };
}

async function fetchContributionsDeductionsReport(
  input?: ReportFilterInput & { view?: ContributionsDeductionsReportView },
) {
  await requireReportsAccess();
  const filters = normalizeFilters(input);
  const view = input?.view ?? REPORT_VIEW.CONTRIBUTIONS;
  const deductionWhere = getDeductionRowsWhere(filters);

  const [contributionRows, deductionSummaryRows] = await Promise.all([
    listContributionDirectory(),
    db.employeeDeductionAssignment.findMany({
      where: deductionWhere,
      select: {
        employeeId: true,
        status: true,
        workflowStatus: true,
        updatedAt: true,
        remainingBalance: true,
        deductionType: { select: { frequency: true } },
      },
    }),
  ]);

  const filteredContributionRows = contributionRows.success
    ? filterContributionPreviewRows(contributionRows.data ?? [], filters)
    : [];
  const contributionEmployeeIds = new Set(
    filteredContributionRows.map((row) => row.employeeId),
  );

  const activeDeductionEmployeeIds = new Set<string>();
  let openInstallments = 0;
  let completedInstallmentsInRange = 0;

  for (const row of deductionSummaryRows) {
    if (
      row.workflowStatus === EmployeeDeductionWorkflowStatus.APPROVED &&
      row.status === EmployeeDeductionAssignmentStatus.ACTIVE
    ) {
      activeDeductionEmployeeIds.add(row.employeeId);
    }

    if (
      row.workflowStatus === EmployeeDeductionWorkflowStatus.APPROVED &&
      row.status === EmployeeDeductionAssignmentStatus.ACTIVE &&
      row.deductionType.frequency === DeductionFrequency.INSTALLMENT &&
      toNumber(row.remainingBalance) > 0
    ) {
      openInstallments += 1;
    }

    const completedInRange =
      row.workflowStatus === EmployeeDeductionWorkflowStatus.APPROVED &&
      row.status === EmployeeDeductionAssignmentStatus.COMPLETED &&
      row.deductionType.frequency === DeductionFrequency.INSTALLMENT &&
      (!filters.dateFrom || row.updatedAt >= filters.dateFrom) &&
      (!filters.dateToExclusive || row.updatedAt < filters.dateToExclusive);

    if (completedInRange) {
      completedInstallmentsInRange += 1;
    }
  }

  const summaryBase: ContributionsDeductionsReportSummary = {
    employeesWithContributionRecords: contributionEmployeeIds.size,
    employeesWithActiveDeductions: activeDeductionEmployeeIds.size,
    openInstallments,
    completedInstallmentsInRange,
    payrollImpactEmployeeCount: 0,
    payrollImpactContributionTotal: 0,
    payrollImpactDeductionTotal: 0,
    payrollImpactWithheldTotal: 0,
    payrollImpactRowCount: 0,
  };

  if (view === REPORT_VIEW.CONTRIBUTIONS) {
    const rows: ContributionSetupReportRow[] = filteredContributionRows.map(
      (record) => {
        const sssEe = record.sss.employeeShare;
        const philHealthEe = record.philHealth.employeeShare;
        const pagIbigEe = record.pagIbig.employeeShare;
        const withholdingEe = record.withholding.employeeShare;
        return {
          rowType: "CONTRIBUTION",
          id: record.employeeId,
          employeeId: record.employeeId,
          employeeCode: record.employeeCode,
          employeeName: record.employeeName,
          department: record.department || "Unassigned",
          effectiveDate: record.updatedAt,
          sssEe,
          philHealthEe,
          pagIbigEe,
          withholdingEe,
          employeeShareTotal: sssEe + philHealthEe + pagIbigEe + withholdingEe,
          isSssActive:
            record.sss.isIncludedInPayroll && record.sss.status === "READY",
          isPhilHealthActive:
            record.philHealth.isIncludedInPayroll &&
            record.philHealth.status === "READY",
          isPagIbigActive:
            record.pagIbig.isIncludedInPayroll &&
            record.pagIbig.status === "READY",
          isWithholdingActive:
            record.withholding.isIncludedInPayroll &&
            record.withholding.status === "READY",
        };
      },
    );

    return { summary: summaryBase, rows, total: rows.length, view };
  }

  if (view === REPORT_VIEW.DEDUCTIONS) {
    const records = await db.employeeDeductionAssignment.findMany({
      where: deductionWhere,
      orderBy: [{ effectiveFrom: "desc" }, { employee: { employeeCode: "asc" } }],
      select: {
        id: true,
        workflowStatus: true,
        status: true,
        effectiveFrom: true,
        effectiveTo: true,
        amountOverride: true,
        percentOverride: true,
        installmentTotal: true,
        installmentPerPayroll: true,
        remainingBalance: true,
        reason: true,
        employee: {
          select: {
            employeeId: true,
            employeeCode: true,
            firstName: true,
            lastName: true,
            department: { select: { name: true } },
          },
        },
        deductionType: {
          select: {
            name: true,
            amountMode: true,
            frequency: true,
            defaultAmount: true,
            defaultPercent: true,
          },
        },
      },
    });

    const rows: DeductionSetupReportRow[] = records.map((record) => ({
      rowType: "DEDUCTION",
      id: record.id,
      employeeId: record.employee.employeeId,
      employeeCode: record.employee.employeeCode,
      employeeName: formatEmployeeName(
        record.employee.firstName,
        record.employee.lastName,
      ),
      department: record.employee.department?.name ?? "Unassigned",
      deductionTypeName: record.deductionType.name,
      workflowStatus: record.workflowStatus,
      runtimeStatus: record.status,
      frequency: record.deductionType.frequency,
      effectiveFrom: record.effectiveFrom.toISOString(),
      effectiveTo: toIsoString(record.effectiveTo),
      amountValue:
        record.amountOverride != null
          ? toNumber(record.amountOverride)
          : record.deductionType.defaultAmount != null
            ? toNumber(record.deductionType.defaultAmount)
            : null,
      percentValue:
        record.percentOverride != null
          ? toNumber(record.percentOverride)
          : record.deductionType.defaultPercent != null
            ? toNumber(record.deductionType.defaultPercent)
            : null,
      installmentTotal:
        record.installmentTotal != null ? toNumber(record.installmentTotal) : null,
      installmentPerPayroll:
        record.installmentPerPayroll != null
          ? toNumber(record.installmentPerPayroll)
          : null,
      remainingBalance:
        record.remainingBalance != null ? toNumber(record.remainingBalance) : null,
      reason: record.reason ?? null,
    }));

    return { summary: summaryBase, rows, total: rows.length, view };
  }

  const records = await db.payrollEmployee.findMany({
    where: getPayrollEmployeesWhere(filters, true),
    orderBy: [
      { payroll: { payrollPeriodStart: "desc" } },
      { employee: { employeeCode: "asc" } },
    ],
    select: {
      id: true,
      grossPay: true,
      totalDeductions: true,
      netPay: true,
      deductions: {
        where: { isVoided: false },
        select: { deductionType: true, amount: true },
      },
      payroll: {
        select: {
          payrollId: true,
          payrollPeriodStart: true,
          payrollPeriodEnd: true,
          payrollType: true,
          releasedAt: true,
        },
      },
      employee: {
        select: {
          employeeId: true,
          employeeCode: true,
          firstName: true,
          lastName: true,
          department: { select: { name: true } },
        },
      },
    },
  });

  const rows: PayrollImpactReportRow[] = records.map((record) => {
    const contributionTotal = record.deductions.reduce((sum, line) => {
      return CONTRIBUTION_DEDUCTION_TYPES.has(line.deductionType)
        ? sum + toNumber(line.amount)
        : sum;
    }, 0);
    const deductionTotal = record.deductions.reduce((sum, line) => {
      return CONTRIBUTION_DEDUCTION_TYPES.has(line.deductionType)
        ? sum
        : sum + toNumber(line.amount);
    }, 0);

    return {
      rowType: "PAYROLL_IMPACT",
      payrollEmployeeId: record.id,
      payrollId: record.payroll.payrollId,
      employeeId: record.employee.employeeId,
      employeeCode: record.employee.employeeCode,
      employeeName: formatEmployeeName(
        record.employee.firstName,
        record.employee.lastName,
      ),
      department: record.employee.department?.name ?? "Unassigned",
      payrollPeriodStart: record.payroll.payrollPeriodStart.toISOString(),
      payrollPeriodEnd: record.payroll.payrollPeriodEnd.toISOString(),
      payrollType: record.payroll.payrollType,
      contributionTotal,
      deductionTotal,
      totalWithheld: contributionTotal + deductionTotal,
      grossPay: toNumber(record.grossPay),
      netPay: toNumber(record.netPay),
      releasedAt: toIsoString(record.payroll.releasedAt),
    };
  });

  const impactedEmployees = new Set(rows.map((row) => row.employeeId));
  const summary: ContributionsDeductionsReportSummary = {
    ...summaryBase,
    payrollImpactEmployeeCount: impactedEmployees.size,
    payrollImpactContributionTotal: rows.reduce(
      (sum, row) => sum + row.contributionTotal,
      0,
    ),
    payrollImpactDeductionTotal: rows.reduce(
      (sum, row) => sum + row.deductionTotal,
      0,
    ),
    payrollImpactWithheldTotal: rows.reduce(
      (sum, row) => sum + row.totalWithheld,
      0,
    ),
    payrollImpactRowCount: rows.length,
  };

  return { summary, rows, total: rows.length, view };
}

async function fetchContributionsReport(input?: ReportFilterInput) {
  const result = await fetchContributionsDeductionsReport({
    ...input,
    view: REPORT_VIEW.CONTRIBUTIONS,
  });

  const rows = result.rows as ContributionsReportRow[];
  const summary: ContributionsReportSummary = {
    totalContributionRecords: rows.length,
    activeSssCount: rows.filter((row) => row.isSssActive).length,
    activePhilHealthCount: rows.filter((row) => row.isPhilHealthActive).length,
    activePagIbigCount: rows.filter((row) => row.isPagIbigActive).length,
    activeWithholdingCount: rows.filter((row) => row.isWithholdingActive).length,
  };

  return { summary, rows, total: rows.length };
}

async function fetchDeductionsReport(input?: ReportFilterInput) {
  const result = await fetchContributionsDeductionsReport({
    ...input,
    view: REPORT_VIEW.DEDUCTIONS,
  });

  const rows = result.rows as DeductionsReportRow[];
  const activeEmployeeCount = new Set(
    rows
      .filter(
        (row) =>
          row.workflowStatus === EmployeeDeductionWorkflowStatus.APPROVED &&
          row.runtimeStatus === EmployeeDeductionAssignmentStatus.ACTIVE,
      )
      .map((row) => row.employeeId),
  ).size;

  const summary: DeductionsReportSummary = {
    totalAssignments: rows.length,
    employeesWithActiveDeductions: activeEmployeeCount,
    openInstallments: result.summary.openInstallments,
    completedInstallmentsInRange: result.summary.completedInstallmentsInRange,
  };

  return { summary, rows, total: rows.length };
}

async function fetchDeductedContributionsRows(input?: ReportFilterInput) {
  await requireReportsAccess();
  const filters = normalizeFilters(input);
  const records = await db.payrollEmployee.findMany({
    where: getPayrollEmployeesWithContributionWhere(filters),
    orderBy: [
      { payroll: { payrollPeriodStart: "desc" } },
      { employee: { employeeCode: "asc" } },
    ],
    select: {
      id: true,
      payroll: {
        select: {
          payrollPeriodStart: true,
          payrollPeriodEnd: true,
          payrollType: true,
          releasedAt: true,
        },
      },
      employee: {
        select: {
          employeeCode: true,
          firstName: true,
          lastName: true,
          department: { select: { name: true } },
        },
      },
      deductions: {
        where: {
          isVoided: false,
          deductionType: { in: Array.from(CONTRIBUTION_EXPORT_TYPES) },
        },
        select: {
          deductionType: true,
          amount: true,
        },
      },
    },
  });

  return records
    .map((record) => {
      let sss = 0;
      let philHealth = 0;
      let pagIbig = 0;
      let withholding = 0;

      for (const line of record.deductions) {
        const amount = toNumber(line.amount);
        switch (line.deductionType) {
          case PayrollDeductionType.CONTRIBUTION_SSS:
            sss += amount;
            break;
          case PayrollDeductionType.CONTRIBUTION_PHILHEALTH:
            philHealth += amount;
            break;
          case PayrollDeductionType.CONTRIBUTION_PAGIBIG:
            pagIbig += amount;
            break;
          case PayrollDeductionType.WITHHOLDING_TAX:
            withholding += amount;
            break;
          default:
            break;
        }
      }

      const totalDeducted = sss + philHealth + pagIbig + withholding;

      return {
        payrollEmployeeId: record.id,
        payrollPeriodStart: record.payroll.payrollPeriodStart.toISOString(),
        payrollPeriodEnd: record.payroll.payrollPeriodEnd.toISOString(),
        payrollType: record.payroll.payrollType,
        employeeCode: record.employee.employeeCode,
        employeeName: formatEmployeeName(
          record.employee.firstName,
          record.employee.lastName,
        ),
        department: record.employee.department?.name ?? "Unassigned",
        sss,
        philHealth,
        pagIbig,
        withholding,
        totalDeducted,
        releasedAt: toIsoString(record.payroll.releasedAt),
      };
    })
    .filter((row) => row.totalDeducted > 0);
}

async function fetchViolationsReport(input?: ReportFilterInput) {
  await requireReportsAccess();
  const filters = normalizeFilters(input);
  const records = await db.employeeViolation.findMany({
    where: getViolationsWhere(filters),
    orderBy: [{ violationDate: "desc" }, { employee: { employeeCode: "asc" } }],
    select: {
      id: true,
      violationDate: true,
      status: true,
      strikePointsSnapshot: true,
      isCountedForStrike: true,
      isAcknowledged: true,
      reviewedAt: true,
      voidedAt: true,
      employee: {
        select: {
          employeeId: true,
          employeeCode: true,
          firstName: true,
          lastName: true,
          department: { select: { name: true } },
        },
      },
      violation: { select: { name: true } },
      reviewedBy: { select: { username: true } },
    },
  });

  const rows: ViolationsReportRow[] = records.map((record) => ({
    id: record.id,
    employeeId: record.employee.employeeId,
    employeeCode: record.employee.employeeCode,
    employeeName: formatEmployeeName(
      record.employee.firstName,
      record.employee.lastName,
    ),
    department: record.employee.department?.name ?? "Unassigned",
    violationType: record.violation.name,
    incidentDate: record.violationDate.toISOString(),
    status: record.status,
    strikeValue: record.strikePointsSnapshot,
    countedStrikeValue:
      record.status === EmployeeViolationStatus.APPROVED &&
      record.isCountedForStrike &&
      !record.voidedAt
        ? record.strikePointsSnapshot
        : 0,
    isAcknowledged: record.isAcknowledged,
    reviewedBy: record.reviewedBy?.username ?? null,
    reviewedAt: toIsoString(record.reviewedAt),
  }));

  const summary: ViolationsReportSummary = {
    totalViolations: rows.length,
    pendingReviewCount: rows.filter(
      (row) => row.status === EmployeeViolationStatus.DRAFT,
    ).length,
    approvedCount: rows.filter(
      (row) => row.status === EmployeeViolationStatus.APPROVED,
    ).length,
    rejectedCount: rows.filter(
      (row) => row.status === EmployeeViolationStatus.REJECTED,
    ).length,
    activeStrikesTotal: rows.reduce(
      (sum, row) => sum + row.countedStrikeValue,
      0,
    ),
  };

  return { summary, rows, total: rows.length };
}

async function fetchPayrollReport(input?: ReportFilterInput) {
  await requireReportsAccess();
  const filters = normalizeFilters(input);
  const records = await db.payrollEmployee.findMany({
    where: getPayrollEmployeesWhere(filters),
    orderBy: [
      { payroll: { payrollPeriodStart: "desc" } },
      { employee: { employeeCode: "asc" } },
    ],
    select: {
      id: true,
      grossPay: true,
      totalDeductions: true,
      netPay: true,
      payroll: {
        select: {
          payrollId: true,
          payrollPeriodStart: true,
          payrollPeriodEnd: true,
          payrollType: true,
          releasedAt: true,
          releasedBy: { select: { username: true } },
        },
      },
      employee: {
        select: {
          employeeId: true,
          employeeCode: true,
          firstName: true,
          lastName: true,
          department: { select: { name: true } },
        },
      },
    },
  });

  const rows: PayrollReportRow[] = records.map((record) => ({
    payrollEmployeeId: record.id,
    payrollId: record.payroll.payrollId,
    payrollPeriodStart: record.payroll.payrollPeriodStart.toISOString(),
    payrollPeriodEnd: record.payroll.payrollPeriodEnd.toISOString(),
    payrollType: record.payroll.payrollType,
    employeeId: record.employee.employeeId,
    employeeCode: record.employee.employeeCode,
    employeeName: formatEmployeeName(
      record.employee.firstName,
      record.employee.lastName,
    ),
    department: record.employee.department?.name ?? "Unassigned",
    grossPay: toNumber(record.grossPay),
    totalDeductions: toNumber(record.totalDeductions),
    netPay: toNumber(record.netPay),
    releasedAt: toIsoString(record.payroll.releasedAt),
    releasedBy: record.payroll.releasedBy?.username ?? null,
  }));

  const runIds = new Set(rows.map((row) => row.payrollId));
  const employeeIds = new Set(rows.map((row) => row.employeeId));
  const summary: PayrollReportSummary = {
    releasedRunsCount: runIds.size,
    employeesPaidCount: employeeIds.size,
    grossTotal: rows.reduce((sum, row) => sum + row.grossPay, 0),
    deductionsTotal: rows.reduce((sum, row) => sum + row.totalDeductions, 0),
    netTotal: rows.reduce((sum, row) => sum + row.netPay, 0),
  };

  return { summary, rows, total: rows.length };
}

export async function listReportFilterOptions(): Promise<
  ReportSuccess<ReportFilterOptions> | ReportFailure
> {
  try {
    await requireReportsAccess();
    const [departments, employees] = await Promise.all([
      db.department.findMany({
        orderBy: { name: "asc" },
        select: { departmentId: true, name: true },
      }),
      db.employee.findMany({
        where: { isArchived: false },
        orderBy: [{ employeeCode: "asc" }, { lastName: "asc" }],
        select: {
          employeeId: true,
          employeeCode: true,
          firstName: true,
          lastName: true,
        },
      }),
    ]);

    return {
      success: true,
      data: {
        departments,
        employees: employees.map((employee) => ({
          employeeId: employee.employeeId,
          employeeCode: employee.employeeCode,
          employeeName: formatEmployeeName(
            employee.firstName,
            employee.lastName,
          ),
        })),
      },
    };
  } catch (error) {
    console.error("Error listing report filter options:", error);
    return { success: false, error: "Failed to load report filters." };
  }
}

export async function getAttendanceReport(
  input?: ReportFilterInput,
): Promise<
  | ReportSuccess<{
      summary: AttendanceReportSummary;
      rows: AttendanceReportRow[];
      total: number;
    }>
  | ReportFailure
> {
  try {
    return { success: true, data: await fetchAttendanceReport(input) };
  } catch (error) {
    console.error("Error loading attendance report:", error);
    return { success: false, error: "Failed to load attendance report." };
  }
}

export async function exportAttendanceReportCsv(
  input?: ReportFilterInput,
): Promise<ReportSuccess<CsvExport> | ReportFailure> {
  try {
    const data = await fetchAttendanceReport(input);
    const filename = `attendance-report-${buildFileRangeSuffix(input)}.csv`;
    const content = buildCsv(
      [
        "Employee Code",
        "Employee",
        "Department",
        "Work Date",
        "Status",
        "Expected Shift",
        "Actual In",
        "Actual Out",
        "Worked Minutes",
        "Net Worked Minutes",
        "Overtime Minutes",
        "Locked",
        "Payroll Linked",
      ],
      data.rows.map((row) => [
        row.employeeCode,
        row.employeeName,
        row.department,
        row.workDate,
        row.status,
        row.expectedShift,
        row.actualInAt ?? "",
        row.actualOutAt ?? "",
        row.workedMinutes,
        row.netWorkedMinutes,
        row.overtimeMinutes,
        row.isLocked ? "Yes" : "No",
        row.isPayrollLinked ? "Yes" : "No",
      ]),
    );
    return { success: true, data: { filename, content } };
  } catch (error) {
    console.error("Error exporting attendance report:", error);
    return { success: false, error: "Failed to export attendance report." };
  }
}

export async function getAccountsReport(
  input?: ReportFilterInput,
): Promise<
  | ReportSuccess<{
      summary: AccountsReportSummary;
      rows: AccountsReportRow[];
      total: number;
    }>
  | ReportFailure
> {
  try {
    return { success: true, data: await fetchAccountsReport(input) };
  } catch (error) {
    console.error("Error loading accounts report:", error);
    return { success: false, error: "Failed to load accounts report." };
  }
}

export async function getEmployeeInformationReport(
  input?: ReportFilterInput,
): Promise<
  | ReportSuccess<{
      summary: EmployeeInformationReportSummary;
      rows: EmployeeInformationReportRow[];
      total: number;
    }>
  | ReportFailure
> {
  try {
    return { success: true, data: await fetchEmployeeInformationReport(input) };
  } catch (error) {
    console.error("Error loading employee information report:", error);
    return {
      success: false,
      error: "Failed to load employee information report.",
    };
  }
}

export async function getContributionsReport(
  input?: ReportFilterInput,
): Promise<
  | ReportSuccess<{
      summary: ContributionsReportSummary;
      rows: ContributionsReportRow[];
      total: number;
    }>
  | ReportFailure
> {
  try {
    return { success: true, data: await fetchContributionsReport(input) };
  } catch (error) {
    console.error("Error loading contributions report:", error);
    return { success: false, error: "Failed to load contributions report." };
  }
}

export async function exportContributionsReportCsv(
  input?: ReportFilterInput,
): Promise<ReportSuccess<CsvExport> | ReportFailure> {
  try {
    const data = await fetchContributionsReport(input);
    const filename = `contributions-report-${buildFileRangeSuffix(input)}.csv`;
    const content = buildCsv(
      [
        "Employee Code",
        "Employee",
        "Department",
        "Effective Date",
        "SSS EE",
        "PhilHealth EE",
        "Pag-IBIG EE",
        "Withholding",
        "Employee Share Total",
        "SSS Active",
        "PhilHealth Active",
        "Pag-IBIG Active",
        "Withholding Active",
      ],
      data.rows.map((row) => [
        row.employeeCode,
        row.employeeName,
        row.department,
        row.effectiveDate,
        row.sssEe,
        row.philHealthEe,
        row.pagIbigEe,
        row.withholdingEe,
        row.employeeShareTotal,
        row.isSssActive ? "Yes" : "No",
        row.isPhilHealthActive ? "Yes" : "No",
        row.isPagIbigActive ? "Yes" : "No",
        row.isWithholdingActive ? "Yes" : "No",
      ]),
    );
    return { success: true, data: { filename, content } };
  } catch (error) {
    console.error("Error exporting contributions report:", error);
    return { success: false, error: "Failed to export contributions report." };
  }
}

export async function exportDeductedContributionsReportCsv(
  input?: ReportFilterInput,
): Promise<ReportSuccess<CsvExport> | ReportFailure> {
  try {
    const rows = await fetchDeductedContributionsRows(input);
    const filename = `contributions-deducted-report-${buildFileRangeSuffix(
      input,
    )}.csv`;
    const content = buildCsv(
      [
        "Payroll Period Start",
        "Payroll Period End",
        "Payroll Type",
        "Employee Code",
        "Employee",
        "Department",
        "SSS Deducted",
        "PhilHealth Deducted",
        "Pag-IBIG Deducted",
        "Withholding Deducted",
        "Total Deducted",
        "Released At",
      ],
      rows.map((row) => [
        row.payrollPeriodStart,
        row.payrollPeriodEnd,
        row.payrollType,
        row.employeeCode,
        row.employeeName,
        row.department,
        row.sss,
        row.philHealth,
        row.pagIbig,
        row.withholding,
        row.totalDeducted,
        row.releasedAt ?? "",
      ]),
    );
    return { success: true, data: { filename, content } };
  } catch (error) {
    console.error("Error exporting deducted contributions report:", error);
    return {
      success: false,
      error: "Failed to export deducted contributions report.",
    };
  }
}

export async function getDeductionsReport(
  input?: ReportFilterInput,
): Promise<
  | ReportSuccess<{
      summary: DeductionsReportSummary;
      rows: DeductionsReportRow[];
      total: number;
    }>
  | ReportFailure
> {
  try {
    return { success: true, data: await fetchDeductionsReport(input) };
  } catch (error) {
    console.error("Error loading deductions report:", error);
    return { success: false, error: "Failed to load deductions report." };
  }
}

export async function exportDeductionsReportCsv(
  input?: ReportFilterInput,
): Promise<ReportSuccess<CsvExport> | ReportFailure> {
  try {
    const data = await fetchDeductionsReport(input);
    const filename = `deductions-report-${buildFileRangeSuffix(input)}.csv`;
    const content = buildCsv(
      [
        "Employee Code",
        "Employee",
        "Department",
        "Deduction Type",
        "Workflow Status",
        "Payroll Status",
        "Frequency",
        "Effective From",
        "Effective To",
        "Amount",
        "Percent",
        "Installment Total",
        "Per Payroll",
        "Remaining Balance",
        "Reason",
      ],
      data.rows.map((row) => [
        row.employeeCode,
        row.employeeName,
        row.department,
        row.deductionTypeName,
        row.workflowStatus,
        row.runtimeStatus,
        row.frequency,
        row.effectiveFrom,
        row.effectiveTo ?? "",
        row.amountValue ?? "",
        row.percentValue ?? "",
        row.installmentTotal ?? "",
        row.installmentPerPayroll ?? "",
        row.remainingBalance ?? "",
        row.reason ?? "",
      ]),
    );
    return { success: true, data: { filename, content } };
  } catch (error) {
    console.error("Error exporting deductions report:", error);
    return { success: false, error: "Failed to export deductions report." };
  }
}

export async function exportAccountsReportCsv(
  input?: ReportFilterInput,
): Promise<ReportSuccess<CsvExport> | ReportFailure> {
  try {
    const data = await fetchAccountsReport(input);
    const filename = `accounts-report-${buildFileRangeSuffix(input)}.csv`;
    const content = buildCsv(
      [
        "Username",
        "Email",
        "Role",
        "Linked Employee",
        "Employee Code",
        "Department",
        "Disabled",
        "Created At",
        "Updated At",
      ],
      data.rows.map((row) => [
        row.username,
        row.email,
        row.role,
        row.linkedEmployeeName ?? "",
        row.linkedEmployeeCode ?? "",
        row.department ?? "",
        row.isDisabled ? "Yes" : "No",
        row.createdAt,
        row.updatedAt,
      ]),
    );
    return { success: true, data: { filename, content } };
  } catch (error) {
    console.error("Error exporting accounts report:", error);
    return { success: false, error: "Failed to export accounts report." };
  }
}

export async function exportEmployeeInformationReportCsv(
  input?: ReportFilterInput,
): Promise<ReportSuccess<CsvExport> | ReportFailure> {
  try {
    const data = await fetchEmployeeInformationReport(input);
    const filename = `employee-information-report-${buildFileRangeSuffix(
      input,
    )}.csv`;
    const content = buildCsv(
      [
        "Employee Code",
        "Employee",
        "Department",
        "Position",
        "Employment Status",
        "Current Status",
        "Email",
        "Phone",
        "Start Date",
        "End Date",
        "Ended",
        "Archived",
        "Created At",
        "Updated At",
      ],
      data.rows.map((row) => [
        row.employeeCode,
        row.employeeName,
        row.department ?? "",
        row.position ?? "",
        row.employmentStatus,
        row.currentStatus,
        row.email ?? "",
        row.phone ?? "",
        row.startDate,
        row.endDate ?? "",
        row.isEnded ? "Yes" : "No",
        row.isArchived ? "Yes" : "No",
        row.createdAt,
        row.updatedAt,
      ]),
    );
    return { success: true, data: { filename, content } };
  } catch (error) {
    console.error("Error exporting employee information report:", error);
    return {
      success: false,
      error: "Failed to export employee information report.",
    };
  }
}

export async function getContributionsDeductionsReport(
  input?: ReportFilterInput & { view?: ContributionsDeductionsReportView },
): Promise<
  | ReportSuccess<{
      summary: ContributionsDeductionsReportSummary;
      rows: ContributionsDeductionsReportRow[];
      total: number;
      view: ContributionsDeductionsReportView;
    }>
  | ReportFailure
> {
  try {
    return {
      success: true,
      data: await fetchContributionsDeductionsReport(input),
    };
  } catch (error) {
    console.error("Error loading contributions and deductions report:", error);
    return {
      success: false,
      error: "Failed to load contributions and deductions report.",
    };
  }
}

export async function exportContributionsDeductionsReportCsv(
  input?: ReportFilterInput & { view?: ContributionsDeductionsReportView },
): Promise<ReportSuccess<CsvExport> | ReportFailure> {
  try {
    const data = await fetchContributionsDeductionsReport(input);
    const view = data.view;
    const filename = `contributions-deductions-${view}-${buildFileRangeSuffix(
      input,
    )}.csv`;

    if (view === REPORT_VIEW.CONTRIBUTIONS) {
      const rows = data.rows as ContributionSetupReportRow[];
      const content = buildCsv(
        [
          "Employee Code",
          "Employee",
          "Department",
          "Effective Date",
          "SSS EE",
          "PhilHealth EE",
          "Pag-IBIG EE",
          "Withholding",
          "Employee Share Total",
          "SSS Active",
          "PhilHealth Active",
          "Pag-IBIG Active",
          "Withholding Active",
        ],
        rows.map((row) => [
          row.employeeCode,
          row.employeeName,
          row.department,
          row.effectiveDate,
          row.sssEe,
          row.philHealthEe,
          row.pagIbigEe,
          row.withholdingEe,
          row.employeeShareTotal,
          row.isSssActive ? "Yes" : "No",
          row.isPhilHealthActive ? "Yes" : "No",
          row.isPagIbigActive ? "Yes" : "No",
          row.isWithholdingActive ? "Yes" : "No",
        ]),
      );
      return { success: true, data: { filename, content } };
    }

    if (view === REPORT_VIEW.DEDUCTIONS) {
      const rows = data.rows as DeductionSetupReportRow[];
      const content = buildCsv(
        [
          "Employee Code",
          "Employee",
          "Department",
          "Deduction Type",
          "Workflow Status",
          "Payroll Status",
          "Frequency",
          "Effective From",
          "Effective To",
          "Amount",
          "Percent",
          "Installment Total",
          "Per Payroll",
          "Remaining Balance",
          "Reason",
        ],
        rows.map((row) => [
          row.employeeCode,
          row.employeeName,
          row.department,
          row.deductionTypeName,
          row.workflowStatus,
          row.runtimeStatus,
          row.frequency,
          row.effectiveFrom,
          row.effectiveTo ?? "",
          row.amountValue ?? "",
          row.percentValue ?? "",
          row.installmentTotal ?? "",
          row.installmentPerPayroll ?? "",
          row.remainingBalance ?? "",
          row.reason ?? "",
        ]),
      );
      return { success: true, data: { filename, content } };
    }

    const rows = data.rows as PayrollImpactReportRow[];
    const content = buildCsv(
      [
        "Payroll Period Start",
        "Payroll Period End",
        "Payroll Type",
        "Employee Code",
        "Employee",
        "Department",
        "Contribution Total",
        "Deduction Total",
        "Total Withheld",
        "Gross Pay",
        "Net Pay",
        "Released At",
      ],
      rows.map((row) => [
        row.payrollPeriodStart,
        row.payrollPeriodEnd,
        row.payrollType,
        row.employeeCode,
        row.employeeName,
        row.department,
        row.contributionTotal,
        row.deductionTotal,
        row.totalWithheld,
        row.grossPay,
        row.netPay,
        row.releasedAt ?? "",
      ]),
    );

    return { success: true, data: { filename, content } };
  } catch (error) {
    console.error(
      "Error exporting contributions and deductions report:",
      error,
    );
    return {
      success: false,
      error: "Failed to export contributions and deductions report.",
    };
  }
}

export async function getViolationsReport(
  input?: ReportFilterInput,
): Promise<
  | ReportSuccess<{
      summary: ViolationsReportSummary;
      rows: ViolationsReportRow[];
      total: number;
    }>
  | ReportFailure
> {
  try {
    return { success: true, data: await fetchViolationsReport(input) };
  } catch (error) {
    console.error("Error loading violations report:", error);
    return { success: false, error: "Failed to load violations report." };
  }
}

export async function exportViolationsReportCsv(
  input?: ReportFilterInput,
): Promise<ReportSuccess<CsvExport> | ReportFailure> {
  try {
    const data = await fetchViolationsReport(input);
    const filename = `violations-report-${buildFileRangeSuffix(input)}.csv`;
    const content = buildCsv(
      [
        "Employee Code",
        "Employee",
        "Department",
        "Violation Type",
        "Incident Date",
        "Status",
        "Strike Value",
        "Counted Strikes",
        "Acknowledged",
        "Reviewed By",
        "Reviewed At",
      ],
      data.rows.map((row) => [
        row.employeeCode,
        row.employeeName,
        row.department,
        row.violationType,
        row.incidentDate,
        row.status,
        row.strikeValue,
        row.countedStrikeValue,
        row.isAcknowledged ? "Yes" : "No",
        row.reviewedBy ?? "",
        row.reviewedAt ?? "",
      ]),
    );
    return { success: true, data: { filename, content } };
  } catch (error) {
    console.error("Error exporting violations report:", error);
    return { success: false, error: "Failed to export violations report." };
  }
}

export async function getPayrollReport(
  input?: ReportFilterInput,
): Promise<
  | ReportSuccess<{
      summary: PayrollReportSummary;
      rows: PayrollReportRow[];
      total: number;
    }>
  | ReportFailure
> {
  try {
    return { success: true, data: await fetchPayrollReport(input) };
  } catch (error) {
    console.error("Error loading payroll report:", error);
    return { success: false, error: "Failed to load payroll report." };
  }
}

export async function exportPayrollReportCsv(
  input?: ReportFilterInput,
): Promise<ReportSuccess<CsvExport> | ReportFailure> {
  try {
    const data = await fetchPayrollReport(input);
    const filename = `payroll-report-${buildFileRangeSuffix(input)}.csv`;
    const content = buildCsv(
      [
        "Payroll Period Start",
        "Payroll Period End",
        "Payroll Type",
        "Employee Code",
        "Employee",
        "Department",
        "Gross Pay",
        "Total Deductions",
        "Net Pay",
        "Released At",
        "Released By",
      ],
      data.rows.map((row) => [
        row.payrollPeriodStart,
        row.payrollPeriodEnd,
        row.payrollType,
        row.employeeCode,
        row.employeeName,
        row.department,
        row.grossPay,
        row.totalDeductions,
        row.netPay,
        row.releasedAt ?? "",
        row.releasedBy ?? "",
      ]),
    );
    return { success: true, data: { filename, content } };
  } catch (error) {
    console.error("Error exporting payroll report:", error);
    return { success: false, error: "Failed to export payroll report." };
  }
}
