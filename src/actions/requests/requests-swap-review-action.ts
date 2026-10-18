"use server";

import { ScheduleSwapRequestStatus } from "@prisma/client";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { requireScheduleManager } from "@/lib/scheduling-auth";
import { scheduleAccessError } from "@/lib/scheduling-access";
import { startOfZonedDay } from "@/lib/timezone";
import {
  scheduleSwapCoworkerReviewSchema,
  scheduleSwapManagerReviewSchema,
} from "@/lib/validations/requests";
import {
  buildScheduleSwapPreview,
  canCreateEmployeeRequests,
  employeeRequestSelect,
  getEmployeeForSession,
  getScheduleSwapBlockingIssue,
  reviewedBySelect,
  revalidateRequestLayouts,
  scheduleSwapEmployeeSelect,
  serializeScheduleSwapRequest,
  toEmployeeName,
} from "./requests-shared";
import {
  notifyEmployeeOfRequestDecision,
  notifyManagersOfRequest,
  notifySwapRequester,
} from "./requests-notifications";
import type {
  RequestReviewPayload,
  ScheduleSwapCoworkerReviewPayload,
  ScheduleSwapRequestRow,
} from "./types";

export async function respondToScheduleSwapRequest(
  input: ScheduleSwapCoworkerReviewPayload,
): Promise<{
  success: boolean;
  data?: ScheduleSwapRequestRow;
  error?: string;
}> {
  try {
    const session = await getSession();
    if (!session?.isLoggedIn || !canCreateEmployeeRequests(session.role)) {
      return {
        success: false,
        error: "You are not allowed to respond to schedule swap requests.",
      };
    }
    if (!session.userId) {
      return { success: false, error: "Employee session is invalid." };
    }

    const parsed = scheduleSwapCoworkerReviewSchema.safeParse(input);
    if (!parsed.success) {
      return {
        success: false,
        error: parsed.error.issues[0]?.message || "Invalid swap response data.",
      };
    }

    const employee = await getEmployeeForSession(session.userId);
    if (!employee || employee.isArchived) {
      return { success: false, error: "Employee record not found." };
    }

    const existing = await db.scheduleSwapRequest.findUnique({
      where: { id: parsed.data.id },
      include: {
        requesterEmployee: { select: employeeRequestSelect },
        coworkerEmployee: { select: employeeRequestSelect },
        reviewedBy: { select: reviewedBySelect },
      },
    });

    if (!existing) {
      return { success: false, error: "Schedule swap request not found." };
    }
    if (existing.coworkerEmployeeId !== employee.employeeId) {
      return {
        success: false,
        error: "Only the selected coworker can respond to this swap request.",
      };
    }
    if (existing.status !== ScheduleSwapRequestStatus.PENDING_COWORKER) {
      return {
        success: false,
        error: "This schedule swap request is no longer waiting for coworker response.",
      };
    }

    const updated = await db.scheduleSwapRequest.update({
      where: { id: parsed.data.id },
      data: {
        status:
          parsed.data.decision === "ACCEPTED"
            ? ScheduleSwapRequestStatus.PENDING_MANAGER
            : ScheduleSwapRequestStatus.DECLINED,
        coworkerRemarks: parsed.data.coworkerRemarks ?? null,
        coworkerRespondedAt: new Date(),
      },
      include: {
        requesterEmployee: { select: employeeRequestSelect },
        coworkerEmployee: { select: employeeRequestSelect },
        reviewedBy: { select: reviewedBySelect },
      },
    });

    revalidateRequestLayouts();
    if (parsed.data.decision === "ACCEPTED") {
      await notifyManagersOfRequest({
        eventType: "SCHEDULE_SWAP_REQUEST_COWORKER_APPROVED",
        title: "Schedule swap ready for manager review",
        message: `${updated.coworkerEmployee.firstName} ${updated.coworkerEmployee.lastName} accepted a schedule swap request.`,
        actorUserId: session.userId ?? null,
        entityType: "ScheduleSwapRequest",
        entityId: updated.id,
      });
    }
    await notifySwapRequester({
      eventType:
        parsed.data.decision === "ACCEPTED"
          ? "SCHEDULE_SWAP_REQUEST_COWORKER_APPROVED"
          : "SCHEDULE_SWAP_REQUEST_COWORKER_REJECTED",
      actorUserId: session.userId ?? null,
      requesterEmployeeId: updated.requesterEmployee.employeeId,
      requestId: updated.id,
      title:
        parsed.data.decision === "ACCEPTED"
          ? "Coworker accepted your schedule swap request"
          : "Coworker declined your schedule swap request",
      message:
        parsed.data.decision === "ACCEPTED"
          ? "Your schedule swap request was accepted by your coworker and is now waiting for manager review."
          : "Your schedule swap request was declined by your coworker.",
    });
    return {
      success: true,
      data: serializeScheduleSwapRequest(updated, employee.employeeId),
    };
  } catch (error) {
    console.error("Error responding to schedule swap request:", error);
    return {
      success: false,
      error: "Failed to respond to the schedule swap request.",
    };
  }
}

