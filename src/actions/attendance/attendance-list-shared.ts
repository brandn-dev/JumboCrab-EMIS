import { ATTENDANCE_STATUS, PUNCH_TYPE, type Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  computeBreakDeduction,
  computeLateGraceCreditMinutes,
  computeLateMinutes,
  computePayableAmountFromNetMinutes,
  computePayrollVariance,
  computeRatePerMinute,
  computeScheduledPaidMinutes,
  getExpectedShiftForDate,
} from "@/lib/attendance";
import { endOfZonedDay, startOfZonedDay } from "@/lib/timezone";
import type { AttendanceRecord } from "./attendance-shared";
import {
  buildEmployeeDayKey,
  buildRateLookupKey,
  computeBreakStats,
  resolveEffectiveDailyRates,
  serializeAttendance,
  serializeEmployeeSummary,
} from "./attendance-shared";

export type AttendanceDayPunch = {
  punchType: string;
  punchTime: Date;
  source: string | null;
};

export const loadAttendanceListContext = async ({
  page,
  pageSize,
  shouldPaginate,
  where,
}: {
  where: Prisma.AttendanceWhereInput;
  page: number;
  pageSize: number;
  shouldPaginate: boolean;
}) => {
  const totalCount = shouldPaginate
    ? await db.attendance.count({ where })
    : 0;
  const totalPages = shouldPaginate
    ? Math.max(1, Math.ceil(totalCount / pageSize))
    : 1;
  const safePage = shouldPaginate ? Math.min(page, totalPages) : 1;
  const skip = shouldPaginate ? (safePage - 1) * pageSize : undefined;
  const take = shouldPaginate ? pageSize : undefined;

  const records = await db.attendance.findMany({
    where,
    orderBy: { workDate: "desc" },
    skip,
    take,
    include: {
      employee: {
        select: {
          employeeId: true,
          employeeCode: true,
          firstName: true,
          lastName: true,
          department: { select: { name: true } },
          position: { select: { name: true } },
        },
      },
      expectedShift: {
        select: {
          id: true,
          name: true,
          isDayOff: true,
          startMinutes: true,
          endMinutes: true,
          breakStartMinutes: true,
          breakEndMinutes: true,
          breakMinutesUnpaid: true,
          paidHoursPerDay: true,
        },
      },
    },
  });

  const recordDatesByEmployee = new Map<string, Date[]>();
  records.forEach((record) => {
    if (!recordDatesByEmployee.has(record.employeeId)) {
      recordDatesByEmployee.set(record.employeeId, []);
    }
    recordDatesByEmployee.get(record.employeeId)!.push(record.workDate);
  });

  const effectiveDailyRates = await resolveEffectiveDailyRates({
    employeeDates: recordDatesByEmployee,
  });

  const punchesByEmployeeDay = new Map<string, AttendanceDayPunch[]>();
  if (records.length > 0) {
    const employeeIds = [...new Set(records.map((record) => record.employeeId))];
    const attendanceWorkDates = new Map(
      records.map((record) => [record.id, record.workDate]),
    );
    const attendanceIds = records.map((record) => record.id);
    const workDates = records.map((record) => record.workDate.getTime());
    const minWorkDate = new Date(Math.min(...workDates));
    const maxWorkDate = new Date(Math.max(...workDates));
    const rangeStart = startOfZonedDay(minWorkDate);
    const rangeEnd = endOfZonedDay(maxWorkDate);

    const allPunches = await db.punch.findMany({
      where: {
        employeeId: { in: employeeIds },
        OR: [
          { attendanceId: { in: attendanceIds } },
          {
            attendanceId: null,
            punchTime: { gte: rangeStart, lt: rangeEnd },
          },
        ],
      },
      orderBy: { punchTime: "asc" },
    });

    allPunches.forEach((punch) => {
      const linkedWorkDate = punch.attendanceId
        ? attendanceWorkDates.get(punch.attendanceId)
        : null;
      const key = buildEmployeeDayKey(
        punch.employeeId,
        linkedWorkDate ?? punch.punchTime,
      );
      if (!punchesByEmployeeDay.has(key)) {
        punchesByEmployeeDay.set(key, []);
      }
      punchesByEmployeeDay.get(key)!.push({
        punchType: punch.punchType,
        punchTime: punch.punchTime,
        source: punch.source ?? null,
      });
    });
  }

  return {
    records: records as AttendanceRecord[],
    totalCount,
    totalPages,
    safePage,
    effectiveDailyRates,
    punchesByEmployeeDay,
  };
};

