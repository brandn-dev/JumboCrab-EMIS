"use server";

import { ATTENDANCE_STATUS, LeaveRequestStatus } from "@prisma/client";
import { getExpectedShiftForDate } from "@/lib/attendance";
import { db } from "@/lib/db";
import { requireScheduleManager } from "@/lib/scheduling-auth";
import { scheduleAccessError } from "@/lib/scheduling-access";
import { leaveReviewSchema } from "@/lib/validations/requests";
import {
  DAY_MS,
  employeeRequestSelect,
  enumerateZonedDaysInclusive,
  revalidateRequestLayouts,
  reviewedBySelect,
  serializeLeaveRequest,
  shortDate,
  syncEmployeeCurrentStatusFromApprovedLeave,
  toZonedDayKey,
} from "./requests-shared";
import {
  consumeEmployeeLeaveCredits,
  toLeaveCreditType,
} from "./requests-leave-credit-shared";
import { notifyEmployeeOfRequestDecision } from "./requests-notifications";
import type { LeaveRequestRow, RequestReviewPayload } from "./types";

export async function reviewLeaveRequest(
  input: RequestReviewPayload,
): Promise<{
  success: boolean;
  data?: LeaveRequestRow;
  error?: string;
}> {
  try {
    const actor = await requireScheduleManager();

    const parsed = leaveReviewSchema.safeParse(input);
    if (!parsed.success) {
      return {
        success: false,
        error: parsed.error.issues[0]?.message || "Invalid review data.",
      };
    }

    const existing = await db.leaveRequest.findUnique({
      where: { id: parsed.data.id },
      include: {
        employee: {
          select: {
            employeeId: true,
            employeeCode: true,
            firstName: true,
            lastName: true,
            startDate: true,
            isArchived: true,
          },
        },
      },
    });

    if (!existing) {
      return { success: false, error: "Leave request not found." };
    }
    if (existing.employee.isArchived) {
      return {
        success: false,
        error: "The employee linked to this request is archived.",
      };
    }
    if (existing.status !== LeaveRequestStatus.PENDING_MANAGER) {
      return {
        success: false,
        error: "Only pending review requests can be reviewed.",
      };
    }

    const reviewedAt = new Date();

    if (parsed.data.decision === "REJECTED") {
      const reviewed = await db.leaveRequest.update({
        where: { id: parsed.data.id },
        data: {
          status: LeaveRequestStatus.REJECTED,
          managerRemarks: parsed.data.managerRemarks ?? null,
          reviewedByUserId: actor.userId,
          reviewedAt,
        },
        include: {
          employee: { select: employeeRequestSelect },
          reviewedBy: { select: reviewedBySelect },
          attendances: {
            select: {
              workDate: true,
              isPaidLeave: true,
            },
          },
        },
      });

      revalidateRequestLayouts();
      await notifyEmployeeOfRequestDecision({
        eventType: "LEAVE_REQUEST_REJECTED",
        title: "Leave request rejected",
        message: "Your leave request was rejected.",
        actorUserId: actor.userId,
        employeeId: reviewed.employee.employeeId,
        entityType: "LeaveRequest",
        entityId: reviewed.id,
        linkHref: "/employee/leave",
      });
      return { success: true, data: serializeLeaveRequest(reviewed) };
    }

    const leaveDays = enumerateZonedDaysInclusive(
      existing.startDate,
      existing.endDate,
    );
    const leaveCreditType = toLeaveCreditType(existing.leaveType);
    const isPaidLeaveRequest = Boolean(leaveCreditType);
    const firstDay = leaveDays[0];
    const lastExclusive = new Date(
      leaveDays[leaveDays.length - 1].getTime() + DAY_MS,
    );

    const existingAttendanceRows = await db.attendance.findMany({
      where: {
        employeeId: existing.employeeId,
        workDate: {
          gte: firstDay,
          lt: lastExclusive,
        },
      },
      select: {
        id: true,
        workDate: true,
        isLocked: true,
        payrollPeriodId: true,
        actualInAt: true,
        actualOutAt: true,
        workedMinutes: true,
        netWorkedMinutes: true,
      },
    });

    const payrollLinkedRow = existingAttendanceRows.find(
      (row) => row.payrollPeriodId,
    );
    if (payrollLinkedRow) {
      return {
        success: false,
        error: `Cannot approve leave for ${shortDate(
          payrollLinkedRow.workDate,
        )}. Attendance is already linked to payroll.`,
      };
    }

    const lockedRow = existingAttendanceRows.find((row) => row.isLocked);
    if (lockedRow) {
      return {
        success: false,
        error: `Cannot approve leave for ${shortDate(
          lockedRow.workDate,
        )}. Attendance is locked for that date.`,
      };
    }

    const workedRow = existingAttendanceRows.find(
      (row) =>
        Boolean(row.actualInAt) ||
        Boolean(row.actualOutAt) ||
        Math.max(0, row.workedMinutes ?? 0) > 0 ||
        Math.max(0, row.netWorkedMinutes ?? 0) > 0,
    );
    if (workedRow) {
      return {
        success: false,
        error: `Cannot approve leave for ${shortDate(
          workedRow.workDate,
        )}. Attendance already has recorded work on that date.`,
      };
    }

    const expectedShifts = await Promise.all(
      leaveDays.map(async (day) => ({
        day,
        dayKey: toZonedDayKey(day),
        expected: await getExpectedShiftForDate(existing.employeeId, day),
      })),
    );

    const unscheduledPaidDay = expectedShifts.find(
      ({ expected }) =>
        isPaidLeaveRequest &&
        (!expected.shift || expected.shift.isDayOff) &&
        expected.scheduledStartMinutes == null &&
        expected.scheduledEndMinutes == null,
    );
    if (unscheduledPaidDay) {
      return {
        success: false,
        error: `Cannot mark ${shortDate(
          unscheduledPaidDay.day,
        )} as paid leave because that date has no scheduled work.`,
      };
    }

    const reviewed = await db.$transaction(async (tx) => {
      for (const { day, expected } of expectedShifts) {
        await tx.attendance.upsert({
          where: {
            employeeId_workDate: {
              employeeId: existing.employeeId,
              workDate: day,
            },
          },
          update: {
            status: ATTENDANCE_STATUS.LEAVE,
            isPaidLeave: isPaidLeaveRequest,
            leaveRequestId: existing.id,
            expectedShiftId: expected.shift?.id ?? null,
            scheduledStartMinutes: expected.scheduledStartMinutes,
            scheduledEndMinutes: expected.scheduledEndMinutes,
            paidHoursPerDay: expected.shift?.paidHoursPerDay ?? null,
            actualInAt: null,
            actualOutAt: null,
            workedMinutes: null,
            breakMinutes: 0,
            deductedBreakMinutes: 0,
            netWorkedMinutes: null,
            breakCount: 0,
            lateMinutes: 0,
            undertimeMinutes: 0,
            overtimeMinutesRaw: 0,
            overtimeMinutesApproved: 0,
            nightMinutes: 0,
          },
          create: {
            employeeId: existing.employeeId,
            workDate: day,
            status: ATTENDANCE_STATUS.LEAVE,
            isPaidLeave: isPaidLeaveRequest,
            leaveRequestId: existing.id,
            expectedShiftId: expected.shift?.id ?? null,
            scheduledStartMinutes: expected.scheduledStartMinutes,
            scheduledEndMinutes: expected.scheduledEndMinutes,
            paidHoursPerDay: expected.shift?.paidHoursPerDay ?? null,
            actualInAt: null,
            actualOutAt: null,
            workedMinutes: null,
            breakMinutes: 0,
            deductedBreakMinutes: 0,
            netWorkedMinutes: null,
            breakCount: 0,
            lateMinutes: 0,
            undertimeMinutes: 0,
            overtimeMinutesRaw: 0,
            overtimeMinutesApproved: 0,
            nightMinutes: 0,
            isLocked: false,
          },
        });
      }

      if (leaveCreditType) {
        await consumeEmployeeLeaveCredits({
          client: tx,
          employeeId: existing.employeeId,
          employeeStartDate: existing.employee.startDate,
          leaveType: leaveCreditType,
          days: leaveDays.length,
          effectiveDate: reviewedAt,
          leaveRequestId: existing.id,
          createdByUserId: actor.userId,
        });
      }

      const reviewedRequest = await tx.leaveRequest.update({
        where: { id: parsed.data.id },
        data: {
          status: LeaveRequestStatus.APPROVED,
          managerRemarks: parsed.data.managerRemarks ?? null,
          reviewedByUserId: actor.userId,
          reviewedAt,
        },
        include: {
          employee: { select: employeeRequestSelect },
          reviewedBy: { select: reviewedBySelect },
          attendances: {
            select: {
              workDate: true,
            },
          },
        },
      });

      await syncEmployeeCurrentStatusFromApprovedLeave(
        tx,
        existing.employeeId,
        reviewedAt,
      );

      return reviewedRequest;
    });

    revalidateRequestLayouts();
    await notifyEmployeeOfRequestDecision({
      eventType: "LEAVE_REQUEST_APPROVED",
      title: "Leave request approved",
      message: "Your leave request was approved.",
      actorUserId: actor.userId,
      employeeId: reviewed.employee.employeeId,
      entityType: "LeaveRequest",
      entityId: reviewed.id,
      linkHref: "/employee/leave",
    });
    return { success: true, data: serializeLeaveRequest(reviewed) };
  } catch (error) {
    console.error("Error reviewing leave request:", error);
    const accessError = scheduleAccessError(error, "Failed to review leave request.");
    return {
      success: false,
      error:
        accessError === "Unauthorized" || accessError === "Forbidden"
          ? "You are not allowed to review leave requests."
          : accessError,
    };
  }
}