export async function reviewScheduleSwapRequest(
  input: RequestReviewPayload,
): Promise<{
  success: boolean;
  data?: ScheduleSwapRequestRow;
  error?: string;
}> {
  try {
    const actor = await requireScheduleManager();

    const parsed = scheduleSwapManagerReviewSchema.safeParse(input);
    if (!parsed.success) {
      return {
        success: false,
        error: parsed.error.issues[0]?.message || "Invalid review data.",
      };
    }

    const existing = await db.scheduleSwapRequest.findUnique({
      where: { id: parsed.data.id },
      include: {
        requesterEmployee: { select: scheduleSwapEmployeeSelect },
        coworkerEmployee: { select: scheduleSwapEmployeeSelect },
        reviewedBy: { select: reviewedBySelect },
      },
    });

    if (!existing) {
      return { success: false, error: "Schedule swap request not found." };
    }
    if (
      existing.requesterEmployee.isArchived ||
      existing.coworkerEmployee.isArchived
    ) {
      return {
        success: false,
        error: "One of the employees linked to this request is archived.",
      };
    }
    if (existing.status !== ScheduleSwapRequestStatus.PENDING_MANAGER) {
      return {
        success: false,
        error: "Only coworker-approved swap requests can be reviewed.",
      };
    }

    const reviewedAt = new Date();

    if (parsed.data.decision === "REJECTED") {
      const reviewed = await db.scheduleSwapRequest.update({
        where: { id: parsed.data.id },
        data: {
          status: ScheduleSwapRequestStatus.REJECTED,
          managerRemarks: parsed.data.managerRemarks ?? null,
          reviewedByUserId: actor.userId,
          reviewedAt,
        },
        include: {
          requesterEmployee: { select: employeeRequestSelect },
          coworkerEmployee: { select: employeeRequestSelect },
          reviewedBy: { select: reviewedBySelect },
        },
      });

      revalidateRequestLayouts();
      await notifySwapRequester({
        eventType: "SCHEDULE_SWAP_REQUEST_REJECTED",
        actorUserId: actor.userId,
        requesterEmployeeId: reviewed.requesterEmployee.employeeId,
        requestId: reviewed.id,
        title: "Schedule swap request rejected",
        message: "Your schedule swap request was rejected by management.",
      });
      await notifyEmployeeOfRequestDecision({
        eventType: "SCHEDULE_SWAP_REQUEST_REJECTED",
        title: "Schedule swap request rejected",
        message: "A schedule swap request involving you was rejected by management.",
        actorUserId: actor.userId,
        employeeId: reviewed.coworkerEmployee.employeeId,
        entityType: "ScheduleSwapRequest",
        entityId: reviewed.id,
        linkHref: "/employee/requests",
      });
      return { success: true, data: serializeScheduleSwapRequest(reviewed) };
    }

    const workDate = startOfZonedDay(existing.workDate);
    const previewResult = await buildScheduleSwapPreview(
      existing.requesterEmployeeId,
      existing.coworkerEmployeeId,
      workDate,
    );

    if ("error" in previewResult) {
      return { success: false, error: previewResult.error };
    }
    if (!previewResult.preview.wouldChange) {
      return {
        success: false,
        error:
          "The schedules no longer differ on that date, so the swap request is no longer applicable.",
      };
    }

    if (
      previewResult.requesterSnapshot.shiftId !==
        existing.requesterShiftIdSnapshot ||
      previewResult.coworkerSnapshot.shiftId !== existing.coworkerShiftIdSnapshot
    ) {
      return {
        success: false,
        error:
          "One of the schedules changed after the request was submitted. Ask the employee to submit a new swap request.",
      };
    }

    const requesterIssue = await getScheduleSwapBlockingIssue(
      existing.requesterEmployeeId,
      workDate,
      toEmployeeName(existing.requesterEmployee),
    );
    if (requesterIssue) {
      return { success: false, error: requesterIssue };
    }
    const coworkerIssue = await getScheduleSwapBlockingIssue(
      existing.coworkerEmployeeId,
      workDate,
      toEmployeeName(existing.coworkerEmployee),
    );
    if (coworkerIssue) {
      return { success: false, error: coworkerIssue };
    }

    const reviewed = await db.$transaction(async (tx) => {
      await tx.employeeShiftOverride.upsert({
        where: {
          employeeId_workDate: {
            employeeId: existing.requesterEmployeeId,
            workDate,
          },
        },
        update: {
          shiftId: existing.coworkerShiftIdSnapshot,
          source: "APPROVED_REQUEST",
          note: `Schedule swap approved from request ${existing.id}`,
        },
        create: {
          employeeId: existing.requesterEmployeeId,
          workDate,
          shiftId: existing.coworkerShiftIdSnapshot,
          source: "APPROVED_REQUEST",
          note: `Schedule swap approved from request ${existing.id}`,
        },
      });

      await tx.employeeShiftOverride.upsert({
        where: {
          employeeId_workDate: {
            employeeId: existing.coworkerEmployeeId,
            workDate,
          },
        },
        update: {
          shiftId: existing.requesterShiftIdSnapshot,
          source: "APPROVED_REQUEST",
          note: `Schedule swap approved from request ${existing.id}`,
        },
        create: {
          employeeId: existing.coworkerEmployeeId,
          workDate,
          shiftId: existing.requesterShiftIdSnapshot,
          source: "APPROVED_REQUEST",
          note: `Schedule swap approved from request ${existing.id}`,
        },
      });

      const existingRequesterAttendance = await tx.attendance.findUnique({
        where: {
          employeeId_workDate: {
            employeeId: existing.requesterEmployeeId,
            workDate,
          },
        },
        select: { id: true },
      });
      if (existingRequesterAttendance) {
        await tx.attendance.update({
          where: { id: existingRequesterAttendance.id },
          data: {
            expectedShiftId: existing.coworkerShiftIdSnapshot,
            scheduledStartMinutes: existing.coworkerStartMinutesSnapshot,
            scheduledEndMinutes: existing.coworkerEndMinutesSnapshot,
          },
        });
      }

      const existingCoworkerAttendance = await tx.attendance.findUnique({
        where: {
          employeeId_workDate: {
            employeeId: existing.coworkerEmployeeId,
            workDate,
          },
        },
        select: { id: true },
      });
      if (existingCoworkerAttendance) {
        await tx.attendance.update({
          where: { id: existingCoworkerAttendance.id },
          data: {
            expectedShiftId: existing.requesterShiftIdSnapshot,
            scheduledStartMinutes: existing.requesterStartMinutesSnapshot,
            scheduledEndMinutes: existing.requesterEndMinutesSnapshot,
          },
        });
      }

      return tx.scheduleSwapRequest.update({
        where: { id: parsed.data.id },
        data: {
          status: ScheduleSwapRequestStatus.APPROVED,
          managerRemarks: parsed.data.managerRemarks ?? null,
          reviewedByUserId: actor.userId,
          reviewedAt,
        },
        include: {
          requesterEmployee: { select: employeeRequestSelect },
          coworkerEmployee: { select: employeeRequestSelect },
          reviewedBy: { select: reviewedBySelect },
        },
      });
    });

    revalidateRequestLayouts();
    await notifySwapRequester({
      eventType: "SCHEDULE_SWAP_REQUEST_APPROVED",
      actorUserId: actor.userId,
      requesterEmployeeId: reviewed.requesterEmployee.employeeId,
      requestId: reviewed.id,
      title: "Schedule swap request approved",
      message: "Your schedule swap request was approved.",
    });
    await notifyEmployeeOfRequestDecision({
      eventType: "SCHEDULE_SWAP_REQUEST_APPROVED",
      title: "Schedule swap request approved",
      message: "A schedule swap request involving you was approved.",
      actorUserId: actor.userId,
      employeeId: reviewed.coworkerEmployee.employeeId,
      entityType: "ScheduleSwapRequest",
      entityId: reviewed.id,
      linkHref: "/employee/requests",
    });
    return { success: true, data: serializeScheduleSwapRequest(reviewed) };
  } catch (error) {
    console.error("Error reviewing schedule swap request:", error);
    const accessError = scheduleAccessError(
      error,
      "Failed to review schedule swap request.",
    );
    return {
      success: false,
      error:
        accessError === "Unauthorized" || accessError === "Forbidden"
          ? "You are not allowed to review schedule swap requests."
          : accessError,
    };
  }
}
