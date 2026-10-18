"use server";

import { requireAiSchedulingEnabled } from "@/lib/ai-scheduling-feature";
import { isAiSchedulingChatEnabled } from "@/lib/ai-scheduling-chat-policy";
import { scheduleAccessError } from "@/lib/scheduling-access";
import { requireScheduleManager } from "@/lib/scheduling-auth";
import {
  generateScheduleDraft as generateScheduleDraftImpl,
  approveScheduleDraft as approveScheduleDraftImpl,
  listScheduleCoverageRules as listScheduleCoverageRulesImpl,
  publishScheduleDraft as publishScheduleDraftImpl,
  retrySchedulePublicationNotification as retrySchedulePublicationNotificationImpl,
  saveScheduleCoverageRule as saveScheduleCoverageRuleImpl,
  SchedulePolicyServiceError,
  validateScheduleDraft as validateScheduleDraftImpl,
} from "@/lib/schedule-policy-service";

const policyActionError = (error: unknown, fallback: string) => {
  const accessError = scheduleAccessError(error, fallback);
  if (accessError !== fallback) return accessError;
  if (error instanceof SchedulePolicyServiceError) return error.message;
  if (error instanceof Error && error.message === "AI scheduling is disabled") return error.message;
  return fallback;
};

export async function getSchedulePolicyFeatureAvailability() {
  try {
    await requireScheduleManager();
    return {
      success: true as const,
      enabled: process.env.AI_SCHEDULING_ENABLED === "true",
      chatEnabled: isAiSchedulingChatEnabled({
        schedulingFlag: process.env.AI_SCHEDULING_ENABLED,
        chatFlag: process.env.AI_SCHEDULING_CHAT_ENABLED,
      }),
    };
  } catch (error) {
    return { success: false as const, error: policyActionError(error, "Failed to check scheduling feature access") };
  }
}

export async function listScheduleCoverageRules() {
  try {
    await requireScheduleManager();
    requireAiSchedulingEnabled();
    const data = await listScheduleCoverageRulesImpl();
    return { success: true as const, data };
  } catch (error) {
    return { success: false as const, error: policyActionError(error, "Failed to load coverage rules") };
  }
}

export async function saveScheduleCoverageRule(input: {
  id?: string;
  name: string;
  departmentId?: string | null;
  positionId?: string | null;
  shiftId?: number | null;
  weekday: number;
  minimumStaff: number;
  maximumStaff?: number | null;
  priority: "HARD" | "SOFT";
  isActive: boolean;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}) {
  try {
    const actor = await requireScheduleManager();
    requireAiSchedulingEnabled();
    const data = await saveScheduleCoverageRuleImpl({ ...input, actorUserId: actor.userId });
    return { success: true as const, data };
  } catch (error) {
    return { success: false as const, error: policyActionError(error, "Failed to save coverage rule") };
  }
}

export async function validateScheduleDraft(input: { draftId: string }) {
  try {
    const actor = await requireScheduleManager();
    requireAiSchedulingEnabled();
    const data = await validateScheduleDraftImpl({
      draftId: input?.draftId,
      ownerUserId: actor.userId,
      actorUserId: actor.userId,
    });
    return { success: true as const, data };
  } catch (error) {
    return { success: false as const, error: policyActionError(error, "Failed to validate schedule draft") };
  }
}

export async function approveScheduleDraft(input: {
  draftId: string;
  acknowledgeWarnings: boolean;
}) {
  try {
    const actor = await requireScheduleManager();
    requireAiSchedulingEnabled();
    const data = await approveScheduleDraftImpl({
      draftId: input?.draftId,
      ownerUserId: actor.userId,
      actorUserId: actor.userId,
      acknowledgeWarnings: input?.acknowledgeWarnings === true,
    });
    return { success: true as const, data };
  } catch (error) {
    return { success: false as const, error: policyActionError(error, "Failed to approve schedule draft") };
  }
}

export async function publishScheduleDraft(input: {
  draftId: string;
  confirmed: boolean;
}) {
  try {
    const actor = await requireScheduleManager();
    requireAiSchedulingEnabled();
    const data = await publishScheduleDraftImpl({
      draftId: input?.draftId,
      ownerUserId: actor.userId,
      actorUserId: actor.userId,
      confirmed: input?.confirmed === true,
    });
    return { success: true as const, data };
  } catch (error) {
    return { success: false as const, error: policyActionError(error, "Failed to publish schedule") };
  }
}

export async function retrySchedulePublicationNotification(input: { draftId: string }) {
  try {
    const actor = await requireScheduleManager();
    requireAiSchedulingEnabled();
    const data = await retrySchedulePublicationNotificationImpl({
      draftId: input?.draftId,
      ownerUserId: actor.userId,
    });
    return { success: true as const, data };
  } catch (error) {
    return { success: false as const, error: policyActionError(error, "Failed to retry schedule notification") };
  }
}

export async function generateScheduleDraft(input: { draftId: string }) {
  try {
    const actor = await requireScheduleManager();
    requireAiSchedulingEnabled();
    const data = await generateScheduleDraftImpl({
      draftId: input?.draftId,
      ownerUserId: actor.userId,
      actorUserId: actor.userId,
    });
    return { success: true as const, data };
  } catch (error) {
    return { success: false as const, error: policyActionError(error, "Failed to generate schedule from reference") };
  }
}
