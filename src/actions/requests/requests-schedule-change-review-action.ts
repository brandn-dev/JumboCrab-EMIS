"use server";

import { ScheduleChangeRequestStatus } from "@prisma/client";
import { getExpectedShiftForDate } from "@/lib/attendance";
import { db } from "@/lib/db";
import { requireScheduleManager } from "@/lib/scheduling-auth";
import { scheduleAccessError } from "@/lib/scheduling-access";
import { startOfZonedDay } from "@/lib/timezone";
import { requestReviewSchema } from "@/lib/validations/requests";
import {
  buildScheduleChangePreview,
  enumerateZonedDaysInclusive,
  employeeRequestSelect,
  getScheduleSwapBlockingIssue,
  revalidateRequestLayouts,
  reviewedBySelect,
  scheduleSwapEmployeeSelect,
  serializeScheduleChangeRequest,
  toEmployeeName,
} from "./requests-shared";
import { notifyEmployeeOfRequestDecision } from "./requests-notifications";
import type {
  RequestReviewPayload,
  ScheduleChangeRequestRow,
} from "./types";

export async function reviewScheduleChangeRequest(
  input: RequestReviewPayload,
): Promise<{
  success: boolean;
  data?: ScheduleChangeRequestRow;
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

    const existing = await db.scheduleChangeRequest.findUnique({
      where: { id: parsed.data.id },
      include: {
        employee: { select: scheduleSwapEmployeeSelect },
        reviewedBy: { select: reviewedBySelect },
      },
    });

    if (!existing) {
      return { success: false, error: "Schedule change request not found." };
    }
    if (existing.employee.isArchived) {
      return {
        success: false,
        error: "The employee linked to this request is archived.",
      };
    }
    if (existing.status !== ScheduleChangeRequestStatus.PENDING_MANAGER) {
      return {
        success: false,
        error: "Only pending schedule change requests can be reviewed.",
      };
    }

    const reviewedAt = new Date();

    if (parsed.data.decision === "REJECTED") {
      const reviewed = await db.scheduleChangeRequest.update({
        where: { id: parsed.data.id },
        data: {
          status: ScheduleChangeRequestStatus.REJECTED,
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
        eventType: "SCHEDULE_CHANGE_REQUEST_REJECTED",
        title: "Schedule change request rejected",
        message: "Your schedule change request was rejected.",
        actorUserId: actor.userId,
        employeeId: reviewed.employee.employeeId,
        entityType: "ScheduleChangeRequest",
        entityId: reviewed.id,
        linkHref: "/employee/requests",
      });
      return { success: true, data: serializeScheduleChangeRequest(reviewed) };
    }

    const startDate = startOfZonedDay(existing.startDate ?? existing.workDate);
    const endDate = startOfZonedDay(existing.endDate ?? existing.workDate);
    const previewResult = await buildScheduleChangePreview(
      existing.employeeId,
      existing.requestedShiftId,
      startDate,
      endDate,
    );

    if ("error" in previewResult) {
      return { success: false, error: previewResult.error };
    }
    const requestDates = enumerateZonedDaysInclusive(startDate, endDate);
    const firstExpected = await getExpectedShiftForDate(existing.employeeId, startDate);
    if (firstExpected.shift?.id !== existing.currentShiftIdSnapshot) {
      return {
        success: false,
        error:
          "The employee's schedule changed after the request was submitted. Ask them to submit a new schedule change request.",
      };
    }

    for (const day of requestDates) {
      const issue = await getScheduleSwapBlockingIssue(
        existing.employeeId,
        day,
        toEmployeeName(existing.employee),
      );
      if (issue) {
        return { success: false, error: issue };
      }
      const expected =
        day.getTime() === startDate.getTime()
          ? firstExpected
          : await getExpectedShiftForDate(existing.employeeId, day);
      if (!expected.shift || expected.shift.isDayOff) {
        return {
          success: false,
          error: "Every day in the approved range must still be a scheduled workday.",
        };
      }
    }

    const reviewed = await db.$transaction(async (tx) => {
      for (const workDate of requestDates) {
        await tx.employeeShiftOverride.upsert({
          where: {
            employeeId_workDate: {
              employeeId: existing.employeeId,
              workDate,
            },
          },
          update: {
            shiftId: existing.requestedShiftId,
            source: "APPROVED_REQUEST",
            note: `Schedule change approved from request ${existing.id}`,
          },
          create: {
            employeeId: existing.employeeId,
            workDate,
            shiftId: existing.requestedShiftId,
            source: "APPROVED_REQUEST",
            note: `Schedule change approved from request ${existing.id}`,
          },
        });

        const existingAttendance = await tx.attendance.findUnique({
          where: {
            employeeId_workDate: {
              employeeId: existing.employeeId,
              workDate,
            },
          },
          select: { id: true },
        });

        if (existingAttendance) {
          await tx.attendance.update({
            where: { id: existingAttendance.id },
            data: {
              expectedShiftId: existing.requestedShiftId,
              scheduledStartMinutes: existing.requestedStartMinutesSnapshot,
              scheduledEndMinutes: existing.requestedEndMinutesSnapshot,
            },
          });
        }
      }

      return tx.scheduleChangeRequest.update({
        where: { id: parsed.data.id },
        data: {
          status: ScheduleChangeRequestStatus.APPROVED,
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
      eventType: "SCHEDULE_CHANGE_REQUEST_APPROVED",
      title: "Schedule change request approved",
      message: "Your schedule change request was approved.",
      actorUserId: actor.userId,
      employeeId: reviewed.employee.employeeId,
      entityType: "ScheduleChangeRequest",
      entityId: reviewed.id,
      linkHref: "/employee/requests",
    });
    return { success: true, data: serializeScheduleChangeRequest(reviewed) };
  } catch (error) {
    console.error("Error reviewing schedule change request:", error);
    const accessError = scheduleAccessError(
      error,
      "Failed to review schedule change request.",
    );
    return {
      success: false,
      error:
        accessError === "Unauthorized" || accessError === "Forbidden"
          ? "You are not allowed to review schedule change requests."
          : accessError,
    };
  }
}