export const enrichAttendanceRecords = ({
  effectiveDailyRates,
  punchesByEmployeeDay,
  records,
}: {
  records: AttendanceRecord[];
  effectiveDailyRates: Map<string, number | null>;
  punchesByEmployeeDay: Map<string, AttendanceDayPunch[]>;
}) =>
  records.map((record) => {
    const effectiveDailyRate =
      effectiveDailyRates.get(
        buildRateLookupKey(record.employeeId, record.workDate),
      ) ?? null;

    const dayStart = startOfZonedDay(record.workDate);
    const punches =
      punchesByEmployeeDay.get(
        buildEmployeeDayKey(record.employeeId, record.workDate),
      ) ?? [];
    const { breakCount, breakMinutes, breakStartAt, breakEndAt } =
      computeBreakStats(punches);

    const expectedShift =
      record.expectedShift && !record.expectedShift.isDayOff ? record.expectedShift : null;
    const expectedStart = record.scheduledStartMinutes ?? null;
    const expectedEnd = record.scheduledEndMinutes ?? null;
    const scheduledBreakMinutes = expectedShift?.breakMinutesUnpaid ?? null;

    const firstClockIn = punches.find((punch) => punch.punchType === "TIME_IN") ?? null;
    const lastClockOut =
      [...punches].reverse().find((punch) => punch.punchType === "TIME_OUT") ??
      null;
    const autoTimeoutPunch =
      [...punches]
        .reverse()
        .find(
          (punch) =>
            punch.punchType === PUNCH_TYPE.TIME_OUT &&
            punch.source === "AUTO_TIMEOUT",
        ) ?? null;

    const actualInAt = firstClockIn?.punchTime ?? record.actualInAt ?? null;
    const actualOutAt = lastClockOut?.punchTime ?? null;
    const actualInMinutes = actualInAt
      ? Math.round((actualInAt.getTime() - dayStart.getTime()) / 60000)
      : null;
    const actualOutMinutes = actualOutAt
      ? Math.round((actualOutAt.getTime() - dayStart.getTime()) / 60000)
      : null;

    const lateMinutes =
      computeLateMinutes(expectedStart, actualInMinutes) ??
      record.lateMinutes ??
      null;
    const workedMinutes =
      actualInAt && actualOutAt
        ? Math.max(
            0,
            Math.round((actualOutAt.getTime() - actualInAt.getTime()) / 60000),
          )
        : null;
    const mergedBreakMinutes = breakMinutes || record.breakMinutes || 0;
    const { deductedBreakMinutes, netWorkedMinutes } = computeBreakDeduction({
      workedMinutes,
      actualBreakMinutes: mergedBreakMinutes,
      scheduledBreakMinutes,
      breakStartMinutes: expectedShift?.breakStartMinutes ?? null,
      breakEndMinutes: expectedShift?.breakEndMinutes ?? null,
      actualInMinutes,
      actualOutMinutes,
    });
    const scheduledPaidMinutes = computeScheduledPaidMinutes({
      paidHoursPerDay:
        record.paidHoursPerDay ?? expectedShift?.paidHoursPerDay ?? null,
      scheduledStartMinutes: expectedStart,
      scheduledEndMinutes: expectedEnd,
      scheduledBreakMinutes,
    });
    const lateGraceCreditMinutes = computeLateGraceCreditMinutes({
      scheduledStartMinutes: expectedStart,
      actualInMinutes,
    });
    const payableWorkedMinutes =
      netWorkedMinutes != null && Number.isFinite(netWorkedMinutes)
        ? scheduledPaidMinutes != null && Number.isFinite(scheduledPaidMinutes)
          ? Math.max(
              0,
              Math.min(
                Math.round(scheduledPaidMinutes),
                Math.round(netWorkedMinutes) + lateGraceCreditMinutes,
              ),
            )
          : Math.max(0, Math.round(netWorkedMinutes))
        : null;
    const { undertimeMinutes, overtimeMinutesRaw } =
      netWorkedMinutes != null && scheduledPaidMinutes != null
        ? computePayrollVariance({
            netWorkedMinutes,
            scheduledPaidMinutes,
            lateGraceCreditMinutes,
          })
        : { undertimeMinutes: null, overtimeMinutesRaw: null };
    const ratePerMinute = computeRatePerMinute({
      dailyRate: effectiveDailyRate,
      scheduledPaidMinutes,
    });
    const payableAmount = computePayableAmountFromNetMinutes({
      netWorkedMinutes,
      ratePerMinute,
    });
    const normalizedStatus =
      record.status !== ATTENDANCE_STATUS.LEAVE &&
      !expectedShift &&
      !actualInAt &&
      !actualOutAt &&
      punches.length === 0
        ? ATTENDANCE_STATUS.REST
        : record.status;
    const forgotToTimeOut =
      Boolean(autoTimeoutPunch) ||
      (normalizedStatus === ATTENDANCE_STATUS.INCOMPLETE &&
        Boolean(actualInAt) &&
        !actualOutAt);

    return serializeAttendance(record, {
      status: normalizedStatus,
      forgotToTimeOut,
      breakCount: breakCount || record.breakCount || 0,
      breakMinutes: mergedBreakMinutes,
      deductedBreakMinutes,
      netWorkedMinutes,
      dailyRate: effectiveDailyRate,
      ratePerMinute,
      payableAmount,
      breakStartAt,
      breakEndAt,
      actualInAt,
      actualOutAt,
      expectedShiftId: expectedShift?.id ?? record.expectedShiftId ?? null,
      expectedShiftName: expectedShift?.name ?? record.expectedShift?.name ?? null,
      scheduledStartMinutes: expectedStart,
      scheduledEndMinutes: expectedEnd,
      scheduledBreakMinutes,
      punchesCount: punches.length,
      lateMinutes,
      lateGraceCreditMinutes,
      undertimeMinutes,
      overtimeMinutesRaw,
      workedMinutes,
      payableWorkedMinutes,
    });
  });

