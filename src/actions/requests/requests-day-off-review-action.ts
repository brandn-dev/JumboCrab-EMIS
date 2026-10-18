"use server";

import { ATTENDANCE_STATUS, DayOffRequestStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { requireScheduleManager } from "@/lib/scheduling-auth";
import { scheduleAccessError } from "@/lib/scheduling-access";
import { startOfZonedDay } from "@/lib/timezone";
import { requestReviewSchema } from "@/lib/validations/requests";
import {
  buildDayOffPreview,
  employeeRequestSelect,
  getScheduleSwapBlockingIssue,
  revalidateRequestLayouts,
  reviewedBySelect,
  scheduleSwapEmployeeSelect,
  serializeDayOffRequest,
  toEmployeeName,
} from "./requests-shared";
import { notifyEmployeeOfRequestDecision } from "./requests-notifications";
import type { DayOffRequestRow, RequestReviewPayload } from "./types";

export async function reviewDayOffRequest(
  input: RequestReviewPayload,
): Promise<{
  success: boolean;
  data?: DayOffRequestRow;
  error?: string;
}> {
  try {
    const actor = await requireScheduleManager();

    const parsed = requestReviewSchema.safeParse(input);
    if (!parsed.success) {
      return {
        success: false,
        error: parsed.error.issues[0]?.message || "Invalid review data.",
      };
    }

    const existing = await db.dayOffRequest.findUnique({
      where: { id: parsed.data.id },
      include: {
        employee: { select: scheduleSwapEmployeeSelect },
        reviewedBy: { select: reviewedBySelect },
      },
    });

    if (!existing) {
      return { success: false, error: "Day off request not found." };
    }
    if (existing.employee.isArchived) {
      return {
        success: false,
        error: "The employee linked to this request is archived.",
      };
    }
    if (existing.status !== DayOffRequestStatus.PENDING_MANAGER) {
      return {
        success: false,
        error: "Only pending day off requests can be reviewed.",
      };
    }

    const reviewedAt = new Date();

    if (parsed.data.decision === "REJECTED") {
      const reviewed = await db.dayOffRequest.update({
        where: { id: parsed.data.id },
        data: {
          status: DayOffRequestStatus.REJECTED,
          managerRemarks: parsed.data.managerRemarks ?? null,
          reviewedByUserId: actor.userId,
          reviewedAt,
        },
        include: {
          employee: { select: employeeRequestSelect },
          reviewedBy: { select: reviewedBySelect },
        },
      });

      revalidateRequestLayouts();
      await notifyEmployeeOfRequestDecision({
        eventType: "DAY_OFF_REQUEST_REJECTED",
        title: "Day off request rejected",
        message: "Your day off request was rejected.",
        actorUserId: actor.userId,
        employeeId: reviewed.employee.employeeId,
        entityType: "DayOffRequest",
        entityId: reviewed.id,
        linkHref: "/employee/day-off",
      });
      return { success: true, data: serializeDayOffRequest(reviewed) };
    }

    const sourceOffDate = startOfZonedDay(existing.sourceOffDate ?? existing.workDate);
    const targetWorkDate = startOfZonedDay(existing.targetWorkDate ?? existing.workDate);
    const previewResult = await buildDayOffPreview(
      existing.employeeId,
      sourceOffDate,
      targetWorkDate,
    );
    if ("error" in previewResult) {
      return { success: false, error: previewResult.error };
    }
    if (!previewResult.sourceIsDayOff) {
      return {
        success: false,
        error: "The source date is no longer an OFF day.",
      };
    }
    if (!previewResult.targetSnapshot.shiftId || previewResult.targetIsDayOff) {
      return {
        success: false,
        error: "The target date is no longer a scheduled workday.",
      };
    }
    if (previewResult.targetSnapshot.shiftId !== existing.currentShiftIdSnapshot) {
      return {
        success: false,
        error:
          "The target workday schedule changed after the request was submitted. Ask for a new change day off request.",
      };
    }

    const [sourceBlockingIssue, targetBlockingIssue] = await Promise.all([
      getScheduleSwapBlockingIssue(
        existing.employeeId,
        sourceOffDate,
        toEmployeeName(existing.employee),
      ),
      getScheduleSwapBlockingIssue(
        existing.employeeId,
        targetWorkDate,
        toEmployeeName(existing.employee),
      ),
    ]);
    if (sourceBlockingIssue || targetBlockingIssue) {
      return { success: false, error: sourceBlockingIssue ?? targetBlockingIssue ?? undefined };
    }

    const reviewed = await db.$transaction(async (tx) => {
      await tx.employeeShiftOverride.upsert({
        where: {
          employeeId_workDate: {
            employeeId: existing.employeeId,
            workDate: sourceOffDate,
          },
        },
        update: {
          shiftId: existing.currentShiftIdSnapshot,
          source: "APPROVED_REQUEST",
          note: `Day off transfer source approved from request ${existing.id}`,
        },
        create: {
          employeeId: existing.employeeId,
          workDate: sourceOffDate,
          shiftId: existing.currentShiftIdSnapshot,
          source: "APPROVED_REQUEST",
          note: `Day off transfer source approved from request ${existing.id}`,
        },
      });

      await tx.employeeShiftOverride.upsert({
        where: {
          employeeId_workDate: {
            employeeId: existing.employeeId,
            workDate: targetWorkDate,
          },
        },
        update: {
          shiftId: existing.sourceShiftIdSnapshot,
          source: "APPROVED_REQUEST",
          note: `Day off transfer target approved from request ${existing.id}`,
        },
        create: {
          employeeId: existing.employeeId,
          workDate: targetWorkDate,
          shiftId: existing.sourceShiftIdSnapshot,
          source: "APPROVED_REQUEST",
          note: `Day off transfer target approved from request ${existing.id}`,
        },
      });

      const sourceAttendance = await tx.attendance.findUnique({
        where: {
          employeeId_workDate: {
            employeeId: existing.employeeId,
            workDate: sourceOffDate,
          },
        },
        select: { id: true },
      });

      if (sourceAttendance) {
        await tx.attendance.update({
          where: { id: sourceAttendance.id },
          data: {
            expectedShiftId: existing.currentShiftIdSnapshot,
            scheduledStartMinutes: existing.currentStartMinutesSnapshot,
            scheduledEndMinutes: existing.currentEndMinutesSnapshot,
            paidHoursPerDay: null,
            leaveRequestId: null,
            isPaidLeave: false,
          },
        });
      }

      const targetAttendance = await tx.attendance.findUnique({
        where: {
          employeeId_workDate: {
            employeeId: existing.employeeId,
            workDate: targetWorkDate,
          },
        },
        select: { id: true },
      });

      if (targetAttendance) {
        await tx.attendance.update({
          where: { id: targetAttendance.id },
          data: {
            status: ATTENDANCE_STATUS.REST,
            isPaidLeave: false,
            leaveRequestId: null,
            expectedShiftId: existing.sourceShiftIdSnapshot,
            scheduledStartMinutes: null,
            scheduledEndMinutes: null,
            paidHoursPerDay: null,
          },
        });
      }

      return tx.dayOffRequest.update({
        where: { id: parsed.data.id },
        data: {
          status: DayOffRequestStatus.APPROVED,
          managerRemarks: parsed.data.managerRemarks ?? null,
          reviewedByUserId: actor.userId,
          reviewedAt,
        },
        include: {
          employee: { select: employeeRequestSelect },
          reviewedBy: { select: reviewedBySelect },
        },
      });
    });

    revalidateRequestLayouts();
    await notifyEmployeeOfRequestDecision({
      eventType: "DAY_OFF_REQUEST_APPROVED",
        title: "Day off request approved",
        message: "Your change day off request was approved.",
      actorUserId: actor.userId,
      employeeId: reviewed.employee.employeeId,
      entityType: "DayOffRequest",
      entityId: reviewed.id,
      linkHref: "/employee/day-off",
    });
    return { success: true, data: serializeDayOffRequest(reviewed) };
  } catch (error) {
    console.error("Error reviewing day off request:", error);
    const accessError = scheduleAccessError(error, "Failed to review day off request.");
    return {
      success: false,
      error:
        accessError === "Unauthorized" || accessError === "Forbidden"
          ? "You are not allowed to review day off requests."
          : accessError,
    };
  }
}
