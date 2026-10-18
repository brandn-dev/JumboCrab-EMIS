"use server";

import { requireScheduleManager } from "@/lib/scheduling-auth";
import { scheduleAccessError } from "@/lib/scheduling-access";
import { requireAiSchedulingEnabled } from "@/lib/ai-scheduling-feature";
import {
  createScheduleDraft as createScheduleDraftImpl,
  discardScheduleDraft as discardScheduleDraftImpl,
  discardScheduleDraftsForWeek as discardScheduleDraftsForWeekImpl,
  getScheduleDraftVersion as getScheduleDraftVersionImpl,
  listScheduleDraftsForWeek as listScheduleDraftsForWeekImpl,
  saveScheduleDraftVersion as saveScheduleDraftVersionImpl,
  ScheduleDraftServiceError,
} from "@/lib/schedule-draft-service";
import type { DraftSourceMode } from "@/lib/schedule-draft-policy";

const draftActionError = (error: unknown, fallback: string) => {
  const accessError = scheduleAccessError(error, fallback);
  if (accessError !== fallback) return accessError;
  if (error instanceof Error && error.message === "AI scheduling is disabled") return error.message;
  return error instanceof ScheduleDraftServiceError ? error.message : fallback;
};

export async function listScheduleDraftsForWeek(input: { weekStart: string }) {
  try {
    const actor = await requireScheduleManager();
    requireAiSchedulingEnabled();
    const data = await listScheduleDraftsForWeekImpl({
      weekStart: input?.weekStart,
      ownerUserId: actor.userId,
    });
    return { success: true as const, data };
  } catch (error) {
    return { success: false as const, error: draftActionError(error, "Failed to load schedule drafts") };
  }
}

export async function getScheduleDraftVersion(input: { draftId: string }) {
  try {
    const actor = await requireScheduleManager();
    requireAiSchedulingEnabled();
    const data = await getScheduleDraftVersionImpl({
      draftId: input?.draftId,
      ownerUserId: actor.userId,
    });
    return { success: true as const, data };
  } catch (error) {
    return { success: false as const, error: draftActionError(error, "Failed to load schedule draft") };
  }
}

export async function createScheduleDraft(input: {
  requestKey: string;
  weekStart: string;
  referenceWeekStart?: string | null;
  departmentId?: string | null;
  selectedEmployeeIds?: string[];
  sourceMode: DraftSourceMode;
}) {
  try {
    const actor = await requireScheduleManager();
    requireAiSchedulingEnabled();
    const data = await createScheduleDraftImpl({
      ...input,
      ownerUserId: actor.userId,
    });
    return { success: true as const, data };
  } catch (error) {
    return { success: false as const, error: draftActionError(error, "Failed to create schedule draft") };
  }
}

export async function saveScheduleDraftVersion(input: {
  requestKey: string;
  draftId: string;
  assignments: Array<{
    employeeId: string;
    workDate: string;
    shiftId: number | null;
    assignmentKind: string;
    reason?: string | null;
  }>;
}) {
  try {
    const actor = await requireScheduleManager();
    requireAiSchedulingEnabled();
    const data = await saveScheduleDraftVersionImpl({
      ...input,
      ownerUserId: actor.userId,
    });
    return { success: true as const, data };
  } catch (error) {
    return { success: false as const, error: draftActionError(error, "Failed to save schedule draft") };
  }
}

export async function discardScheduleDraft(input: { draftId: string }) {
  try {
    const actor = await requireScheduleManager();
    requireAiSchedulingEnabled();
    await discardScheduleDraftImpl({ draftId: input?.draftId, ownerUserId: actor.userId });
    return { success: true as const };
  } catch (error) {
    return { success: false as const, error: draftActionError(error, "Failed to discard schedule draft") };
  }
}

export async function discardScheduleDraftsForWeek(input: { weekStart: string }) {
  try {
    const actor = await requireScheduleManager();
    requireAiSchedulingEnabled();
    const data = await discardScheduleDraftsForWeekImpl({
      weekStart: input?.weekStart,
      ownerUserId: actor.userId,
    });
    return { success: true as const, data };
  } catch (error) {
    return { success: false as const, error: draftActionError(error, "Failed to discard schedule drafts") };
  }
}