export const buildSingleDayAttendanceList = async ({
  enriched,
  startDate,
  startLabel,
  employeeWhere,
}: {
  startDate: Date;
  startLabel: string;
  enriched: ReturnType<typeof enrichAttendanceRecords>;
  employeeWhere?: Prisma.EmployeeWhereInput;
}) => {
  const employees = await db.employee.findMany({
    where: {
      isArchived: false,
      ...(employeeWhere ?? {}),
    },
    orderBy: { employeeCode: "asc" },
    select: {
      employeeId: true,
      employeeCode: true,
      firstName: true,
      lastName: true,
      department: { select: { name: true } },
      position: { select: { name: true } },
    },
  });

  const dayStart = startOfZonedDay(startDate);
  const dayEnd = endOfZonedDay(startDate);

  const includeAllDatesByEmployee = new Map<string, Date[]>();
  employees.forEach((employee) => {
    includeAllDatesByEmployee.set(employee.employeeId, [dayStart]);
  });
  const includeAllEffectiveRates = await resolveEffectiveDailyRates({
    employeeDates: includeAllDatesByEmployee,
  });

  const employeeIds = employees.map((employee) => employee.employeeId);
  const attendanceIds = enriched
    .map((record) => record.id)
    .filter((id) => !id.startsWith("placeholder-"));
  const punches = await db.punch.findMany({
    where: {
      employeeId: { in: employeeIds },
      OR: [
        ...(attendanceIds.length
          ? [{ attendanceId: { in: attendanceIds } }]
          : []),
        {
          attendanceId: null,
          punchTime: { gte: dayStart, lt: dayEnd },
        },
      ],
    },
    orderBy: { punchTime: "asc" },
  });

  const breakMap = new Map<
    string,
    {
      count: number;
      minutes: number;
      startAt: string | null;
      endAt: string | null;
    }
  >();
  const forgotTimeoutMap = new Map<string, boolean>();

  employeeIds.forEach((employeeId) => {
    breakMap.set(employeeId, {
      count: 0,
      minutes: 0,
      startAt: null,
      endAt: null,
    });
    forgotTimeoutMap.set(employeeId, false);
  });

  const groupedPunches = new Map<string, typeof punches>();
  punches.forEach((punch) => {
    if (!groupedPunches.has(punch.employeeId)) {
      groupedPunches.set(punch.employeeId, []);
    }
    groupedPunches.get(punch.employeeId)!.push(punch);
  });

  groupedPunches.forEach((punchList, employeeId) => {
    const stats = computeBreakStats(punchList);
    const autoTimeoutPunch =
      [...punchList]
        .reverse()
        .find(
          (punch) =>
            punch.punchType === PUNCH_TYPE.TIME_OUT &&
            punch.source === "AUTO_TIMEOUT",
        ) ?? null;
    breakMap.set(employeeId, {
      count: stats.breakCount,
      minutes: stats.breakMinutes,
      startAt: stats.breakStartAt ? stats.breakStartAt.toISOString() : null,
      endAt: stats.breakEndAt ? stats.breakEndAt.toISOString() : null,
    });
    forgotTimeoutMap.set(employeeId, Boolean(autoTimeoutPunch));
  });

  const existingByEmployeeId = new Map(
    enriched.map((row) => [row.employeeId, row]),
  );
  const expectedMap = new Map<
    string,
    Awaited<ReturnType<typeof getExpectedShiftForDate>>
  >();
  await Promise.all(
    employees.map(async (employee) => {
      const expected = await getExpectedShiftForDate(employee.employeeId, dayStart);
      expectedMap.set(employee.employeeId, expected);
    }),
  );

  const data = employees.map((employee) => {
    const existing = existingByEmployeeId.get(employee.employeeId);
    const breaks = breakMap.get(employee.employeeId) ?? {
      count: 0,
      minutes: 0,
      startAt: null,
      endAt: null,
    };
    const expected = expectedMap.get(employee.employeeId);
    const scheduledStart =
      existing?.scheduledStartMinutes ??
      expected?.scheduledStartMinutes ??
      null;
    const scheduledEnd =
      existing?.scheduledEndMinutes ??
      expected?.scheduledEndMinutes ??
      null;
    const scheduledBreakMinutes =
      existing?.scheduledBreakMinutes ??
      expected?.shift?.breakMinutesUnpaid ??
      null;
    const scheduledPaidMinutes = computeScheduledPaidMinutes({
      paidHoursPerDay: expected?.shift?.paidHoursPerDay ?? null,
      scheduledStartMinutes: scheduledStart,
      scheduledEndMinutes: scheduledEnd,
      scheduledBreakMinutes,
    });
    const effectiveDailyRate =
      includeAllEffectiveRates.get(
        buildRateLookupKey(employee.employeeId, dayStart),
      ) ?? null;
    const ratePerMinute = computeRatePerMinute({
      dailyRate: effectiveDailyRate,
      scheduledPaidMinutes,
    });
    const expectedShiftId =
      existing?.expectedShiftId ?? expected?.shift?.id ?? null;
    const expectedShiftName =
      existing?.expectedShiftName ?? expected?.shift?.name ?? null;

    if (existing) {
      return {
        ...existing,
        dailyRate: existing.dailyRate ?? effectiveDailyRate,
        ratePerMinute: existing.ratePerMinute ?? ratePerMinute ?? null,
        scheduledStartMinutes: scheduledStart,
        scheduledEndMinutes: scheduledEnd,
        scheduledBreakMinutes,
        expectedShiftId,
        expectedShiftName,
        forgotToTimeOut:
          (forgotTimeoutMap.get(employee.employeeId) ?? false) ||
          existing.forgotToTimeOut ||
          false,
        breakCount: breaks.count || existing.breakCount || 0,
        breakMinutes: breaks.minutes || existing.breakMinutes || 0,
        breakStartAt: breaks.startAt ?? existing.breakStartAt ?? null,
        breakEndAt: breaks.endAt ?? existing.breakEndAt ?? null,
      };
    }

    return {
      id: `placeholder-${employee.employeeId}-${startLabel}`,
      workDate: dayStart.toISOString(),
      status: expected?.shift && !expected.shift.isDayOff
        ? ATTENDANCE_STATUS.ABSENT
        : ATTENDANCE_STATUS.REST,
      expectedShiftId,
      expectedShiftName,
      scheduledStartMinutes: scheduledStart,
      scheduledEndMinutes: scheduledEnd,
      scheduledBreakMinutes,
      actualInAt: null,
      actualOutAt: null,
      workedMinutes: null,
      workedHoursAndMinutes: null,
      dailyRate: effectiveDailyRate,
      ratePerMinute,
      payableAmount: null,
      deductedBreakMinutes: 0,
      netWorkedMinutes: null,
      netWorkedHoursAndMinutes: null,
      lateMinutes: null,
      undertimeMinutes: null,
      overtimeMinutesRaw: null,
      punchesCount: 0,
      forgotToTimeOut: forgotTimeoutMap.get(employee.employeeId) ?? false,
      breakCount: breaks.count,
      breakMinutes: breaks.minutes,
      breakStartAt: breaks.startAt,
      breakEndAt: breaks.endAt,
      employeeId: employee.employeeId,
      employee: serializeEmployeeSummary(employee),
    };
  });

  return {
    success: true as const,
    data,
    totalCount: data.length,
    page: 1,
    pageSize: data.length,
    totalPages: 1,
  };
};
